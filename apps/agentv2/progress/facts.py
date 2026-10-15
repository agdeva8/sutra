"""The numbers behind progress. Pure: plain rows in, plain facts out, no DB, network or model.

Code owns every number here. The model (`judge`) only reads them and says what they mean, so a
percentage can never be an opinion. A level (month or week) is measured by the *days* inside it, the
only rows that carry real hours of work, so a plan with no monthly row still has honest numbers.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from hashlib import sha1
import json


@dataclass(frozen=True)
class PlanRow:
    """One plan row at any level, as plain data. `hours` is the work it holds; `done_hours` how much of it is finished."""

    id: str
    horizon: str  # "daily" | "weekly" | "monthly"
    title: str
    start: date | None
    end: date | None
    hours: float
    done_hours: float = 0.0


@dataclass(frozen=True)
class MilestoneRow:
    id: str
    title: str
    target: date | None
    done: bool


@dataclass
class LevelFacts:
    id: str
    label: str
    start: date
    end: date
    #: Hours the level was planned to hold, and the daily hours actually scheduled inside it.
    planned: float
    scheduled: float
    #: Scheduled hours whose day has already passed, and how many of those are finished.
    due: float
    done: float
    #: "past" | "current" | "future", from today.
    when: str


@dataclass
class MilestoneFacts:
    id: str
    title: str
    target: date | None
    done: bool
    days_left: int | None
    #: Scheduled hours dated on or before the milestone, and how many of those are finished.
    hours_before: float
    done_before: float


@dataclass
class GoalFacts:
    goal_id: str
    title: str
    today: date
    deadline: date | None
    #: Hours the whole plan holds (the weeks, which cover the whole deadline), and how many of those are
    #: already broken into days. The rest is broken into days when its week gets close.
    total_planned: float
    total_done: float
    scheduled_in_days: float
    #: Everything scheduled up to and including yesterday, versus what is finished.
    due_so_far: float
    #: Hours not yet finished, and the weeks left to do them in.
    remaining: float
    weeks_left: float | None
    #: Percent of the whole plan finished, and percent that should be finished by now.
    pct_done: int
    pct_expected: int
    months: list[LevelFacts] = field(default_factory=list)
    weeks: list[LevelFacts] = field(default_factory=list)
    milestones: list[MilestoneFacts] = field(default_factory=list)

    def digest(self) -> str:
        """Changes when any number does (and each day), so a cached verdict is reused only while it is true."""
        return sha1(json.dumps(asdict(self), default=str, sort_keys=True).encode()).hexdigest()[:16]


def _pct(part: float, whole: float) -> int:
    return round(100 * part / whole) if whole > 0 else 0


def _when(start: date, end: date, today: date) -> str:
    return "past" if end < today else "future" if start > today else "current"


def _level(row: PlanRow, days: list[PlanRow], today: date, label: str) -> LevelFacts | None:
    if row.start is None or row.end is None:
        return None
    inside = [d for d in days if d.start and row.start <= d.start <= row.end]
    due = [d for d in inside if d.start < today]
    return LevelFacts(
        id=row.id, label=label, start=row.start, end=row.end, planned=round(row.hours, 2),
        scheduled=round(sum(d.hours for d in inside), 2), due=round(sum(d.hours for d in due), 2),
        done=round(sum(d.done_hours for d in inside), 2), when=_when(row.start, row.end, today),
    )


def build_goal_facts(goal_id: str, title: str, deadline: date | None, rows: list[PlanRow], milestones: list[MilestoneRow], today: date) -> GoalFacts:
    days = [r for r in rows if r.horizon == "daily" and r.start is not None]
    in_days = round(sum(d.hours for d in days), 2)
    # The weeks span the whole deadline, the days only the near weeks, so the plan's size is the larger.
    total = max(in_days, round(sum(r.hours for r in rows if r.horizon == "weekly"), 2))
    done = round(sum(d.done_hours for d in days), 2)
    due = round(sum(d.hours for d in days if d.start < today), 2)
    remaining = round(max(0.0, total - done), 2)
    weeks_left = round(max(0, (deadline - today).days) / 7, 1) if deadline else None

    months = [f for r in sorted((r for r in rows if r.horizon == "monthly"), key=lambda r: r.start or date.max)
              if (f := _level(r, days, today, f"{r.start:%B %Y}" if r.start else r.title))]
    weeks = [f for r in sorted((r for r in rows if r.horizon == "weekly"), key=lambda r: r.start or date.max)
             if (f := _level(r, days, today, f"week of {r.start:%d %b}" if r.start else r.title))]
    miles = []
    for m in sorted(milestones, key=lambda m: m.target or date.max):
        before = [d for d in days if m.target and d.start <= m.target]
        miles.append(MilestoneFacts(
            id=m.id, title=m.title, target=m.target, done=m.done,
            days_left=(m.target - today).days if m.target else None,
            hours_before=round(sum(d.hours for d in before), 2), done_before=round(sum(d.done_hours for d in before), 2),
        ))
    return GoalFacts(goal_id, title, today, deadline, total, done, in_days, due, remaining, weeks_left,
                     _pct(done, total), _pct(min(due, total), total), months, weeks, miles)
