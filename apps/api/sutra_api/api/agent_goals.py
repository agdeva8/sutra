"""Goal intake and creation, served by `agentv2`.

Two routes. `POST /goals/intake` is one turn of the dialogue: it returns either the
next question (with an opaque `state` to send back) or a draft goal. Nothing is
written until `POST /goals/intake/confirm`, which creates the goal and its
milestones and plans it, in one transaction.

The state is round-tripped through the client rather than stored: it is only the
conversation so far, it affects nothing but the caller's own goal, and it means the
server keeps no session to lose.
"""
from __future__ import annotations

import logging

from agentv2 import GoalDraft, IntakeState, create_goal, intake_turn, local_now
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent_store import SqlStore
from ..db import get_session
from ..models import AuditEntry
from ..plan_guard import guarded, live_builds
from ..progress import progress_payload
from ..rate_limit import llm_rate_limit
from ..store import repo
from ..deps import CurrentUser, require_user

log = logging.getLogger(__name__)

router = APIRouter(tags=["goals"])

#: Intake and planning call the model; a one-line cap keeps a runaway message out.
MESSAGE_MAX_CHARS = 4000
#: Cap on the client's confirm id. A UUID is 36; anything longer is not one of ours.
CONFIRM_ID_MAX_CHARS = 128
#: Audit rows that remember which goal a `confirm_id` created. No migration needed: the ledger is
#: already there, and its `payload` is JSONB.
AUDIT_INTAKE_CONFIRM = "intake:confirm"

#: The `plan` block of a confirm response, for a goal this request did not create.
ALREADY_CREATED_NOTE = "This goal was already created by this confirm."


def normalize_confirm_id(value: object) -> str | None:
    """A usable confirm id, or None. Optional: a request without one behaves exactly as before."""
    if not isinstance(value, str):
        return None
    confirm_id = value.strip()
    return confirm_id if 0 < len(confirm_id) <= CONFIRM_ID_MAX_CHARS else None


def goal_created_by_confirm(payloads) -> str | None:
    """The goal id an earlier audit row for this `confirm_id` created, or None.

    Newest first; the first well-formed row wins. A row whose goal was written but whose payload is
    malformed proves nothing, so it is skipped rather than reported.
    """
    for payload in payloads:
        goal_id = (payload or {}).get("goal_id")
        if isinstance(goal_id, str) and goal_id:
            return goal_id
    return None


def _tz(request: Request) -> str | None:
    """The user's IANA timezone, sent by the browser on every request."""
    return request.headers.get("x-timezone")


async def _json(request: Request) -> dict:
    try:
        return (await request.json()) or {}
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")


@router.post("/goals/intake", dependencies=[Depends(llm_rate_limit)])
async def intake(request: Request, user: CurrentUser = Depends(require_user)) -> dict:
    body = await _json(request)
    message = str(body.get("message") or "").strip()[:MESSAGE_MAX_CHARS]
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    try:
        state = IntakeState.model_validate(body["state"]) if body.get("state") else None
    except ValidationError:
        raise HTTPException(status_code=400, detail="state is not valid")

    step = await intake_turn(state, message, tz=_tz(request))
    if step.error:
        raise HTTPException(status_code=503, detail=step.error)
    return {
        "kind": "draft" if step.draft else "question",
        "question": step.question,
        "options": step.options,
        "draft": step.draft.model_dump() if step.draft else None,
        "state": step.state.model_dump(),
    }


async def _goal_for_confirm_id(
    session: AsyncSession, *, user_id: str, confirm_id: str
) -> str | None:
    """The goal an earlier request with this `confirm_id` created, or None."""
    payloads = (
        await session.execute(
            select(AuditEntry.payload).where(
                AuditEntry.user_id == user_id,
                AuditEntry.type == AUDIT_INTAKE_CONFIRM,
                AuditEntry.payload["confirm_id"].astext == confirm_id,
            )
        )
    ).scalars().all()
    return goal_created_by_confirm(payloads)


