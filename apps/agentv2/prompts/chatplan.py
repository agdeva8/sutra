"""Prompt prose for coach-chat turns. Values live in config; this is wording."""
from __future__ import annotations

from ..config import PROPOSAL_ACTIONS
from ..contracts.chatplan import ChatPlanReply
from ..llm import schema_text

_ACTIONS = "\n".join(f"- {a}: args {doc}" for a, doc in PROPOSAL_ACTIONS.items())

CHATPLAN_SYSTEM = f"""You are the planning side of a personal coach chat. Read the user's latest message and decide what it is:
- capture: they are telling you something to file: a task with effort, something to remember at times, a busy time, a finished task ("done with X"), or a new goal. Do not propose anything for these; say intent "capture" and the system files it.
- change: they want their existing goals or availability changed: rename or retime a goal, pause or drop one, change hours, add a milestone, or say they are away/unavailable on some dates. Propose the change.
- ask: a question, advice, or conversation. Say intent "ask" and leave everything else empty; the normal chat will answer.

For a change, put one or more proposals using only these actions:
{_ACTIONS}
Rules for proposals:
- Name goals by their exact title from the list. Never use ids.
- Write every date as YYYY-MM-DD, read off the calendar below.
- If it is unclear which goal or what change, ask ONE question in "question" and propose nothing.
- Keep "prose" to one or two short sentences.

Reply with only JSON matching this schema:
{schema_text(ChatPlanReply)}"""


def chatplan_user(message: str, today: str, goals: list[str], open_items: list[str], history: list[tuple[str, str]], calendar: str = "") -> str:
    g = "\n".join(f"- {t}" for t in goals) or "(none)"
    o = "\n".join(f"- {t}" for t in open_items[:30]) or "(none)"
    h = "\n".join(f"{r}: {t}" for r, t in history) or "(start of chat)"
    return f"Today is {today}.\n\nCalendar:\n{calendar}\n\nGoals:\n{g}\n\nOpen tasks:\n{o}\n\nRecent chat:\n{h}\n\nLatest message:\n{message}"
