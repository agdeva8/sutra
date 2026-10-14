"""Plan a goal: weeks first, then day-level detail for the weeks that are close."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime

from ..config import DAY_WINDOW_WEEKS, FIX_MAX_LOOPS
from ..contracts import AddPlanWeek, Change, ChangeSet, Origin
from ..contracts.planner import GoalSpec
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


def plan_week_with_critic(chat, goal: GoalSpec, w, ctx: Context, now: datetime, notes: list[str]):
    """Plan a week's days, have it reviewed, and re-plan with the critic's problems as feedback."""
    feedback: str | None = None
    for attempt in range(1 + FIX_MAX_LOOPS):
        changes, new_ctx, how = plan_day_level(chat, goal, w, ctx, now, feedback)
        verdict = critique_week(chat, goal, w, changes)
        if verdict is None or verdict.ok or not verdict.problems:
            if attempt:
                notes.append(f"{w.week:%d %b}: fixed after {attempt} critique(s)")
            return changes, new_ctx, how
        feedback = " ".join(verdict.problems)
    notes.append(f"{w.week:%d %b}: critic still unhappy: {feedback}")
    return changes, new_ctx, how


def plan_goal(chat, goal: GoalSpec, ctx: Context, now: datetime) -> GoalPlan:
    wk = plan_weeks(chat, goal, ctx, now)
    notes = [f"week plan via {wk.how}"]
    if wk.shortfall > 0:
        notes.append(f"only {goal.total_hours - wk.shortfall:g} of {goal.total_hours:g}h fit before the deadline")
    changes: list[Change] = []
    running = ctx
    for i, w in enumerate(wk.allocs):
        changes.append(AddPlanWeek(id=new_id("pw"), goal_id=goal.id, week_start=w.week, focus=w.focus, hours=w.hours))
        if i < DAY_WINDOW_WEEKS:
            day_changes, running, how = plan_week_with_critic(chat, goal, w, running, now, notes)
            changes += day_changes
            notes.append(f"{w.week:%d %b}: day plan via {how}")
    return GoalPlan(goal, changes, notes)


async def plan_goals(chat, goals: list[GoalSpec], ctx: Context, now: datetime, origin: Origin) -> tuple[ChangeSet, list[str]]:
    """Plan several goals at once. Each is planned from the same snapshot, in parallel;
    `merge` then resolves any time two goals both claimed, by priority."""
    plans = await asyncio.gather(*(asyncio.to_thread(plan_goal, chat, g, ctx, now) for g in goals))
    merged = merge([(p.goal.priority, p.changes) for p in plans], ctx, now)
    return ChangeSet(origin=origin, changes=merged), [n for p in plans for n in p.notes]
