"""Untimed planner work and re-planning: both hold hours without holding a clock slot.

A quota ("send 5 applications", any time) and a multi-day item are untimed task blocks. They
use up the user's hours, so a second goal must see them as taken; and a re-plan must not treat
the goal's own old sessions (which ClearGoalPlan removes) as busy.
"""
from datetime import date, datetime, time, timedelta

import pytest

import agentv2.planner.replan as replan
from agentv2.contracts import AddBlock, ChangeSet, ClearGoalPlan, Origin
from agentv2.contracts.blocks import AddItem, TaskBlock
from agentv2.contracts.planner import DayItem, DayPlan, GoalSpec
from agentv2.core.calendar import free_hours_by_day
from agentv2.core.context import BlockRow, Context, GoalHours, without_goal_plan
from agentv2.core.validate import RULE_CAPACITY, validate
from agentv2.planner import day
from agentv2.planner.day import plan_day_level
from agentv2.planner.plan import GoalPlan
from agentv2.planner.week import WeekAlloc

MONDAY = date(2026, 10, 19)
NOW = datetime(2026, 10, 19, 9, 0)


def day_id(d: date) -> str:
    return f"{day.DAY_PREFIX}{d.isoformat()}"


def spec(**kw) -> GoalSpec:
    base = dict(id="g", title="Switch to a backend job", total_hours=10)
    return GoalSpec(**{**base, **kw})


def fake_day_model(plan: DayPlan):
    """complete_json that answers the day prompt, and declines the (unneeded) slot prompt."""
    def fake(chat, system, user, schema, *a):
        return plan if schema is DayPlan else None
    return fake


# ---------------------------------------------------------------------------
# Gap 1: untimed planner work uses up the user's hours
# ---------------------------------------------------------------------------


def test_a_quota_reduces_room_and_free_hours_for_a_second_goal():
    quota = {MONDAY + timedelta(days=i): 1.0 for i in range(5)}  # Mon-Fri, 1h a day
    ctx = Context(today=MONDAY, untimed_hours_by_day=quota)
    empty = Context(today=MONDAY)

    assert day._room(ctx, MONDAY) == pytest.approx(day._room(empty, MONDAY) - 1.0) == pytest.approx(7.0)
    free, free_empty = free_hours_by_day(ctx, NOW, MONDAY), free_hours_by_day(empty, NOW, MONDAY)
    for d in quota:
        assert free[d] == pytest.approx(free_empty[d] - 1.0)
    # Days without untimed work are untouched.
    assert free[MONDAY + timedelta(days=5)] == pytest.approx(free_empty[MONDAY + timedelta(days=5)])


def test_plan_day_level_records_the_untimed_load_it_creates(monkeypatch):
    plan = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="Send 5 applications", hours=5, kind="quota",
        count=2, minutes_each=30, weekdays=[0, 1, 2, 3, 4])])
    monkeypatch.setattr(day, "complete_json", fake_day_model(plan))
    _changes, out_ctx, how = plan_day_level(
        None, spec(), WeekAlloc(MONDAY, "Applications", 5.0), Context(today=MONDAY), NOW)

    assert how == "model"
    assert out_ctx.untimed_hours_by_day == {MONDAY + timedelta(days=i): 1.0 for i in range(5)}


def test_a_multi_day_items_total_is_split_over_its_days(monkeypatch):
    days = [MONDAY + timedelta(days=1), MONDAY + timedelta(days=2)]
    plan = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="System design: caching", hours=4, kind="multi_day",
        days=[day_id(d) for d in days])])
    monkeypatch.setattr(day, "complete_json", fake_day_model(plan))
    _changes, out_ctx, _how = plan_day_level(
        None, spec(), WeekAlloc(MONDAY, "System design", 4.0), Context(today=MONDAY), NOW)

    assert out_ctx.untimed_hours_by_day == {d: 2.0 for d in days}