@router.post("/goals/intake/confirm", status_code=201, dependencies=[Depends(llm_rate_limit)])
async def confirm(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Create the goal a draft describes, once per `confirm_id`.

    The client sends a `confirm_id` generated once per proposal. A retry (a double tap, a resend after
    a dropped reply) finds the goal that id already created and returns it instead of making a second
    one. The id lives in the audit row's payload, so no migration is needed.
    """
    body = await _json(request)
    confirm_id = normalize_confirm_id(body.get("confirm_id"))
    if confirm_id:
        existing = await _goal_for_confirm_id(session, user_id=user.user_id, confirm_id=confirm_id)
        if existing:
            log.info("intake confirm %s already created goal %s", confirm_id, existing)
            return {
                "goal_id": existing,
                "plan": {"status": "applied", "applied": 0, "proposed": 0,
                         "notes": [ALREADY_CREATED_NOTE]},
            }

    try:
        draft = GoalDraft.model_validate(body.get("draft") or {})
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"draft is not valid: {e.errors()[0]['loc']}")

    now = local_now(_tz(request))
    created = await create_goal(SqlStore(session, user.user_id, today=now.date()), draft, now=now)
    if created.plan.status != "applied":
        await session.rollback()
        raise HTTPException(status_code=422, detail="Couldn't plan this goal safely.")
    if confirm_id:
        await repo.write_audit(
            session,
            user_id=user.user_id,
            type=AUDIT_INTAKE_CONFIRM,
            summary=f"Created goal '{draft.title}' (intake confirm)",
            payload={"confirm_id": confirm_id, "goal_id": created.goal_id},
        )
    await session.commit()
    return {
        "goal_id": created.goal_id,
        "plan": {"status": created.plan.status, "applied": created.plan.applied,
                 "proposed": created.plan.proposed, "notes": created.plan.notes},
    }


@router.post("/agent/tick", dependencies=[Depends(llm_rate_limit)])
async def tick_me(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Run the nightly tick for the caller: give day-level detail to plan weeks that came into the window.

    A scheduler calls this once a night per user (`scripts/agent_tick.py`); it is also safe to call by hand,
    because a week that already has days is skipped."""
    from agentv2 import tick

    now = local_now(_tz(request))
    # One build per goal: a goal whose schedule is being rebuilt right now (a plan change, a second
    # tab) must not be re-planned by the tick as well. Its rows stay out of the tick's context.
    live = await live_builds(session, user_id=user.user_id, now=now)
    if live:
        log.info(
            "tick skipped goals with a live build for %s: %s",
            user.user_id, ", ".join(sorted(live)),
        )
    out = await tick(
        guarded(SqlStore(session, user.user_id, today=now.date()), live), now=now
    )
    if out.status != "applied":
        await session.rollback()
        raise HTTPException(status_code=422, detail="Couldn't update the plan safely.")
    await session.commit()
    return {"status": out.status, "applied": out.applied, "notes": out.notes}


@router.get("/agent/progress")
async def progress(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Per active goal: the numbers (computed by code, always fresh) and the model's verdict on them when
    one is current. `stale: true` means the numbers moved since the verdict; `POST /agent/progress/judge`
    makes it fresh."""
    now = local_now(_tz(request))
    return {"goals": await progress_payload(session, user.user_id, now.date(), judge=False)}


@router.post("/agent/progress/judge", dependencies=[Depends(llm_rate_limit)])
async def judge_progress(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Ask the model to judge every goal whose verdict is stale, then return the same payload."""
    now = local_now(_tz(request))
    goals = await progress_payload(session, user.user_id, now.date(), judge=True)
    await session.commit()
    return {"goals": goals}


@router.get("/recurring")
async def list_recurring(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """The user's repeating commitments that have not ended."""
    from datetime import date

    from sqlalchemy import select

    from ..models import RecurringBlock

    rows = (await session.execute(select(RecurringBlock).where(
        RecurringBlock.user_id == user.user_id,
        (RecurringBlock.end_date.is_(None)) | (RecurringBlock.end_date >= date.today())))).scalars().all()
    return {"recurring": [
        {"id": r.id, "title": r.title, "weekdays": r.weekdays, "start_time": r.start_time.strftime("%H:%M"),
         "end_time": r.end_time.strftime("%H:%M"), "start_date": r.start_date.isoformat(),
         "end_date": r.end_date.isoformat() if r.end_date else None}
        for r in rows
    ]}


@router.post("/recurring/{rule_id}/stop")
async def stop_recurring(
    rule_id: str,
    request: Request,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Stop a repeating commitment from a day on (default today). What is before that day is kept."""
    from datetime import date

    from agentv2 import ChangeSet, Origin, apply_changes
    from agentv2.contracts import StopRecurring

    body = await _json(request) if request.headers.get("content-length", "0") != "0" else {}
    try:
        from_date = date.fromisoformat(str(body.get("from_date"))[:10]) if body.get("from_date") else local_now(_tz(request)).date()
    except ValueError:
        raise HTTPException(status_code=400, detail="from_date must be YYYY-MM-DD")
    store = SqlStore(session, user.user_id, today=local_now(_tz(request)).date())
    res = await apply_changes(store, ChangeSet(origin=Origin(source="manual", ref=rule_id), changes=[StopRecurring(rule_id=rule_id, from_date=from_date)]))
    if hasattr(res, "violations"):
        raise HTTPException(status_code=404, detail="That repeating commitment isn't active.")
    await session.commit()
    return {"ok": True, "from_date": from_date.isoformat()}
