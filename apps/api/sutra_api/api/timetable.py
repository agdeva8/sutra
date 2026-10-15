"""Timetable blocks — the immovable part of the week.

Distinct from a blocker in kind, not degree: a blocker removes capacity for a
whole date range, a block occupies named hours on one date. A block is where the
user already *is* at 09:00; a blocker is a week they cannot work at all.

## The envelope is load-bearing here

`GET` returns `{"blocks": [...]}` and **must**. Three call sites read
`res?.blocks` with no array fallback:

* `DayPlanner.jsx:71` — `.then((res) => setBlocks(res?.blocks || []))`
* `Timeline.js:440` — `.then((r) => setTimetableBlocks(r?.blocks || []))`
* `TodayTimetable.jsx:56` — `timetableRes?.blocks`

A bare array makes `.blocks` undefined at all three, and the day planner renders
empty. The spec declares a bare array "to match `/blockers`" — the opposite of
what v1 did, and it would break the UI. See `CONTRACT-RECONCILIATION.md` #42.

Time is `HH:MM` on the wire; the column is a Postgres `time`, so this is a
presentation choice made once, in `wire.time_block`.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..agent_background import replan_conflicts_for
from ..db import get_session
from ..rate_limit import llm_rate_limit
from ..background import run_after
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..models import BLOCKER_KINDS, Reminder, TimetableBlock
from ..store import repo, staleness
from ..wire import time_block

router = APIRouter(tags=["timetable"])

_TIME_RE = re.compile(r"^(\d{2}):(\d{2})(?::\d{2})?$")


def _parse_time(v: object, field: str) -> time:
    m = _TIME_RE.match(str(v or ""))
    if not m:
        raise HTTPException(status_code=400, detail=f"{field} must be HH:MM")
    hour, minute = int(m.group(1)), int(m.group(2))
    if hour > 23 or minute > 59:
        raise HTTPException(status_code=400, detail=f"{field} is not a valid time")
    return time(hour=hour, minute=minute)


def _parse_date(v: object) -> date:
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="block_date must be YYYY-MM-DD")


async def _resolve_goal_title(
    session: AsyncSession, *, user_id: str, goal_id: str | None
) -> str:
    """Denormalised `goal_title`, resolved server-side when only the id is given.

    An unowned or unknown id yields an empty title rather than a 404 — v1's
    behaviour, and the opposite of the sources routes. A block is a real
    commitment even when its goal link is stale, so refusing the write would lose
    the user's calendar entry over a dangling reference.
    """
    if not goal_id:
        return ""
    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    return goal.title if goal is not None else ""


#: A reminder is a moment, not a stretch of time; it is drawn as a block this long so Today can show it.
REMINDER_DISPLAY_MINUTES = 15
#: Reminder occurrences from this many days back to this many days ahead are listed. Generous: it bounds the payload.
REMINDER_DAYS_BACK = 1
REMINDER_DAYS_AHEAD = 120
KIND_REMINDER = "reminder"


def _reminder_blocks(reminders: list) -> list[dict]:
    """Each reminder's days x times as short blocks, so Today and the calendar show them like anything
    else on the day. They are read-only here: the id names the reminder, the day and the time."""
    today = date.today()
    lo, hi = today - timedelta(days=REMINDER_DAYS_BACK), today + timedelta(days=REMINDER_DAYS_AHEAD)
    out: list[dict] = []
    for r in reminders:
        for day_s in r.days or []:
            day = date.fromisoformat(day_s)
            if not lo <= day <= hi:
                continue
            for t in r.times or []:
                start = time.fromisoformat(t)
                end = (datetime.combine(day, start) + timedelta(minutes=REMINDER_DISPLAY_MINUTES)).time()
                out.append({
                    "id": f"{r.id}:{day_s}:{t}", "user_id": r.user_id, "block_date": day_s,
                    "start_time": t, "end_time": end.strftime("%H:%M"), "label": r.title, "kind": KIND_REMINDER,
                    "source": "agent", "source_id": r.id, "goal_id": r.goal_id, "goal_title": "", "note": "",
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                })
    return out


@router.get("/timetable")
async def list_timetable(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    rows = await repo.list_time_blocks(session, user_id=user.user_id)
    reminders = (await session.execute(select(Reminder).where(Reminder.user_id == user.user_id))).scalars().all()
    return {"blocks": [time_block(b) for b in rows] + _reminder_blocks(reminders)}


@router.post("/timetable/replan-conflicts", dependencies=[Depends(llm_rate_limit)])
async def replan_conflicts_now(
    request: Request,
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Plan goals again around calendar changes the user just made.

    The follow-up the client sends after adding, editing or removing a block or an away period. It is its own
    request so the write itself returns at once; it does nothing when nothing conflicts."""
    await replan_conflicts_for(user.user_id, request.headers.get("x-timezone"))
    return {"ok": True}


