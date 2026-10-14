"""The user's "now". Pure.

Every date the agent works out ("today", "tomorrow", which hours are still free)
hangs off one `now`, so it must be the user's local time, not the server's. The
caller passes the user's IANA zone; an unknown or missing one falls back to
`DEFAULT_TIMEZONE`, and while `USE_CLIENT_TIMEZONE` is off the zone is always `DEFAULT_TIMEZONE` (IST). The result is naive local time, which is what the planner
works in (a slot at 18:00 means 18:00 where the user is).
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import DEFAULT_TIMEZONE, USE_CLIENT_TIMEZONE


def local_now(tz: str | None = None) -> datetime:
    try:
        zone = ZoneInfo((tz if USE_CLIENT_TIMEZONE else None) or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    return datetime.now(zone).replace(tzinfo=None)
