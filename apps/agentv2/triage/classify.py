"""The triage model call: one note in, one `TriageResult` out (or None)."""
from __future__ import annotations

from datetime import datetime

from ..contracts.triage import TriageResult
from ..core.context import Context
from ..core.dates import calendar_text
from ..llm import Image, complete_json
from ..prompts.triage import TRIAGE_SYSTEM, triage_user


_DAY = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _days(weekdays) -> str:
    return "/".join(_DAY[d] for d in weekdays)


def classify(chat, text: str, ctx: Context, now: datetime, images: list[Image] | None = None) -> TriageResult | None:
    user = triage_user(text, ctx.goal_titles, now.date().isoformat(), ctx.open_items, calendar_text(now.date()), {r.id: f"{r.title} ({_days(r.weekdays)} {r.start:%H:%M}-{r.end:%H:%M})" for r in ctx.recurring})
    return complete_json(chat, TRIAGE_SYSTEM, user, TriageResult, images)
