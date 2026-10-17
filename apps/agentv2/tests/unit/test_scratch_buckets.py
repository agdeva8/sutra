"""Scratch routing for the buckets added with the goal-less to-do, the away range and partial ticks.
`route` is pure given a TriageResult, so no model is involved."""
import asyncio
import importlib
from datetime import date, datetime, time

import pytest

from agentv2.contracts import AddBlocker, AddItem, AddTodo, CompleteItem, Origin
from agentv2.contracts.triage import AwaySpec, ReminderSpec, TriageItem, TriageResult
from agentv2.core.context import Context
from agentv2.gateway import apply
from agentv2.gateway.memory import InMemoryStore
from agentv2.triage.route import route

# The package re-exports the `route` function under the module's own name, so the module is
# fetched by path: that is where `route()` reads the flag.
triage_route = importlib.import_module("agentv2.triage.route")


@pytest.fixture(autouse=True)
def _four_kind_writes(monkeypatch):
    """Pin the 4-kind path, the one the app is moving to, whatever the deployed default is."""
    monkeypatch.setattr(triage_route, "FOUR_KIND_WRITES", True)


NOW = datetime(2026, 10, 14, 10, 0)
ORIGIN = Origin(source="scratch")


def _route(*items, ctx=None):
    return route(None, TriageResult(items=list(items), confidence=0.95), ctx or Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}), NOW, ORIGIN)


def test_a_todo_needs_no_goal_and_no_hours():
    # Still a plan_items to-do on the 4-kind path: the To-dos screen reads that table.
    routed = _route(TriageItem(bucket="todo", title="Reply to Mohit on Slack"))
    task = routed.changeset.changes[0]
    assert isinstance(task, AddTodo) and task.goal_id is None and routed.waiting is None


def test_a_task_that_cannot_be_tied_to_a_goal_becomes_a_todo_instead_of_a_question():
    routed = _route(TriageItem(bucket="task", title="Buy milk"))
    assert routed.waiting is None and isinstance(routed.changeset.changes[0], AddTodo)


def test_a_bare_reminder_gets_defaults_and_an_explicit_time_is_honoured():
    bare = _route(TriageItem(bucket="reminder", title="Drink water")).changeset.changes[0]
    assert isinstance(bare, AddItem) and bare.block.block_kind == "task"
    assert bare.block.at == time(9, 0)
    assert bare.block.day == NOW.date() and bare.block.repeat is None
    timed = _route(TriageItem(bucket="reminder", title="Call mom", reminder=ReminderSpec(at_time="18:00", date="2026-10-15"))).changeset.changes[0]
    assert timed.block.at == time(18, 0)
    assert timed.block.day == date(2026, 10, 15)


def test_a_reminder_over_several_days_repeats_until_its_last_day_once_per_time():
    spec = ReminderSpec(times_per_day=3, duration_days=3, date="2026-10-15")
    changes = _route(TriageItem(bucket="reminder", title="Eye drops", reminder=spec)).changeset.changes
    assert [c.block.at for c in changes] == [time(9, 0), time(14, 0), time(21, 0)]
    for c in changes:
        assert c.block.day == date(2026, 10, 15)
        assert c.block.repeat.until == date(2026, 10, 17)
        assert c.block.repeat.weekdays == sorted({date(2026, 10, d).weekday() for d in (15, 16, 17)})


def test_a_trip_is_one_away_range_not_a_block_per_day():
    routed = _route(TriageItem(bucket="away", title="Delhi trip", away=AwaySpec(start_date="2026-10-21", end_date="2026-10-25")))
    (change,) = routed.changeset.changes
    assert isinstance(change, AddItem) and change.block.block_kind == "away"
    assert (change.block.start_date, change.block.end_date) == (date(2026, 10, 21), date(2026, 10, 25))


def test_an_away_range_in_the_past_or_missing_dates_asks_instead_of_guessing():
    assert _route(TriageItem(bucket="away", title="x", away=AwaySpec(start_date="2026-10-01"))).waiting
    assert _route(TriageItem(bucket="away", title="x")).waiting


def test_partial_and_skip_ticks_keep_the_amount_and_a_partial_without_an_amount_counts_as_done():
    ctx = Context(goal_ids=frozenset({"g"}), open_items={"t1": "Graph set"})
    half = _route(TriageItem(bucket="done", title="x", target_id="t1", outcome="partial", fraction=0.5), ctx=ctx).changeset.changes[0]
    assert isinstance(half, CompleteItem) and half.outcome == "partial" and half.fraction == 0.5
    skipped = _route(TriageItem(bucket="done", title="x", target_id="t1", outcome="skip"), ctx=ctx).changeset.changes[0]
    assert skipped.outcome == "skip"
    vague = _route(TriageItem(bucket="done", title="x", target_id="t1", outcome="partial"), ctx=ctx).changeset.changes[0]
    assert vague.outcome == "full"


def test_an_away_range_blocks_planning_and_clears_planned_time_on_those_days():
    from agentv2.contracts import AddBlock, ChangeSet
    from datetime import time
    store = InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}, today=date(2026, 10, 14)))
    asyncio.run(apply(ChangeSet(origin=ORIGIN, changes=[AddBlock(id="b1", title="Study", day=date(2026, 10, 22), start=time(9), end=time(10), goal_id="g")]), store))
    res = asyncio.run(apply(ChangeSet(origin=ORIGIN, changes=[AddBlocker(id="a1", title="Trip", start_date=date(2026, 10, 21), end_date=date(2026, 10, 23))]), store))
    assert not hasattr(res, "violations") and "b1" not in store.blocks and "g" in res.displaced_goals
    assert date(2026, 10, 22) in asyncio.run(store.context()).blocked_dates


def test_a_timed_block_keeps_its_goal_when_the_goal_is_real_and_none_otherwise():
    from agentv2.contracts.triage import BlockSpec
    spec = BlockSpec(date="2026-10-15", start_time="18:00", end_time="20:00")
    linked = _route(TriageItem(bucket="block", title="LLD prep", goal_id="g", block=spec)).changeset.changes[0]
    assert linked.block.block_kind == "task" and linked.block.goal_id == "g"
    plain = _route(TriageItem(bucket="block", title="Dentist", block=spec)).changeset.changes[0]
    assert plain.block.block_kind == "event" and plain.block.goal_id is None
    invented = _route(TriageItem(bucket="block", title="Dentist", goal_id="g_made_up", block=spec)).changeset.changes[0]
    assert invented.block.goal_id is None


def test_a_goal_task_placed_from_scratch_gives_its_slots_the_goal(monkeypatch):
    from datetime import time
    from agentv2.contracts import AddBlock
    import importlib
    route_mod = importlib.import_module("agentv2.triage.route")
    seen = {}

    def fake_place(chat, title, hours, ctx, now, *, task_id=None, goal_id=None):
        seen["goal_id"] = goal_id
        return [AddBlock(id="b", title=title, day=date(2026, 10, 15), start=time(9), end=time(10), status="tentative", task_id=task_id, goal_id=goal_id)], "model"

    monkeypatch.setattr(route_mod, "place_task", fake_place)
    routed = _route(TriageItem(bucket="task", title="Mock interview", goal_id="g", effort_hours=1))
    slot = routed.changeset.changes[1]
    assert seen["goal_id"] == "g" and slot.goal_id == "g"
