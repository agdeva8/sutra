"""Plan a goal: weeks first, then day-level detail for the weeks that are close."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime

from ..config import DAY_WINDOW_WEEKS, FIX_MAX_LOOPS, PLAN_PARALLEL_WEEKS, PROGRESS_REVIEW, PROGRESS_WEEK, PROGRESS_WEEKS

Progress = Callable[[str], None]
from ..contracts import AddPlanMonth, AddPlanWeek, Change, ChangeSet, Origin
from ..contracts.planner import GoalSpec
from ..core.calendar import free_hours_by_day
from ..core.context import Context
from ..core.ids import new_id
from .critic import critique_week
from .day import plan_day_level
from .merge import merge
from .week import plan_weeks


@dataclass
class GoalPlan:
    goal: GoalSpec
    changes: list[Change]
    notes: list[str] = field(default_factory=list)


def plan_week_with_critic(chat, goal: GoalSpec, w, ctx: Context, now: datetime, notes: list[str], progress: Progress | None = None):
    """Plan a week's days, have it reviewed, and re-plan with the critic's problems as feedback."""
    feedback: str | None = None
    for attempt in range(1 + FIX_MAX_LOOPS):
        if progress:
            progress(PROGRESS_WEEK.format(week=f"{w.week:%d %b}"))
        changes, new_ctx, how = plan_day_level(chat, goal, w, ctx, now, feedback)
        if progress:
            progress(PROGRESS_REVIEW.format(week=f"{w.week:%d %b}"))
        # The days that could take work: not past, and with free time. Without them the critic sees a
        # week started on Saturday as "everything crammed into the weekend" and burns every retry.
        open_days = sorted(d for d, hours in free_hours_by_day(ctx, now, w.week).items() if hours > 0)
        verdict = critique_week(chat, goal, w, changes, open_days)
        if verdict is None or verdict.ok or not verdict.problems:
            if attempt:
                notes.append(f"{w.week:%d %b}: fixed after {attempt} critique(s)")
            return changes, new_ctx, how
        feedback = " ".join(verdict.problems)
    notes.append(f"{w.week:%d %b}: critic still unhappy: {feedback}")
    return changes, new_ctx, how


def plan_goal(chat, goal: GoalSpec, ctx: Context, now: datetime, progress: Progress | None = None) -> GoalPlan:
    if progress:
        progress(PROGRESS_WEEKS)
    wk = plan_weeks(chat, goal, ctx, now)
    notes = [f"week plan via {wk.how}"]
    if wk.shortfall > 0:
        notes.append(f"only {goal.total_hours - wk.shortfall:g} of {goal.total_hours:g}h fit before the deadline")
    # A week that could not hold the pace the user asked for says so; the note keeps it visible.
    notes += wk.shortfalls
    changes: list[Change] = []

    # Every planned week is taken down to days. Weeks cover different days, so each is planned from the
    # same calendar snapshot, in parallel; the results are put back in week order.
    def plan_one(w):
        week_notes: list[str] = []
        day_changes, _ctx_after, how = plan_week_with_critic(chat, goal, w, ctx, now, week_notes, progress)
        return day_changes, how, week_notes

    detailed = wk.allocs[:DAY_WINDOW_WEEKS]
    with ThreadPoolExecutor(max_workers=max(1, min(PLAN_PARALLEL_WEEKS, len(detailed) or 1))) as pool:
        planned = list(pool.map(plan_one, detailed))
    for m in wk.months:
        changes.append(AddPlanMonth(id=new_id("pm"), goal_id=goal.id, month_start=m.month, focus=m.focus,
                                    hours=m.hours, why=m.why, outcomes=m.outcomes))
    for i, w in enumerate(wk.allocs):
        changes.append(AddPlanWeek(id=new_id("pw"), goal_id=goal.id, week_start=w.week, focus=w.focus,
                                   hours=w.hours, why=w.why, outcomes=w.outcomes))
        if i < len(planned):
            day_changes, how, week_notes = planned[i]
            changes += day_changes
            notes += week_notes
            notes.append(f"{w.week:%d %b}: day plan via {how}")
    return GoalPlan(goal, changes, notes)


async def plan_goals(chat, goals: list[GoalSpec], ctx: Context, now: datetime, origin: Origin, progress: Progress | None = None) -> tuple[ChangeSet, list[str]]:
    """Plan several goals at once. Each is planned from the same snapshot, in parallel;
    `merge` then resolves any time two goals both claimed, by priority."""
    plans = await asyncio.gather(*(asyncio.to_thread(plan_goal, chat, g, ctx, now, progress) for g in goals))
    merged = merge([(p.goal.priority, p.changes) for p in plans], ctx, now)
    return ChangeSet(origin=origin, changes=merged), [n for p in plans for n in p.notes]
