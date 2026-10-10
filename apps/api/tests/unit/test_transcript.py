"""`render_transcript` — the conversation block the intake and plan prompts read.

Pure by construction: it takes message-shaped objects and returns a string, so
it is testable with no database and no driver, which is why the service keeps it
in `core/` rather than beside the code that loads the rows.
"""
from __future__ import annotations

from types import SimpleNamespace

from sutra_api.core.transcript import CONTEXT_MAX_CHARS, render_transcript


def _msg(role: str, content: str):
    return SimpleNamespace(role=role, content=content)


def test_lowercases_the_role():
    """`User:` at line start is a trap for the stub, not a style choice.

    `app/llm/client._user_message` finds the request with
    `re.findall(r"^User:\\s*(.+)$", user, re.M)` and takes the last match. A
    second line with that shape would be read as the request the moment a prompt
    template moves the real one earlier.
    """
    out = render_transcript([_msg("user", "I want to switch jobs")])
    assert out == "- user: I want to switch jobs"
    assert "User:" not in out


def test_is_oldest_first_and_skips_blanks():
    out = render_transcript(
        [_msg("user", "first"), _msg("coach", "   "), _msg("coach", "second")]
    )
    assert out.splitlines() == ["- user: first", "- coach: second"]


def test_collapses_whitespace_within_a_message():
    out = render_transcript([_msg("user", "two\n\n  lines   here")])
    assert out == "- user: two lines here"


def test_a_missing_role_renders_as_the_user():
    out = render_transcript([SimpleNamespace(role=None, content="hello")])
    assert out == "- user: hello"


def test_drops_whole_oldest_turns_over_the_cap():
    """Budgets drop whole lines. Slicing the string would leave a half-sentence
    the model reads as a truncated thought."""
    msgs = [_msg("user", "x" * 50) for _ in range(5)]
    out = render_transcript(msgs, limit_chars=120)
    assert all(line == "- user: " + "x" * 50 for line in out.splitlines())
    assert len(out.splitlines()) == 2


def test_nothing_renders_empty_not_none():
    """The prompts do `context or "none"`, so empty is the right sentinel —
    `None` would render as the literal string "None"."""
    assert render_transcript([]) == ""


def test_the_default_budget_is_positive():
    assert CONTEXT_MAX_CHARS > 0
