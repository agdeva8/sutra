"""Unit tests for the pure core. No LLM, no DB, no network.

The `place` tests are the load-bearing ones: they assert the invariants the
whole design rests on — capacity respected, the shared weekly budget respected
across goals, and reproducibility.
"""
from __future__ import annotations

import pytest

from app.contracts.schemas import (
    Availability,
    ConstraintDelta,
    GoalSpec,
    HorizonTask,
    MilestoneSpec,
)
from app.core import staleness as st
from app.core.headroom import RENEGOTIATE, check_headroom
from app.core.lattice import BUFFER_RATIO, build_lattice
from app.core.place import place
from app.core.util import add_days, days_between, iso_week, iter_dates, round_half_up, weekday_of
from app.core.validate import cross_validate, verify_placement

# --------------------------------------------------------------------------
# util
# --------------------------------------------------------------------------


def test_date_math_is_utc_and_whole_days():
    assert days_between("2026-01-01", "2026-01-31") == 30
    assert add_days("2026-01-31", 1) == "2026-02-01"
    assert days_between("2026-01-31", "2026-01-01") == -30


def test_weekday_and_iso_week():
    assert weekday_of("2026-01-05") == "mon"  # a Monday
    assert weekday_of("2026-01-11") == "sun"
    assert iso_week("2026-01-05") == 2


def test_round_half_up_is_not_bankers():
    assert round_half_up(0.5) == 1
    assert round_half_up(1.5) == 2
    assert round_half_up(2.5) == 3  # banker's rounding would give 2


def test_iter_dates_inclusive_and_safe_when_reversed():
    assert iter_dates("2026-01-01", "2026-01-03") == ["2026-01-01", "2026-01-02", "2026-01-03"]
    assert iter_dates("2026-01-03", "2026-01-01") == []


# --------------------------------------------------------------------------
# lattice
# --------------------------------------------------------------------------


def _goal(**kw) -> GoalSpec:
    base = dict(
        title="Switch jobs",
        horizon="short",
        start_date="2026-01-01",
        target_date="2026-03-31",
        weekly_hours=10,
        phase_objectives=["Foundations", "Mocks", "Full loops"],
    )
    base.update(kw)
    return GoalSpec(**base)


def test_lattice_emits_all_five_horizons():
    ms = [
        MilestoneSpec(title="Pass 5 SD mocks", phase="Mocks"),
        MilestoneSpec(title="Ship 3 applications", phase="Foundations"),
    ]
    out = build_lattice(goal=_goal(), milestones=ms, today="2026-01-01")
    assert out.error == ""
    horizons = {i.horizon for i in out.items}
    assert horizons == {"yearly", "quarterly", "monthly", "weekly", "daily"}


def test_lattice_schedules_into_the_eighty_percent_window():
    out = build_lattice(goal=_goal(), milestones=[], today="2026-01-01")
    for span in out.spans:
        scheduled_end = max(
            (i.end_date for i in out.items if i.horizon == "weekly" and i.phase == span.phase),
            default=span.start,
        )
        # weekly bands never run past the effective window
        assert days_between(scheduled_end, span.window_end) >= 0
        assert span.window_end <= span.end


def test_lattice_is_deterministic():
    ms = [MilestoneSpec(title="A", phase="Mocks"), MilestoneSpec(title="B", phase="Foundations")]
    a = build_lattice(goal=_goal(), milestones=ms, today="2026-01-01")
    b = build_lattice(goal=_goal(), milestones=ms, today="2026-01-01")
    assert [i.model_dump() for i in a.items] == [i.model_dump() for i in b.items]


def test_lattice_widens_a_too_short_goal():
    out = build_lattice(
        goal=_goal(start_date="2026-01-01", target_date="2026-01-03"),
        milestones=[],
        today="2026-01-01",
    )
    yearly = next(i for i in out.items if i.horizon == "yearly")
    assert days_between(yearly.start_date, yearly.end_date) >= 7


def test_lattice_never_raises_and_reports_errors_as_data():
    """`build_lattice` is non-fatal by contract (HLD §13) — a failure is data."""
    out = build_lattice(goal=_goal(), milestones=[], today="2026-01-01")
    assert out.error == ""


