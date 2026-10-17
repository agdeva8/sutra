"""One confirm, one goal: an id the client sends once per proposal makes the route idempotent."""
from sutra_api.api.agent_goals import (
    CONFIRM_ID_MAX_CHARS,
    goal_created_by_confirm,
    normalize_confirm_id,
)


def test_a_confirm_id_is_trimmed():
    assert normalize_confirm_id("  abc-123  ") == "abc-123"


def test_a_missing_or_blank_confirm_id_is_ignored():
    assert normalize_confirm_id(None) is None
    assert normalize_confirm_id("") is None
    assert normalize_confirm_id("   ") is None


def test_a_non_string_confirm_id_is_ignored():
    assert normalize_confirm_id(42) is None
    assert normalize_confirm_id({"id": "x"}) is None


def test_an_overlong_confirm_id_is_ignored():
    assert normalize_confirm_id("x" * (CONFIRM_ID_MAX_CHARS + 1)) is None
    assert normalize_confirm_id("x" * CONFIRM_ID_MAX_CHARS) == "x" * CONFIRM_ID_MAX_CHARS


def test_no_audit_row_means_nothing_was_created():
    assert goal_created_by_confirm([]) is None


def test_a_malformed_payload_is_skipped():
    assert goal_created_by_confirm([{}, {"goal_id": ""}, {"goal_id": 7}]) is None


def test_the_first_well_formed_row_wins():
    payloads = [{"goal_id": "g_new"}, {"goal_id": "g_old"}]
    assert goal_created_by_confirm(payloads) == "g_new"
