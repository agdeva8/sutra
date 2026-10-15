"""The "about you" profile, turned into planner settings. Pure.

The profile is what the user said once in the first-run flow: when they work or study, when they
wake and sleep, how many hours a week they can really give to goals, and which days they want kept
free of goal work. Every field is optional, because every one of them could have been skipped.

What it changes in planning:

* wake to sleep becomes the active window (nothing is scheduled while they sleep);
* work or study hours become busy spans on their weekdays (nothing is scheduled over them);
* weekly hours become a cap on how much goal work one week may hold; how that is split across the
  days is the planner's decision, not an even share (a user may want one long session, or five short ones);
* rest days become days with no capacity.

A span that crosses midnight (a night shift, a 2am bedtime) is split at the day boundary, which is
how a night-shift worker gets a correct plan without the planner learning about overnight days.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time

from ..config import ACTIVE_WINDOW_END, ACTIVE_WINDOW_START, DEFAULT_DAILY_CAPACITY_HOURS, END_OF_DAY, MIN_AWAKE_HOURS, PROFILE_WEEKDAY_KEYS

Span = tuple[time, time]
DAY_START = time(0, 0)


@dataclass(frozen=True)
class UserProfile:
    """What the user told us about their week. None or empty means they skipped it."""

    work_days: tuple[int, ...] = ()
    work_start: time | None = None
    work_end: time | None = None
    wake: time | None = None
    sleep: time | None = None
    weekly_goal_hours: float | None = None
    rest_days: tuple[int, ...] = ()

    @classmethod
    def from_json(cls, raw: dict | None) -> "UserProfile":
        """From the stored JSON. Lenient: a malformed field is treated as skipped, never an error."""
        raw = raw or {}
        hours = raw.get("weekly_goal_hours")
        return cls(
            work_days=_days(raw.get("work_days")),
            work_start=_clock(raw.get("work_start")),
            work_end=_clock(raw.get("work_end")),
            wake=_clock(raw.get("wake")),
            sleep=_clock(raw.get("sleep")),
            weekly_goal_hours=float(hours) if isinstance(hours, (int, float)) and hours > 0 else None,
            rest_days=_days(raw.get("rest_days")),
        )


@dataclass(frozen=True)
class PlannerProfile:
    """The profile in the planner's terms."""

    #: The spans of a day the agent may schedule into.
    active_spans: tuple[Span, ...] = ((ACTIVE_WINDOW_START, ACTIVE_WINDOW_END),)
    #: weekday -> spans the user is busy every week (work or study).
    busy_weekly: dict[int, tuple[Span, ...]] = field(default_factory=dict)
    #: weekday -> hours of goal work, or None when no rest days were named (every day has the usual capacity).
    weekday_hours: dict[int, float] | None = None
    #: The most goal work one week may hold, or None when the user gave no weekly figure.
    weekly_cap_hours: float | None = None


def _clock(value) -> time | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return time.fromisoformat(value)
    except ValueError:
        return None


def _days(value) -> tuple[int, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(sorted({PROFILE_WEEKDAY_KEYS.index(v) for v in value if v in PROFILE_WEEKDAY_KEYS}))


def split_span(start: time, end: time) -> tuple[tuple[Span, ...], tuple[Span, ...]]:
    """`(today's spans, tomorrow's spans)` for start..end, splitting at midnight when it wraps."""
    if start < end:
        return ((start, end),), ()
    if start == end:
        return (), ()
    today = ((start, END_OF_DAY),)
    tomorrow = ((DAY_START, end),) if end > DAY_START else ()
    return today, tomorrow


def active_spans(wake: time | None, sleep: time | None) -> tuple[Span, ...]:
    """The awake part of a day. A sleep time after midnight leaves the early hours awake too."""
    start = wake or ACTIVE_WINDOW_START
    end = sleep or ACTIVE_WINDOW_END
    if start < end:
        return ((start, end),)
    if start == end:
        return ((ACTIVE_WINDOW_START, ACTIVE_WINDOW_END),)
    # Awake from wake to midnight and from midnight until sleep (sleep is after midnight).
    return ((DAY_START, end), (start, END_OF_DAY))


def _hours(spans: tuple[Span, ...]) -> float:
    return sum((e.hour * 60 + e.minute) - (s.hour * 60 + s.minute) for s, e in spans) / 60


def waking_conflict(profile: UserProfile) -> str | None:
    """Why the wake and sleep times cannot be right, or None. The check a person would make by eye:
    work hours must fall inside waking hours, and a waking day must be long enough to be a day.

    Only when both wake and sleep were given; a skipped field is not a contradiction."""
    if not (profile.wake and profile.sleep):
        return None
    awake = active_spans(profile.wake, profile.sleep)
    span = f"{profile.wake:%H:%M} to {profile.sleep:%H:%M}"
    if profile.work_start and profile.work_end and profile.work_start != profile.work_end:
        today, tomorrow = split_span(profile.work_start, profile.work_end)
        if any(not any(a <= s and e <= b for a, b in awake) for s, e in (*today, *tomorrow)):
            return (f"Your work hours ({profile.work_start:%H:%M} to {profile.work_end:%H:%M}) fall outside the hours you are "
                    f"awake ({span}). Did you swap wake and sleep, or mean different times?")
    if _hours(awake) < MIN_AWAKE_HOURS:
        return f"That leaves you awake for only {_hours(awake):g} hours ({span}). Check your wake and sleep times."
    return None


def to_planner(profile: UserProfile) -> PlannerProfile:
    busy: dict[int, list[Span]] = {}
    if profile.work_start and profile.work_end and profile.work_days:
        today, tomorrow = split_span(profile.work_start, profile.work_end)
        for day in profile.work_days:
            busy.setdefault(day, []).extend(today)
            if tomorrow:
                busy.setdefault((day + 1) % 7, []).extend(tomorrow)
    weekday_hours: dict[int, float] | None = None
    if profile.rest_days and len(profile.rest_days) < 7:
        # Rest days get nothing; every other day holds the usual capacity. The weekly figure, if any, is a
        # separate cap, so the planner decides how the week's hours fall across those days.
        weekday_hours = {d: DEFAULT_DAILY_CAPACITY_HOURS for d in range(7) if d not in profile.rest_days}
    return PlannerProfile(
        # Contradictory wake and sleep times are not planned around: a plan in hours the person is asleep is
        # worse than one in the usual day. (Saving such a profile is refused, so this is for older stored ones.)
        active_spans=active_spans(None, None) if waking_conflict(profile) else active_spans(profile.wake, profile.sleep),
        busy_weekly={d: tuple(sorted(s)) for d, s in busy.items()},
        weekday_hours=weekday_hours,
        weekly_cap_hours=profile.weekly_goal_hours,
    )
