"""The in-process bridge to `apps/agent`.

**The boundary between the service and the planner is a function call**, which
is the whole architectural claim of the HLD (§5): `apps/web` calls `/plan/*` on
this service, and this service imports the agent's graph rather than proxying to
a second HTTP service. There is no second spec to keep in sync, no internal
secret to share, and no network hop in the planning path.

What that buys, concretely: the clarify interrupt is durable across requests
because the same process holds the checkpointer, and a plan run can read the
user's real rows in the same transaction it will write them in.

This module owns three things and nothing else:

* **Context** — turning the user's rows into the state keys the graph expects.
  The graph is pure and takes its inputs as plain data; assembling them is the
  service's job.
* **Run/resume** — one call, with the checkpointer and the LLM seam injected.
* **Reading a thread back** — `/plan/confirm` has to know what a run produced,
  and the run has already returned, so it reads the checkpointed state.
"""
from __future__ import annotations

from typing import Any

from app.graph.build import build_plan_graph
from app.graph.state import initial_state
from app.llm.client import get_complete
from sqlalchemy.ext.asyncio import AsyncSession

from .core.transcript import CONTEXT_TURNS, render_transcript
from .store import chat, repo
from .store.checkpointer import get_checkpointer

#: The default weekly capacity when a user has never set one. 40 hours is the
#: agent's own default, and keeping the two equal avoids a plan that fits one
#: number and not the other.
DEFAULT_CAPACITY_HOURS = 40.0


async def planner_context(
    session: AsyncSession, *, user_id: str, goal_id: str | None = None, mode: str = "ask"
) -> dict[str, Any]:
    """The state keys the graph reads, from the user's rows.

    Only *active* goals contribute to the load, and only goals with a numeric
    estimate: a goal with `weekly_hours = NULL` has not been estimated yet, and
    counting it as zero would make the headroom check believe there is room.
    """
    from datetime import UTC, datetime

    goals = await repo.list_goals(session, user_id=user_id, limit=500)
    blockers = await repo.list_blockers(session, user_id=user_id, limit=500)
    user_row = await session.get(_user_model(), user_id)

    active = [g for g in goals if g.status == "active"]

    # The recent conversation. Without this `n_intake` and `n_plan` format their
    # `{context}` slot as the literal string "none" on every HTTP-driven turn,
    # so the graph plans against the current message alone — only the TUI ever
    # filled it. A scoped chat (`conv_<kind>_<refId>`) is keyed by goal, so the
    # history folded in is the conversation the user is actually having.
    messages = await chat.history(
        session,
        user_id=user_id,
        conv_id=chat.bucket_id(user_id=user_id, ref_id=goal_id or ""),
        limit=CONTEXT_TURNS,
    )

    return {
        "context": render_transcript(messages),
        "today": datetime.now(UTC).date().isoformat(),
        "mode": mode,
        "user_id": user_id,
        "goal_id": goal_id,
        # A blocker is a hard constraint: every date in its range is zero
        # capacity. Expanded here rather than in the graph, because the graph
        # should not know what a blocker row is.
        "blocked_dates": _expand_blockers(blockers),
        "availability": (user_row.availability if user_row else None) or {},
        "weekly_budget_hours": (
            float(user_row.available_weekly_hours)
            if user_row is not None and user_row.available_weekly_hours
            else None
        ),
        "existing_goal_titles": [g.title for g in goals],
        "active_goal_weekly_hours": [
            float(g.weekly_hours) for g in active if isinstance(g.weekly_hours, (int, float))
        ],
        "capacity_hours": float(
            (user_row.available_weekly_hours if user_row else None)
            or DEFAULT_CAPACITY_HOURS
        ),
    }


def _user_model():
    from .models import User

    return User


def _expand_blockers(blockers: list) -> list[str]:
    """Blockers → the list of dates with zero capacity.

    A blocker with no `end_date` is a single day — the same rule the create route
    applies, so the two cannot disagree about what a one-day blocker covers.
    """
    from datetime import date, timedelta

    out: list[str] = []
    for b in blockers:
        if b.start_date is None:
            continue
        start: date = b.start_date
        end: date = b.end_date or start
        cursor = start
        while cursor <= end:
            out.append(cursor.isoformat())
            cursor += timedelta(days=1)
    return out


async def run(
    *,
    message: str,
    context: dict[str, Any],
    thread_id: str | None = None,
    resume: Any = None,
) -> dict:
    """Run or resume the graph. Returns the agent's result dict, `kind` included.

    `complete` and the checkpointer are resolved here rather than inside the
    graph, which is what keeps the nodes testable without a model and lets this
    service swap the provider without the agent knowing.
    """
    from app.graph.build import run_plan

    result = await run_plan(
        message=message,
        complete=get_complete(),
        checkpointer=await get_checkpointer(),
        thread_id=thread_id,
        resume=resume,
        **{k: v for k, v in context.items() if k != "message"},
    )
    return dict(result)


async def replan(
    *,
    change: dict[str, Any],
    tier: str,
    adjustments: list[str],
    thread_id: str,
    deltas: list[dict] | None = None,
    context: dict[str, Any] | None = None,
) -> dict:
    """Re-solve an existing plan on its own thread.

    A separate entry point from `run`, because the seeds differ in kind: `run`
    starts a turn, `replan` continues a plan. The route used to route a replan
    through `run` by inventing a message for it — `f"Re-plan '{title}' around
    {intent}"` — which meant the graph re-derived the plan's meaning from prose
    and could rewrite the titles the user was looking at.
    """
    from app.graph.build import run_replan

    return dict(
        await run_replan(
            change=change,
            thread_id=thread_id,
            tier=tier,
            adjustments=adjustments,
            deltas=deltas or [],
            complete=get_complete(),
            checkpointer=await get_checkpointer(),
            **{k: v for k, v in (context or {}).items() if k != "message"},
        )
    )


async def thread_result(thread_id: str) -> dict | None:
    """What a finished run produced, read back from the checkpoint.

    `/plan/confirm` needs this: the run returned its `plan_items` to whoever
    called `/plan/run`, and the confirm happens in a *later* request that has no
    access to that response. Reading the checkpointed state is what makes the
    plan survive the gap — and what makes a confirm possible after a reload, a
    deploy, or from a different server process.

    Returns `None` when the thread is unknown or never reached a result.
    """
    graph = build_plan_graph(
        complete=get_complete(), checkpointer=await get_checkpointer()
    )
    snapshot = await graph.aget_state({"configurable": {"thread_id": thread_id}})
    if snapshot is None:
        return None
    values = getattr(snapshot, "values", None) or {}
    result = values.get("result")
    return dict(result) if isinstance(result, dict) else None


def empty_state(**kw: Any) -> dict:
    """The graph's initial state, for tests that drive a node directly."""
    return initial_state(**kw)
