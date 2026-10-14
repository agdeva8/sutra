"""`/plan/*`, served by agentv2.

The same five routes and wire shapes as before, now backed by agentv2 instead of the v1 graph.
What changed underneath:

* `run` / `stream` are one coach-chat turn (`agentv2.chat_turn`): it files what it can, proposes
  goal and availability changes for the user to confirm, and returns a question when it needs one.
* `confirm` is retired (410). v2 writes a plan when a goal is created (`/goals/intake/confirm`) and
  applies a proposal when it is confirmed (`/tools/confirm`); there is no separate computed-plan
  commit to confirm any more.
* `change` records the change and its blast radius as before, then re-plans the goal around it
  (`agentv2.replan_goal`) once the tier allows it.
* `staleness` is unchanged.

`kind` tells the caller what to do next: `ok` (something was filed or proposed), `clarify` (a
question is needed), `no_change` (nothing for the planner to do; use the ordinary chat).
"""
from __future__ import annotations

from typing import Any

from agentv2 import chat_turn, local_now, replan_goal
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent_store import SqlStore
from ..core.blast_radius import radius_for_intent
from ..core.staleness import build_adjustments, classify_change, make_change
from ..db import get_session
from ..rate_limit import llm_rate_limit
from ..deps import CurrentUser, planner_enabled_for, require_user
from ..store import repo, staleness
from ..stream import done, frame, needs_clarification, plan as plan_frame, progress_stream, sse_response, wants_stream

router = APIRouter(tags=["planning"])


def _disabled() -> dict:
    """The planner is dark for this user: `{"status": "disabled"}` rather than an error, because the
    client's fallback is the SSE chat path and a 4xx would make a flag look like a failure."""
    return {"status": "disabled"}


async def _read_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    return body or {}


def _payload(turn) -> dict:
    kind = {"ok": "ok", "clarify": "clarify"}.get(turn.kind, "no_change")
    return {
        "kind": kind,
        "prose": "\n".join(p for p in [turn.prose, *turn.applied] if p),
        "proposals": turn.proposals,
        "plan_items": [],
        "questions": turn.questions,
        "adjustments": [],
        "tier": None,
        "reason": "",
        "rejects": [],
        "thread_id": "",
        "place": None,
        "review_rounds": 0,
        "trace_url": None,
    }


async def _run_turn(session: AsyncSession, user: CurrentUser, request: Request, message: str):
    now = local_now(request.headers.get("x-timezone"))
    turn = await chat_turn(SqlStore(session, user.user_id, today=now.date()), message, now=now)
    await session.commit()
    return turn


@router.post("/plan/run", dependencies=[Depends(llm_rate_limit)])
async def plan_run(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """One planning turn to completion."""
    if not planner_enabled_for(user):
        return _disabled()
    body = await _read_body(request)
    message = str(body.get("message") or "")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    return _payload(await _run_turn(session, user, request, message))


@router.post("/plan/stream", dependencies=[Depends(llm_rate_limit)])
async def plan_stream(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """The same turn, framed as SSE: a progress frame, then either a question or the result."""
    if not planner_enabled_for(user):
        return _disabled()
    body = await _read_body(request)
    message = str(body.get("message") or "")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    async def events():
        from ..stream import error as error_frame

        yield frame(plan_frame("plan"))
        try:
            turn = await _run_turn(session, user, request, message)
        except Exception as exc:  # noqa: BLE001 - an SSE stream must end with a frame, not a traceback
            yield frame(error_frame(str(exc)))
            return
        if turn.kind == "clarify":
            yield frame(needs_clarification(list(turn.questions), prompt=turn.prose, thread_id=""))
            return
        yield frame(done(message_id="", provider="agentv2", thread_id="", text=_payload(turn)["prose"]))

    return sse_response(events())


@router.post("/plan/confirm")
async def plan_confirm() -> dict:
    """Retired. A plan is written when a goal is created, and a proposal is applied when it is confirmed."""
    raise HTTPException(
        status_code=410,
        detail="Plans are written when a goal is created (/goals/intake/confirm) or a proposal is confirmed (/tools/confirm).",
    )


#: First progress line of a streamed plan change, before the planner reports its own.
PLAN_CHANGE_FIRST = "Looking at what changed…"


@router.post("/plan/change")
async def plan_change(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> object:
    """Record a change and decide its blast radius, then re-plan the goal around it.

    The tier is computed, never asserted by the model. `slim` changes (day-level dates) are re-planned
    silently behind a toaster; `escalate` changes are recorded and re-planned only when the caller sends
    `confirmed: true`, which is the confirm modal's "yes". A re-plan bumps the plan generation, so the
    "N changes" badge clears only when the plan really was rebuilt.
    """
    body = await _read_body(request)

    async def job(say) -> dict:
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
        detail = action.get("rationale") or goal.title
        recorded = await staleness.record_change(
            session, user_id=user.user_id, goal_id=goal_id, kind=f"{intent}:{verdict.tier}",
            horizons_moved=horizons, milestone_moved=milestone_moved, summary=str(detail),
        )
        adjustments = build_adjustments([recorded])

        replanned = False
        if verdict.tier == "slim" or body.get("confirmed"):
            now = local_now(request.headers.get("x-timezone"))
            out = await replan_goal(SqlStore(session, user.user_id, today=now.date()), goal_id, now=now, progress=say)
            if out.status != "applied":
                await session.rollback()
                raise HTTPException(status_code=422, detail="Couldn't re-plan this goal safely.")
            replanned = True
            if verdict.tier != "slim":
                await staleness.mark_planned(session, user_id=user.user_id, goal_id=goal_id)
        await session.commit()

        return {
            "tier": verdict.tier,
            "reason": verdict.reason,
            "adjustments": adjustments,
            "replanned": replanned,
            "plan_items": [],
        }

    if wants_stream(request):
        return sse_response(progress_stream(job, first=PLAN_CHANGE_FIRST))
    return await job(lambda _line: None)


@router.get("/plan/staleness")
async def plan_staleness(
    goal_id: str = "",
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """The refresh button's badge and sentence (unchanged)."""
    return await staleness.rollup(session, user_id=user.user_id, goal_id=goal_id or None)
