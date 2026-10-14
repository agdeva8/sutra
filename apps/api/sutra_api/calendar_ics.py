"""Render a user's plan as an iCalendar (RFC 5545) feed.

Pure: takes rows, returns text. No DB, no request — so the format can be checked
by printing it. Hand-written rather than a dependency because the subset we emit
is small: VEVENTs with a stable UID, an all-day or floating-time span, and an
optional VALARM.

**Stable UIDs are the whole sync story.** A subscribed calendar re-fetches this
feed and diffs by UID, so a replan that moves a step moves the event, and a step
the replan dropped disappears. A plan replan rewrites `plan_items` rows wholesale
(new ids), which the calendar sees as delete + add — correct, just not a "move".
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

PRODID = "-//Sutra//GoalCoach Plan Feed//EN"
CALENDAR_NAME = "Sutra plan"
#: Domain half of every UID. Must never change once feeds are subscribed —
#: a new UID is a new event, and every user would see their plan duplicated.
UID_DOMAIN = "sutra.app"
#: Hint to clients on how often to re-fetch. Apple honours it; Google ignores it.
REFRESH_INTERVAL = "PT1H"
#: Minutes before a timed block starts that the reminder fires.
TIMED_ALARM_MINUTES = 15
DONE_PREFIX = "✓ "
#: RFC 5545 §3.1: content lines are folded at 75 octets.
_FOLD_OCTETS = 75


@dataclass(frozen=True)
class FeedEvent:
    """One calendar entry. All-day when `start_time` is None, else floating local time.

    Floating (no TZID) on purpose: the plan stores wall-clock times with no zone,
    and a floating time shows at that wall-clock hour wherever the user is.
    """

    uid: str
    title: str
    start: date
    end: date | None = None  # inclusive last day for all-day spans
    start_time: time | None = None
    end_time: time | None = None
    description: str = ""
    done: bool = False


def _escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """Fold to 75 octets without splitting a UTF-8 character."""
    out: list[str] = []
    buf, size = "", 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        if size + n > _FOLD_OCTETS:
            out.append(buf)
            buf, size = " ", 1  # continuation lines start with one space
        buf += ch
        size += n
    out.append(buf)
    return "\r\n".join(out)


def _d(d: date) -> str:
    return d.strftime("%Y%m%d")


def _dt(d: date, t: time) -> str:
    return datetime.combine(d, t).strftime("%Y%m%dT%H%M%S")


def _event_lines(ev: FeedEvent, stamp: str) -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{ev.uid}@{UID_DOMAIN}",
        f"DTSTAMP:{stamp}",
        f"SUMMARY:{_escape((DONE_PREFIX if ev.done else '') + ev.title)}",
    ]
    if ev.start_time is None:
        # DTEND is exclusive for DATE values, hence the +1 day.
        last = ev.end if ev.end and ev.end >= ev.start else ev.start
        lines += [
            f"DTSTART;VALUE=DATE:{_d(ev.start)}",
            f"DTEND;VALUE=DATE:{_d(last + timedelta(days=1))}",
            "TRANSP:TRANSPARENT",  # an all-day plan step should not mark the day busy
        ]
    else:
        end_t = ev.end_time if ev.end_time and ev.end_time > ev.start_time else ev.start_time
        lines += [
            f"DTSTART:{_dt(ev.start, ev.start_time)}",
            f"DTEND:{_dt(ev.start, end_t)}",
        ]
    if ev.description:
        lines.append(f"DESCRIPTION:{_escape(ev.description)}")
    if ev.start_time is not None and not ev.done:
        lines += [
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            f"DESCRIPTION:{_escape(ev.title)}",
            f"TRIGGER:-PT{TIMED_ALARM_MINUTES}M",
            "END:VALARM",
        ]
    lines.append("END:VEVENT")
    return lines


def render_calendar(events: Iterable[FeedEvent], *, now: datetime) -> str:
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{CALENDAR_NAME}",
        f"NAME:{CALENDAR_NAME}",
        f"REFRESH-INTERVAL;VALUE=DURATION:{REFRESH_INTERVAL}",
        f"X-PUBLISHED-TTL:{REFRESH_INTERVAL}",
    ]
    for ev in events:
        lines += _event_lines(ev, stamp)
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
