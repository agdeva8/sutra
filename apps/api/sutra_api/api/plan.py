"""The v2 planner surface — `/plan/*`, served by importing `apps/agent`.

Five routes, and the whole point of the architecture: this service owns the wire,
the agent owns the planning, and the boundary between them is a **function call**
(HLD §5). `apps/web` never reaches the agent, and the agent has no HTTP surface of
its own.

## `kind` tells the caller what to do next

| kind | means |
|---|---|
| `ok` | a plan was produced; `plan_items` is populated |
| `early` | a question is needed first; `questions` is populated |
| `no_change` | the plan already satisfied the request |
| `renegotiate` | the request cannot fit; `proposals` carries the options |
| `clarify` | the graph interrupted; resume with the same `thread_id` and `answers` |

## Confirm is where staleness is enforced

`/plan/confirm` is the only route that writes a plan, and it is the only place
`plan_generation` moves. The 409 is the interesting part: a plan computed before
a change the user has since made must not be committed over the top of it. See
`_is_stale` for the check and its limits.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.staleness import build_adjustments, classify_change, make_change

from .. import planner
from ..core.blast_radius import radius_for_intent
from ..db import get_session
from ..deps import CurrentUser, planner_enabled_for, require_user
from ..models import Conversation, PlanChange
from ..store import repo, staleness, threads
from ..stream import done, frame, needs_clarification, plan as plan_frame, sse_response
from ..wire import plan_item_row

router = APIRouter(tags=["planning"])

#: The keys a `/plan/*` request may carry. Anything else in the body is ignored
#: rather than rejected: the client has evolved faster than this surface, and a
#: 400 on an unknown key would break a working UI over a field nothing reads.
_KNOWN_REQUEST_KEYS = {"message", "mode", "goal_id", "thread_id", "answers"}


def _disabled() -> dict:
    """The planner is dark for this user (HLD §14).

    `{"status": "disabled"}` rather than an error, because the client's fallback
    is to use the SSE chat path — a 4xx would make a flag look like a failure.
    """
    return {"status": "disabled"}


def _result_payload(result: dict) -> dict:
    """The agent's result dict, shaped to the spec's `PipelineResult`.

    `plan_items` are re-serialised through `wire.plan_item_row` rather than passed
    through: the agent's `PlanItemRow` and this service's wire shape agree today,
    and routing them through the one serialiser is what keeps that true.
    """
    return {
        "kind": result.get("kind", "no_change"),
        "prose": result.get("prose", ""),
        "proposals": result.get("proposals") or [],
        "plan_items": [
            plan_item_row(i) for i in (result.get("plan_items") or [])
        ],
        "questions": result.get("questions") or [],
        "adjustments": result.get("adjustments") or [],
        "tier": result.get("tier"),
        "reason": result.get("reason", ""),
        "rejects": result.get("rejects") or [],
        "thread_id": result.get("thread_id", ""),
        "place": result.get("place"),
        "review_rounds": result.get("review_rounds", 0),
        # Not in the spec, and worth having: the LangSmith trace for this turn.
        # Additive, so a strict client is unaffected.
        "trace_url": result.get("trace_url"),
    }


async def _read_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    return {k: v for k, v in (body or {}).items() if k in _KNOWN_REQUEST_KEYS}


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------


@router.post("/plan/run")
async def plan_run(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Run the graph to completion and return one terminal result."""
    if not planner_enabled_for(user):
        return _disabled()

    body = await _read_body(request)
    message = str(body.get("message") or "")
    if not message and not body.get("answers"):
        raise HTTPException(status_code=400, detail="message is required")

    context = await planner.planner_context(
        session,
        user_id=user.user_id,
        goal_id=body.get("goal_id"),
        mode=str(body.get("mode") or "ask"),
    )

    # Resuming an interrupt passes answers to the checkpointed thread instead of
    # starting a new run — the same HTTP call, a different door.
    resume = body.get("answers") if body.get("thread_id") else None

    try:
        result = await planner.run(
            message=message,
            context=context,
            thread_id=body.get("thread_id"),
            resume=resume,
        )
    except Exception as exc:  # noqa: BLE001
        # A *programmer* error in the graph should surface loudly (HLD §13) — but
        # this is the HTTP boundary, so it becomes a 503 the client can retry
        # rather than a stack trace the user cannot act on.
        raise HTTPException(status_code=503, detail=f"Planner unavailable: {exc}")

    return _result_payload(result)


