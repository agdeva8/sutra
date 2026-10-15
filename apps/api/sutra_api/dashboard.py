"""The dashboard snapshot — assembled once, read from two places.

`GET /state` and `POST /tools/confirm` return the *same* body, and they must: the
confirm response carries the fresh board so the client re-renders without a
second round trip, and if the two assembled it separately they would drift the
first time one of them gained a field.

v1 kept this in a `dashboard-state` module for that reason and had a read-through
cache around it. The cache is gone (see `api/state.py`), the single-assembly rule
is not.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from .core.over_commitment import compute_over_commitment
from .core.replan_suggestions import compute_replan_suggestions
from sqlalchemy import select

from .models import Reminder, User
from .store import drift as drift_store
from .store import repo
from .wire import (
    audit_entry,
    blocker,
    goal_state,
    milestone_state,
    plan_item,
    source_list_row,
    time_block,
)

#: v1's read caps. They describe the shape the dashboard was designed for; raising
#: them would silently change what the UI paginates around.
GOAL_LIMIT = 500
MILESTONE_LIMIT = 1000
BLOCKER_LIMIT = 500
SOURCE_LIMIT = 500
PLAN_ITEM_LIMIT = 2000
BLOCK_LIMIT = 1000
REMINDER_LIMIT = 500
AUDIT_RECENT = 10


async def assemble_state(session: AsyncSession, *, user_id: str) -> dict:
    """Everything the dashboard renders, in one body.

    Drift is refreshed first and swallowed on failure: it is a diagnostic, and a
    diagnostic that can break the board is worse than a stale one.
    """
    try:
        await drift_store.refresh_drift_for_dashboard(session, user_id=user_id)
        await session.commit()
    except Exception:
        await session.rollback()

    goals = await repo.list_goals(session, user_id=user_id, limit=GOAL_LIMIT)
    milestones = await repo.list_milestones(
        session, user_id=user_id, limit=MILESTONE_LIMIT
    )
    blockers = await repo.list_blockers(session, user_id=user_id, limit=BLOCKER_LIMIT)
    items = await repo.list_plan_items(session, user_id=user_id, limit=PLAN_ITEM_LIMIT)
    blocks = await repo.list_time_blocks(session, user_id=user_id, limit=BLOCK_LIMIT)
    sources = await repo.list_sources(session, user_id=user_id, limit=SOURCE_LIMIT)
    recent = await repo.recent_audit(session, user_id=user_id, limit=AUDIT_RECENT)

    reminders = list((await session.execute(select(Reminder).where(Reminder.user_id == user_id).limit(REMINDER_LIMIT))).scalars())
    user_row = await session.get(User, user_id)
    available_weekly_hours = user_row.available_weekly_hours if user_row else None

    # A dropped goal's plan is not rendered. Its rows still exist — a drop is a
    # status change, and `plan_items` cascade only when the *row* goes — so this
    # filter is what keeps a dropped goal's steps off the board.
    dropped = {g.id for g in goals if g.status == "dropped"}

    sources_by_goal: dict[str, list[str]] = {}
    for src in sources:
        if src.goal_id:
            sources_by_goal.setdefault(src.goal_id, []).append(src.id)

    goal_payload = [goal_state(g, sources_by_goal.get(g.id, [])) for g in goals]
    milestone_payload = [
        milestone_state(m)
        for m in milestones
        if m.goal_id is None or m.goal_id not in dropped
    ]
    item_payload = [
        plan_item(i) for i in items if i.goal_id is None or i.goal_id not in dropped
    ]
    blocker_payload = [blocker(b) for b in blockers]
    block_payload = [time_block(b) for b in blocks]
    source_payload = [source_list_row(s) for s in sources]
    audit_payload = [audit_entry(a) for a in recent]

    suggestions = compute_replan_suggestions(
        {
            "goals": [
                {
                    "id": g["id"],
                    "title": g["title"],
                    "status": g["status"],
                    "start_date": g["start_date"],
                    "target_date": g["target_date"],
                    "drift_status": g["drift_status"],
                    "weekly_hours": g["weekly_hours"],
                }
                for g in goal_payload
            ],
            "blockers": blocker_payload,
            "recentAudit": audit_payload,
            "milestones": milestone_payload,
            # `commitments` is deliberately absent — the entity was folded into
            # `plan_items`, and v1's dashboard never passed it either, which is
            # why that branch of `compute_replan_suggestions` is dead.
            "timetableBlocks": block_payload,
            "availableWeeklyHours": available_weekly_hours,
        }
    )

    return {
        "goals": goal_payload,
        "milestones": milestone_payload,
        "blockers": blocker_payload,
        "plan_items": item_payload,
        "sources": source_payload,
        "over_commitment": compute_over_commitment(goal_payload),
        "audit_summary": {"recent": audit_payload},
        "replan_suggestions": suggestions,
        # A constant, not a computation: the replan engine has one door.
        "replan_engine": "review_progress",
        "available_weekly_hours": available_weekly_hours,
        "generated_at": datetime.now(UTC).isoformat(),
        # Camel-case because that is what `Coach.js:102` reads. Also emitted
        # snake-case because that is what the spec declares — see
        # `x-contract-notes#timetable-blocks`, whose "either add it or delete the
        # read" resolves to *add*, since the read is real and shipped.
        "timetableBlocks": block_payload,
        "timetable_blocks": block_payload,
        # Each reminder is its whole schedule: the days it falls on and the times of day on each of them.
        "reminders": [{"id": r.id, "title": r.title, "goal_id": r.goal_id, "days": list(r.days or []), "times": list(r.times or [])} for r in reminders],
    }
