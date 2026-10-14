"""The "about you" profile, mapped onto the planner: waking hours, work hours, weekly capacity."""
from datetime import date, datetime, time

from agentv2.config import ACTIVE_WINDOW_END, ACTIVE_WINDOW_START, DEFAULT_DAILY_CAPACITY_HOURS
from agentv2.core.context import Context
from agentv2.core.profile import UserProfile, to_planner
from agentv2.core.slots import busy_by_day, free_windows

MONDAY = date(2026, 10, 19)


def _ctx(raw):
    p = to_planner(UserProfile.from_json(raw))
    return Context(active_spans=p.active_spans, busy_weekly=p.busy_weekly, weekday_hours=p.weekday_hours)


def test_empty_profile_keeps_the_defaults():
    p = to_planner(UserProfile.from_json({}))
    assert p.active_spans == ((ACTIVE_WINDOW_START, ACTIVE_WINDOW_END),)
    assert p.busy_weekly == {} and p.weekday_hours is None


def test_malformed_fields_are_treated_as_skipped():
    prof = UserProfile.from_json({"wake": "early", "work_days": ["xyz"], "weekly_goal_hours": "lots"})
    assert prof == UserProfile()


def test_work_hours_and_waking_hours_shape_the_free_windows():
    ctx = _ctx({"work_days": ["mon"], "work_start": "09:00", "work_end": "17:00", "wake": "06:30", "sleep": "23:00"})
    spans = [(w.start, w.end) for w in free_windows(ctx, datetime.combine(MONDAY, time(0, 0)), days=1)]
    assert spans == [(time(6, 30), time(9, 0)), (time(17, 0), time(23, 0))]
    assert busy_by_day(ctx, datetime.combine(MONDAY, time(0, 0)), days=1)[MONDAY][0][:2] == (time(9, 0), time(17, 0))


def test_a_night_shift_and_a_late_bedtime_wrap_midnight():
    ctx = _ctx({"work_days": ["mon"], "work_start": "22:00", "work_end": "06:00", "wake": "14:00", "sleep": "07:00"})
    tuesday = date(2026, 10, 20)
    windows = [(w.start, w.end) for w in free_windows(ctx, datetime.combine(tuesday, time(0, 0)), days=1)]
    # Monday's shift runs to 06:00 Tuesday; awake until 07:00, then asleep until 14:00.
    assert windows == [(time(6, 0), time(7, 0)), (time(14, 0), time(23, 59))]


def test_weekly_hours_cap_the_week_and_leave_the_split_across_days_to_the_planner():
    raw = {"weekly_goal_hours": 6, "rest_days": ["sat"]}
    p = to_planner(UserProfile.from_json(raw))
    assert p.weekly_cap_hours == 6
    ctx = _ctx(raw)
    # No even share: any non-rest day can hold a long session, Saturday holds nothing.
    assert ctx.capacity_on(MONDAY) == DEFAULT_DAILY_CAPACITY_HOURS
    assert ctx.capacity_on(date(2026, 10, 24)) == 0.0  # Saturday


def test_a_week_never_offers_more_goal_hours_than_the_weekly_figure():
    from agentv2.core.calendar import free_hours_by_week

    p = to_planner(UserProfile.from_json({"weekly_goal_hours": 6}))
    ctx = Context(weekday_hours=p.weekday_hours, weekly_cap_hours=p.weekly_cap_hours)
    free = free_hours_by_week(ctx, datetime.combine(MONDAY, time(0, 0)), 2)
    assert all(h <= 6 for h in free.values()) and max(free.values()) == 6


def test_rest_days_without_weekly_hours_keep_the_usual_day():
    ctx = _ctx({"rest_days": ["sun"]})
    assert ctx.capacity_on(MONDAY) == DEFAULT_DAILY_CAPACITY_HOURS
    assert ctx.capacity_on(date(2026, 10, 25)) == 0.0
