"""The recent conversation, rendered for a prompt.

Pure — no `store/`, no `db`, no FastAPI — so the formatting rules are testable
without a database, which is the only way this gets covered at all: anything
touching JSONB or ARRAY needs real Postgres in this service.

It lives here rather than in `planner.py` because `planner.py` imports
`sqlalchemy.ext.asyncio`, and a pure string formatter should not need a driver
installed to be exercised. Three callers render a transcript — the intake
prompt, the plan prompt, and the agent's own TUI — and one function is what
keeps them from drifting.
"""
from __future__ import annotations

from typing import Any, Iterable

#: How many recent turns to fold in. Small on purpose: both prompts that read
#: this also carry the goal, the availability and the blockers, and an unbounded
#: history would crowd out the constraints that actually decide the plan.
CONTEXT_TURNS = 12

#: A ceiling on the rendered history, in characters. Whole newest turns are kept
#: and whole oldest turns are dropped, so no line is ever cut mid-sentence.
CONTEXT_MAX_CHARS = 4000


def render_transcript(
    messages: Iterable[Any], *, limit_chars: int = CONTEXT_MAX_CHARS
) -> str:
    """Recent turns as `- role: text` lines, oldest first.

    Lowercase `- user:` rather than `User:` on purpose. `app/llm/client.py`
    locates the request inside a rendered prompt with
    `re.findall(r"^User:\\s*(.+)$", user, re.M)` and takes the last match, so a
    second line matching that shape is a trap laid for whoever next edits the
    prompt templates.

    A message with no role renders as the user's — the only role where dropping
    the speaker is harmless, since the alternative is a line the model reads as
    unattributed.
    """
    lines: list[str] = []
    for m in messages:
        text = " ".join((getattr(m, "content", "") or "").split())
        if not text:
            continue
        lines.append(f"- {getattr(m, 'role', '') or 'user'}: {text}")

    # Drop whole turns from the oldest end rather than slicing the string, which
    # would leave a half-sentence the model reads as a truncated thought.
    while lines and len("\n".join(lines)) > limit_chars:
        lines.pop(0)
    return "\n".join(lines)
