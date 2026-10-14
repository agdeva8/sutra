"""Question discipline, profile, guardrails and coach context: the pure logic behind the Add-goal interview."""
import asyncio
from datetime import date

from sutra_api.coach_context import HEADER_INACTIVE, CoachFacts, render
from sutra_api.profile import ProfileError, answered_topics, clean_profile, profile_lines
from agentv2.coach.prompts import GUARDRAILS, INTAKE_MODE, MAX_QUESTIONS_PER_ROUND, assemble_system
from agentv2.coach.questions import drop_answered_by_profile, filter_repeats, is_repeat
from agentv2.coach.safety import signals_crisis
from agentv2.coach.turn import MAX_INTERVIEW_ROUNDS, run_turn

import pytest


# --- repeats -------------------------------------------------------------------------------------------

def test_a_reworded_question_is_a_repeat():
    assert is_repeat("How much time per week can you commit?", ["How many hours a week can you give?"])
    assert is_repeat("What's your current level with the guitar?", ["Where are you starting from with the guitar?"])
    assert is_repeat("What is the fixed move date?", ["Do you have a fixed move date, or is next month flexible?"])


def test_different_questions_are_not_repeats_even_with_the_goal_named_in_each():
    asked = ["For the React chapters 3-7 goal, what counts as finishing a chapter?"]
    assert not is_repeat("For the React chapters 3-7 goal, where are you starting from?", asked)
    assert not is_repeat("Who is doing the physical move?", ["Where are you starting from with packing?"])


def test_filter_repeats_drops_asked_and_within_round_duplicates():
    found = [{"question": "How many hours a week can you give?"}, {"question": "Is the date fixed?"},
             {"question": "Is that date fixed?"}]
    kept = filter_repeats(found, ["How much time per week can you commit?"])
    assert [q["question"] for q in kept] == ["Is the date fixed?"]


def test_profile_answers_remove_their_questions():
    qs = [{"question": "How many hours a week can you give this?"}, {"question": "Where are you starting from?"}]
    topics = answered_topics({"weekly_goal_hours": 6})
    assert [q["question"] for q in drop_answered_by_profile(qs, topics)] == ["Where are you starting from?"]
    assert drop_answered_by_profile(qs, set()) == qs


# --- the turn ------------------------------------------------------------------------------------------

def _fake(replies):
    calls = []

    async def complete(system, user):
        calls.append((system, user))
        return replies[min(len(calls) - 1, len(replies) - 1)]

    return complete, calls


BLOCK = '[[TOOLS]]\n[{"action": "create_goal", "args": {"title": "Play guitar"}}]\n[[/TOOLS]]'
INTAKE = dict(auto_answer=False, clarify=False, proactive_propose=False, scoped_kind="add_goal")


def test_all_repeats_turn_into_a_proposal_not_a_second_card():
    complete, calls = _fake(["Two things.\n1. How many hours a week can you give?\n2. Is the date fixed?",
                             f"I'll assume 4 hours.\n{BLOCK}"])
    turn = asyncio.run(run_turn(complete=complete, message="01: soon", asked=[
        "How much time per week can you commit?", "Is that date fixed?"], rounds_asked=1, **INTAKE))
    assert turn.outcome == "proposals" and not turn.questions
    assert len(calls) == 2 and "Do not ask any more questions" in calls[1][1]
    # The asked list reaches the model too.
    assert "ALREADY ASKED" in calls[0][0] and "How much time per week" in calls[0][0]


def test_only_new_questions_are_asked_and_capped():
    many = "\n".join(f"{i}. {q}" for i, q in enumerate([
        "Where are you starting from?", "Is the party date fixed?", "Do you own a guitar?",
        "Which songs matter most?", "Who will you practise with?", "Will you sing as well?"], 1))
    complete, _ = _fake([many])
    turn = asyncio.run(run_turn(complete=complete, message="learn guitar", **INTAKE))
    assert turn.outcome == "clarify" and len(turn.questions) == MAX_QUESTIONS_PER_ROUND


def test_round_cap_forces_a_proposal():
    complete, calls = _fake(["1. A brand new question about chords?", BLOCK])
    turn = asyncio.run(run_turn(complete=complete, message="01: yes", rounds_asked=MAX_INTERVIEW_ROUNDS, **INTAKE))
    assert turn.outcome == "proposals"


def test_crisis_message_gets_only_the_reply():
    complete, calls = _fake([f"I'm glad you told me. Please contact local emergency services.\n{BLOCK}"])
    turn = asyncio.run(run_turn(complete=complete, message="I don't want to be alive anymore", **INTAKE))
    assert turn.outcome == "prose" and turn.crisis and not turn.proposals and len(calls) == 1


@pytest.mark.parametrize("text,crisis", [
    ("I want to kill myself", True), ("thinking about suicide", True), ("I don't want to live", True),
    ("I want to end my subscription", False), ("kill it at the interview", False), ("lose weight", False),
])
def test_crisis_signals(text, crisis):
    assert signals_crisis(text) is crisis


# --- prompts ---------------------------------------------------------------------------------------------

def test_guardrails_are_in_every_mode():
    for kw in (dict(clarify=True, auto_answer=False), dict(clarify=False, auto_answer=True),
               dict(clarify=False, auto_answer=False)):
        system = assemble_system(proactive_propose=False, scoped_kind="add_goal", **kw)
        assert GUARDRAILS.strip() in system
    assert "would a milestone, a date or the weekly hours be different" in INTAKE_MODE
    for phrase in ("Never judge", "Never assume where they live", "crisis line", "qualified professional"):
        assert phrase in GUARDRAILS


# --- profile -----------------------------------------------------------------------------------------------

def test_clean_profile_keeps_valid_fields_and_marks_asked():
    out = clean_profile({"wake": "07:00", "sleep": "", "work_days": ["tue", "mon"], "weekly_goal_hours": 6, "junk": 1})
    assert out == {"asked": True, "wake": "07:00", "work_days": ["mon", "tue"], "weekly_goal_hours": 6}
    assert clean_profile({}) == {"asked": True}
    for bad in ({"wake": "7am"}, {"work_days": ["funday"]}, {"weekly_goal_hours": 500}, {"weekly_goal_hours": True}):
        with pytest.raises(ProfileError):
            clean_profile(bad)


def test_profile_reaches_the_coach_context_and_history_is_neutral():
    text = render(CoachFacts(today=date(2026, 10, 15), profile={"weekly_goal_hours": 6, "wake": "07:00"},
                             inactive=["- Run a marathon: dropped"], facts=["Has a dog"]))
    assert "6 hours a week" in text and "Wakes 07:00" in text and "Has a dog" in text
    assert HEADER_INACTIVE in text and "Never mention them to judge" in text
    assert profile_lines({}) == []
