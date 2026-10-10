"""TUI helper tests — the bits with logic in them.

The prompt loop itself needs a terminal, but `take_answer` is where the
"type a number to pick an option" behaviour lives, and it is the fix for a real
bug: typing a bare answer used to be routed as a NEW plan message, so the agent
re-asked the same question forever.
"""
from __future__ import annotations

from app.tui import Session, prompt_hint, take_answer


def _q(qid="hours", options=("3–5", "6–10", "11–15", "16+")):
    return {"id": qid, "question": "How many hours a week?", "options": list(options)}


def test_a_bare_number_selects_that_option():
    s = Session()
    s.pending = [_q()]
    take_answer(s, "2")
    assert s.answers == [{"id": "hours", "answer": "6–10"}]
    assert s.pending == []


def test_free_text_is_taken_literally_so_options_are_not_a_cage():
    s = Session()
    s.pending = [_q()]
    take_answer(s, "about 12, evenings only")
    assert s.answers[0]["answer"] == "about 12, evenings only"


def test_a_number_out_of_range_falls_back_to_the_literal():
    s = Session()
    s.pending = [_q()]
    take_answer(s, "9")
    assert s.answers[0]["answer"] == "9"


def test_answers_are_consumed_in_order():
    s = Session()
    s.pending = [_q("domain", ("software engineering", "data / ML")), _q("hours")]
    take_answer(s, "2")
    take_answer(s, "16+")
    assert s.answers == [
        {"id": "domain", "answer": "data / ML"},
        {"id": "hours", "answer": "16+"},
    ]
    assert s.pending == []


def test_the_prompt_shows_which_question_is_open():
    s = Session()
    assert "[" not in prompt_hint(s)
    s.pending = [_q("domain")]
    assert "domain" in prompt_hint(s)


def test_taking_an_answer_with_nothing_pending_is_a_no_op():
    s = Session()
    take_answer(s, "whatever")
    assert s.answers == []
