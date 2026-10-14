"""The snapshot the validator and gateway read.

Plain data, no I/O: a `Store` builds one, and everything downstream stays pure
and testable. It is rebuilt per run and never persisted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time

from ..config import ACTIVE_WINDOW_END, ACTIVE_WINDOW_START, DEFAULT_DAILY_CAPACITY_HOURS


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
    #: The parts of a day the agent may schedule into (the user's waking hours, from their profile).
    active_spans: tuple[tuple[time, time], ...] = ((ACTIVE_WINDOW_START, ACTIVE_WINDOW_END),)
    #: weekday -> spans the user is busy every week (their work or study hours, from their profile).
    busy_weekly: dict[int, tuple[tuple[time, time], ...]] = field(default_factory=dict)

    def capacity_on(self, day: date) -> float:
        """Hours of planned work `day` can hold."""
        if self.weekday_hours is None:
            return self.daily_capacity_hours
        return self.weekday_hours.get(day.weekday(), 0.0)

    def block(self, block_id: str) -> BlockRow | None:
        return next((b for b in self.blocks if b.id == block_id), None)