def test_the_validator_capacity_rule_counts_untimed_load():
    cs = ChangeSet(origin=Origin(source="manual"), changes=[
        AddBlock(id="b", title="Deep work", day=MONDAY, start=time(9), end=time(10))])

    full = validate(cs, Context(today=MONDAY, untimed_hours_by_day={MONDAY: 7.5}))
    assert any(v.rule == RULE_CAPACITY for v in full)

    fits = validate(cs, Context(today=MONDAY, untimed_hours_by_day={MONDAY: 6.5}))
    assert fits == []


# ---------------------------------------------------------------------------
# Gap 2: a re-plan ignores the goal's own old work
# ---------------------------------------------------------------------------


def _quota(gid: str, weekday_count: int, effort: float, anchor: date = MONDAY) -> TaskBlock:
    return TaskBlock(
        id=f"t_{gid}", title=f"{gid} quota", goal_id=gid, day=anchor,
        repeat=day.Repeat(weekdays=list(range(weekday_count)), until=anchor + timedelta(days=weekday_count - 1)),
        quota=2, effort_hours=effort, placed_by="planner",
    )


def test_without_goal_plan_removes_only_the_goals_tentative_from_d_work():
    ctx = Context(
        today=MONDAY,
        blocks=(
            BlockRow("g_today", MONDAY, time(9), time(10), "tentative", goal_id="g"),
            BlockRow("g_future", MONDAY + timedelta(days=2), time(9), time(10), "tentative", goal_id="g"),
            BlockRow("g_past", MONDAY - timedelta(days=1), time(9), time(10), "tentative", goal_id="g"),
            BlockRow("g_committed", MONDAY, time(11), time(12), "committed", goal_id="g"),
            BlockRow("h_today", MONDAY, time(13), time(14), "tentative", goal_id="h"),
        ),
        items={
            "g_quota": _quota("g", 3, 1.0),          # Mon-Wed, 1h a day
            "g_extra": TaskBlock(id="g_extra", title="Any time", goal_id="g", day=MONDAY,
                                 effort_hours=1.5, placed_by="planner"),
            "h_quota": _quota("h", 2, 2.0),          # Mon-Tue, 1h a day
        },
        untimed_hours_by_day={MONDAY: 3.5, MONDAY + timedelta(days=1): 2.0, MONDAY + timedelta(days=2): 1.0},
    )
    out = without_goal_plan(ctx, "g", MONDAY)

    assert {b.id for b in out.blocks} == {"g_past", "g_committed", "h_today"}
    assert set(out.items) == {"h_quota"}
    # G's load is gone from its days; the other goal's stays.
    assert out.untimed_hours_by_day == {MONDAY: 1.0, MONDAY + timedelta(days=1): 1.0}


def test_a_replan_can_reuse_the_goals_old_slot(monkeypatch):
    ctx = Context(
        today=MONDAY,
        goal_titles={"g": "Switch jobs"},
        goal_hours={"g": GoalHours(total=10, done=0)},
        blocks=(
            BlockRow("g_old", MONDAY, time(9), time(10), "tentative", goal_id="g"),
            BlockRow("h_other", MONDAY, time(13), time(14), "tentative", goal_id="h"),
        ),
    )
    seen: dict[str, Context] = {}

    def fake_plan(chat, goal_spec, plan_ctx, now, progress=None):
        seen["ctx"] = plan_ctx
        # The old 09:00-10:00 slot must read as free, and the new plan takes it back.
        assert free_hours_by_day(plan_ctx, now, MONDAY)[MONDAY] > 0
        blk = TaskBlock(id="new", title="Deep work", goal_id="g", day=MONDAY,
                        start=time(9), end=time(10), effort_hours=1, placed_by="planner")
        return GoalPlan(goal_spec, [AddItem(block=blk)])

    monkeypatch.setattr(replan, "plan_goal", fake_plan)
    changes, _notes = replan.replan_changes(None, ctx, "g", NOW)

    assert isinstance(changes[0], ClearGoalPlan)
    placed = next(c.block for c in changes if isinstance(c, AddItem))
    assert (placed.start, placed.end) == (time(9), time(10))
    assert seen["ctx"].block("g_old") is None
    assert seen["ctx"].block("h_other") is not None
