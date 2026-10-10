"""Blockers — the dates a user cannot work.

**A hard constraint, not a preference.** The solver treats every date in the
range as zero capacity. That is why the routes here recompute drift best-effort
after every write: a new blocker can push a goal's milestones behind, and the
dashboard's `at_risk` chip is the only place that surfaces.

## The envelope

`GET` returns `{"blockers": [...]}`, not a bare array — v1's shape, and the
opposite of what the spec declares. The spec chose bare "to match `/audit`,
`/timetable` and `/sources`", but `/timetable` cannot be bare (see
`timetable.py`), so the rationale collapses. `TodayTimetable.jsx:40` tolerates
either via `Array.isArray`, so both would work — v1's shape wins because it is
what every other consumer was written against. See
`CONTRACT-RECONCILIATION.md` #41-42.

`POST` is **201**; `PUT` and `DELETE` are 200. v1's split, kept: create is a
create, and an update is not.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..store import drift as drift_store
from ..store import repo, staleness
from ..wire import blocker

router = APIRouter(tags=["blockers"])


def _require_date(v: object, field: str) -> date:
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400, detail=f"{field} must be YYYY-MM-DD"
        )


def _optional_date(v: object, field: str) -> date | None:
    if v is None or v == "":
        return None
    return _require_date(v, field)


async def _after_capacity_change(
    session: AsyncSession, *, user_id: str, goal_id: str | None, kind: str, summary: str
) -> None:
    """Drift recompute plus the staleness record, both inside the transaction.

    v1 recomputed drift here and relayed the staleness change fire-and-forget.
    Both are in the transaction now, so a committed blocker is a recorded one.
    """
    try:
        await drift_store.recompute_goal_drift(session, user_id=user_id)
    except Exception:
        # A drift failure is a missing chip, not a failed write.
        pass
    if goal_id:
        horizons, milestone_moved = radius_for(kind)
        await staleness.record_change(
            session,
            user_id=user_id,
            goal_id=goal_id,
            kind="blocker",
            horizons_moved=horizons,
            milestone_moved=milestone_moved,
            summary=summary,
            detail={"summary": summary},
        )


@router.get("/blockers")
async def list_blockers(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    rows = await repo.list_blockers(session, user_id=user.user_id)
    return {"blockers": [blocker(b) for b in rows]}


@router.post("/blockers", status_code=201)
async def create_blocker(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Add a blocker. `end_date` defaults to `start_date` — one day, not open-ended."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    start = _require_date(body.get("start_date"), "start_date")
    end = _optional_date(body.get("end_date"), "end_date")
    if end is not None and end < start:
        raise HTTPException(
            status_code=400, detail="end_date must not precede start_date"
        )

    row = await repo.create_blocker(
        session,
        user_id=user.user_id,
        title=title,
        start_date=start,
        end_date=end,
        note=str(body.get("note") or ""),
    )
    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="create:blocker",
        summary=f"Blocker '{row.title}' {row.start_date}..{row.end_date}",
        payload={"blocker_id": row.id, "title": row.title},
    )
    # Blockers are not goal-scoped, so there is no single `goal_id` to mark
    # stale — but every active goal's drift may have moved, which is what
    # `_after_capacity_change` recomputes.
    await _after_capacity_change(
        session,
        user_id=user.user_id,
        goal_id=None,
        kind="blocker.add",
        summary=f"Blocker '{row.title}'",
    )
    await session.commit()
    return blocker(row)


@router.put("/blockers/{id}")
async def update_blocker(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Full replace, not a patch: `title` and `start_date` are required."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    row = await repo.get_blocker(session, user_id=user.user_id, blocker_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Blocker not found")

    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    start = _require_date(body.get("start_date"), "start_date")
    end = _optional_date(body.get("end_date"), "end_date")

    row.title = title
    row.start_date = start
    row.end_date = end or start
    row.note = str(body.get("note") or "")

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="update:blocker",
        summary=f"Updated blocker '{row.title}'",
        payload={"blocker_id": row.id, "title": row.title},
    )
    await _after_capacity_change(
        session,
        user_id=user.user_id,
        goal_id=None,
        kind="blocker.edit",
        summary=f"Updated blocker '{row.title}'",
    )
    await session.commit()
    return {"blocker": blocker(row)}


@router.delete("/blockers/{id}")
async def delete_blocker(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = await repo.get_blocker(session, user_id=user.user_id, blocker_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Blocker not found")

    title = row.title
    await session.delete(row)
    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="delete:blocker",
        summary=f"Deleted blocker '{title}'",
        payload={"blocker_id": id},
    )
    await _after_capacity_change(
        session,
        user_id=user.user_id,
        goal_id=None,
        kind="blocker.delete",
        summary=f"Deleted blocker '{title}'",
    )
    await session.commit()
    return {"ok": True}
