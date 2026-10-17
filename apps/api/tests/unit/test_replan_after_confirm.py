"""After a confirm, does the goal's plan need rebuilding? Pure decision, no database or model."""
from sutra_api.core.replan_after_confirm import needs_replan


def test_moving_the_deadline_replans():
    assert needs_replan("update_goal", {"goal_id": "g", "target_date": "2027-01-15"}) is True


def test_changing_weekly_hours_replans():
    assert needs_replan("update_goal", {"goal_id": "g", "weekly_hours": 8}) is True


def test_restating_the_same_fields_still_replans():
    # A proposal carries what it sets, not a diff; the executor decides whether anything changed.
    # Erring towards a rebuild keeps the sessions true when it did.
    assert needs_replan("update_goal", {"goal_id": "g", "weekly_hours": 6}) is True


def test_a_milestone_replacement_replans():
    assert needs_replan("update_goal", {"goal_id": "g", "milestones": [{"title": "One"}]}) is True
    assert needs_replan("replace_milestones", {"goal_id": "g", "milestones": []}) is True


def test_a_new_milestone_replans():
    assert needs_replan("add_milestone", {"goal_id": "g", "title": "One"}) is True


def test_setting_goal_dates_replans():
    assert needs_replan("set_goal_dates", {"goal_id": "g", "target_date": "2027-01-15"}) is True


def test_a_gateway_change_carrying_a_replacement_replans():
    assert needs_replan("apply_change", {"change": {"kind": "replace_milestones"}}) is True


def test_a_rename_does_not_replan():
    assert needs_replan("update_goal", {"goal_id": "g", "title": "A better title"}) is False


def test_pausing_or_dropping_does_not_replan():
    assert needs_replan("update_goal", {"goal_id": "g", "status": "paused"}) is False
    assert needs_replan("update_goal", {"goal_id": "g", "status": "dropped"}) is False


def test_unrelated_actions_do_not_replan():
    for action in ("add_block", "add_reminder", "add_task", "create_goal", "link_source"):
        assert needs_replan(action, {"goal_id": "g"}) is False


def test_an_empty_target_date_is_not_a_deadline_change():
    assert needs_replan("update_goal", {"goal_id": "g", "target_date": None}) is False
    assert needs_replan("update_goal", {"goal_id": "g", "target_date": ""}) is False


def test_an_unreadable_payload_does_not_replan():
    assert needs_replan("update_goal", None) is False
    assert needs_replan("update_goal", "nope") is False
