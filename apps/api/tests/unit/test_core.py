"""The pure logic — over-commitment, drift, replan suggestions, blast radius.

Every payload here is one the v1 implementation actually produced; the thresholds
and the sentences were read from `lib/over-commitment.ts`, `lib/drift.ts` and
`lib/replan-suggestions.ts` rather than inferred. A test that pins copy is
usually a bad trade — but these strings render on the dashboard chip and in the
toaster, and a paraphrase is a silent product change.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sutra_api.core.blast_radius import radius_for, radius_for_intent
from sutra_api.core.drift import compute_drift
from sutra_api.core.motivation import compute_state_hash, detect_bucket
from sutra_api.core.over_commitment import compute_over_commitment
from sutra_api.core.replan_suggestions import compute_replan_suggestions


def _goal(id_: str, *, status: str = "active", **kw) -> dict:
    return {"id": id_, "title": f"Goal {id_}", "status": status, **kw}


# ---------------------------------------------------------------------------
# over-commitment
# ---------------------------------------------------------------------------


class TestOverCommitment:
    def test_clear_below_three(self):
        result = compute_over_commitment([_goal("g1"), _goal("g2")])
        assert result["level"] == "clear"
        assert result["message"] == "A steady, focused load."
        assert result["conflicting"] == []
        assert result["active_goals"] == 2

    def test_moderate_at_three(self):
        result = compute_over_commitment([_goal(f"g{i}") for i in range(3)])
        assert result["level"] == "moderate"
        assert "only one can lead this week" in result["message"]
        # Moderate carries no `conflicting` — three goals is advice, not a warning.
        assert result["conflicting"] == []

    def test_high_at_five_names_three(self):
        result = compute_over_commitment([_goal(f"g{i}") for i in range(5)])
        assert result["level"] == "high"
        assert len(result["conflicting"]) == 3

    def test_critical_at_seven(self):
        result = compute_over_commitment([_goal(f"g{i}") for i in range(7)])
        assert result["level"] == "critical"
        assert "wish-list, not a week" in result["message"]

    def test_only_active_goals_count(self):
        """A paused goal is not a load, and a dropped one is the fix."""
        goals = [_goal("g1"), _goal("g2", status="paused"), _goal("g3", status="dropped")]
        assert compute_over_commitment(goals)["active_goals"] == 1

    def test_open_commitments_is_always_zero(self):
        """v1 hardcodes it: the `commitments` entity was folded into plan_items."""
        assert compute_over_commitment([_goal("g1")])["open_commitments"] == 0


# ---------------------------------------------------------------------------
# drift
# ---------------------------------------------------------------------------


class TestDrift:
    def test_open_milestone_past_its_date_is_at_risk(self):
        result = compute_drift(
            "2026-10-10",
            [{"title": "Ship the beta", "targetDate": "2026-10-01", "status": "open"}],
        )
        assert result["status"] == "at_risk"
        assert "passed its target date" in result["reasons"][0]

    def test_done_milestone_never_drifts(self):
        result = compute_drift(
            "2026-10-10",
            [{"title": "Ship the beta", "targetDate": "2026-10-01", "status": "done"}],
        )
        assert result["status"] == "on_track"

    def test_future_milestone_is_on_track(self):
        result = compute_drift(
            "2026-10-10",
            [{"title": "Ship", "targetDate": "2026-11-01", "status": "open"}],
        )
        assert result["status"] == "on_track"

    def test_a_milestone_with_no_date_is_ignored(self):
        """Not-yet-scheduled is not behind."""
        result = compute_drift(
            "2026-10-10", [{"title": "TBD", "targetDate": None, "status": "open"}]
        )
        assert result["status"] == "on_track"


# ---------------------------------------------------------------------------
# replan suggestions
# ---------------------------------------------------------------------------


class TestReplanSuggestions:
    def test_drift_goal_produces_a_suggestion(self):
        out = compute_replan_suggestions(
            {
                "goals": [_goal("g1", drift_status="at_risk")],
                "blockers": [],
                "recentAudit": [],
            }
        )
        assert [s["trigger"] for s in out] == ["drift"]
        assert out[0]["id"] == "drift:g1"
        assert out[0]["prefill"]

    def test_capacity_freed_needs_someone_left_to_replan_for(self):
        """A drop that empties the board has nothing to offer."""
        audit = [
            {
                "id": "audit_1",
                "type": "drop:goal",
                "summary": "Dropped goal 'Goa'",
                "payload": {
                    "goal_id": "g1",
                    "goal_title": "Goa",
                    "freed_weekly_hours": 5,
                },
                "created_at": "2026-10-09T10:00:00+00:00",
            }
        ]
        only_goal = compute_replan_suggestions(
            {
                "goals": [_goal("g1", status="dropped")],
                "blockers": [],
                "recentAudit": audit,
                "today": "2026-10-10",
            }
        )
        assert only_goal == []

        with_another = compute_replan_suggestions(
            {
                "goals": [
                    _goal("g1", status="dropped", title="Goa"),
                    _goal("g2"),
                ],
                "blockers": [],
                "recentAudit": audit,
                "today": "2026-10-10",
            }
        )
        assert [s["trigger"] for s in with_another] == ["capacity_freed"]
        assert with_another[0]["freed_weekly_hours"] == 5

    def test_capacity_freed_expires_after_a_week(self):
        out = compute_replan_suggestions(
            {
                "goals": [_goal("g1", status="dropped"), _goal("g2")],
                "blockers": [],
                "recentAudit": [
                    {
                        "id": "audit_1",
                        "type": "drop:goal",
                        "summary": "Dropped goal 'Goa'",
                        "payload": {"goal_id": "g1", "freed_weekly_hours": 5},
                        "created_at": "2026-09-01T10:00:00+00:00",
                    }
                ],
                "today": "2026-10-10",
            }
        )
        assert out == []

    def test_blocker_overlapping_a_goal_window(self):
        out = compute_replan_suggestions(
            {
                "goals": [
                    _goal("g1", start_date="2026-10-01", target_date="2026-10-20")
                ],
                "blockers": [
                    {
                        "id": "blk_1",
                        "title": "Goa trip",
                        "start_date": "2026-10-12",
                        "end_date": "2026-10-18",
                    }
                ],
                "recentAudit": [],
            }
        )
        assert [s["trigger"] for s in out] == ["blocker_collision"]
        assert out[0]["blocker_title"] == "Goa trip"
        assert "Goa trip" in out[0]["message"]

    def test_a_blocker_outside_the_window_is_not_a_collision(self):
        out = compute_replan_suggestions(
            {
                "goals": [_goal("g1", start_date="2026-10-01", target_date="2026-10-10")],
                "blockers": [
                    {
                        "id": "blk_1",
                        "title": "Later",
                        "start_date": "2026-11-01",
                        "end_date": "2026-11-05",
                    }
                ],
                "recentAudit": [],
            }
        )
        assert out == []

    def test_capped_at_five_and_sorted_by_priority(self):
        goals = [_goal(f"g{i}", drift_status="at_risk") for i in range(8)]
        out = compute_replan_suggestions(
            {"goals": goals, "blockers": [], "recentAudit": []}
        )
        assert len(out) == 5
        assert all(s["trigger"] == "drift" for s in out)


# ---------------------------------------------------------------------------
# blast radius
# ---------------------------------------------------------------------------


class TestBlastRadius:
    def test_a_blocker_is_slim_daily_only(self):
        horizons, milestone_moved = radius_for("blocker.add")
        assert horizons == ["daily"]
        assert milestone_moved is False

    def test_a_milestone_always_moves_the_milestone(self):
        """It is a promise to the user, so it escalates whatever else it does."""
        for action in ("milestone.create", "milestone.edit", "milestone.delete"):
            assert radius_for(action)[1] is True

    def test_moving_dates_escalates(self):
        assert radius_for("goal.dates")[1] is True

    def test_an_unknown_action_takes_the_cheapest_radius(self):
        """Escalating an unknown write would train the user to dismiss modals."""
        assert radius_for("something.new") == (["daily"], False)

    def test_every_intent_has_a_radius(self):
        for intent in (
            "add_goal",
            "plan_day",
            "edit_goal",
            "drop_goal",
            "review_progress",
            "replan",
        ):
            horizons, _ = radius_for_intent(intent)
            assert horizons


# ---------------------------------------------------------------------------
# motivation
# ---------------------------------------------------------------------------


class TestMotivationBucket:
    def test_overdue_beats_everything(self):
        """A milestone past its date is the most urgent signal there is."""
        bucket = detect_bucket(
            today=datetime(2026, 10, 10, tzinfo=UTC).date(),
            milestones=[{"status": "open", "target_date": "2026-10-01"}],
            goals=[_goal("g1", updated_at="2026-10-10T00:00:00+00:00")],
        )
        assert bucket == "overdue"

    def test_no_active_goals_is_stuck(self):
        bucket = detect_bucket(
            today=datetime(2026, 10, 10, tzinfo=UTC).date(),
            milestones=[],
            goals=[_goal("g1", status="paused")],
        )
        assert bucket == "stuck"

    def test_untouched_for_three_weeks_is_dormant(self):
        now = datetime(2026, 10, 10, tzinfo=UTC)
        bucket = detect_bucket(
            today=now.date(),
            milestones=[],
            goals=[_goal("g1", updated_at=(now - timedelta(days=30)).isoformat())],
            now=now,
        )
        assert bucket == "dormant"

    def test_recently_touched_is_stuck_not_dormant(self):
        now = datetime(2026, 10, 10, tzinfo=UTC)
        bucket = detect_bucket(
            today=now.date(),
            milestones=[],
            goals=[_goal("g1", updated_at=(now - timedelta(days=1)).isoformat())],
            now=now,
        )
        assert bucket == "stuck"

    def test_state_hash_is_order_independent(self):
        """Two calls over the same rows must hit the same cache entry."""
        a = compute_state_hash(overdue_ids=["m1", "m2"], goals=[_goal("g1"), _goal("g2")])
        b = compute_state_hash(overdue_ids=["m2", "m1"], goals=[_goal("g2"), _goal("g1")])
        assert a == b

    def test_state_hash_changes_when_the_state_moves(self):
        before = compute_state_hash(overdue_ids=[], goals=[_goal("g1")])
        after = compute_state_hash(overdue_ids=["m1"], goals=[_goal("g1")])
        assert before != after
