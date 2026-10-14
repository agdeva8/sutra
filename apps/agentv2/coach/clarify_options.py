"""Deterministic option chips for a clarifying question.

Ported from v1's `lib/chat/clarify-options.ts`.

**Why this exists at all.** A model asked to clarify produces free-text questions,
and free text means the user types a full answer to a question they could have
answered with one tap. The chips are the difference between a form and a
conversation.

The bank is **regex-keyed, not model-keyed**, and it is the *fallback*: options the model wrote under
its own question always win (`enrich`), because the model knows what it asked.

The bank is **domain-neutral and narrow**. v1's bank was tuned to job switches (relocation, lateral
moves, interview pipelines), which put "Open to relocating abroad" under a question about a wedding
venue. A chip set that does not fit the question is worse than none: it invites a wrong answer the
plan then builds on. So each pattern matches only a question whose answers are genuinely these, and
nothing here assumes a country, a currency, a job, or a life situation.
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
        # "How many hours a week can you give this?" -- weekly hours, never hours a day or a salary.
        re.compile(r"\bhow many hours\b.*\b(a|per|each|every) week\b|\bhours (a|per) week\b|\bweekly hours\b", re.I),
        ["2-4 hours a week", "5-7 hours a week", "8-10 hours a week", "More than 10 hours a week"],
        False,
    ),
    (
        # "Which days suit you best?" -- the one multi-select: several days can be true at once.
        re.compile(r"\b(which|what) days\b|\bbest days\b", re.I),
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        True,
    ),
    (
        # "What is your skill level / how much experience do you have with X?"
        # Not "current level" alone: "your current level of debt" must not get "Complete beginner".
        re.compile(r"\b(skill|experience) level\b|\bhow much experience\b|\bcomplete beginner\b", re.I),
        ["Complete beginner", "Some experience", "Fairly experienced", "Advanced"],
        False,
    ),
    (
        # "Is that deadline fixed?" -- about whether a date can move, not what the date is.
        re.compile(r"\b(deadline|date)\b.*\b(fixed|firm|hard|flexible|move)\b", re.I),
        ["Fixed, it cannot move", "Somewhat flexible", "No real deadline"],
        False,
    ),
]


def options_for(question: str) -> tuple[list[str], bool]:
    """`(options, multi)`. Empty when nothing matches, which is the norm.

    Only the **first** match wins: two chip sets on one question would render as a wall of buttons.
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
