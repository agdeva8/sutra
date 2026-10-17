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
from ..ids import new_id
from ..models import Conversation
from ..store import chat as chat_store
from ..store import repo
from ..store.executor import ExecResult, _as_date, apply_proposal, ledger_args
from .chat import KIND_ADD_GOAL
from ..core.replan_after_confirm import needs_replan

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


def _with_milestone_dates(rows: list, *, fallback_target=None) -> dict[str, dict]:
    """Each proposal's args, with undated milestones given a date.

    The goal's deadline is set by the model, but milestones often arrive with no date at all, which left the
    Timeline empty and nothing ever overdue. Code owns dates: milestones with none are spread evenly between
    today and the goal's deadline, in the order proposed. Milestones that already have a date keep it.

    `fallback_target` is the goal's existing deadline, for an edit whose `update_goal` does not restate it.
    """
    args = {r.id: dict(r.args or {}) for r in rows}
    goal = next((r for r in rows if r.action == BATCH_FIRST_ACTION), None)
    target = _as_date((goal.args or {}).get("target_date")) if goal else None
    if target is None:
        target = fallback_target
    if goal is not None:
        args[goal.id]["target_date"] = target.isoformat() if target else args[goal.id].get("target_date")
    undated = [r for r in rows if r.action == "add_milestone" and not _as_date(args[r.id].get("target_date"))]
    today = datetime.now(UTC).date()
    if target and target > today and undated:
        span = (target - today).days
        for i, r in enumerate(undated, start=1):
            args[r.id]["target_date"] = (today + timedelta(days=round(span * i / len(undated)))).isoformat()
    return args


def _milestone_inputs(rows: list, dated: dict[str, dict]) -> list:
    """The proposed milestone set as gateway inputs, with parent titles resolved inside the set.

    Ids are minted here because a milestone proposal carries none: the set replaces the old open
    rows, so a fresh id is the honest identity for a checkpoint the user has just redefined. A
    sub-milestone names its facet by title, and the facet is in the same set, so the title maps to
    the id minted for it; an unknown title leaves it a facet itself, as `add_milestone` does.
    """
    from agentv2.contracts import MilestoneInput

    made: list[tuple[dict, MilestoneInput]] = []
    by_title: dict[str, str] = {}
    for row in rows:
        args = dated[row.id]
        title = str(args.get("title") or "").strip()
        if not title:
            continue
        milestone_id = new_id("mile")
        by_title.setdefault(title.casefold(), milestone_id)
        made.append((args, MilestoneInput(
            id=milestone_id,
            title=title,
            target_date=_as_date(args.get("target_date")),
            hours=float(args.get("hours") or 0),
        )))
    for args, item in made:
        parent_title = str(args.get("parent") or "").strip()
        if parent_title:
            item.parent_id = by_title.get(parent_title.casefold())
    return [item for _args, item in made]


def _edit_batch_goal_id(rows: list, conversation) -> str | None:
    """The goal an edit batch revises, or `None` when this is an ordinary add batch.

    An edit is recognised by the conversation, not by the action names alone: it continues the
    goal's Add-goal thread and carries an `update_goal` next to the re-proposed milestones. Keying
    on `update_goal` alone would let any chat turn that updates a goal and adds a milestone wipe the
    goal's other open milestones, which is not what an additive `add_milestone` has ever meant.
    """
    if conversation is None or conversation.kind != KIND_ADD_GOAL:
        return None
    if not any(r.action == "add_milestone" for r in rows):
        return None
    update = next((r for r in rows if r.action == "update_goal"), None)
    if update is None or (update.args or {}).get("status") in ("dropped", "paused"):
        return None
    return conversation.goal_id or str((update.args or {}).get("goal_id") or "") or None


