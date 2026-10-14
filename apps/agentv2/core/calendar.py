"""Free hours by week and by day, from the free windows. Pure."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from .context import Context
from .slots import Window, free_windows


def week_start(d: date) -> date:
    """The Monday of `d`'s week."""
    return d - timedelta(days=d.weekday())


def free_hours_by_week(ctx: Context, now: datetime, n_weeks: int) -> dict[date, float]:
    """Free hours per week, keyed by Monday. The first week counts only from `now`."""
    first = week_start(now.date())
    out = {first + timedelta(weeks=i): 0.0 for i in range(n_weeks)}
    for w in free_windows(ctx, now, days=n_weeks * 7 + 7):
        k = week_start(w.day)
        if k in out:
            out[k] += w.hours
    return out


def free_hours_by_day(ctx: Context, now: datetime, week: date) -> dict[date, float]:
    out = {week + timedelta(days=i): 0.0 for i in range(7)}
    for w in free_windows(ctx, now, days=(week - now.date()).days + 8 if week >= now.date() else 8):
        if w.day in out:
            out[w.day] += w.hours
    return {d: h for d, h in out.items() if d >= now.date()}


def windows_on(ctx: Context, now: datetime, day: date) -> list[Window]:
    return [w for w in free_windows(ctx, now, days=max((day - now.date()).days + 1, 1)) if w.day == day]
