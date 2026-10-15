"""Confirming and rejecting a pending proposal.

The HITL confirm half (HLD §10). Four things about this module are
load-bearing, and all four come from `CONTRACT-RECONCILIATION.md` §4:

1. **The body is `{proposal_id}`.** The spec says `{proposal, refId}`; the client
   sends ids, and v1 tolerated `message_id`/`proposal_title` as no-ops. Accepting
   the spec's shape would mean re-validating a proposal the client had already
   been given, which is a second source of truth for the action.

2. **Executor failure is 422, not 500** — and the proposal is left `pending`, so
   the user can fix their input and retry. A 500 would tell them the server
   broke, when in fact their request was refused.

3. **409 when the proposal is already resolved.** The status flip is an
   `UPDATE … WHERE status = 'pending'`; when it matches zero rows, someone else
   won the race. That guard is what makes a double-click, or a retried request,
   apply exactly once.

4. **Reject always answers 200 `{ok: true}`**, even when it lost the race, and
   carries **no state**. The user asked for the proposal to go away, and it has;
   nothing changed, so there is nothing to re-render.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..dashboard import assemble_state
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..store import chat as chat_store
from ..store import repo
from ..store.executor import ExecResult, _as_date, apply_proposal, ledger_args

router = APIRouter(tags=["tools"])


async def _load_pending(
    session: AsyncSession, *, user_id: str, body: dict
):
    """Fetch the proposal and check it is this user's and still actionable.

    The three failures are distinguished on purpose: a client that sees only
    "404" for all of them cannot tell a stale id from a foreign one, and the
    difference matters when the user is looking at a card that will not confirm.
    """
    proposal_id = body.get("proposal_id")
    if not proposal_id or not isinstance(proposal_id, str):
        raise HTTPException(status_code=400, detail="Missing proposal_id")

    row = await chat_store.get_proposal(session, user_id=user_id, proposal_id=proposal_id)
    # Scoped by user in the query, so a foreign proposal is indistinguishable
    # from a missing one — which is the point: a 403 would confirm the id exists.
    if row is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail="Proposal already resolved")
    return row


async def _apply_gateway_proposal(session: AsyncSession, *, user_id: str, proposal) -> ExecResult:
    """A proposal raised by agentv2's gateway (it carries the change itself): apply it, now that the
    user has confirmed. Validation still runs, so a change that went stale is refused, not forced."""
    from agentv2 import ChangeSet, Origin, apply_changes, local_now
    from agentv2.contracts import Change
    from pydantic import TypeAdapter

    from ..agent_store import SqlStore

    change = TypeAdapter(Change).validate_python(proposal.args["change"])
    now = local_now()
    res = await apply_changes(
        SqlStore(session, user_id, today=now.date()),
        ChangeSet(origin=Origin(source="manual", ref=proposal.id), changes=[change]),
        approved=True,
    )
    if hasattr(res, "violations"):
        return ExecResult(False, "That change no longer fits: " + "; ".join(v.message for v in res.violations))
    return ExecResult(True, "Done.")


#: Applied first in a batch: milestones attach to the goal by title, so the goal must exist before them.
BATCH_FIRST_ACTION = "create_goal"
#: A plan is a goal plus a handful of milestones; this bounds a malicious or buggy client, not a real plan.
MAX_BATCH_PROPOSALS = 50


def _with_milestone_dates(rows: list) -> dict[str, dict]:
    """Each proposal's args, with undated milestones given a date.

    The goal's deadline is set by the model, but milestones often arrive with no date at all, which left the
    Timeline empty and nothing ever overdue. Code owns dates: milestones with none are spread evenly between
    today and the goal's deadline, in the order proposed. Milestones that already have a date keep it.
    """
    args = {r.id: dict(r.args or {}) for r in rows}
    goal = next((r for r in rows if r.action == BATCH_FIRST_ACTION), None)
    target = _as_date((goal.args or {}).get("target_date")) if goal else None
    if goal is not None:
        args[goal.id]["target_date"] = target.isoformat() if target else args[goal.id].get("target_date")
    undated = [r for r in rows if r.action == "add_milestone" and not _as_date(args[r.id].get("target_date"))]
    today = datetime.now(UTC).date()
    if target and target > today and undated:
        span = (target - today).days
        for i, r in enumerate(undated, start=1):
            args[r.id]["target_date"] = (today + timedelta(days=round(span * i / len(undated)))).isoformat()
    return args


async def _confirm_batch(session: AsyncSession, *, user_id: str, proposal_ids: list) -> dict:
    """Apply several proposals as one transaction: all of them, or none.

    The client used to POST once per proposal (a goal plus six milestones was seven requests, ~40s, and a
    failure on the fifth left a half-made goal). Here a failure rolls everything back and every proposal
    stays pending so the user can retry the whole plan.
    """
    ids = [i for i in proposal_ids if isinstance(i, str) and i]
    if not ids or len(ids) != len(proposal_ids) or len(set(ids)) != len(ids) or len(ids) > MAX_BATCH_PROPOSALS:
        raise HTTPException(status_code=400, detail="proposal_ids must be a list of 1-50 distinct ids")

    rows = [await _load_pending(session, user_id=user_id, body={"proposal_id": i}) for i in ids]
    rows.sort(key=lambda r: r.action != BATCH_FIRST_ACTION)  # stable: keeps the client's order otherwise

    dated = _with_milestone_dates(rows)
    results: list[str] = []
    for row in rows:
        if "change" in (row.args or {}):
            outcome = await _apply_gateway_proposal(session, user_id=user_id, proposal=row)
        else:
            outcome = await apply_proposal(session, user_id=user_id, action=row.action, args=dated[row.id])
        if not outcome.success:
            await session.rollback()
            return _refused(outcome.result)
        flipped = await chat_store.mark_proposal_resolved(
            session, user_id=user_id, proposal_id=row.id, status="confirmed", result=outcome.result
        )
        if not flipped:
            await session.rollback()
            raise HTTPException(status_code=409, detail="Proposal already resolved")
        await repo.write_audit(
            session,
            user_id=user_id,
            type=f"confirm:{row.action}",
            summary=outcome.result,
            payload={"proposal_id": row.id, "args": ledger_args(row.args)},
        )
        results.append(outcome.result)
    await session.commit()

    state = await assemble_state(session, user_id=user_id)
    return {"ok": True, "result": "; ".join(results), "results": results, "confirmed": ids, "state": state}


@router.post("/tools/confirm")
async def confirm(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Apply a proposal, then hand back the fresh board.

    The `state` in the response is why the client needs no second call after a
    confirm — which matters, because the alternative is a round trip whose result
    the user is already waiting to see.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    if "proposal_ids" in body:
        if not isinstance(body["proposal_ids"], list):
            raise HTTPException(status_code=400, detail="proposal_ids must be a list")
        return await _confirm_batch(session, user_id=user.user_id, proposal_ids=body["proposal_ids"])

    proposal = await _load_pending(session, user_id=user.user_id, body=body)

    if "change" in (proposal.args or {}):
        outcome = await _apply_gateway_proposal(session, user_id=user.user_id, proposal=proposal)
    else:
        outcome = await apply_proposal(
            session, user_id=user.user_id, action=proposal.action, args=proposal.args or {}
        )

    if not outcome.success:
        # Roll back any partial work, and *keep the proposal pending* so the
        # user can retry with a better input.
        await session.rollback()
        return _refused(outcome.result)

    # The guard: only flip if it is still pending. Zero rows means a concurrent
    # confirm already applied it, and applying it twice is exactly the bug this
    # design exists to prevent.
    flipped = await chat_store.mark_proposal_resolved(
        session,
        user_id=user.user_id,
        proposal_id=proposal.id,
        status="confirmed",
        result=outcome.result,
    )
    if not flipped:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Proposal already resolved")

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type=f"confirm:{proposal.action}",
        summary=outcome.result,
        payload={"proposal_id": proposal.id, "args": ledger_args(proposal.args)},
    )
    await session.commit()

    state = await assemble_state(session, user_id=user.user_id)
    return {"ok": True, "result": outcome.result, "state": state}


@router.post("/tools/reject")
async def reject(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Decline a proposal. `reason` is optional and only recorded.

    No `state`: a rejection changes nothing, so a snapshot would be a whole
    dashboard assembled to say "unchanged".
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    proposal = await _load_pending(session, user_id=user.user_id, body=body)

    reason = body.get("reason")
    reason = reason.strip() if isinstance(reason, str) and reason.strip() else None

    flipped = await chat_store.mark_proposal_resolved(
        session,
        user_id=user.user_id,
        proposal_id=proposal.id,
        status="rejected",
        result=None,
    )
    if flipped:
        await repo.write_audit(
            session,
            user_id=user.user_id,
            type=f"reject:{proposal.action}",
            summary=(
                f"User rejected: {proposal.action} ({reason})"
                if reason
                else f"User rejected: {proposal.action}"
            ),
            payload={
                "proposal_id": proposal.id,
                "args": ledger_args(proposal.args),
                "reason": reason,
            },
        )
    await session.commit()
    return {"ok": True}


def _refused(result: str):
    """The 422 body. Shaped like success minus `state`, so the client's success
    path can read `result` without branching on the shape."""
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=422, content={"ok": False, "result": result})
