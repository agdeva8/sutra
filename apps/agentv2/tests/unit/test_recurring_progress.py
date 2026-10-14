"""Recurring commitments (with stop) and progress, against the in-memory store. No model."""
import asyncio
from datetime import date, datetime, time

from agentv2 import goal_progress
from agentv2.contracts import (
    AddBlock, AddGoal, AddRecurring, AddTask, ChangeSet, CompleteItem, Origin, StopRecurring,
)
from agentv2.core.context import Context, GoalHours
from agentv2.core.recurring import occurrences
from agentv2.core.validate import validate
from agentv2.gateway import apply, undo
from agentv2.gateway.memory import InMemoryStore

TODAY = date(2026, 10, 14)  # Wednesday
NOW = datetime(2026, 10, 14, 10, 0)
ORIGIN = Origin(source="manual")


def run(c):
    return asyncio.run(c)


def store():
    return InMemoryStore(Context(today=TODAY, goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}))


def class_rule(**kw):
    base = dict(id="r1", title="Class", weekdays=[1, 3], start=time(18), end=time(20), start_date=TODAY)
    return AddRecurring(**{**base, **kw})


def test_occurrences_follow_the_weekdays_and_stop_at_the_end_date():
    days = [d for d, _, _ in occurrences([1, 3], time(18), time(20), TODAY, date(2026, 10, 29), TODAY)]
    assert days == [date(2026, 10, 15), date(2026, 10, 20), date(2026, 10, 22), date(2026, 10, 27), date(2026, 10, 29)]


def test_a_rule_with_no_end_runs_to_the_horizon():
    days = occurrences([0], time(7), time(8), TODAY, None, TODAY, horizon_days=28)
    assert len(days) == 4 and all(d.weekday() == 0 for d, _, _ in days)


def test_a_rule_that_starts_later_waits():
    days = occurrences([2], time(7), time(8), date(2026, 11, 4), None, TODAY, horizon_days=30)
    assert days[0][0] == date(2026, 11, 4)


def test_bad_rules_are_rejected():
    ctx = Context()
    assert validate(ChangeSet(origin=ORIGIN, changes=[class_rule(weekdays=[9])]), ctx)
    assert validate(ChangeSet(origin=ORIGIN, changes=[class_rule(start=time(20), end=time(18))]), ctx)
    assert validate(ChangeSet(origin=ORIGIN, changes=[class_rule(end_date=date(2026, 9, 1))]), ctx)


def test_adding_a_rule_lays_out_fixed_blocks_and_displaces_planned_time():
    s = store()
    run(apply(ChangeSet(origin=ORIGIN, changes=[
        AddTask(id="t", goal_id="g", title="x", effort_hours=1),
        AddBlock(id="p", title="x", day=date(2026, 10, 15), start=time(18), end=time(19), task_id="t", goal_id="g")]), s))
    res = run(apply(ChangeSet(origin=ORIGIN, changes=[class_rule()]), s))
    assert res.displaced_goals == ["g"] and "p" not in s.blocks
    assert all(b.status == "committed" for k, b in s.blocks.items() if k.startswith("r1:"))
    assert len([k for k in s.blocks if k.startswith("r1:")]) > 20


def test_stopping_removes_everything_from_the_date_and_keeps_the_past():
    s = store()
    run(apply(ChangeSet(origin=ORIGIN, changes=[class_rule()]), s))
    run(apply(ChangeSet(origin=ORIGIN, changes=[StopRecurring(rule_id="r1", from_date=date(2026, 10, 22), title="Class")]), s))
    left = sorted(b.day for k, b in s.blocks.items() if k.startswith("r1:"))
    assert left == [date(2026, 10, 15), date(2026, 10, 20)]
    assert s.recurring["r1"].end_date == date(2026, 10, 21)
    # still listed while it has days left (it ends 21 Oct, today is 14 Oct) ...
    assert [r.end_date for r in run(s.context()).recurring] == [date(2026, 10, 21)]
    # ... and gone once it has ended
    s.today = date(2026, 10, 25)
    assert run(s.context()).recurring == ()


def test_stopping_something_that_does_not_exist_is_refused():
    v = validate(ChangeSet(origin=ORIGIN, changes=[StopRecurring(rule_id="nope", from_date=TODAY)]), Context())
    assert [x.rule for x in v] == ["item_exists"]


def test_extending_adds_only_what_is_missing():
    s = store()
    run(apply(ChangeSet(origin=ORIGIN, changes=[class_rule()]), s))
    before = len(s.blocks)
    assert run(s.extend_recurring(TODAY)) == 0 and len(s.blocks) == before
    assert run(s.extend_recurring(date(2026, 12, 14))) > 0  # two months on, the horizon has moved


def test_undoing_a_new_rule_removes_its_blocks():
    s = store()
    res = run(apply(ChangeSet(origin=ORIGIN, changes=[class_rule()]), s))
    run(undo(s, res.audit_id))
    assert s.recurring == {} and not any(k.startswith("r1:") for k in s.blocks)


def test_progress_measures_done_hours_against_the_total():
    s = store()
    run(apply(ChangeSet(origin=ORIGIN, changes=[
        AddGoal(id="g2", title="Cooking", total_hours=10),
        AddTask(id="t1", goal_id="g2", title="a", effort_hours=3),
        AddTask(id="t2", goal_id="g2", title="b", effort_hours=2)]), s))
    run(apply(ChangeSet(origin=ORIGIN, changes=[CompleteItem(item_id="t1", title="a")]), s))
    (row,) = run(goal_progress(s, now=NOW))
    assert (row["total"], row["done"], row["remaining"]) == (10, 3.0, 7.0)


def test_remaining_never_goes_below_zero():
    assert GoalHours(total=5, done=8).remaining == 0
