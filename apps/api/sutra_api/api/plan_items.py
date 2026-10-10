"""Plan items — the rows of the schedule of record.

Only two things a caller may do, and both are narrow on purpose: **add a
user-owned daily task**, and **tick it**. Everything else on this table is
written by the solver, where a plan is replaced whole rather than patched.

Three v1 asymmetries are kept; `CONTRACT-RECONCILIATION.md` #37-40:

* `POST` returns **200**, not 201, and wraps the row in `{"plan_item": ...}`.
* `PATCH` — the same resource — also wraps, which is the opposite of what the
  spec says.
* The `POST` row **omits `created_at`**; the `PATCH` row includes it.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import PLAN_ITEM_STATUSES
from ..store import repo, staleness
from ..wire import plan_item

router = APIRouter(tags=["plan-items"])


def _as_date(v: object) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {v!r}")


async def _record_plan_item_change(
    session: AsyncSession, *, user_id: str, goal_id: str | None, summary: str
) -> None:
    """Record the staleness change, but only for a goal-owned item.

    A user's own daily task with no goal has no goal to make stale. v1 recorded
    one anyway, passing the action string where the `goal_id` belonged, which is
    how that family of bugs went unnoticed.
    """
    if not goal_id:
        return
    horizons, milestone_moved = radius_for("plan_item.edit")
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal_id,
        kind="plan_item",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=summary,
    )


@router.post("/plan-items")
async def create_plan_item(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Add a user-owned daily task.

    `due_date` is required, and `horizon` is forced to `daily`: this endpoint
    creates a task on a day, not a scheduled span. A caller cannot use it to
    invent a monthly row — that is the solver's output, and letting a client
    write one would put an unscheduled row in the lattice.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    due = _as_date(body.get("due_date"))
    if due is None:
        raise HTTPException(status_code=400, detail="due_date is required")

    goal_id = body.get("goal_id") or None
    if goal_id:
        goal = await repo.get_goal(session, user_id=user.user_id, goal_id=goal_id)
        if goal is None:
            raise HTTPException(status_code=404, detail="Goal not found")

    item = await repo.create_user_plan_item(
        session,
        user_id=user.user_id,
        title=title,
        due_date=due,
        goal_id=goal_id,
        note=str(body.get("note") or ""),
    )
    await _record_plan_item_change(
        session,
        user_id=user.user_id,
        goal_id=goal_id,
        summary=f"Added task '{item.title}'",
    )
    await session.commit()
    return {"plan_item": plan_item(item, with_created_at=False)}


@router.patch("/plan-items/{id}")
async def update_plan_item(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Tick a task open or done. **Only `status` is editable.**

    Not a general patch: the title, the note and the dates of a solver-written
    row are the plan, and a client editing them would desynchronise the row from
    the placement that produced it.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    unknown = set(body) - {"status"}
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown fields: {', '.join(sorted(unknown))}",
        )

    item = await repo.get_plan_item(session, user_id=user.user_id, item_id=id)
    if item is None:
        raise HTTPException(status_code=404, detail="Plan item not found")

    if "status" in body:
        status = str(body["status"])
        if status not in PLAN_ITEM_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"status must be one of {', '.join(PLAN_ITEM_STATUSES)}",
            )
        item.status = status
        await _record_plan_item_change(
            session,
            user_id=user.user_id,
            goal_id=item.goal_id,
            summary=(
                "Completed a task" if status == "done" else "Reopened a task"
            ),
        )
    await session.commit()
    return {"plan_item": plan_item(item)}
