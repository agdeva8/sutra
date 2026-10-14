"""Deterministic option chips for a clarifying question.

Ported from v1's `lib/chat/clarify-options.ts`.

**Why this exists at all.** A model asked to clarify produces free-text questions,
and free text means the user types a full answer to a question they could have
answered with one tap. The chips are the difference between a form and a
conversation.

The bank is **regex-keyed, not model-keyed**: the model does not choose its
options, and it does not have to be told about them. A question about relocation
gets relocation chips because of how it is worded, which means a prompt change
cannot silently strip the chips off a question.

The patterns are tuned to be *specific*. A generic "how many hours?" chip on a
salary question is worse than no chip — it invites a wrong answer that the plan
then builds on.
"""
from __future__ import annotations

import re

#: `(pattern, options, multi)`.
#:
#: `multi` marks a question where several answers can be true at once — the
#: availability grid is the only one, and it is the only place a single-select
#: would lose information.
_BANK: list[tuple[re.Pattern[str], list[str], bool]] = [
    (
        re.compile(r"\b(relocat|which cit|where.*(based|live))\b", re.I),
        ["Only my current city", "Anywhere in the country", "Open to relocating abroad", "Fully remote is fine"],
        False,
    ),
    (
        re.compile(r"\b(lateral|step up|seniority|level|promotion|title)\b", re.I),
        ["A lateral move is fine", "I want a step up", "I'd take either", "Not sure yet"],
        False,
    ),
    (
        re.compile(r"\b(notice period|how soon|when can you start|available to start)\b", re.I),
        ["Immediately", "Within a month", "Two to three months", "No fixed date"],
        False,
    ),
    (
        re.compile(
            r"\b(hours (a|per) week|how many hours|weekly hours|time.*commit|bandwidth)\b",
            re.I,
        ),
        ["2–4 hours", "5–7 hours", "8–10 hours", "More than 10 hours"],
        False,
    ),
    (
        re.compile(r"\b(pipeline|interview|how many companies|applications)\b", re.I),
        ["Just starting out", "A few conversations", "Several interviews running", "Waiting on an offer"],
        False,
    ),
    (
        re.compile(r"\b(function|role|switch.*(field|function)|different industry|career change)\b", re.I),
        ["Stay in the same function", "Adjacent function", "Something completely different", "Open to anything"],
        False,
    ),
    (
        re.compile(r"\b(which days|what days|availability|when are you free|best days)\b", re.I),
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        # The one multi-select: several days can be true, and picking one would
        # throw away the rest of the answer.
        True,
    ),
]


def options_for(question: str) -> tuple[list[str], bool]:
    """`(options, multi)`. Empty when nothing matches — which is the norm.

    Only the **first** match wins. Two chip sets on one question would render as
    a wall of buttons, and the bank is ordered most-specific first.
    """
    text = question or ""
    for pattern, options, multi in _BANK:
        if pattern.search(text):
            return list(options), multi
    return [], False


def enrich(questions: list[dict]) -> list[dict]:
    """Add chips to any question that has none.

    A model may already have supplied `options`; those win, because it knows
    what it was asking. This only fills the gap.
    """
    out: list[dict] = []
    for index, question in enumerate(questions or [], start=1):
        row = dict(question) if isinstance(question, dict) else {"question": str(question)}
        row.setdefault("id", f"q{index}")
        existing = row.get("options")
        if not isinstance(existing, list) or not existing:
            options, multi = options_for(str(row.get("question") or ""))
            row["options"] = options
            if multi:
                row["multi"] = True
        out.append(row)
    return out
