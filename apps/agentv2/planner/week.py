"""Week level: spread a goal's total hours over the coming weeks.

The model proposes; code checks every period against its capacity. A rejected plan
goes back to the model with the exact problem, up to `FIX_MAX_LOOPS` times, then
`even_split` takes over. A goal is never left unplanned because a reply was bad.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from ..config import FIX_MAX_LOOPS, GOAL_MAX_SHARE_OF_FREE, MONTH_LEVEL_MIN_WEEKS, WEEK_HORIZON
from ..contracts.planner import GoalSpec, MonthPlan, WeekPlan
from ..core.budget import check_allocation, even_split
from ..core.calendar import free_hours_by_week
from ..core.context import Context
from ..llm import complete_json
from ..prompts.planner import MONTH_SYSTEM, WEEK_SYSTEM, month_user, week_user

WEEK_PREFIX = "wk_"


@dataclass
class WeekAlloc:
    week: date
    focus: str
    hours: float


@dataclass
class WeekResult:
    allocs: list[WeekAlloc]
    how: str  # "model" | "even_split"
    #: Hours the goal needs that no week before the deadline could hold.
    shortfall: float


def _weeks_until(goal: GoalSpec, now: datetime) -> int:
    if goal.deadline is None:
        return WEEK_HORIZON
    return max(1, min(WEEK_HORIZON, (goal.deadline - now.date()).days // 7 + 1))


MONTH_PREFIX = "mo_"


def _month_of(week_id: str) -> str:
    return MONTH_PREFIX + week_id[len(WEEK_PREFIX):][:7]


def _plan_months(chat, goal: GoalSpec, usable: dict[str, float]) -> tuple[dict[str, float], str]:
    """Hours per month. Same discipline as weeks: model, checked, fixed, then an even split."""
    cap: dict[str, float] = {}
    for wid, h in usable.items():
        cap[_month_of(wid)] = round(cap.get(_month_of(wid), 0.0) + h, 2)
    listed = "\n".join(f"- {mid}: {h:g}h" for mid, h in cap.items())
    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, MONTH_SYSTEM, month_user(goal.title, goal.total_hours, goal.deadline and goal.deadline.isoformat(), listed, problem), MonthPlan)
        if plan is None:
            break
        alloc: dict[str, float] = {}
        for m in plan.months:
            alloc[m.month_id] = alloc.get(m.month_id, 0.0) + m.hours
        problem = check_allocation(alloc, cap, goal.total_hours)
        if problem is None:
            return {k: v for k, v in alloc.items() if v > 0}, "model"
    return even_split(goal.total_hours, cap), "even_split"


def plan_weeks(chat, goal: GoalSpec, ctx: Context, now: datetime) -> WeekResult:
    free = free_hours_by_week(ctx, now, _weeks_until(goal, now))
    usable = {f"{WEEK_PREFIX}{d.isoformat()}": round(h * GOAL_MAX_SHARE_OF_FREE, 2) for d, h in free.items() if h > 0}
    if len(usable) <= MONTH_LEVEL_MIN_WEEKS:
        return _alloc_weeks(chat, goal, goal.total_hours, usable)

    # Long goal: months first, then the weeks inside each month against that month's hours.
    months, how = _plan_months(chat, goal, usable)
    allocs: list[WeekAlloc] = []
    shortfall = 0.0
    for mid, hours in sorted(months.items()):
        sub = {w: h for w, h in usable.items() if _month_of(w) == mid}
        r = _alloc_weeks(chat, goal, hours, sub, [a.focus for a in allocs])
        allocs += r.allocs
        shortfall += r.shortfall
    return WeekResult(sorted(allocs, key=lambda a: a.week), f"month({how})+week", round(shortfall, 2))


def _alloc_weeks(chat, goal: GoalSpec, total: float, usable: dict[str, float], earlier: list[str] | None = None) -> WeekResult:
    listed = "\n".join(f"- {wid}: {h:g}h" for wid, h in usable.items())

    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, WEEK_SYSTEM, week_user(goal.title, total, goal.deadline and goal.deadline.isoformat(), listed, problem, earlier), WeekPlan)
        if plan is None:
            break
        alloc: dict[str, float] = {}
        for w in plan.weeks:
            alloc[w.week_id] = alloc.get(w.week_id, 0.0) + w.hours
        problem = check_allocation(alloc, usable, total)
        if problem is None:
            focus = {w.week_id: w.focus for w in plan.weeks}
            return WeekResult([WeekAlloc(date.fromisoformat(w[len(WEEK_PREFIX):]), focus.get(w, goal.title), h)
                               for w, h in sorted(alloc.items()) if h > 0], "model", 0.0)

    split = even_split(total, usable)
    return WeekResult(
        [WeekAlloc(date.fromisoformat(w[len(WEEK_PREFIX):]), goal.title, h) for w, h in sorted(split.items())],
        "even_split",
        max(0.0, round(total - sum(split.values()), 2)),
    )