def test_contract_boundary_drops_a_blank_phase():
    """A blank phase is dropped at the contract edge, not carried into the lattice.

    This used to raise. It does not any more: a real model returning one blank
    phase among three good ones should not fail the whole turn, and the lattice
    reads an empty list as a single span — so the degraded answer is a plan with
    one phase rather than no plan at all.
    """
    assert _goal(phase_objectives=["  ", "Mocks"]).phase_objectives == ["Mocks"]
    assert _goal(phase_objectives=[]).phase_objectives == []


# --------------------------------------------------------------------------
# place — the load-bearing tests
# --------------------------------------------------------------------------

MON_FRI = Availability(
    hours={"mon": 2, "tue": 2, "wed": 2, "thu": 2, "fri": 2, "sat": 0, "sun": 0},
    blocked_dates=[],
    weekly_budget_hours=10,
)


def _task(tid: str, *, start="2026-01-05", end="2026-01-11", hours=2.0, **kw) -> HorizonTask:
    return HorizonTask(
        id=tid, title=f"task {tid}", window_start=start, window_end=end, est_hours=hours, **kw
    )


def test_place_respects_per_day_capacity():
    tasks = [_task(f"t{i}", hours=2.0) for i in range(5)]
    res = place(tasks, MON_FRI)
    assert res.feasible
    per_day: dict[str, float] = {}
    for s in res.slots:
        per_day[s.date] = per_day.get(s.date, 0) + s.hours
    for date, hours in per_day.items():
        assert hours <= MON_FRI.cap_for(date) + 1e-6, f"{date} over capacity"


def test_a_step_longer_than_a_day_is_split_across_days():
    """The flaw the TUI demo exposed: 2.7h against a 2h/day cap.

    Under one-sitting-per-task this was unplaceable and fell through to the
    fallback. It must instead become 2h on one day and 0.7h on the next.
    """
    tasks = [_task("t1", hours=2.7, start="2026-01-05", end="2026-01-09")]
    res = place(tasks, MON_FRI)
    assert res.solver == "cpsat"
    assert not res.unscheduled
    assert sum(s.hours for s in res.slots) == pytest.approx(2.7, abs=1e-6)
    assert len(res.slots) >= 2, "a 2.7h step cannot fit a 2h day in one sitting"


def test_place_honours_session_max_as_a_per_sitting_cap():
    tasks = [_task("t1", hours=4.0, start="2026-01-05", end="2026-01-09", session_max_hours=1.0)]
    res = place(tasks, MON_FRI)
    assert all(s.hours <= 1.0 + 1e-6 for s in res.slots), "no sitting may exceed session_max"


def test_place_respects_the_shared_weekly_budget():
    """The constraint v1 never had: two goals sharing one weekly budget.

    Two 4h goals against a 6h/week budget. The solver may only *claim* 6h; the
    rest is reported as short, so the user sees the shortfall instead of a
    silently short plan. Nothing is dropped.
    """
    a = [_task("a1", hours=4.0, goal_id="gA", goal_priority=5)]
    b = [_task("b1", hours=4.0, goal_id="gB", goal_priority=5)]
    avail = Availability(
        hours={"mon": 8, "tue": 8, "wed": 8, "thu": 8, "fri": 8, "sat": 8, "sun": 8},
        weekly_budget_hours=6,
    )
    res = place(a + b, avail)

    claimed = sum(s.hours for s in res.slots if s.task_id not in res.unscheduled)
    assert claimed <= 6 + 1e-6, f"shared weekly budget breached by a claimed slot: {claimed}h"
    assert res.short, "the over-budget task must be flagged, not silently accepted"
    assert {s.task_id for s in res.slots} == {"a1", "b1"}, "no task may be dropped"
    # and the invariant checker agrees the claimed placement is sound
    assert verify_placement(a + b, avail, res) == []


def test_shared_weekly_budget_spans_goals_not_just_days():
    """With no weekly cap the same input fits; with one it is cut back."""
    tasks = [_task("x", hours=3.0, goal_id="g1"), _task("y", hours=3.0, goal_id="g2")]
    no_cap = Availability(hours={"mon": 8, "tue": 8}, weekly_budget_hours=None)
    capped = Availability(hours={"mon": 8, "tue": 8}, weekly_budget_hours=4)
    assert not place(tasks, no_cap).short
    assert place(tasks, capped).short


def test_place_is_reproducible():
    tasks = [_task(f"t{i}", hours=2.0, goal_id=f"g{i % 2}", goal_priority=3 + i % 2) for i in range(6)]
    first = place(tasks, MON_FRI)
    second = place(tasks, MON_FRI)
    assert [(s.task_id, s.date, s.hours) for s in first.slots] == [
        (s.task_id, s.date, s.hours) for s in second.slots
    ]


