"""Plan a goal again after something changed (a new commitment, an away week, a moved deadline).

Everything the agent set aside for the goal from today on is cleared and planned afresh around
what is on the calendar now. Fixed blocks, finished work and the past are untouched. The hours to
plan are the goal's open weekly hours; the deadline is the goal's own date.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

from ..config import BLOCK_TENTATIVE
from ..contracts import ChangeSet, ClearGoalPlan, Origin
from ..contracts.planner import GoalSpec
from ..core.calendar import week_start
from ..core.context import Context
from .plan import plan_goal


def replan_changes(chat, ctx: Context, goal_id: str, now: datetime, progress=None) -> tuple[list, list[str]] | None:
    """(changes, notes), or None if the goal has nothing left to plan."""
    this_week = week_start(now.date())
    open_weeks = [w for w in ctx.plan_weeks if w.goal_id == goal_id and w.week_start >= this_week]
    # What is still to do: the goal's total less what is done, when the total is known (so missed sessions
    # roll forward and early finishes shrink the plan); otherwise the hours still planned.
    known = ctx.goal_hours.get(goal_id)
    remaining = known.remaining if known else sum(w.hours for w in open_weeks)
    if remaining <= 0:
        return None

    cleared_ctx = replace(ctx, blocks=tuple(
        b for b in ctx.blocks if not (b.goal_id == goal_id and b.status == BLOCK_TENTATIVE and b.day >= now.date())
    ))
    cleared_ctx = replace(cleared_ctx, plan_weeks=tuple(w for w in ctx.plan_weeks if w.goal_id != goal_id))
    spec = GoalSpec(id=goal_id, title=ctx.goal_titles.get(goal_id, goal_id), total_hours=remaining,
                    deadline=ctx.goal_targets.get(goal_id) or now.date() + timedelta(weeks=12))
    plan = plan_goal(chat, spec, cleared_ctx, now, progress)
    return [ClearGoalPlan(goal_id=goal_id, from_date=now.date()), *plan.changes], ["replanned"] + plan.notes