async def _replace_milestones(
    session: AsyncSession, *, user_id: str, goal_id: str, rows: list
) -> ExecResult:
    """Apply the edit's whole open milestone set through the gateway, in this transaction.

    The old open set is read first: it is what the replacement retires, and carrying it on the
    change is what lets undo restore it. Done milestones are never in `before` and are never
    removed — `ReplaceMilestones` keeps them in the store.
    """
    from agentv2 import ChangeSet, Origin, apply_changes
    from agentv2.contracts import MilestoneInput, ReplaceMilestones

    from ..agent_store import SqlStore

    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    if goal is None:
        return ExecResult(False, "That goal no longer exists.")

    existing = [
        m for m in await repo.list_milestones(session, user_id=user_id)
        if m.goal_id == goal_id and m.status != "done"
    ]
    dated = _with_milestone_dates(rows, fallback_target=goal.target_date)
    change = ReplaceMilestones(
        goal_id=goal_id,
        milestones=_milestone_inputs(rows, dated),
        before=[
            MilestoneInput(
                id=m.id, title=m.title, target_date=m.target_date,
                parent_id=m.parent_id, hours=m.hours or 0,
            )
            for m in existing
        ],
    )
    res = await apply_changes(
        SqlStore(session, user_id, today=datetime.now(UTC).date()),
        ChangeSet(origin=Origin(source="chat", ref=goal_id), changes=[change]),
        approved=True,
    )
    if hasattr(res, "violations"):
        return ExecResult(False, "That plan no longer fits: " + "; ".join(v.message for v in res.violations))
    return ExecResult(True, f"Re-planned '{goal.title}': {len(change.milestones)} milestones", goal_id)


async def _link_goal_to_conversation(
    session: AsyncSession, *, user_id: str, proposal, goal_id: str | None
) -> None:
    """Write the new goal's id on the conversation that proposed it.

    That link is how the Edit-goal flow finds the conversation again: without it the thread that
    holds the plan's history is only reachable by guessing a deterministic bucket id.
    """
    if not goal_id or not proposal.conversation_id:
        return
    conversation = await session.get(Conversation, proposal.conversation_id)
    if conversation is not None and conversation.user_id == user_id and not conversation.goal_id:
        conversation.goal_id = goal_id


async def _replan_after_confirm(session: AsyncSession, *, user_id: str, goal_id: str) -> bool:
    """Re-plan the goal's sessions now that a confirmed change moved what they were planned around.

    Runs in the same request, behind the same lease as `/plan/change`: when a build is already in
    flight nothing starts, because two writers over the same rows would race. A failure does not
    fail the confirm — the change is committed and the goal's `plan_status` says `failed`, which is
    the signal the client polls. Returns whether a build ran.
    """
    from agentv2 import local_now, replan_goal

    from ..agent_store import SqlStore
    from ..models import PLAN_FAILED, PLAN_PLANNING, PLAN_READY
    from .plan import _set_plan_status, build_in_flight

    now = local_now()
    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    if goal is None or goal.status != "active":
        return False
    if build_in_flight(goal.plan_status, goal.plan_started_at, now):
        return False
    await _set_plan_status(session, goal, PLAN_PLANNING)
    try:
        out = await replan_goal(SqlStore(session, user_id, today=now.date()), goal_id, now=now)
    except Exception:
        await session.rollback()
        await _set_plan_status(session, goal, PLAN_FAILED)
        return False
    if out.status != "applied":
        await session.rollback()
        await _set_plan_status(session, goal, PLAN_FAILED)
        return False
    goal.plan_status = PLAN_READY
    await session.commit()
    return True


