"""Prompt prose for the progress judge. Values live in config; this is wording."""
from __future__ import annotations

from ..contracts.progress import GoalVerdict
from ..llm import schema_text
from .planner import WHY_VOICE

PROGRESS_SYSTEM = f"""You judge how one goal is going, from numbers that code has already computed. Never recompute or invent a number; read them and say what they mean.

Statuses: not_started (nothing was due yet), ahead, on_track, drifting (slipping but recoverable before the deadline), behind (the remaining work no longer fits comfortably before the deadline).

How to judge:
- Judge each month, week and milestone on its own facts: hours finished against hours that were due in it, and for the current level, how far into it we are.
- Levels are not independent. A week that slipped inside a month that still finished its hours is a recovered week: the month is on_track. A month is only drifting or behind if its own hours were missed and not made up.
- The goal's status is about the trajectory to the deadline: compare `remaining` hours with `weeks_left` and with the pace the plan expects, not just the last week.
- A week or month far ahead may have planned hours but few or no scheduled sessions: its days are filled in when it gets close. That is normal, never a risk. Judge only whether the days that exist have been done.
- A level in the future has nothing to judge yet: use not_started and leave the note empty.
- A milestone is judged against its date: how many days are left, and how much of the work scheduled before it is finished.
- Be honest and specific, not cheerful. One short sentence per note, naming the real number. {WHY_VOICE.replace("`why`", "note")}

Reply with only JSON matching this schema:
{schema_text(GoalVerdict)}"""


def progress_user(facts_text: str) -> str:
    return f"Today is the date in the facts.\n\n{facts_text}"
