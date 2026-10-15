"""A goal carries where building its schedule stands, so the goal list can poll or offer a rebuild."""
from datetime import datetime, timezone
from types import SimpleNamespace

from sutra_api.models import PLAN_PLANNING
from sutra_api.wire import goal_state


def test_goal_state_carries_plan_status_and_when_it_started():
    started = datetime(2026, 10, 15, 9, 0, tzinfo=timezone.utc)
    g = SimpleNamespace(id="g", title="t", horizon="short", status="active", why="", next_action="", target_date=None,
                        start_date=None, drift_status="on_track", weekly_hours=None, phase_objectives={},
                        plan_status=PLAN_PLANNING, plan_started_at=started)
    out = goal_state(g)
    assert out["plan_status"] == "planning" and out["plan_started_at"].startswith("2026-10-15T09:00")


def test_an_older_goal_without_the_columns_reads_as_never_planned():
    g = SimpleNamespace(id="g", title="t", horizon="short", status="active", why="", next_action="", target_date=None,
                        start_date=None, drift_status="on_track", weekly_hours=None, phase_objectives={})
    assert goal_state(g)["plan_status"] is None