def test_place_never_drops_a_task():
    """Infeasible must degrade to structural placement, not to a shorter plan."""
    tasks = [_task("t1", hours=9.0)]  # 9h cannot fit a 2h/day cap
    res = place(tasks, MON_FRI)
    assert {s.task_id for s in res.slots} == {"t1"}


def test_place_honours_blocked_days():
    avail = Availability(
        hours={"mon": 2, "tue": 2, "wed": 2, "thu": 2, "fri": 2},
        blocked_dates=["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"],
    )
    res = place([_task("t1", hours=2.0, start="2026-01-05", end="2026-01-09")], avail)
    assert all(s.date not in avail.blocked_dates for s in res.slots)


def test_place_higher_priority_goal_wins_a_contested_slot():
    hi = [_task("hi", hours=2.0, goal_id="gHi", goal_priority=5)]
    lo = [_task("lo", hours=2.0, goal_id="gLo", goal_priority=1)]
    avail = Availability(hours={"mon": 2}, weekly_budget_hours=None)
    res = place(hi + lo, avail)
    placed = {s.task_id for s in res.slots}
    assert "hi" in placed


def test_place_accepts_a_constraint_delta_pin():
    """The LLM's judgment enters as a constraint, never as a date."""
    tasks = [_task("t1", hours=2.0, start="2026-01-05", end="2026-01-09")]
    delta = ConstraintDelta(kind="pin", task_id="t1", value="2026-01-08")
    res = place(tasks, MON_FRI, deltas=[delta])
    assert res.slots and res.slots[0].date == "2026-01-08"


def test_place_accepts_a_constraint_delta_precedence():
    a = _task("a", hours=2.0, start="2026-01-05", end="2026-01-09")
    b = _task("b", hours=2.0, start="2026-01-05", end="2026-01-09")
    delta = ConstraintDelta(kind="precedence", task_id="b", other="a")
    res = place([a, b], MON_FRI, deltas=[delta])
    by = res.by_task()
    if "a" in by and "b" in by:
        assert by["a"].date < by["b"].date


def test_place_accepts_allowed_days_delta():
    tasks = [_task("t1", hours=2.0, start="2026-01-05", end="2026-01-09")]
    # 2 = Wednesday only
    delta = ConstraintDelta(kind="allowed_days", task_id="t1", value=[2])
    res = place(tasks, MON_FRI, deltas=[delta])
    assert all(weekday_of(s.date) == "wed" for s in res.slots)


def test_place_handles_no_tasks():
    res = place([], MON_FRI)
    assert res.feasible and res.slots == []


# --------------------------------------------------------------------------
# verify (layer 1)
# --------------------------------------------------------------------------


def test_verify_placement_catches_a_capacity_breach():
    tasks = [_task("t1", hours=2.0)]
    res = place(tasks, MON_FRI)
    # forge a breach
    res.slots[0].hours = 99.0
    violations = verify_placement(tasks, MON_FRI, res)
    assert any("capacity" in v for v in violations)


def test_verify_placement_accepts_a_sound_result():
    tasks = [_task(f"t{i}", hours=2.0) for i in range(3)]
    res = place(tasks, MON_FRI)
    assert verify_placement(tasks, MON_FRI, res) == []


def test_verify_placement_catches_out_of_window_slots():
    tasks = [_task("t1", hours=2.0, start="2026-01-05", end="2026-01-07")]
    res = place(tasks, MON_FRI)
    res.slots[0].date = "2026-06-01"
    violations = verify_placement(tasks, MON_FRI, res)
    assert any("outside" in v for v in violations)


# --------------------------------------------------------------------------
# headroom
# --------------------------------------------------------------------------


def test_headroom_notes_tightness_at_the_grace_boundary():
    """-5h is *inside* the 5h grace band, so it proceeds with a warning.

    This is the PRD's own example (§5.2): 45h against a 40h capacity proceeds
    but names the tightness; only past -5h does it offer the four buttons.
    """
    h = check_headroom(new_goal_hours=10, active_goal_hours=[35], capacity_hours=40)
    assert h.verdict == "proceed_tight"
    assert h.free_hours == -5


def test_headroom_renegotiates_past_the_grace_band():
    h = check_headroom(new_goal_hours=11, active_goal_hours=[35], capacity_hours=40)
    assert h.verdict == RENEGOTIATE
    assert h.free_hours == -6


