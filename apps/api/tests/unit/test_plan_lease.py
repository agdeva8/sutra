"""One build per goal: a live `planning` blocks a second one, a dead one does not."""
from datetime import datetime, timedelta, timezone

from sutra_api.api.plan import PLAN_LEASE, build_in_flight
from sutra_api.models import PLAN_FAILED, PLAN_PLANNING, PLAN_READY

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)


def test_a_build_that_just_started_is_in_flight():
    assert build_in_flight(PLAN_PLANNING, NOW, NOW) is True


def test_a_build_just_inside_the_lease_is_in_flight():
    assert build_in_flight(PLAN_PLANNING, NOW - PLAN_LEASE + timedelta(seconds=1), NOW) is True


def test_a_build_just_past_the_lease_is_abandoned():
    assert build_in_flight(PLAN_PLANNING, NOW - PLAN_LEASE - timedelta(seconds=1), NOW) is False


def test_finished_states_are_never_in_flight():
    assert build_in_flight(PLAN_READY, NOW, NOW) is False
    assert build_in_flight(PLAN_FAILED, NOW, NOW) is False


def test_a_planning_without_a_start_time_is_not_trusted_as_live():
    assert build_in_flight(PLAN_PLANNING, None, NOW) is False


def test_a_naive_start_time_is_read_as_utc():
    naive = NOW.replace(tzinfo=None) - timedelta(minutes=1)
    assert build_in_flight(PLAN_PLANNING, naive, NOW) is True
