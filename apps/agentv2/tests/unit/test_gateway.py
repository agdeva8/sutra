"""The validator, the gateway and undo, against the in-memory store. No model, no network."""
import asyncio
from datetime import date, time

from agentv2.contracts import (
    AddBlock, AddGoal, AddTask, ChangeSet, ClearGoalPlan, CompleteItem, MoveBlock, Origin, Rejected,
)
from agentv2.core.context import BlockRow, Context
from agentv2.core.validate import validate
from agentv2.gateway import apply, undo
from agentv2.gateway.memory import InMemoryStore

DAY = date(2026, 10, 15)
ORIGIN = Origin(source="manual")


def run(coro):
    return asyncio.run(coro)


def store(**kw):
    return InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}, **kw))


def cs(*changes):
    return ChangeSet(origin=ORIGIN, changes=list(changes))


def block(id, start, end, status="tentative", **kw):
    return AddBlock(id=id, title=id, day=DAY, start=time(start), end=time(end), status=status, **kw)


def test_task_needs_an_existing_goal():
    v = validate(cs(AddTask(id="t", goal_id="nope", title="x", effort_hours=1)), Context())
    assert [x.rule for x in v] == ["goal_exists"]


def test_goal_and_its_task_in_one_set_are_valid():
    assert validate(cs(AddGoal(id="g2", title="G"), AddTask(id="t", goal_id="g2", title="x", effort_hours=1)), Context()) == []


def test_planned_block_cannot_overlap_a_fixed_one():
    ctx = Context(blocks=(BlockRow("w", DAY, time(16), time(20), "committed"),))
    assert [x.rule for x in validate(cs(block("b", 18, 19)), ctx)] == ["no_overlap"]


def test_fixed_block_displaces_planned_time_instead_of_failing():
    ctx = Context(blocks=(BlockRow("p", DAY, time(9), time(10), "tentative"),))
    assert validate(cs(block("c", 8, 12, "committed")), ctx) == []


def test_block_must_start_before_it_ends():
    assert [x.rule for x in validate(cs(block("b", 10, 9)), Context())] == ["block_start_before_end"]


def test_capacity_is_enforced_per_day():
    ctx = Context(daily_capacity_hours=2.0)
    assert [x.rule for x in validate(cs(block("a", 8, 10), block("b", 11, 12)), ctx)] == ["capacity"]


def test_weekday_hours_make_a_missing_day_a_day_off():
    thursday = DAY.weekday()
    assert Context(weekday_hours={0: 2.0}).capacity_on(DAY) == 0.0
    assert Context(weekday_hours={thursday: 3.0}).capacity_on(DAY) == 3.0
    assert Context().capacity_on(DAY) == 8.0


def test_nothing_is_filed_in_the_past():
    ctx = Context(today=date(2026, 10, 20))
    assert [x.rule for x in validate(cs(block("b", 9, 10, "committed")), ctx)] == ["not_in_past"]


def test_planned_block_on_a_blocked_date_is_rejected():
    ctx = Context(blocked_dates=frozenset({DAY}))
    assert [x.rule for x in validate(cs(block("b", 9, 10)), ctx)] == ["blocked_date"]


def test_gateway_applies_safe_changes_and_audits():
    s = store()
    res = run(apply(cs(AddTask(id="t", goal_id="g", title="x", effort_hours=1), block("b", 9, 10, task_id="t", goal_id="g")), s))
    assert res.applied == [0, 1] and res.proposed == []
    assert "t" in s.tasks and "b" in s.blocks and len(s.audit) == 1


def test_gateway_rejects_and_writes_nothing_when_invalid():
    s = store()
    res = run(apply(cs(AddTask(id="t", goal_id="nope", title="x", effort_hours=1)), s))
    assert isinstance(res, Rejected) and s.tasks == {} and len(s.rejects) == 1


def test_moving_a_fixed_block_becomes_a_proposal_not_a_write():
    s = store(blocks=(BlockRow("w", DAY, time(16), time(20), "committed"),))
    res = run(apply(cs(MoveBlock(block_id="w", day=DAY, start=time(17), end=time(21))), s))
    assert [p.reason for p in res.proposed] == ["moves a committed block"]
    assert s.blocks["w"].start == time(16)


def test_a_user_approved_change_is_applied():
    s = store(blocks=(BlockRow("w", DAY, time(16), time(20), "committed"),))
    res = run(apply(cs(MoveBlock(block_id="w", day=DAY, start=time(17), end=time(21))), s, approved=True))
    assert res.proposed == [] and s.blocks["w"].start == time(17)


def test_a_fixed_block_removes_the_planned_time_it_covers_and_names_the_goal():
    s = store()
    run(apply(cs(AddTask(id="t", goal_id="g", title="x", effort_hours=1), block("p", 9, 10, task_id="t", goal_id="g")), s))
    res = run(apply(cs(block("c", 8, 12, "committed")), s))
    assert res.displaced_goals == ["g"] and "p" not in s.blocks and "c" in s.blocks


def test_finishing_a_task_clears_its_future_planned_blocks_and_undo_reopens_it():
    s = store()
    run(apply(cs(AddTask(id="t", goal_id="g", title="x", effort_hours=1), block("p", 9, 10, task_id="t", goal_id="g")), s))
    done = run(apply(cs(CompleteItem(item_id="t", title="x")), s))
    assert "t" in s.done and "p" not in s.blocks
    run(undo(s, done.audit_id))
    assert "t" not in s.done


def test_undo_removes_what_was_added_and_cannot_run_twice():
    s = store()
    added = run(apply(cs(AddTask(id="t", goal_id="g", title="x", effort_hours=1)), s))
    assert run(undo(s, added.audit_id)).reverted == 1 and s.tasks == {}
    assert run(undo(s, added.audit_id)).already_undone


def test_clearing_a_goals_plan_frees_the_time_for_the_new_plan():
    ctx = Context(goal_ids=frozenset({"g"}), blocks=(BlockRow("p", DAY, time(9), time(10), "tentative", "x", "g"),))
    assert validate(cs(ClearGoalPlan(goal_id="g", from_date=DAY), block("n", 9, 10, goal_id="g")), ctx) == []
