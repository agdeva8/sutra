"""The nightly tick: give day-level detail to weeks that have just come close.

Far weeks are stored as hours and a focus only (HLD §3). Each night, any such week
inside the day window that has no blocks yet is planned down to days and slots,
against whatever the calendar looks like *now* (new commitments included).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from ..config import DAY_WINDOW_WEEKS
from ..contracts import Change
from ..contracts.planner import GoalSpec
from ..core.calendar import week_start
from ..core.context import Context
from .plan import plan_week_with_critic
from .week import WeekAlloc


def tick_changes(chat, ctx: Context, now: datetime) -> tuple[list[Change], list[str]]:
    this_week = week_start(now.date())
    window_end = this_week + timedelta(weeks=DAY_WINDOW_WEEKS)
    due = sorted(
        (w for w in ctx.plan_weeks if this_week <= w.week_start < window_end and (w.goal_id, w.week_start) not in ctx.expanded_weeks),
        key=lambda w: (w.week_start, w.goal_id),
    )
    changes: list[Change] = []
    notes: list[str] = []
    running = ctx
    for w in due:
        goal = GoalSpec(id=w.goal_id, title=w.goal_title or w.focus, total_hours=w.hours)
        day_changes, running, how = plan_week_with_critic(chat, goal, WeekAlloc(w.week_start, w.focus, w.hours), running, now, notes)
        changes += day_changes
        notes.append(f"{w.goal_title or w.goal_id} {w.week_start:%d %b}: expanded via {how}")
    return changes, notes
