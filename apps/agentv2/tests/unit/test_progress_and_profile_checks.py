"""Progress facts (code owns every number) and the profile's own contradiction check."""
from datetime import date

from agentv2.core.profile import UserProfile, to_planner, waking_conflict
from agentv2.progress import MilestoneRow, PlanRow, build_goal_facts
from agentv2.prompts.milestones import MILESTONE_RULES

TODAY = date(2026, 10, 15)


def _day(i, d, hours, done=0.0):
    return PlanRow(f"d{i}", "daily", "s", d, None, hours, done)


def test_percentages_and_levels_come_from_the_rows():
    rows = [
        PlanRow("pm", "monthly", "Oct", date(2026, 10, 1), date(2026, 10, 31), 10),
        PlanRow("pw1", "weekly", "wk", date(2026, 10, 5), date(2026, 10, 11), 5),
        PlanRow("pw2", "weekly", "wk", date(2026, 10, 12), date(2026, 10, 18), 5),
        _day(1, date(2026, 10, 6), 2, 2), _day(2, date(2026, 10, 8), 3, 0),   # week 1: 5h due, 2h done
        _day(3, date(2026, 10, 13), 2, 2), _day(4, date(2026, 10, 20), 3, 0),
    ]
    f = build_goal_facts("g", "G", date(2027, 1, 7), rows, [MilestoneRow("m", "M", date(2026, 11, 19), False)], TODAY)
    assert (f.total_planned, f.total_done, f.pct_done) == (10.0, 4.0, 40)
    assert f.pct_expected == 70 and f.remaining == 6.0
    assert f.weeks[0].due == 5.0 and f.weeks[0].done == 2.0 and f.weeks[0].when == "past"
    assert f.months[0].scheduled == 10.0 and f.milestones[0].days_left == 35


def test_the_plan_size_is_the_whole_plan_not_just_the_weeks_already_broken_into_days():
    rows = [PlanRow("pw", "weekly", "wk", date(2026, 12, 7), date(2026, 12, 13), 12), _day(1, date(2026, 10, 15), 2)]
    f = build_goal_facts("g", "G", None, rows, [], TODAY)
    assert f.total_planned == 12.0 and f.scheduled_in_days == 2.0


def test_the_digest_changes_when_a_number_does():
    rows = [_day(1, date(2026, 10, 15), 2)]
    a = build_goal_facts("g", "G", None, rows, [], TODAY).digest()
    b = build_goal_facts("g", "G", None, [_day(1, date(2026, 10, 15), 2, 2)], [], TODAY).digest()
    assert a != b


def test_swapped_wake_and_sleep_is_caught_and_not_planned_around():
    swapped = UserProfile.from_json({"wake": "01:00", "sleep": "09:00", "work_start": "10:30", "work_end": "17:00", "work_days": ["mon"]})
    assert "outside the hours you are awake" in waking_conflict(swapped)
    assert to_planner(swapped).active_spans == ((to_planner(UserProfile()).active_spans[0]),)


def test_a_real_week_and_a_night_shift_are_not_flagged():
    for raw in (
        {"wake": "09:30", "sleep": "01:00", "work_start": "09:30", "work_end": "18:30", "work_days": ["mon"]},
        {"wake": "15:00", "sleep": "07:00", "work_start": "22:00", "work_end": "06:00", "work_days": ["mon"]},
        {"wake": "07:00"},
    ):
        assert waking_conflict(UserProfile.from_json(raw)) is None


def test_a_waking_day_that_is_too_short_is_flagged():
    assert "only 6 hours" in waking_conflict(UserProfile.from_json({"wake": "08:00", "sleep": "14:00"}))


def test_the_milestone_rules_forbid_bundling():
    assert "ONE outcome" in MILESTONE_RULES and "Never bundle" in MILESTONE_RULES
