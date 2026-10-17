"""One Add-goal plan creates one goal: the confirm batch applies only the first `create_goal`."""
from types import SimpleNamespace

from sutra_api.api.tools import SKIPPED_DUPLICATE_GOAL, duplicate_goal_ids


def _row(proposal_id: str, action: str) -> SimpleNamespace:
    return SimpleNamespace(id=proposal_id, action=action)


def test_no_create_goal_means_nothing_is_skipped():
    rows = [_row("p1", "add_milestone"), _row("p2", "add_milestone")]
    assert duplicate_goal_ids(rows) == []


def test_a_single_create_goal_is_not_skipped():
    assert duplicate_goal_ids([_row("g1", "create_goal"), _row("m1", "add_milestone")]) == []


def test_every_create_goal_after_the_first_is_skipped():
    rows = [
        _row("g1", "create_goal"),
        _row("m1", "add_milestone"),
        _row("g2", "create_goal"),
        _row("g3", "create_goal"),
    ]
    assert duplicate_goal_ids(rows) == ["g2", "g3"]


def test_the_skip_note_text_is_stable():
    # The note is what the batch answers a skipped card with; the response shape stays a `results` list.
    assert isinstance(SKIPPED_DUPLICATE_GOAL, str) and SKIPPED_DUPLICATE_GOAL
