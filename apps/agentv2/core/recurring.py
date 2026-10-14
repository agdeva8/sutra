"""A repeating commitment ("class every Tuesday and Thursday 6 to 8pm, until 20 Dec") as dated occurrences. Pure."""
from __future__ import annotations

from datetime import date, time, timedelta

from ..config import RECURRING_HORIZON_DAYS


def occurrences(
    weekdays: tuple[int, ...] | list[int], start: time, end: time, start_date: date, until: date | None,
    today: date, horizon_days: int = RECURRING_HORIZON_DAYS,
) -> list[tuple[date, time, time]]:
    """Each day the rule falls on from today (or its own start) to the horizon (or its end date)."""
    first = max(start_date, today)
    last = today + timedelta(days=horizon_days)
    if until is not None:
        last = min(last, until)
    out = []
    d = first
    while d <= last:
        if d.weekday() in weekdays:
            out.append((d, start, end))
        d += timedelta(days=1)
    return out
