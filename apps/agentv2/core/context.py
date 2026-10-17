"""The snapshot the validator and gateway read.

Plain data, no I/O: a `Store` builds one, and everything downstream stays pure
and testable. It is rebuilt per run and never persisted.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import date, time, timedelta

from ..config import ACTIVE_WINDOW_END, ACTIVE_WINDOW_START, DEFAULT_DAILY_CAPACITY_HOURS, RECURRING_HORIZON_DAYS


@dataclass(frozen=True)
class BlockRow:
    id: str
    day: date
    start: time
    end: time
    status: str  # "committed" | "tentative"
    #: What the block is, shown to the model so it can reason about the day ("Dentist", "Learn driving").
    title: str = ""
    goal_id: str | None = None


@dataclass(frozen=True)
class PlanWeekRow:
    """A week of a goal's plan that exists as hours and a focus, possibly without days yet."""

    goal_id: str
    goal_title: str
    week_start: date
    focus: str
    hours: float
    #: Why this week carries this load, one sentence for the user. Empty on older rows.
    why: str = ""
    #: What the user can check off by the week's end. Empty on older rows.
    outcomes: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlanMonthRow:
    """A month of a goal's plan: the outcome its weeks add up to."""

    goal_id: str
    goal_title: str
    month_start: date
    focus: str
    hours: float
    why: str = ""
    outcomes: tuple[str, ...] = ()


@dataclass(frozen=True)
class RecurringRow:
    id: str
    title: str
    weekdays: tuple[int, ...]
    start: time
    end: time
    end_date: date | None = None


@dataclass(frozen=True)
class GoalHours:
    """Effort a goal needs and how much of it is done."""

    total: float
    done: float

    @property
    def remaining(self) -> float:
        return max(0.0, self.total - self.done)


@dataclass(frozen=True)
class Context:
    goal_ids: frozenset[str] = frozenset()
    #: goal id -> the date it should be done by, where it has one.
    goal_targets: dict[str, date] = field(default_factory=dict)
    #: id -> title of things not yet done (tasks, milestones), so "done X" can name the real one.
    open_items: dict[str, str] = field(default_factory=dict)
    #: id -> title, shown to the triage model so it files against real goals.
    goal_titles: dict[str, str] = field(default_factory=dict)
    #: goal id -> the user's weekly pace for it, where they gave one.
    goal_weekly_hours: dict[str, float] = field(default_factory=dict)
    #: goal id -> its open milestone breakdown (facets, each followed by its sub-milestones), for re-planning.
    goal_milestones: dict[str, tuple] = field(default_factory=dict)
    blocks: tuple[BlockRow, ...] = ()
    #: The user's today, so the validator can refuse something dated in the past.
    today: date | None = None
    daily_capacity_hours: float = DEFAULT_DAILY_CAPACITY_HOURS
    #: Hours the user gives on each weekday (Monday = 0), when they have said. A weekday left out is a
    #: day off. None means they have not said, so the default capacity applies.
    weekday_hours: dict[int, float] | None = None
    #: The most goal work one week may hold, from the user's own figure; None when they gave none.
    weekly_cap_hours: float | None = None
    plan_weeks: tuple[PlanWeekRow, ...] = ()
    #: The goal's current and coming month rows, so the plan's outcomes can be read back.
    plan_months: tuple[PlanMonthRow, ...] = ()
    #: The goals that are `active` (not paused or dropped). The share of free time a goal may take
    #: depends on how many others compete with it. Empty when the caller did not say; fall back to
    #: `goal_ids` then.
    active_goal_ids: frozenset[str] = frozenset()
    #: Active recurring commitments, so "stop my Tuesday class" can name the real one.
    recurring: tuple[RecurringRow, ...] = ()
    #: goal id -> hours needed and hours done, for goals whose total is known.
    goal_hours: dict[str, GoalHours] = field(default_factory=dict)
    #: Days the user is unavailable (a blocker). Nothing is planned on them.
    blocked_dates: frozenset[date] = frozenset()
    #: (goal id, Monday) pairs that already have day-level blocks.
    expanded_weeks: frozenset[tuple[str, date]] = frozenset()
    #: Tentative hours already planned per day, outside the blocks list.
    planned_hours: dict[date, float] = field(default_factory=dict)
    #: Hours the planner's untimed work already asks of each day: a quota's per-day effort, or a
    #: multi-day item's total split over its days. It holds no time on the clock, but it does use
    #: up the user's hours, so capacity and free time both count it. Read-only.
    untimed_hours_by_day: Mapping[date, float] = field(default_factory=dict)
    #: The parts of a day the agent may schedule into (the user's waking hours, from their profile).
    active_spans: tuple[tuple[time, time], ...] = ((ACTIVE_WINDOW_START, ACTIVE_WINDOW_END),)
    #: weekday -> spans the user is busy every week (their work or study hours, from their profile).
    busy_weekly: dict[int, tuple[tuple[time, time], ...]] = field(default_factory=dict)
    #: id -> Block for the four calendar block kinds (calendar_blocks table).
    items: dict[str, "Block"] = field(default_factory=dict)

    def capacity_on(self, day: date) -> float:
        """Hours of planned work `day` can hold."""
        if self.weekday_hours is None:
            return self.daily_capacity_hours
        return self.weekday_hours.get(day.weekday(), 0.0)

    def block(self, block_id: str) -> BlockRow | None:
        return next((b for b in self.blocks if b.id == block_id), None)


