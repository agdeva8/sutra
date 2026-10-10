"""Date math — pure, UTC-only, no timezone drift.

Every function takes and returns ISO `YYYY-MM-DD` strings. Nothing here imports
the DB, the network, or an LLM client.
"""
from __future__ import annotations

import datetime as _dt

WEEKDAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def parse(iso: str) -> _dt.date:
    """ISO date string → `date`. Raises `ValueError` on anything else."""
    return _dt.date.fromisoformat(iso)


def iso(d: _dt.date) -> str:
    return d.isoformat()


def add_days(iso_date: str, n: int) -> str:
    return iso(parse(iso_date) + _dt.timedelta(days=n))


def days_between(a_iso: str, b_iso: str) -> int:
    """Whole days from `a` to `b`. Negative when `b` precedes `a`."""
    return (parse(b_iso) - parse(a_iso)).days


def weekday_of(iso_date: str) -> str:
    """`mon`..`sun`."""
    return WEEKDAYS[parse(iso_date).weekday()]


def weekday_index(iso_date: str) -> int:
    """0 = Monday .. 6 = Sunday."""
    return parse(iso_date).weekday()


def iso_week(iso_date: str) -> int:
    """ISO week number — the unit the shared weekly budget is enforced over."""
    return parse(iso_date).isocalendar().week


def iso_year_week(iso_date: str) -> tuple[int, int]:
    """`(iso_year, iso_week)` — weeks are only comparable within a year."""
    c = parse(iso_date).isocalendar()
    return (c.year, c.week)


def iter_dates(start_iso: str, end_iso: str) -> list[str]:
    """Inclusive range. Empty when `end` precedes `start`."""
    n = days_between(start_iso, end_iso)
    if n < 0:
        return []
    return [add_days(start_iso, i) for i in range(n + 1)]


def round_half_up(x: float) -> int:
    """Round half away from zero — deterministic, unlike banker's rounding."""
    import math

    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


def round1(x: float) -> float:
    return round_half_up(x * 10) / 10.0


def today_utc() -> str:
    return iso(_dt.datetime.now(_dt.timezone.utc).date())


def now_utc() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
