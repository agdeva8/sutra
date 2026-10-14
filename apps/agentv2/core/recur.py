"""Expanding a reminder rule into concrete days and times. Pure.

"3 a day for 5 days" is stored as a rule and expanded here, so the model supplies
frequency and duration and code supplies every date and time.
"""
from __future__ import annotations

from datetime import date, time, timedelta

from ..config import MAX_REMINDER_DAYS, REMINDER_TIMES


def expand_reminder(times_per_day: int, duration_days: int, start: date) -> tuple[list[date], list[time]]:
    per_day = min(max(times_per_day, 1), max(REMINDER_TIMES))
    days = [start + timedelta(days=i) for i in range(min(max(duration_days, 1), MAX_REMINDER_DAYS))]
    return days, list(REMINDER_TIMES[per_day])
