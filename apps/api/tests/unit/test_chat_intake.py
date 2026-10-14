"""The Add-goal chat: the interview prompt, question extraction with their answer chips, and the plan handoff."""
import asyncio

from sutra_api.api import chat as chat_routes
from agentv2.coach.clarify_options import options_for
from agentv2.coach.prompts import INTAKE_MODE, KIND_ADD_GOAL, mode_hint
from agentv2.coach.tools_block import extract_clarifying_questions


def _hint(**kw):
    base = dict(proactive_propose=False, clarify=False, auto_answer=False)
    return mode_hint(**{**base, **kw})


def test_add_goal_interviews_unless_auto_answer():
    assert _hint(scoped_kind=KIND_ADD_GOAL) == INTAKE_MODE
    assert _hint(scoped_kind=KIND_ADD_GOAL, auto_answer=True) != INTAKE_MODE
    assert _hint(scoped_kind="general") != INTAKE_MODE


def test_bullets_under_a_question_become_its_options():
    text = "Two things.\n\n1. Where are you today?\n   - Same role\n   - New industry\n\n2. How many hours can you give?"
    qs = extract_clarifying_questions(text)
    assert [q["question"] for q in qs] == ["Where are you today?", "How many hours can you give?"]
    assert qs[0]["options"] == ["Same role", "New industry"]
    assert qs[1]["options"] == []


def test_bold_markers_are_stripped_from_questions():
    qs = extract_clarifying_questions("1. **What is the deadline?**")
    assert qs[0]["question"] == "What is the deadline?"


def test_chips_are_domain_neutral_and_only_attach_when_they_fit():
    assert options_for("What stopped you the last time you tried to move?") == ([], False)
    # The career-only banks are gone: location, seniority and pipeline questions get no chips.
    assert options_for("Where are you based?") == ([], False)
    assert options_for("Are you after a lateral move or a step up?") == ([], False)
    assert options_for("What is your current level of debt?") == ([], False)
    assert options_for("How many hours a day do you sleep?") == ([], False)
    assert options_for("How many hours a week can you give this?")[0]
    assert options_for("Which days suit you best?") == (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], True)


def test_options_the_model_wrote_win_over_the_bank():
    from agentv2.coach.clarify_options import enrich

    out = enrich([{"question": "How many hours a week can you give?", "options": ["1h", "3h"]}])
    assert out[0]["options"] == ["1h", "3h"]


def test_plan_hands_add_goal_to_the_chat():
    class _Req:
        async def json(self):
            return {"message": "switch jobs", "kind": chat_routes.KIND_ADD_GOAL}

    out = asyncio.run(chat_routes.chat_plan(_Req(), session=None, user=None))
    assert out["status"] == "not_planned"


def test_pdf_text_layer_is_read_and_a_broken_pdf_reads_as_unreadable():
    from sutra_api.core.extract import PDF_NO_TEXT, extract_text

    text, pending = extract_text(filename="x.pdf", content_type="application/pdf", data=b"not a pdf")
    assert (text, pending) == (PDF_NO_TEXT, False)


def test_attached_sources_reach_the_prompt():
    from types import SimpleNamespace

    rows = [SimpleNamespace(url="", original_filename="syllabus.txt", text_excerpt="Week 1: arrays")]

    async def fake(_session, *, user_id, ids):
        return rows

    chat_routes.repo.sources_by_ids, saved = fake, chat_routes.repo.sources_by_ids
    try:
        block = asyncio.run(chat_routes._sources_block(None, user_id="u", source_ids=["s1"]))
    finally:
        chat_routes.repo.sources_by_ids = saved
    assert "syllabus.txt" in block and "Week 1: arrays" in block


def test_inline_lettered_options_attach_to_their_question_and_the_list_is_not_repeated():
    from agentv2.coach.tools_block import strip_question_list

    text = "Intro.\n\n1. Where are you today? (a) just starting, (b) applying now)\n2. How many hours?"
    qs = extract_clarifying_questions(text)
    assert qs[0]["question"] == "Where are you today?"
    assert qs[0]["options"] == ["just starting", "applying now"]
    assert strip_question_list(text) == "Intro."


def test_a_reply_is_not_cut_off_at_the_end():
    from agentv2.coach.turn import _generate

    reply = "Answer what applies and I'll build the plan."

    async def complete(_system, _user):
        return reply

    seen = []

    async def on_delta(chunk):
        seen.append(chunk)

    asyncio.run(_generate(complete=complete, system="", message="", on_delta=on_delta))
    assert "".join(seen) == reply
