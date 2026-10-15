"""Scratch routing for the buckets added with the goal-less to-do, the away range and partial ticks.
`route` is pure given a TriageResult, so no model is involved."""
import asyncio
from datetime import date, datetime

from agentv2.contracts import AddBlocker, AddReminder, AddTask, CompleteItem, Origin
from agentv2.contracts.triage import AwaySpec, ReminderSpec, TriageItem, TriageResult
from agentv2.core.context import Context
from agentv2.gateway import apply
from agentv2.gateway.memory import InMemoryStore
from agentv2.triage.route import route

NOW = datetime(2026, 10, 14, 10, 0)
ORIGIN = Origin(source="scratch")


def _route(*items, ctx=None):
    return route(None, TriageResult(items=list(items), confidence=0.95), ctx or Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}), NOW, ORIGIN)


def test_a_todo_needs_no_goal_and_no_hours():
    routed = _route(TriageItem(bucket="todo", title="Reply to Mohit on Slack"))
    task = routed.changeset.changes[0]
    assert isinstance(task, AddTask) and task.goal_id is None and task.effort_hours is None and routed.waiting is None


def test_a_task_that_cannot_be_tied_to_a_goal_becomes_a_todo_instead_of_a_question():
    routed = _route(TriageItem(bucket="task", title="Buy milk"))
    assert routed.waiting is None and isinstance(routed.changeset.changes[0], AddTask)


def test_a_bare_reminder_gets_defaults_and_an_explicit_time_is_honoured():
    bare = _route(TriageItem(bucket="reminder", title="Drink water")).changeset.changes[0]
    assert isinstance(bare, AddReminder) and bare.days == [date(2026, 10, 14)]
    timed = _route(TriageItem(bucket="reminder", title="Call mom", reminder=ReminderSpec(at_time="18:00", date="2026-10-15"))).changeset.changes[0]
    assert timed.days == [date(2026, 10, 15)] and [t.strftime("%H:%M") for t in timed.times] == ["18:00"]


def test_a_trip_is_one_away_range_not_a_block_per_day():
    routed = _route(TriageItem(bucket="away", title="Delhi trip", away=AwaySpec(start_date="2026-10-21", end_date="2026-10-25")))
    (change,) = routed.changeset.changes
    assert isinstance(change, AddBlocker) and (change.start_date, change.end_date) == (date(2026, 10, 21), date(2026, 10, 25))


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
