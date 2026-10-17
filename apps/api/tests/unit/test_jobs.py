"""The job queue's pure decisions: dedupe, claim, lease, the fact rule, the audit sentence, the guard.

Everything here is a function over values — no database, no model, no network. The row
plumbing itself (`enqueue`'s savepoint, `claim`'s `SKIP LOCKED`) is exercised by the
integration suite; what it has to *decide* is decided here.
"""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from agentv2.contracts import AddGoal, AddMilestone, AddTask, MilestoneInput, ReplaceMilestones

from sutra_api.api.cron import authorised
from sutra_api.jobs import (
    GoalFacts,
    PlannedSlot,
    committed_events,
    dedupe_key_for,
    fact_changes,
    facts_after,
    job_is_claimable,
    keeps_goal_facts,
    lease_is_live,
    lease_outcome,
    movement_summary,
    planned_slots,
)

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)
GOAL = "goal_1"
TARGET = date(2027, 1, 15)
MILESTONE_DATE = date(2026, 12, 1)


def _facts(*, target: date | None = TARGET, hours: int | None = 6) -> GoalFacts:
    return GoalFacts(
        target_date=target,
        weekly_hours=hours,
        milestones=frozenset({("mile_1", MILESTONE_DATE)}),
    )


# ---------------------------------------------------------------------------
# Dedupe and claim
# ---------------------------------------------------------------------------


def test_dedupe_key_is_per_kind_and_goal_with_a_userwide_marker():
    assert dedupe_key_for("build_plan", GOAL) == "build_plan:goal_1"
    assert dedupe_key_for("replan_conflicts", None) == "replan_conflicts:*"
    assert dedupe_key_for("build_plan", GOAL) != dedupe_key_for("replan_goal", GOAL)


def test_a_queued_due_job_is_claimable_when_nothing_runs_for_the_user():
    assert job_is_claimable(
        status="queued", run_after=NOW - timedelta(seconds=1), now=NOW, running_for_user=False
    )


def test_a_running_job_for_the_same_user_blocks_the_next_one():
    # The one-per-user rule: two builds for one user would race over the same plan.
    assert not job_is_claimable(
        status="queued", run_after=NOW, now=NOW, running_for_user=True
    )


def test_a_job_scheduled_for_later_is_not_claimable():
    assert not job_is_claimable(
        status="queued", run_after=NOW + timedelta(seconds=30), now=NOW, running_for_user=False
    )


def test_only_queued_jobs_are_claimable():
    for status in ("running", "done", "failed"):
        assert not job_is_claimable(
            status=status, run_after=NOW, now=NOW, running_for_user=False
        )


def test_a_naive_run_after_is_read_as_utc():
    naive = datetime(2026, 10, 17, 11, 59)
    assert job_is_claimable(status="queued", run_after=naive, now=NOW, running_for_user=False)


# ---------------------------------------------------------------------------
# Lease
# ---------------------------------------------------------------------------


def test_an_expired_lease_retries_until_the_attempt_cap_then_fails():
    assert lease_outcome(1, 3) == "queued"
    assert lease_outcome(2, 3) == "queued"
    assert lease_outcome(3, 3) == "failed"
    assert lease_outcome(4, 3) == "failed"


def test_a_lease_is_live_only_when_it_is_set_and_in_the_future():
    assert lease_is_live(NOW + timedelta(minutes=1), NOW)
    assert not lease_is_live(NOW, NOW)
    assert not lease_is_live(NOW - timedelta(seconds=1), NOW)
    assert not lease_is_live(None, NOW)


# ---------------------------------------------------------------------------
# The rule: what a re-plan may change on its own
# ---------------------------------------------------------------------------


def test_plan_moves_leave_the_goal_facts_alone():
    changes = [
        AddTask(id="task_1", goal_id=GOAL, title="Apply", effort_hours=2, day=date(2026, 10, 20)),
    ]
    assert keeps_goal_facts(_facts(), changes, GOAL)


def test_a_new_milestone_changes_the_facts():
    changes = [
        AddMilestone(id="mile_2", goal_id=GOAL, title="Offer", target_date=date(2027, 2, 1)),
    ]
    assert not keeps_goal_facts(_facts(), changes, GOAL)
    assert fact_changes(_facts(), changes, GOAL) == changes


def test_an_added_milestone_with_the_same_id_and_date_is_not_a_change():
    # Ids are the identity: the planner re-stating the milestone it already has is not a re-date.
    changes = [AddMilestone(id="mile_1", goal_id=GOAL, title="Offer", target_date=MILESTONE_DATE)]
    assert keeps_goal_facts(_facts(), changes, GOAL)


def test_restating_the_goal_with_the_same_deadline_keeps_the_facts():
    changes = [AddGoal(id=GOAL, title="Switch jobs", target_date=TARGET)]
    assert keeps_goal_facts(_facts(), changes, GOAL)


def test_moving_the_goals_deadline_changes_the_facts():
    changes = [AddGoal(id=GOAL, title="Switch jobs", target_date=date(2027, 3, 1))]
    assert not keeps_goal_facts(_facts(), changes, GOAL)


def test_replace_milestones_with_the_same_open_set_keeps_the_facts():
    changes = [
        ReplaceMilestones(
            goal_id=GOAL,
            milestones=[MilestoneInput(id="mile_1", title="Offer", target_date=MILESTONE_DATE)],
        )
    ]
    assert keeps_goal_facts(_facts(), changes, GOAL)