@router.post("/plan/stream")
async def plan_stream(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """The same run, framed as SSE.

    Progress is derived from the graph's own node updates rather than from custom
    stream writes — the agent's nodes emit none, and adding them would mean
    touching a library this service only imports. `stream_mode="updates"` gives
    the node name as each one finishes, which is exactly what a progress bar
    wants.
    """
    body = await _read_body(request)
    message = str(body.get("message") or "")
    thread = str(body.get("thread_id") or "") or None

    if not planner_enabled_for(user):
        # Plain JSON, not a stream. A stream has no way to say "this feature is
        # off" that a client can branch on — an `error` frame reads as a
        # failure, and an empty `done` reads as an empty plan. The JSON body is
        # the same shape `/chat/plan` uses for the same condition.
        return _disabled()

    context = await planner.planner_context(
        session,
        user_id=user.user_id,
        goal_id=body.get("goal_id"),
        mode=str(body.get("mode") or "ask"),
    )
    resume = body.get("answers") if thread else None

    async def events():
        from app.graph.build import build_plan_graph
        from app.llm.client import get_complete

        from ..llm import provider_status
        from ..store.checkpointer import get_checkpointer

        checkpointer = await get_checkpointer()
        graph = build_plan_graph(complete=get_complete(), checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread or f"plan-{user.user_id}"}}

        if resume is not None:
            from langgraph.types import Command

            graph_input = Command(resume=resume)
        else:
            from app.graph.state import initial_state

            graph_input = initial_state(message=message, **context)

        try:
            async for chunk in graph.astream(
                graph_input, config, stream_mode="updates", version="v2"
            ):
                node = _node_of(chunk)
                if node:
                    yield frame(plan_frame(node))
        except Exception as exc:  # noqa: BLE001
            from ..stream import error as error_frame

            yield frame(error_frame(str(exc)))
            return

        snapshot = await graph.aget_state(config)
        values = getattr(snapshot, "values", None) or {}
        pending = values.get("__interrupt__")
        if pending:
            first = pending[0]
            value = getattr(first, "value", first) or {}
            yield frame(
                needs_clarification(
                    list(value.get("questions") or []),
                    prompt=value.get("prompt", ""),
                    thread_id=config["configurable"]["thread_id"],
                )
            )
            return

        result = values.get("result") or {"kind": "no_change"}
        yield frame(
            done(
                message_id=config["configurable"]["thread_id"],
                provider=provider_status()["provider"],
                thread_id=result.get("thread_id", ""),
                text=result.get("prose", ""),
            )
        )

    return sse_response(events())


def _node_of(chunk: Any) -> str:
    """The node name from an `updates` chunk, across LangGraph's shapes.

    `version="v2"` normalises everything to `{"type","ns","data"}`, but a future
    version could change that, and a progress frame is not worth a hard failure.
    """
    if isinstance(chunk, dict):
        data = chunk.get("data", chunk)
        if isinstance(data, dict):
            for key in data:
                return str(key)
        if isinstance(chunk.get("type"), str):
            return ""
    if isinstance(chunk, tuple) and len(chunk) == 2:
        return str(chunk[0])
    return ""


# ---------------------------------------------------------------------------
# confirm
# ---------------------------------------------------------------------------


