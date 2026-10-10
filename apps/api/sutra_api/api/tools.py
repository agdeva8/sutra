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

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..dashboard import assemble_state
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..store import repo
from ..store.executor import apply_proposal, ledger_args

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

    row = await repo.get_proposal(session, user_id=user_id, proposal_id=proposal_id)
    # Scoped by user in the query, so a foreign proposal is indistinguishable
    # from a missing one — which is the point: a 403 would confirm the id exists.
    if row is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail="Proposal already resolved")
    return row


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

    proposal = await _load_pending(session, user_id=user.user_id, body=body)

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
    flipped = await repo.mark_proposal_resolved(
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

    flipped = await repo.mark_proposal_resolved(
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
