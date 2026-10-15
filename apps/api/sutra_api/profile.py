"""The "about you" profile: its stored shape, validation, and the line the coach reads.

Asked once in the first-run flow (the Add Goal dialog shows it while the profile is unasked). Every
field is optional. `asked` is set the first time the step is shown and answered or skipped, so the
step is never shown again even when the user skipped every field.

Country and timezone are deliberately not here: timezone stays the product default
(`agentv2.config.USE_CLIENT_TIMEZONE`) and nothing in planning needs a country.

The planner reads the same JSON through `agentv2.core.profile` (`SqlStore.context`).
"""
from __future__ import annotations

import re

from agentv2.config import PROFILE_WEEKDAY_KEYS
from agentv2.core.profile import UserProfile, waking_conflict

#: "HH:MM", 24-hour.
CLOCK_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
#: Weekly hours for goals above this are not a real week (168h in a week, minus sleep).
MAX_WEEKLY_GOAL_HOURS = 112
PROFILE_CLOCK_FIELDS = ("work_start", "work_end", "wake", "sleep")
PROFILE_DAY_FIELDS = ("work_days", "rest_days")
PROFILE_ASKED = "asked"
PROFILE_WEEKLY_HOURS = "weekly_goal_hours"
DAY_NAMES = {"mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun"}


class ProfileError(ValueError):
    """A field the client sent that cannot be stored."""


def clean_profile(raw: dict) -> dict:
    """The storable profile from a request body. Unknown keys are dropped; empty values mean skipped."""
    if not isinstance(raw, dict):
        raise ProfileError("profile must be an object")
    out: dict = {PROFILE_ASKED: True}
    for key in PROFILE_CLOCK_FIELDS:
        value = raw.get(key)
        if value in (None, ""):
            continue
        if not isinstance(value, str) or not CLOCK_RE.match(value):
            raise ProfileError(f"{key} must be HH:MM")
        out[key] = value
    for key in PROFILE_DAY_FIELDS:
        value = raw.get(key)
        if value in (None, ""):
            continue
        if not isinstance(value, list) or any(v not in PROFILE_WEEKDAY_KEYS for v in value):
            raise ProfileError(f"{key} must be a list of {', '.join(PROFILE_WEEKDAY_KEYS)}")
        if value:
            out[key] = [d for d in PROFILE_WEEKDAY_KEYS if d in value]
    hours = raw.get(PROFILE_WEEKLY_HOURS)
    if hours not in (None, ""):
        if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 0 < hours <= MAX_WEEKLY_GOAL_HOURS:
            raise ProfileError(f"{PROFILE_WEEKLY_HOURS} must be between 0 and {MAX_WEEKLY_GOAL_HOURS}")
        out[PROFILE_WEEKLY_HOURS] = hours
    # The same check a person would make by eye: refuse a profile that contradicts itself, with the reason.
    conflict = waking_conflict(UserProfile.from_json(out))
    if conflict:
        raise ProfileError(conflict)
    return out


def _days(keys: list[str]) -> str:
    return ", ".join(DAY_NAMES[k] for k in keys if k in DAY_NAMES)


def profile_lines(profile: dict | None) -> list[str]:
    """What the user told us, one fact per line, for the coach's context. Empty when nothing was said."""
    p = profile or {}
    lines: list[str] = []
    if p.get("work_days") or p.get("work_start"):
        when = f" {p['work_start']}-{p['work_end']}" if p.get("work_start") and p.get("work_end") else ""
        lines.append(f"- Work or study: {_days(p.get('work_days') or []) or 'days not given'}{when}")
    if p.get("wake") or p.get("sleep"):
        lines.append(f"- Wakes {p.get('wake') or '(not given)'}, sleeps {p.get('sleep') or '(not given)'}")
    if p.get(PROFILE_WEEKLY_HOURS):
        lines.append(f"- Can genuinely give {p[PROFILE_WEEKLY_HOURS]:g} hours a week to goals, in total")
    if p.get("rest_days"):
        lines.append(f"- Keep free of goal work: {_days(p['rest_days'])}")
    return lines


#: Profile field -> the question topic it answers (`agentv2.coach.questions.PROFILE_TOPICS`).
FIELD_TOPICS = {PROFILE_WEEKLY_HOURS: "weekly_goal_hours", "work_start": "work_hours", "wake": "sleep", "sleep": "sleep"}


def answered_topics(profile: dict | None) -> set[str]:
    """The question topics the profile already answers, so the coach does not ask them."""
    p = profile or {}
    return {topic for key, topic in FIELD_TOPICS.items() if p.get(key)}
