"""Goals and milestones.

**A union of two disjoint sets.** The spec declares `GET /goals` and
`GET /goals/{id}`; v1 implemented `POST`, `PATCH` and `DELETE` and had no reads
at all. Neither alone is the whole surface, so both are here. See
`CONTRACT-RECONCILIATION.md` #34.

Worth knowing before reading: **the frontend calls only two of these.** `DELETE /goals/{id}`
(and its `GET /goals/{id}/drop-impact` preview) are the direct, chat-free abandon path the drop
confirm dialog uses. Every other goal and milestone write reaches the database through the chat
confirm flow, via the executor — `api.js` has no `updateGoal`, and `GoalActionsMenu.jsx` says so in
a comment. Those routes exist because the contract declares them and because the executor's
behaviour is worth having an HTTP spelling of, not because a screen calls them.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import GOAL_HORIZONS, GOAL_STATUSES, CalendarBlock
from ..store import goal_drop, repo, staleness
from ..wire import goal_row, milestone_row

router = APIRouter(tags=["goals"])

#: `.strict()` on v1's PATCH, so these are the only keys accepted. An unknown key
#: is a 400 rather than a silent no-op — a client typo that "succeeds" is worse
#: than one that fails.
_GOAL_PATCHABLE = {
    "title",
    "why",
    "next_action",
    "horizon",
    "status",
    "start_date",
    "target_date",
    "weekly_hours",
    "life_area",
}


def _as_date(v: object) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {v!r}")


@router.get("/goals")
async def list_goals(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> list[dict]:
    """All goals, bare. Declared by the spec; v1 had no read here."""
    rows = await repo.list_goals(session, user_id=user.user_id)
    return [goal_row(g) for g in rows]


@router.get("/goals/{id}")
async def get_goal(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = await repo.get_goal(session, user_id=user.user_id, goal_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    return goal_row(row)


@router.post("/goals", status_code=201)
async def create_goal(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Create a goal. **201**, and the created row — not a wrapper."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    title = str((body or {}).get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    horizon = str((body or {}).get("horizon") or "").strip()
    if horizon not in GOAL_HORIZONS:
        raise HTTPException(
            status_code=400,
            detail=f"horizon must be one of {', '.join(GOAL_HORIZONS)}",
        )

    goal = await repo.create_goal(
        session,
        user_id=user.user_id,
        title=title,
        horizon=horizon,
        why=str(body.get("why") or ""),
        next_action=str(body.get("next_action") or ""),
        start_date=_as_date(body.get("start_date")),
        target_date=_as_date(body.get("target_date")),
        weekly_hours=body.get("weekly_hours"),
    )

    horizons, milestone_moved = radius_for("goal.create")
    await staleness.record_change(
        session,
        user_id=user.user_id,
        goal_id=goal.id,
        kind="goal_scope",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=f"Created goal '{goal.title}'",
    )

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="create:goal",
        summary=f"Created goal '{goal.title}' ({goal.horizon})",
        payload={
            "goal_id": goal.id,
            "title": goal.title,
            "horizon": goal.horizon,
        },
    )
    await session.commit()
    return goal_row(goal)


@router.patch("/goals/{id}")
async def update_goal(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Patch a goal. `status: "dropped"` routes to the full cascade.

    That routing is deliberate: the client has one way to abandon a goal, and it
    should not have to know whether the cascade is a separate endpoint.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    unknown = set(body) - _GOAL_PATCHABLE
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unknown fields: {', '.join(sorted(unknown))}"
        )
    if not body:
        raise HTTPException(status_code=400, detail="No fields to update")

    goal = await repo.get_goal(session, user_id=user.user_id, goal_id=id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")

    if body.get("status") == "dropped":
        # Other fields in the same body are superseded — a drop is not a patch.
        ref = goal_drop.GoalRef(goal_id=goal.id, goal_title=goal.title)
        await goal_drop.apply_goal_drop_cascade(
            session, user_id=user.user_id, ref=ref, audit_type="drop:goal"
        )
        await session.commit()
        refreshed = await repo.get_goal(session, user_id=user.user_id, goal_id=id)
        return {"goal": goal_row(refreshed)}

    if "status" in body and body["status"] not in GOAL_STATUSES:
        raise HTTPException(
            status_code=400, detail=f"status must be one of {', '.join(GOAL_STATUSES)}"
        )
    if "horizon" in body and body["horizon"] not in GOAL_HORIZONS:
        raise HTTPException(
            status_code=400, detail=f"horizon must be one of {', '.join(GOAL_HORIZONS)}"
        )

    freed: float | None = None
    if body.get("status") == "paused" and goal.status == "active":
        freed = float(goal.weekly_hours) if goal.weekly_hours else None

    patch = dict(body)
    for key in ("start_date", "target_date"):
        if key in patch:
            patch[key] = _as_date(patch[key])
    await repo.update_goal(session, goal=goal, **patch)

    # `goal.dates` if the timeline moved, else `goal.edit` — they escalate
    # differently, and the dates one always escalates.
    moved_dates = "target_date" in body or "start_date" in body
    action = "goal.dates" if moved_dates else "goal.edit"
    horizons, milestone_moved = radius_for(action)
    await staleness.record_change(
        session,
        user_id=user.user_id,
        goal_id=goal.id,
        kind="goal_dates" if moved_dates else "goal_scope",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=f"Updated goal '{goal.title}'",
        detail={"freed_weekly_hours": freed} if freed else None,
    )

    label = {"dropped": "Dropped", "paused": "Paused"}.get(
        body.get("status", ""), "Updated"
    )
    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="update:goal",
        summary=f"{label} goal '{goal.title}'",
        payload={
            "goal_id": goal.id,
            "goal_title": goal.title,
            "freed_weekly_hours": freed,
            "fields": {k: str(v) for k, v in body.items()},
        },
    )
    await session.commit()
    return {"goal": goal_row(goal)}


@router.get("/goals/{id}/drop-impact")
async def goal_drop_impact(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Price a drop **before** it happens. Read-only; writes nothing.

    The confirm dialog needs to name the milestones and sessions that would go and
    the hours that would come back, and it needs those numbers *before* the user
    commits — this is `compute_goal_drop_impact` and its sentence, which the
    cascade itself uses, so the preview and the result can never disagree.

    `drop_impact_sentence` is ported verbatim from v1 and is shown to the user; a
    re-worded one is a silent product change, which is why the route returns the
    cascade's own string rather than letting the client compose one.
    """
    goal = await repo.get_goal(session, user_id=user.user_id, goal_id=id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")

    ref = goal_drop.GoalRef(goal_id=goal.id, goal_title=goal.title)
    impact = await goal_drop.compute_goal_drop_impact(
        session, user_id=user.user_id, ref=ref
    )
    return {
        "impact": impact.as_wire(),
        "sentence": goal_drop.drop_impact_sentence(impact),
    }


@router.delete("/goals/{id}")
async def delete_goal(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Soft-drop. Goals are never hard-deleted — the ledger references them."""
    goal = await repo.get_goal(session, user_id=user.user_id, goal_id=id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")

    ref = goal_drop.GoalRef(goal_id=goal.id, goal_title=goal.title)
    await goal_drop.apply_goal_drop_cascade(
        session, user_id=user.user_id, ref=ref, audit_type="drop:goal"
    )
    horizons, milestone_moved = radius_for("goal.drop")
    await staleness.record_change(
        session,
        user_id=user.user_id,
        goal_id=goal.id,
        kind="goal_scope",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=f"Dropped goal '{goal.title}'",
    )
    await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Milestones
# ---------------------------------------------------------------------------


@router.get("/milestones")
async def list_milestones(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> list[dict]:
    """All milestones, bare. Declared by the spec; `/state` also carries them."""
    rows = await repo.list_milestones(session, user_id=user.user_id)
    return [milestone_row(m) for m in rows]


@router.patch("/milestones/{id}")
async def update_milestone(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Update a milestone.

    A milestone is an **outcome checkpoint** — a promise to the user — so moving
    one always escalates the replan tier, which is why this records
    `milestone.edit` regardless of which field changed.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    allowed = {"title", "target_date", "status", "goal_id"}
    unknown = set(body) - allowed
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unknown fields: {', '.join(sorted(unknown))}"
        )
    if not body:
        raise HTTPException(status_code=400, detail="No fields to update")

    ms = await repo.get_milestone(session, user_id=user.user_id, milestone_id=id)
    cal = await session.get(CalendarBlock, id)
    if cal is not None and cal.user_id != user.user_id:
        cal = None
    if cal is not None and cal.block_kind != "milestone":
        cal = None
    if ms is None and cal is None:
        raise HTTPException(status_code=404, detail="Milestone not found")

    goal_id = ms.goal_id if ms is not None else None
    title = ms.title if ms is not None else cal.title

    if ms is not None:
        if "title" in body:
            ms.title = str(body["title"]).strip()
            title = ms.title
        if "status" in body:
            ms.status = str(body["status"])
        if "target_date" in body:
            ms.target_date = _as_date(body["target_date"])
        if "goal_id" in body:
            new_goal_id = body["goal_id"]
            if new_goal_id:
                goal = await repo.get_goal(
                    session, user_id=user.user_id, goal_id=new_goal_id
                )
                if goal is None:
                    raise HTTPException(status_code=404, detail="Goal not found")
                ms.goal_id = goal.id
                ms.goal_title = goal.title
                goal_id = goal.id
            else:
                # Clearing the parent clears the denormalised title with it, so the
                # row cannot claim a goal it no longer belongs to.
                ms.goal_id = None
                ms.goal_title = ""
                goal_id = None

    # The backfill kept ids, so the same milestone can also live in `calendar_blocks`. Keep the
    # two copies agreeing; a row that exists only there is updated there.
    if cal is not None:
        from agentv2.contracts.blocks import BLOCK_ADAPTER
        blk = BLOCK_ADAPTER.validate_python(cal.data or {})
        if "title" in body:
            blk.title = str(body["title"]).strip()
            title = blk.title
        if "status" in body:
            blk.reached = str(body["status"]) == "done"
        if "target_date" in body and _as_date(body["target_date"]) is not None:
            blk.target_date = _as_date(body["target_date"])
        if "goal_id" in body:
            new_goal_id = body["goal_id"]
            if new_goal_id:
                goal = await repo.get_goal(
                    session, user_id=user.user_id, goal_id=new_goal_id
                )
                if goal is None:
                    raise HTTPException(status_code=404, detail="Goal not found")
                blk.goal_id = goal.id
                goal_id = goal.id
            else:
                blk.goal_id = ""
                goal_id = None
        cal.title = blk.title
        cal.data = blk.model_dump(mode="json")

    # Only a milestone that belongs to a goal can make that goal stale. One with
    # no parent — `goal_id` is `SET NULL`, so a milestone outlives its goal — has
    # nothing to mark, and recording a change against an empty `goal_id` would
    # violate the FK.
    if goal_id:
        horizons, milestone_moved = radius_for("milestone.edit")
        await staleness.record_change(
            session,
            user_id=user.user_id,
            goal_id=goal_id,
            kind="milestone",
            horizons_moved=horizons,
            milestone_moved=milestone_moved,
            summary=f"Updated milestone '{title}'",
        )

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="update:milestone",
        summary=f"Updated milestone '{title}'",
        payload={"milestone_id": id, "fields": list(body)},
    )
    await session.commit()
    if ms is not None:
        return {"milestone": milestone_row(ms)}
    view = repo.milestone_from_block(cal)
    return {"milestone": milestone_row(view)}