async def _confirm_batch(session: AsyncSession, *, user_id: str, proposal_ids: list) -> dict:
    """Apply several proposals as one transaction: all of them, or none.

    The client used to POST once per proposal (a goal plus six milestones was seven requests, ~40s, and a
    failure on the fifth left a half-made goal). Here a failure rolls everything back and every proposal
    stays pending so the user can retry the whole plan.

    An **edit batch** — the goal update and the whole re-proposed milestone set from the Edit-goal
    thread — is applied as `update_goal` followed by one `ReplaceMilestones`, so the goal's open
    milestones are replaced rather than appended to. The goal's sessions are then re-planned after
    the commit, in this request.
    """
    ids = [i for i in proposal_ids if isinstance(i, str) and i]
    if not ids or len(ids) != len(proposal_ids) or len(set(ids)) != len(ids) or len(ids) > MAX_BATCH_PROPOSALS:
        raise HTTPException(status_code=400, detail="proposal_ids must be a list of 1-50 distinct ids")

    rows = [await _load_pending(session, user_id=user_id, body={"proposal_id": i}) for i in ids]
    rows.sort(key=lambda r: r.action != BATCH_FIRST_ACTION)  # stable: keeps the client's order otherwise

    conversation = (
        await session.get(Conversation, rows[0].conversation_id)
        if rows and rows[0].conversation_id else None
    )
    edit_goal_id = _edit_batch_goal_id(rows, conversation)

    dated = _with_milestone_dates(rows)
    results: list[str] = []
    replan_goal_id: str | None = None
    handled: set[str] = set()

    if edit_goal_id:
        update = next(r for r in rows if r.action == "update_goal")
        # The goal id is known here even when the model restated it loosely (or only the conversation
        # identified the goal); the executor resolves the goal from its args, so make it explicit.
        update_args = dict(dated[update.id])
        update_args.setdefault("goal_id", edit_goal_id)
        outcome = await apply_proposal(session, user_id=user_id, action=update.action, args=update_args)
        if not outcome.success:
            await session.rollback()
            return _refused(outcome.result)
        goal_id = outcome.goal_id or edit_goal_id
        milestone_rows = [r for r in rows if r.action == "add_milestone"]
        replaced = await _replace_milestones(
            session, user_id=user_id, goal_id=goal_id, rows=milestone_rows
        )
        if not replaced.success:
            await session.rollback()
            return _refused(replaced.result)
        for row, line in [(update, outcome.result), *((m, replaced.result) for m in milestone_rows)]:
            flipped = await chat_store.mark_proposal_resolved(
                session, user_id=user_id, proposal_id=row.id, status="confirmed", result=line
            )
            if not flipped:
                await session.rollback()
                raise HTTPException(status_code=409, detail="Proposal already resolved")
            handled.add(row.id)
        await repo.write_audit(
            session,
            user_id=user_id,
            type="confirm:update_goal",
            summary=outcome.result,
            payload={"proposal_id": update.id, "args": ledger_args(update.args)},
        )
        results += [outcome.result, replaced.result]
        replan_goal_id = goal_id

    for row in rows:
        if row.id in handled:
            continue
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
        if row.action == BATCH_FIRST_ACTION:
            await _link_goal_to_conversation(
                session, user_id=user_id, proposal=row, goal_id=outcome.goal_id
            )
        results.append(outcome.result)
        if outcome.goal_id and needs_replan(row.action, row.args):
            replan_goal_id = outcome.goal_id
    await session.commit()

    replanned = bool(
        replan_goal_id
        and await _replan_after_confirm(session, user_id=user_id, goal_id=replan_goal_id)
    )
    state = await assemble_state(session, user_id=user_id)
    return {
        "ok": True, "result": "; ".join(results), "results": results,
        "confirmed": ids, "replanned": replanned, "state": state,
    }


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
    if proposal.action == BATCH_FIRST_ACTION:
        await _link_goal_to_conversation(
            session, user_id=user.user_id, proposal=proposal, goal_id=outcome.goal_id
        )
    await session.commit()

    replanned = bool(
        outcome.goal_id
        and needs_replan(proposal.action, proposal.args)
        and await _replan_after_confirm(session, user_id=user.user_id, goal_id=outcome.goal_id)
    )
    state = await assemble_state(session, user_id=user.user_id)
    return {"ok": True, "result": outcome.result, "replanned": replanned, "state": state}


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
