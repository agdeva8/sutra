"""A contradictory profile is refused with the reason, and re-plan banners are only for what the agent cannot absorb."""
import pytest

from sutra_api.core.replan_suggestions import compute_replan_suggestions
from sutra_api.profile import ProfileError, clean_profile


def test_saving_swapped_wake_and_sleep_is_refused_with_a_plain_reason():
    with pytest.raises(ProfileError, match="outside the hours you are awake"):
        clean_profile({"wake": "01:00", "sleep": "09:00", "work_start": "10:30", "work_end": "17:00", "work_days": ["mon"]})


def test_a_consistent_profile_is_saved():
    out = clean_profile({"wake": "09:30", "sleep": "01:00", "work_start": "09:30", "work_end": "18:30", "work_days": ["mon"]})
    assert out["wake"] == "09:30" and out["sleep"] == "01:00"


GOAL = {"id": "g", "title": "Goal", "status": "active", "start_date": "2026-10-12", "target_date": "2027-01-07"}


def _suggestions(blockers, blocks):
    return compute_replan_suggestions({"today": "2026-10-15", "goals": [GOAL], "blockers": blockers, "timetableBlocks": blocks, "recentAudit": []})


def test_a_one_day_trip_and_the_agents_own_session_on_it_raise_no_banner():
    trip = {"id": "b", "title": "Trip", "start_date": "2026-10-15", "end_date": "2026-10-15"}
    session = {"id": "t", "goal_id": "g", "label": "Study", "block_date": "2026-10-15", "kind": "tentative"}
    assert _suggestions([trip], [session]) == []


def test_the_persons_own_fixed_appointment_on_a_trip_day_is_still_raised():
    trip = {"id": "b", "title": "Trip", "start_date": "2026-10-15", "end_date": "2026-10-15"}
    dentist = {"id": "t", "goal_id": "g", "label": "Dentist", "block_date": "2026-10-15", "kind": "committed"}
    assert [s["trigger"] for s in _suggestions([trip], [dentist])] == ["timetable_collision"]


def test_a_long_absence_is_still_asked_about():
    sabbatical = {"id": "b", "title": "Sabbatical", "start_date": "2026-11-01", "end_date": "2026-12-20"}
    assert [s["trigger"] for s in _suggestions([sabbatical], [])] == ["blocker_collision"]
