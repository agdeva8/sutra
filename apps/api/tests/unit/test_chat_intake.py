"""The Add-goal chat: the interview prompt, question extraction with their answer chips, and the plan handoff."""
import asyncio

from sutra_api.api import chat as chat_routes
from sutra_chat.clarify_options import options_for
from sutra_chat.prompts import INTAKE_MODE, KIND_ADD_GOAL, mode_hint
from sutra_chat.tools_block import extract_clarifying_questions


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


def test_trying_to_move_is_not_a_relocation_question():
    assert options_for("What stopped you the last time you tried to move?") == ([], False)
    assert options_for("Where are you based?")[0]


def test_plan_hands_add_goal_to_the_chat():
    class _Req:
        async def json(self):
            return {"message": "switch jobs", "kind": chat_routes.KIND_ADD_GOAL}

    out = asyncio.run(chat_routes.chat_plan(_Req(), session=None, user=None))
    assert out["status"] == "not_planned"