def untimed_load_by_day(blk, first: date, last: date) -> dict[date, float]:
    """Hours an untimed planner task asks of each day between `first` and `last`.

    A quota's `effort_hours` is already its effort on one day, so it counts on every day the
    quota falls on. A multi-day item's `effort_hours` is its total, split evenly over all its
    days: a window that starts partway through must not inflate the remaining days.
    """
    if blk.block_kind != "task" or blk.day is None or blk.start is not None or blk.end is not None:
        return {}
    effort = blk.effort_hours or 0.0
    if not effort:
        return {}
    repeat = blk.repeat
    if repeat is None:
        return {blk.day: effort} if first <= blk.day <= last else {}
    # An open-ended repeat has no `until`; bound it the way occurrences() does.
    end = repeat.until if repeat.until is not None else first + timedelta(days=RECURRING_HORIZON_DAYS)
    days = []
    d = blk.day
    while d <= min(end, last):
        if d.weekday() in repeat.weekdays:
            days.append(d)
        d += timedelta(days=1)
    if not days:
        return {}
    each = effort if blk.quota else effort / len(days)
    return {d: each for d in days if d >= first}


def without_goal_plan(ctx: Context, goal_id: str, from_date: date) -> Context:
    """`ctx` as the planner should see it while re-planning `goal_id` from `from_date`.

    `ClearGoalPlan` deletes this goal's own tentative blocks and untimed planner items from that
    date on, so they must not look busy to the new plan: the goal may reuse its old slots. Every
    other goal's work, and the user's own blocks, stay busy.
    """
    blocks = tuple(
        b for b in ctx.blocks
        if not (b.goal_id == goal_id and b.status == "tentative" and b.day >= from_date)
    )
    # Mirrors ClearGoalPlan: an item is the goal's own when the planner placed it, untimed, and
    # its anchor day is from `from_date` on.
    dropped = {
        bid for bid, blk in ctx.items.items()
        if blk.block_kind == "task" and blk.goal_id == goal_id
        and getattr(blk, "placed_by", "user") == "planner"
        and blk.day is not None and blk.day >= from_date
        and blk.start is None and blk.end is None and not blk.done
    }
    load = dict(ctx.untimed_hours_by_day)
    for bid in dropped:
        for day, hours in untimed_load_by_day(ctx.items[bid], from_date, date.max).items():
            load[day] = max(0.0, load.get(day, 0.0) - hours)
    return replace(
        ctx,
        blocks=blocks,
        items={bid: blk for bid, blk in ctx.items.items() if bid not in dropped},
        untimed_hours_by_day={d: h for d, h in load.items() if h > 0},
    )
