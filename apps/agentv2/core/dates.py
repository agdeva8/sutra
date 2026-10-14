"""Turning the user's own words about a day into a date. Pure.

The model copies what the user said ("thursday", "tomorrow", "2026-11-04");
this module decides which calendar day that is. The model never emits a date it
worked out itself.
"""
from __future__ import annotations

import re
from datetime import date, time, timedelta

_RELATIVE = re.compile(r"in (\d{1,3}) (days?|weeks?|months?)")

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def calendar_text(today: date, days: int = 21) -> str:
    """The next few weeks as "Wed 14 Oct 2026 = 2026-10-14 (today)", one per line. Given to the model so
    it reads dates off a calendar rather than counting weekdays in its head."""
    rows = []
    for i in range(days):
        d = today + timedelta(days=i)
        rows.append(f"{d:%a %d %b %Y} = {d.isoformat()}" + (" (today)" if i == 0 else ""))
    return "\n".join(rows)


def parse_date(text: str, today: date) -> date | None:
    """A date the model wrote (ISO), or one of the user's own phrases as a fallback."""
    t = str(text).strip()
    try:
        return date.fromisoformat(t[:10])
    except ValueError:
        return resolve_day(t, today)


MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_DAY_MONTH = re.compile(r"(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]{3,9})(?:,? (\d{4}))?")
_MONTH_DAY = re.compile(r"([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?")
_END_OF = re.compile(r"(?:the )?end of ([a-z]{3,9})(?: (\d{4}))?")
_NEXT_WEEKDAY = re.compile(r"(?:next|this|coming) ([a-z]+)")


def _month_number(word: str) -> int | None:
    return MONTHS.index(word[:3]) + 1 if word[:3] in MONTHS else None


def _next_occurrence(month: int, day: int, year: int | None, today: date) -> date | None:
    """A calendar day the user named. With no year it is the next time that day comes round."""
    try:
        d = date(year or today.year, month, day)
    except ValueError:
        return None
    if year is None and d < today:
        try:
            d = date(today.year + 1, month, day)
        except ValueError:
            return None
    return d


def resolve_day(ref: str, today: date) -> date | None:
    """`today`, `tomorrow`, a weekday name (next occurrence, today included), "in N days/weeks/months", or an ISO date."""
    r = ref.strip().lower()
    if r == "today":
        return today
    if r == "tomorrow":
        return today + timedelta(days=1)
    if r in WEEKDAYS:
        return today + timedelta(days=(WEEKDAYS.index(r) - today.weekday()) % 7)
    m = _END_OF.fullmatch(r)
    if m and (mo := _month_number(m.group(1))):
        year = int(m.group(2)) if m.group(2) else today.year
        last = (date(year + (mo == 12), mo % 12 + 1, 1) - timedelta(days=1))
        return last if last >= today or m.group(2) else (date(year + 1 + (mo == 12), mo % 12 + 1, 1) - timedelta(days=1))
    for rx, order in ((_DAY_MONTH, "dm"), (_MONTH_DAY, "md")):
        m = rx.fullmatch(r)
        if m:
            day_s, mon_s = (m.group(1), m.group(2)) if order == "dm" else (m.group(2), m.group(1))
            mo = _month_number(mon_s)
            if mo:
                return _next_occurrence(mo, int(day_s), int(m.group(3)) if m.group(3) else None, today)
    m = _NEXT_WEEKDAY.fullmatch(r)
    if m and m.group(1) in WEEKDAYS:
        return today + timedelta(days=(WEEKDAYS.index(m.group(1)) - today.weekday()) % 7 or 7)
    m = _RELATIVE.fullmatch(r)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return today + timedelta(days=n * (7 if unit.startswith("week") else 30 if unit.startswith("month") else 1))
    if r in ("next week", "next monday"):
        return today + timedelta(days=(7 - today.weekday()) % 7 or 7)
    try:
        return date.fromisoformat(r)
    except ValueError:
        return None


def parse_hhmm(text: str) -> time | None:
    try:
        h, m = text.strip().split(":")
        return time(int(h), int(m))
    except (ValueError, AttributeError):
        return None
