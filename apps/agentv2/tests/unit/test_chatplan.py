"""The checks between the model's chat proposals and the user's confirm card. No model."""
from datetime import date

from agentv2.chatplan.turn import _clean_proposal

TODAY = date(2026, 10, 14)
GOALS = {"g1": "Learn driving", "g2": "Google interview prep"}


def test_a_known_goal_and_an_iso_date_pass():
    args, why = _clean_proposal("set_goal_dates", {"goal_title": "learn driving", "target_date": "2026-12-31"}, GOALS, TODAY)
    assert why is None and args == {"goal_title": "Learn driving", "target_date": "2026-12-31"}


def test_the_users_own_phrase_still_resolves_as_a_fallback():
    args, _ = _clean_proposal("set_goal_dates", {"goal_title": "Learn driving", "target_date": "end of December"}, GOALS, TODAY)
    assert args["target_date"] == "2026-12-31"


def test_an_unknown_goal_becomes_a_question():
    args, why = _clean_proposal("pause_goal", {"goal_title": "Cooking"}, GOALS, TODAY)
    assert args is None and "Which goal" in why


def test_a_deadline_in_the_past_is_refused():
    args, why = _clean_proposal("set_goal_dates", {"goal_title": "Learn driving", "target_date": "2026-09-01"}, GOALS, TODAY)
    assert args is None and "already passed" in why


def test_an_unreadable_date_becomes_a_question():
    args, why = _clean_proposal("add_blocker", {"title": "Away", "start_date": "someday"}, GOALS, TODAY)
    assert args is None and "which day" in why.lower()


def test_actions_outside_the_vocabulary_are_refused_and_unknown_args_dropped():
    assert _clean_proposal("delete_everything", {}, GOALS, TODAY)[0] is None
    args, _ = _clean_proposal("pause_goal", {"goal_title": "Learn driving", "reason": "busy", "evil": "x"}, GOALS, TODAY)
    assert "evil" not in args and args["reason"] == "busy"


def test_a_blocker_needs_a_start():
    assert _clean_proposal("add_blocker", {"title": "Away"}, GOALS, TODAY)[0] is None
