"""The chat for an entry the intake was unsure about.

Scoped to one entry and one job: settle what the note means, then hand the settled
text back to triage. It ends in the same place an unambiguous note starts, so the
gateway still does the writing (no second write path).
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import MAX_ENTRY_CHAT_TURNS
from ..contracts.triage import EntryChatReply
from ..core.context import Context
from ..llm import complete_json
from ..prompts.triage import ENTRY_CHAT_SYSTEM, entry_chat_user

MSG_UNREADABLE = "Couldn't follow that. Try again."


@dataclass
class ChatStep:
    #: The updated transcript as (role, text) pairs. Store it and pass it back next turn.
    turns: list[tuple[str, str]]
    reply: str
    #: Set once the entry is settled: the text to hand to triage.
    resolved: str | None = None
    error: str | None = None


def entry_chat(chat, note: str, turns: list[tuple[str, str]], user_message: str, ctx: Context) -> ChatStep:
    turns = [*turns, ("user", user_message)]
    asked = sum(1 for r, _ in turns if r == "assistant")
    reply = complete_json(
        chat, ENTRY_CHAT_SYSTEM,
        entry_chat_user(note, ctx.goal_titles, ctx.open_items, turns, asked < MAX_ENTRY_CHAT_TURNS), EntryChatReply,
    )
    if reply is None:
        return ChatStep(turns, MSG_UNREADABLE, error=MSG_UNREADABLE)
    turns.append(("assistant", reply.reply))
    return ChatStep(turns, reply.reply, resolved=reply.resolved or None)
