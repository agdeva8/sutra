"""Crisis signals: when a message means "stop planning and respond with care".

The prompt (`prompts.GUARDRAILS`) tells the model what to do. This is the code half: when a message
matches, the turn must not force a tools block (the `refine` stage) or a question card on the person,
whatever the model replied. Deliberately broad: a false positive costs one turn without a plan card,
a false negative pushes a plan at someone in danger.
"""
from __future__ import annotations

import re

CRISIS_PATTERN = re.compile(
    r"\b(kill(ing)? myself|end(ing)? (it all|my life)|suicid\w*|self[- ]?harm\w*|hurt(ing)? myself|"
    r"don'?t want to (live|be alive|wake up)|no reason to live|want to die|better off dead|"
    r"cut(ting)? myself|overdos\w*|not safe (at home|right now)|can'?t go on)\b",
    re.I,
)


def signals_crisis(text: str) -> bool:
    return bool(CRISIS_PATTERN.search(text or ""))