@router.post("/timetable", status_code=201)
async def create_block(
    request: Request,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    label = str(body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")

    block_date = _parse_date(body.get("block_date"))
    start = _parse_time(body.get("start_time"), "start_time")
    end = _parse_time(body.get("end_time"), "end_time")
    if end <= start:
        raise HTTPException(
            status_code=400, detail="end_time must be after start_time"
        )

    kind = str(body.get("kind") or "commitment")
    if kind not in BLOCKER_KINDS:
        raise HTTPException(
            status_code=400, detail=f"kind must be one of {', '.join(BLOCKER_KINDS)}"
        )

    goal_id = body.get("goal_id") or None
    goal_title = str(body.get("goal_title") or "")
    if not goal_title:
        goal_title = await _resolve_goal_title(
            session, user_id=user.user_id, goal_id=goal_id
        )

    row = TimetableBlock(
        id=new_id("blk"),
        user_id=user.user_id,
        block_date=block_date,
        start_time=start,
        end_time=end,
        label=label,
        kind=kind,
        # `manual` — the solver writes `plan`, and the difference is what tells a
        # replan which blocks it may move.
        source="manual",
        source_id=None,
        goal_id=goal_id,
        goal_title=goal_title,
        note=str(body.get("note") or ""),
    )
    session.add(row)
    await session.flush()

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="create:timetable_block",
        summary=f"Added '{label}' {block_date} {start:%H:%M}-{end:%H:%M}",
        payload={"block_id": row.id, "label": label, "goal_id": goal_id},
    )
    if goal_id:
        horizons, milestone_moved = radius_for("timetable.add")
        await staleness.record_change(
            session,
            user_id=user.user_id,
            goal_id=goal_id,
            kind="timetable",
            horizons_moved=horizons,
            milestone_moved=milestone_moved,
            summary=f"Added '{label}'",
        )
    await session.commit()
    # No replan here: it ran inside the request (BACKGROUND_INLINE) and added seconds to every write. The
    # client follows up with `POST /timetable/replan-conflicts`.
    return time_block(row)


@router.put("/timetable/{id}")
async def update_block(
    id: str,
    request: Request,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Full replace, as with blockers: the times are required, not optional."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    row = await repo.get_time_block(session, user_id=user.user_id, block_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Block not found")

    label = str(body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")

    start = _parse_time(body.get("start_time"), "start_time")
    end = _parse_time(body.get("end_time"), "end_time")
    if end <= start:
        raise HTTPException(
            status_code=400, detail="end_time must be after start_time"
        )

    row.block_date = _parse_date(body.get("block_date"))
    row.start_time = start
    row.end_time = end
    row.label = label
    row.kind = str(body.get("kind") or row.kind)
    row.goal_id = body.get("goal_id") or None
    row.goal_title = str(body.get("goal_title") or "") or await _resolve_goal_title(
        session, user_id=user.user_id, goal_id=row.goal_id
    )
    row.note = str(body.get("note") or "")

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="update:timetable_block",
        summary=f"Updated block '{label}'",
        payload={"block_id": row.id, "label": label},
    )
    if row.goal_id:
        horizons, milestone_moved = radius_for("timetable.edit")
        await staleness.record_change(
            session,
            user_id=user.user_id,
            goal_id=row.goal_id,
            kind="timetable",
            horizons_moved=horizons,
            milestone_moved=milestone_moved,
            summary=f"Updated block '{label}'",
        )
    await session.commit()
    # No replan here: it ran inside the request (BACKGROUND_INLINE) and added seconds to every write. The
    # client follows up with `POST /timetable/replan-conflicts`.
    return {"block": time_block(row)}


@router.delete("/timetable/{id}")
async def delete_block(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = await repo.get_time_block(session, user_id=user.user_id, block_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Block not found")

    label = row.label
    goal_id = row.goal_id
    await session.delete(row)
    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="delete:timetable_block",
        summary=f"Deleted block '{label}'",
        payload={"block_id": id},
    )
    if goal_id:
        horizons, milestone_moved = radius_for("timetable.delete")
        await staleness.record_change(
            session,
            user_id=user.user_id,
            goal_id=goal_id,
            kind="timetable",
            horizons_moved=horizons,
            milestone_moved=milestone_moved,
            summary=f"Deleted block '{label}'",
        )
    await session.commit()
    return {"ok": True}