def test_replace_milestones_that_drops_or_redates_one_changes_the_facts():
    dropped = [ReplaceMilestones(goal_id=GOAL, milestones=[])]
    redated = [
        ReplaceMilestones(
            goal_id=GOAL,
            milestones=[MilestoneInput(id="mile_1", title="Offer", target_date=date(2027, 1, 1))],
        )
    ]
    assert not keeps_goal_facts(_facts(), dropped, GOAL)
    assert not keeps_goal_facts(_facts(), redated, GOAL)


def test_a_change_to_another_goal_cannot_be_followed_and_counts_as_a_change():
    changes = [AddMilestone(id="mile_2", goal_id="goal_2", title="Other", target_date=date(2027, 2, 1))]
    assert facts_after(_facts(), changes, GOAL) is None
    assert not keeps_goal_facts(_facts(), changes, GOAL)


def test_fact_changes_names_only_the_offending_changes():
    task = AddTask(id="task_1", goal_id=GOAL, title="Apply", effort_hours=1, day=date(2026, 10, 20))
    milestone = AddMilestone(id="mile_2", goal_id=GOAL, title="Offer", target_date=date(2027, 2, 1))
    assert fact_changes(_facts(), [task, milestone], GOAL) == [milestone]


# ---------------------------------------------------------------------------
# The audit sentence
# ---------------------------------------------------------------------------


def _slot(day: date, start: str, end: str, title: str = "Apply") -> PlannedSlot:
    return PlannedSlot(day=day, start=start, end=end, title=title)


def test_a_moved_session_names_the_day_and_the_event_that_displaced_it():
    monday = date(2026, 10, 19)
    tuesday = date(2026, 10, 20)
    before = (_slot(monday, "09:00", "10:00"), _slot(monday, "10:00", "11:00"), _slot(tuesday, "09:00", "10:00"))
    after = (_slot(tuesday, "09:00", "10:00"), _slot(tuesday, "10:00", "11:00"), _slot(monday, "10:00", "11:00"))
    dentist = _slot(monday, "09:00", "10:00", "Dentist")
    line = movement_summary("Switch jobs", before, after, (dentist,))
    assert line == "Moved 1 session for 'Switch jobs' off Mon: Dentist"


def test_a_move_with_no_overlapping_event_says_where_without_a_reason():
    monday = date(2026, 10, 19)
    tuesday = date(2026, 10, 20)
    before = (_slot(monday, "09:00", "10:00"),)
    after = (_slot(tuesday, "09:00", "10:00"),)
    assert movement_summary("Switch jobs", before, after) == "Moved 1 session for 'Switch jobs' off Mon"


def test_the_largest_removal_is_the_day_the_sentence_names():
    monday = date(2026, 10, 19)
    tuesday = date(2026, 10, 20)
    wednesday = date(2026, 10, 21)
    before = (
        _slot(monday, "09:00", "10:00"),
        _slot(tuesday, "09:00", "10:00"),
        _slot(tuesday, "10:00", "11:00"),
    )
    after = (_slot(wednesday, "09:00", "10:00"),)
    assert movement_summary("Switch jobs", before, after) == "Moved 2 sessions for 'Switch jobs' off Tue"


def test_added_sessions_are_scheduled_and_an_unchanged_plan_is_silent():
    day = date(2026, 10, 19)
    assert movement_summary("Switch jobs", (), (_slot(day, "09:00", "10:00"),)) == "Scheduled 1 session for 'Switch jobs'"
    assert movement_summary("Switch jobs", (_slot(day, "09:00", "10:00"),), (_slot(day, "09:00", "10:00"),)) is None


def test_planned_slots_ignores_the_users_own_blocks_and_non_tasks():
    day = date(2026, 10, 19)
    blocks = [
        {"block_kind": "task", "placed_by": "planner", "goal_id": GOAL, "day": day.isoformat(), "start": "09:00:00", "end": "10:00:00", "title": "Apply"},
        {"block_kind": "task", "placed_by": "user", "goal_id": GOAL, "day": day.isoformat(), "start": "11:00", "end": "12:00"},
        {"block_kind": "event", "goal_id": GOAL, "day": day.isoformat(), "start": "13:00", "end": "14:00", "title": "Dentist"},
        {"block_kind": "task", "placed_by": "planner", "goal_id": "", "day": day.isoformat()},
    ]
    slots = planned_slots(blocks)
    assert slots == {GOAL: (_slot(day, "09:00", "10:00"),)}


def test_committed_events_reads_only_events():
    day = date(2026, 10, 19)
    blocks = [
        {"block_kind": "event", "day": day.isoformat(), "start": "09:00", "end": "10:00", "title": "Dentist"},
        {"block_kind": "task", "placed_by": "planner", "goal_id": GOAL, "day": day.isoformat(), "start": "09:00", "end": "10:00"},
        {"block_kind": "event", "day": day.isoformat()},
    ]
    assert committed_events(blocks) == (_slot(day, "09:00", "10:00", "Dentist"),)


# ---------------------------------------------------------------------------
# The cron guard
# ---------------------------------------------------------------------------


def test_the_cron_guard_accepts_only_the_configured_secret():
    assert authorised("Bearer s3cret", "s3cret")
    assert not authorised("Bearer wrong", "s3cret")
    assert not authorised(None, "s3cret")
    assert not authorised("s3cret", "s3cret")


def test_an_unset_secret_closes_the_routes():
    # A deployment that forgot CRON_SECRET must not be triggerable by an empty header.
    assert not authorised("Bearer ", "")
    assert not authorised(None, "")
