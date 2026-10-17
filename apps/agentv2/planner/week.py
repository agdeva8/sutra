"""Week level: spread a goal's total hours over the coming weeks.

The model proposes; code checks every period against its capacity. A rejected plan
goes back to the model with the exact problem, up to `FIX_MAX_LOOPS` times, then
`even_split` takes over. A goal is never left unplanned because a reply was bad.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ..config import FIX_MAX_LOOPS, GOAL_MAX_SHARE_OF_FREE, GOAL_MAX_SHARE_OF_FREE_SINGLE, MONTH_LEVEL_MIN_WEEKS, WEEK_HORIZON
from ..contracts.planner import GoalSpec, MonthPlan, WeekPlan
from ..core.budget import check_allocation, even_split
from ..core.calendar import free_hours_by_day, free_hours_by_week
from ..core.context import Context
from ..llm import complete_json
from ..prompts.planner import (
    MONTH_SYSTEM, SHORTFALL_WHY_CALENDAR, SHORTFALL_WHY_LIMIT, SHORTFALL_WHY_SHARED,
    WEEK_SYSTEM, milestones_text, month_user, week_user,
)

WEEK_PREFIX = "wk_"


@dataclass
class WeekAlloc:
    week: date
    focus: str
    hours: float
    why: str = ""
    #: Titles of the milestones this week works toward, for the day level.
    milestones: list[str] = field(default_factory=list)
    #: What the user can check off by the week's end, 2-4 short results.
    outcomes: list[str] = field(default_factory=list)


@dataclass
class MonthAlloc:
    month: date
    focus: str
    hours: float
    why: str = ""
    outcomes: list[str] = field(default_factory=list)


@dataclass
class WeekResult:
    allocs: list[WeekAlloc]
    how: str  # "model" | "even_split"
    #: Hours the goal needs that no week before the deadline could hold.
    shortfall: float
    #: The months the weeks roll up into, so each can be written as its own row.
    months: list[MonthAlloc] = field(default_factory=list)
    #: One sentence per week that could not hold the pace the user asked for, for the plan's notes.
    shortfalls: list[str] = field(default_factory=list)


def _weeks_until(goal: GoalSpec, now: datetime) -> int:
    if goal.deadline is None:
        return WEEK_HORIZON
    return max(1, min(WEEK_HORIZON, (goal.deadline - now.date()).days // 7 + 1))


MONTH_PREFIX = "mo_"


def _month_of(week_id: str) -> str:
    return MONTH_PREFIX + week_id[len(WEEK_PREFIX):][:7]


def _share_of_free(ctx: Context) -> float:
    """How much of a week's free time one goal may take: half when another goal competes, all when alone."""
    active = ctx.active_goal_ids or ctx.goal_ids
    return GOAL_MAX_SHARE_OF_FREE if len(active) >= 2 else GOAL_MAX_SHARE_OF_FREE_SINGLE


def _plan_months(chat, goal: GoalSpec, usable: dict[str, float]) -> tuple[dict[str, float], dict[str, tuple[str, str, list[str]]], str]:
    """Hours per month. Same discipline as weeks: model, checked, fixed, then an even split."""
    cap: dict[str, float] = {}
    for wid, h in usable.items():
        cap[_month_of(wid)] = round(cap.get(_month_of(wid), 0.0) + h, 2)
    listed = "\n".join(f"- {mid}: {h:g}h" for mid, h in cap.items())
    # Ask only for what can fit. A goal needing more hours than the months hold can never pass the check,
    # so asking for the full total burnt every retry (about a minute each) before the even split anyway.
    # The hours that do not fit come back as the week level's shortfall.
    target = round(min(goal.total_hours, sum(cap.values())), 2)
    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, MONTH_SYSTEM, month_user(goal.title, target, goal.deadline and goal.deadline.isoformat(), listed, problem), MonthPlan)
        if plan is None:
            break
        alloc: dict[str, float] = {}
        for m in plan.months:
            alloc[m.month_id] = alloc.get(m.month_id, 0.0) + m.hours
        problem = check_allocation(alloc, cap, target)
        if problem is None:
            return ({k: v for k, v in alloc.items() if v > 0},
                    {m.month_id: (m.focus, m.why, m.outcomes) for m in plan.months if m.focus}, "model")
    return even_split(target, cap), {}, "even_split"