async def _is_stale(
    session: AsyncSession, *, user_id: str, thread_id: str, goal_ids: list[str]
) -> bool:
    """Was the plan computed before a change the user has since made?

    The baseline is the conversation's `last_message_at`, which the run sets when
    it inserts the user's message. Any `plan_change_ledger` row for one of this
    run's goals, recorded *after* that, means the plan is describing a world that
    has moved — and committing it would rewrite dates the user just changed.

    The limit is real and worth stating: a change recorded in the same second as
    the run's message could compare equal, and the check would miss it. That
    window is one request wide, and the alternative — an explicit
    `plan_runs(thread_id, baseline)` table — is the fix if it ever matters.
    """
    if not goal_ids:
        return False
    conv = await session.get(Conversation, thread_id)
    if conv is None:
        return False
    baseline = conv.last_message_at
    newest = (
        await session.execute(
            select(PlanChange.created_at)
            .where(
                PlanChange.user_id == user_id,
                PlanChange.goal_id.in_(goal_ids),
            )
            .order_by(PlanChange.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return newest is not None and newest > baseline


@router.post("/plan/confirm")
async def plan_confirm(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Commit a produced plan. The **only** route that moves `plan_generation`.

    `accepted: false` records the rejection and writes nothing — that is the
    modal's cancel path, and it exists so a cancelled plan is not an orphaned run
    the user can never clear.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    thread_id = str(body.get("thread_id") or "")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required")

    result = await planner.thread_result(thread_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No plan for that thread")

    accepted = body.get("accepted", True) is not False
    rows = [
        i for i in (result.get("plan_items") or []) if isinstance(i, dict)
    ]

    by_goal: dict[str, list[dict]] = {}
    for row in rows:
        goal_id = str(row.get("goal_id") or "")
        if goal_id:
            by_goal.setdefault(goal_id, []).append(row)

    wanted_goal = body.get("goal_id")
    if wanted_goal:
        by_goal = {k: v for k, v in by_goal.items() if k == wanted_goal}

    if not accepted:
        # Write nothing. The rejection is recorded against every goal that would
        # have changed, so the badge reflects that the user saw and declined.
        for goal_id in by_goal:
            await staleness.record_change(
                session,
                user_id=user.user_id,
                goal_id=goal_id,
                kind="rejected_plan",
                horizons_moved=["daily"],
                summary="Plan rejected",
            )
        await session.commit()
        return {"ok": True, "plan_items": [], "generation": None}

    if await _is_stale(
        session, user_id=user.user_id, thread_id=thread_id, goal_ids=list(by_goal)
    ):
        raise HTTPException(
            status_code=409,
            detail="The plan is stale — re-run before confirming.",
        )

    written: list[dict] = []
    generation: int | None = None
    for goal_id, goal_rows in by_goal.items():
        created = await repo.replace_plan_items_for_goal(
            session, user_id=user.user_id, goal_id=goal_id, rows=goal_rows
        )
        written.extend(plan_item_row(item) for item in created)
        # The generation moves here and *only* here.
        generation = await staleness.mark_planned(
            session, user_id=user.user_id, goal_id=goal_id
        )
        # Point the goal at this thread, so a later replan can re-solve the task
        # set that produced it. Recorded at confirm and not before: a thread
        # whose plan was never accepted is not something a replan should adopt.
        await threads.record_thread(
            session, user_id=user.user_id, goal_id=goal_id, thread_id=thread_id
        )

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="confirm:plan",
        summary=f"Confirmed a plan ({len(written)} items across {len(by_goal)} goals)",
        payload={"thread_id": thread_id, "goals": list(by_goal)},
    )
    await session.commit()
    return {"ok": True, "plan_items": written, "generation": generation}


# ---------------------------------------------------------------------------
# change
# ---------------------------------------------------------------------------


@router.post("/plan/change")
async def plan_change(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Record a change and decide its blast radius.

    The tier is **computed, never asserted by the model** (HLD §9.2). `slim`
    changes day-level dates and applies silently behind a toaster; `escalate`
    needs the confirm modal.

    A `slim` change deliberately does **not** bump the generation — an automatic
    re-solve must never silently reset the user's "N changes" indicator. That is
    what keeps the badge honest: the count only clears when the user confirms.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    action = body.get("action") or {}
    goal_id = str(body.get("goal_id") or "")
    intent = str(action.get("intent") or "")
    if not goal_id or not intent:
        raise HTTPException(status_code=400, detail="action.intent and goal_id are required")

    goal = await repo.get_goal(session, user_id=user.user_id, goal_id=goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")

    horizons, milestone_moved = radius_for_intent(intent)
    verdict = classify_change(horizons, milestone_moved=milestone_moved)

    # The route supplies the specific values it already has, and the *template*
    # stays fixed per kind — HLD §9.5's option B. That is the difference between
    # "Adjusting day tasks" and "Adjusting 3 day tasks around your Goa trip".
    detail = action.get("rationale") or goal.title
    change = make_change(
        goal_id,
        kind=f"{intent}:{verdict.tier}",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        detail={"summary": detail, "label": goal.title},
        generation=(
            await staleness.current_baseline(
                session, user_id=user.user_id, goal_id=goal_id
            )
        ).generation,
    )
    recorded = await staleness.record_change(
        session,
        user_id=user.user_id,
        goal_id=goal_id,
        kind=f"{intent}:{verdict.tier}",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=str(detail),
    )

    adjustments = build_adjustments([recorded])

    plan_items: list[dict] = []
    # What the graph actually did — which is not always what the radius
    # predicted. `at_start` degrades a slim replan with no checkpointed task set
    # to an ordinary run, and that run re-derives the plan's meaning. Applying it
    # silently would make exactly the change the tier promised to hide.
    applied_tier = verdict.tier
    if verdict.tier == "slim":
        thread_id = await threads.thread_for(
            session, user_id=user.user_id, goal_id=goal_id
        )
        if thread_id:
            context = await planner.planner_context(
                session, user_id=user.user_id, goal_id=goal_id
            )
            result = await planner.replan(
                change={
                    "goal_id": goal_id,
                    "intent": intent,
                    "kind": f"{intent}:{verdict.tier}",
                    "detail": detail,
                },
                tier="slim",
                adjustments=adjustments,
                thread_id=thread_id,
                context=context,
            )
            # A result with no `tier` did not take the slim door.
            applied_tier = result.get("tier") or "escalate"
            if applied_tier == "slim":
                rows = [
                    i for i in (result.get("plan_items") or []) if isinstance(i, dict)
                ]
                if rows:
                    created = await repo.replace_plan_items_for_goal(
                        session, user_id=user.user_id, goal_id=goal_id, rows=rows
                    )
                    plan_items = [plan_item_row(i) for i in created]

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type=f"replan:{verdict.tier}",
        summary=str(detail),
        payload={
            "goal_id": goal_id,
            "intent": intent,
            "tier": verdict.tier,
            "horizons_moved": horizons,
        },
    )
    await session.commit()

    return {
        "change": {
            "goal_id": change.goal_id,
            "kind": change.kind,
            "horizons_moved": list(change.horizons_moved),
            "milestone_moved": change.milestone_moved,
            "detail": change.detail,
            "created_at": change.created_at,
            "generation": change.generation,
        },
        "verdict": {
            "tier": verdict.tier,
            "top_horizon": verdict.top_horizon,
            "reason": verdict.reason,
        },
        # Additive, and the honest half: `verdict.tier` is the classification,
        # this is what the graph applied. They differ when a slim replan had no
        # thread to re-solve and silently became a full re-plan — which the
        # client must show as escalate rather than as a quiet date shuffle.
        "applied_tier": applied_tier,
        "adjustments": adjustments,
        "plan_items": plan_items,
    }


# ---------------------------------------------------------------------------
# staleness
# ---------------------------------------------------------------------------


@router.get("/plan/staleness")
async def plan_staleness(
    goal_id: str = "",
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """The refresh button's badge and sentence.

    `total` is the number the badge shows; `label` is the sentence beside it. Both
    come from `rollup_counts`, which is the same function the agent's TUI uses —
    one implementation, so the count on the dashboard and the count in the
    terminal cannot disagree.
    """
    return await staleness.rollup(
        session, user_id=user.user_id, goal_id=goal_id or None
    )