# --------------------------------------------------------------------------
# staleness
# --------------------------------------------------------------------------


def test_daily_change_is_slim_and_a_milestone_move_escalates():
    assert st.classify_change(["daily"]).tier == st.VERDICT_SLIM
    assert st.classify_change(["weekly"]).tier == st.VERDICT_ESCALATE
    assert st.classify_change(["daily"], milestone_moved=True).tier == st.VERDICT_ESCALATE


def test_count_is_zero_after_a_confirm_and_monotonic_inside_a_window():
    """Generation-only counting — a same-tick change must still count.

    Comparing timestamps was the bug: a change recorded in the same second as
    the confirm (the normal case, both in one request) compared equal and
    flickered out of the count.
    """
    base = st.Baseline(goal_id="g1", generation=1, last_planned_at="2026-01-01T00:00:00+00:00")

    same_tick = st.make_change("g1", "daily_log", ["daily"], generation=1)
    same_tick.created_at = base.last_planned_at  # identical instant
    assert st.count_pending([same_tick], base) == 1, "a same-tick change must count"

    later = st.make_change("g1", "blocker.add", ["daily"], generation=1)
    later.created_at = "2026-01-02T00:00:00+00:00"
    assert st.count_pending([same_tick, later], base) == 2, "monotonic inside a window"

    # a confirm advances the generation — every earlier change stops counting
    advanced = st.next_baseline(base, goal_id="g1", at="2026-01-03T00:00:00+00:00")
    assert st.count_pending([same_tick, later], advanced) == 0

    # and a change recorded after the confirm counts again
    fresh = st.make_change("g1", "daily_log", ["daily"], generation=2)
    assert st.count_pending([same_tick, later, fresh], advanced) == 1


def test_adjustments_are_deterministic_and_name_the_thing():
    a = st.make_change("g1", "blocker.add", ["daily"], detail={"label": "your Goa trip"})
    a.created_at = "2026-01-01T00:00:00+00:00"
    b = st.make_change("g1", "goal.edit", ["weekly"], detail={"label": "Switch jobs"})
    b.created_at = "2026-01-01T00:00:01+00:00"
    first = st.build_adjustments([a, b])
    second = st.build_adjustments([b, a])  # order in must not matter
    assert first == second
    assert "Goa trip" in first[0]


def test_rollup_label_reads_cleanly():
    changes = [st.make_change("g1", "daily_log", ["daily"])]
    roll = st.rollup_counts(changes, {})
    assert roll["total"] == 1
    assert roll["label"] == "1 change since last planning"


# --------------------------------------------------------------------------
# cross_validate (grounding)
# --------------------------------------------------------------------------


def test_cross_validate_rejects_an_ungrounded_milestone():
    from app.contracts.schemas import MilestoneSpec, PlanChanges, ReplanAction

    action = ReplanAction(
        intent="add_goal",
        changes=PlanChanges(title="Switch jobs", milestones=[MilestoneSpec(title="Nope", phase="X")]),
    )
    errors = cross_validate(
        [action],
        plan_items=[],
        plan_goal_title="Switch jobs",
        planned_milestone_titles=["Pass 5 SD mocks"],
    )
    assert any("not grounded" in e for e in errors)


def test_cross_validate_accepts_a_grounded_milestone():
    from app.contracts.schemas import MilestoneSpec, PlanChanges, ReplanAction

    action = ReplanAction(
        intent="add_goal",
        changes=PlanChanges(
            title="Switch jobs", milestones=[MilestoneSpec(title="Pass 5 SD mocks", phase="Mocks")]
        ),
    )
    errors = cross_validate(
        [action],
        plan_items=[],
        plan_goal_title="Switch jobs",
        planned_milestone_titles=["Pass 5 SD mocks"],
    )
    assert errors == []


def test_cross_validate_rejects_a_title_that_does_not_match_the_plan():
    from app.contracts.schemas import PlanChanges, ReplanAction

    action = ReplanAction(intent="add_goal", changes=PlanChanges(title="Learn Rust"))
    errors = cross_validate([action], plan_items=[], plan_goal_title="Switch jobs")
    assert any("does not match" in e for e in errors)


def test_cross_validate_accepts_a_grounded_action():
    from app.contracts.schemas import PlanChanges, ReplanAction

    action = ReplanAction(intent="add_goal", changes=PlanChanges(title="Switch jobs"))
    assert cross_validate([action], plan_items=[], plan_goal_title="Switch jobs") == []