def plan_weeks(chat, goal: GoalSpec, ctx: Context, now: datetime) -> WeekResult:
    free = free_hours_by_week(ctx, now, _weeks_until(goal, now))
    share = _share_of_free(ctx)
    # The goal's own pace, when the user gave one, caps every week: "10 hours a week" means no 17-hour week.
    pace = goal.weekly_hours or float("inf")
    usable = {f"{WEEK_PREFIX}{d.isoformat()}": round(min(h * share, pace), 2) for d, h in free.items() if h > 0}
    if len(usable) <= MONTH_LEVEL_MIN_WEEKS:
        # A short goal needs no separate month call: its months are just its weeks, summed.
        r = _alloc_weeks(chat, goal, goal.total_hours, usable)
        r.months = _roll_up(r.allocs)
        _note_shortfalls(r, goal, ctx, now, usable, share)
        return r

    # Long goal: months first, then the weeks inside each month against that month's hours.
    months, month_meta, how = _plan_months(chat, goal, usable)
    # Each month's weeks are planned at once: months cover different weeks, so the calls are independent.
    # A month is told what the months before it are for (the month level's foci), which keeps the thread
    # without waiting for their weeks.
    order = sorted(months.items())

    def weeks_of(i: int) -> WeekResult:
        mid, hours = order[i]
        sub = {w: h for w, h in usable.items() if _month_of(w) == mid}
        earlier = [month_meta[m][0] for m, _ in order[:i] if m in month_meta]
        return _alloc_weeks(chat, goal, hours, sub, earlier)

    with ThreadPoolExecutor(max_workers=max(1, len(order))) as pool:
        results = list(pool.map(weeks_of, range(len(order))))
    allocs = sorted((a for r in results for a in r.allocs), key=lambda a: a.week)
    shortfall = sum(r.shortfall for r in results) + max(0.0, goal.total_hours - sum(months.values()))
    shortfalls = [s for r in results for s in r.shortfalls]
    result = WeekResult(allocs, f"month({how})+week", round(shortfall, 2), _roll_up(allocs, month_meta), shortfalls)
    _note_shortfalls(result, goal, ctx, now, usable, share)
    return result


def _roll_up(allocs: list[WeekAlloc], meta: dict[str, tuple[str, str, list[str]]] | None = None) -> list[MonthAlloc]:
    """One row per month that has planned weeks: the hours its weeks actually got, and what it is for.
    The month's own focus (if the model gave one) wins; otherwise it borrows its first week's."""
    out: dict[date, MonthAlloc] = {}
    for a in allocs:
        first = a.week.replace(day=1)
        focus, why, outcomes = (meta or {}).get(f"{MONTH_PREFIX}{first:%Y-%m}") or (a.focus, a.why, a.outcomes)
        m = out.setdefault(first, MonthAlloc(first, focus, 0.0, why, list(outcomes)))
        m.hours = round(m.hours + a.hours, 2)
    return [m for _, m in sorted(out.items())]


def _note_shortfalls(res: WeekResult, goal: GoalSpec, ctx: Context, now: datetime, usable: dict[str, float], share: float) -> None:
    """Say when a week cannot hold the pace the user asked for, instead of shrinking it silently.

    It fires only when the week was *offered* less than the goal's own weekly hours (the calendar,
    the shared-time cap or capacity), not when a correct plan simply spreads less work over a week.
    The sentence is appended to the week's `why` and returned in the plan's notes.
    """
    wanted = goal.weekly_hours
    if not wanted:
        return
    for a in res.allocs:
        wid = f"{WEEK_PREFIX}{a.week.isoformat()}"
        if usable.get(wid, 0.0) >= wanted - 1e-9 or a.hours >= wanted - 1e-9:
            continue
        full = [d for d, h in free_hours_by_day(ctx, now, a.week).items() if h <= 0]
        if full:
            sentence = SHORTFALL_WHY_CALENDAR.format(got=a.hours, wanted=wanted, days=", ".join(f"{d:%a}" for d in full))
        elif share < 1.0:
            sentence = SHORTFALL_WHY_SHARED.format(got=a.hours, wanted=wanted)
        else:
            sentence = SHORTFALL_WHY_LIMIT.format(got=a.hours, wanted=wanted)
        a.why = f"{a.why} {sentence}".strip()
        res.shortfalls.append(f"{a.week:%d %b}: {sentence}")


def _alloc_weeks(chat, goal: GoalSpec, total: float, usable: dict[str, float], earlier: list[str] | None = None) -> WeekResult:
    listed = "\n".join(f"- {wid}: {h:g}h" for wid, h in usable.items())
    tree = milestones_text(goal.milestones)
    known = {m.title for m in goal.milestones}

    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, WEEK_SYSTEM, week_user(goal.title, total, goal.deadline and goal.deadline.isoformat(), listed, problem, earlier, tree), WeekPlan)
        if plan is None:
            break
        alloc: dict[str, float] = {}
        for w in plan.weeks:
            alloc[w.week_id] = alloc.get(w.week_id, 0.0) + w.hours
        problem = check_allocation(alloc, usable, total)
        if problem is None:
            focus = {w.week_id: w.focus for w in plan.weeks}
            why = {w.week_id: w.why for w in plan.weeks}
            serves = {w.week_id: [t for t in w.milestones if t in known] for w in plan.weeks}
            outcomes = {w.week_id: w.outcomes for w in plan.weeks}
            return WeekResult(
                [WeekAlloc(date.fromisoformat(w[len(WEEK_PREFIX):]), focus.get(w, goal.title), h, why.get(w, ""),
                           serves.get(w, []), outcomes.get(w, []))
                 for w, h in sorted(alloc.items()) if h > 0], "model", 0.0)

    split = even_split(total, usable)
    return WeekResult(
        [WeekAlloc(date.fromisoformat(w[len(WEEK_PREFIX):]), goal.title, h) for w, h in sorted(split.items())],
        "even_split",
        max(0.0, round(total - sum(split.values()), 2)),
    )
