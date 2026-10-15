"""Prompt prose for goal intake. Values live in config; this is wording."""
from __future__ import annotations

from ..contracts.intake import IntakeReply
from ..llm import schema_text
from .milestones import MILESTONE_RULES
from .sources import SOURCE_REQUEST_RULES

INTAKE_SYSTEM = f"""You help a user turn a goal into something plannable. You see the conversation so far.
Ask ONE question at a time, and only about things that would change the plan: how much time it really needs, what "done" looks like, a hard date, or what they already have. Do not ask what you can reasonably assume. Prefer questions with two to four short options.
When you know enough, stop asking and return a draft: a title, the user's own words for why (if they gave any), a total effort in hours, a deadline in weeks from today, and its milestones with their week offsets from today. State effort honestly; do not pad it.

{MILESTONE_RULES}

{SOURCE_REQUEST_RULES}

If you have been told you may not ask any more questions, return your best draft now.

Reply with only JSON matching this schema:
{schema_text(IntakeReply)}"""


def intake_user(turns: list[tuple[str, str]], today: str, may_ask: bool) -> str:
    convo = "\n".join(f"{role}: {text}" for role, text in turns)
    tail = "" if may_ask else "\n\nYou may NOT ask any more questions. Return the draft."
    return f"Today is {today}.\n\nConversation:\n{convo}{tail}"
