"""One coach-chat turn, decided by the model and checked by code.

The model only says what the message *is*. What happens next is code: a capture is
filed through the same triage pipeline as a Scratch note, a change becomes proposals
in the confirm flow's vocabulary after every goal name and date has been checked, and
anything else is handed back to the ordinary chat. Proposals are never applied here:
the user confirms them, as before.
"""
from __future__ import annotations

import asyncio
from datetime import datetime

from ..config import CHAT_HISTORY_TURNS, PROPOSAL_ACTIONS, PROPOSAL_DATE_ARGS
from ..contracts import Origin
from ..contracts.chatplan import ChatPlanReply, ChatTurn
from ..core.dates import calendar_text, parse_date
from ..core.plan_context import plan_block
from ..gateway import Store
from ..llm import complete_json
from ..prompts.chatplan import CHATPLAN_SYSTEM, chatplan_user
from ..triage.process import HANDLED, NEEDS_INPUT, process_entry

NOT_PLANNED = ChatTurn(kind="not_planned")


def _clean_proposal(action: str, args: dict, goals: dict[str, str], today) -> tuple[dict | None, str | None]:
    """(proposal args, None) or (None, why not). Keeps only known arguments, resolves goal names and dates."""
    if action not in PROPOSAL_ACTIONS:
        return None, f"I can't do “{action}” from chat."
    allowed = {a.strip("?") for a in PROPOSAL_ACTIONS[action].replace(" ", "").split(",")}
    clean = {k: v for k, v in args.items() if k in allowed and v not in (None, "")}

    if "goal_title" in allowed:
        by_title = {t.lower(): t for t in goals.values()}
        match = by_title.get(str(clean.get("goal_title", "")).strip().lower())
        if match is None:
            return None, "Which goal do you mean?"
        clean["goal_title"] = match
    for key in PROPOSAL_DATE_ARGS:
        if key in clean:
            resolved = parse_date(str(clean[key]), today)
            if resolved is None:
                return None, f"I couldn't tell which day “{clean[key]}” is. Which date?"
            if resolved < today and key != "start_date":
                return None, f"{resolved:%d %b %Y} has already passed. Which date did you mean?"
            clean[key] = resolved.isoformat()
    if action == "add_blocker" and "start_date" not in clean:
        return None, "When does it start?"
    return clean, None


async def chat_turn(
    chat, store: Store, message: str, history: list[tuple[str, str]], now: datetime, origin: Origin
) -> ChatTurn:
    ctx = await store.context()
    goals = ctx.goal_titles
    reply = await asyncio.to_thread(
        complete_json, chat, CHATPLAN_SYSTEM,
        chatplan_user(message, now.date().isoformat(), list(goals.values()), list(ctx.open_items.values()),
                      history[-CHAT_HISTORY_TURNS:], calendar_text(now.date()), plan_block(ctx, now)),
        ChatPlanReply,
    )
    if reply is None:
        return NOT_PLANNED  # an unreadable reply must never block the ordinary chat

    if reply.question and not reply.proposals:
        return ChatTurn(kind="clarify", prose=reply.prose, questions=[reply.question])

    if reply.intent == "capture":
        out = await process_entry(chat, store, message, now, origin)
        if out.status == NEEDS_INPUT:
            return ChatTurn(kind="clarify", prose=reply.prose, questions=[out.question or "Can you say more?"])
        if out.status == HANDLED and out.lines:
            return ChatTurn(kind="ok", prose=reply.prose or "Done.", applied=out.lines)
        return NOT_PLANNED

    if reply.intent == "change" and reply.proposals:
        cleaned, question = [], None
        for p in reply.proposals:
            args, why = _clean_proposal(p.action, p.args, goals, now.date())
            if args is None:
                question = why
                break
            cleaned.append({"action": p.action, "args": args})
        if question:
            return ChatTurn(kind="clarify", prose="", questions=[question])
        return ChatTurn(kind="ok", prose=reply.prose, proposals=cleaned)

    return NOT_PLANNED
