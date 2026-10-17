"""The 4-kind write path is validated like the old blocks.

The planner's sessions are tentative placements and get the full check; an event, or a task the
user placed, is committed — it takes the time and may double-book, the way a calendar app allows.
"""
from datetime import date, time

from agentv2.contracts import ChangeSet, Origin
from agentv2.contracts.blocks import AddItem, EditItem, EventBlock, TaskBlock
from agentv2.core.context import BlockRow, Context
from agentv2.core.validate import validate

DAY = date(2026, 10, 15)
ORIGIN = Origin(source="manual")


def cs(*changes):
    return ChangeSet(origin=ORIGIN, changes=list(changes))


def planner_task(task_id="p", start=time(9), end=time(10), day=DAY):
    return AddItem(block=TaskBlock(
        id=task_id, title="Study", goal_id="g", day=day,
        start=start, end=end, effort_hours=1, placed_by="planner"))


def event(event_id="e", start=time(9), end=time(10), day=DAY):
    return AddItem(block=EventBlock(
        id=event_id, title="Dentist", day=day, start=start, end=end))


def event_row(block_id="e", start=time(9), end=time(10)):
    return BlockRow(block_id, DAY, start, end, "committed", "Dentist")


def goal_ctx(**kw):
    return Context(goal_ids=frozenset({"g"}), today=date(2026, 10, 15), **kw)


def test_a_planner_session_overlapping_an_event_is_rejected():
    ctx = goal_ctx(blocks=(event_row(),))
    assert [v.rule for v in validate(cs(planner_task()), ctx)] == ["no_overlap"]


def test_a_user_event_overlapping_an_event_is_allowed():
    ctx = goal_ctx(blocks=(event_row(),))
    # Double-booking is the user's own call: an event packed against another one is not invalid.
    assert validate(cs(event(start=time(9, 30), end=time(10, 30))), ctx) == []


def test_a_user_event_over_a_planner_session_displaces_it():
    ctx = goal_ctx(blocks=(BlockRow("p", DAY, time(9), time(10), "tentative", "Study", "g"),))
    assert validate(cs(event()), ctx) == []

    # The gateway does the removing; the validator has already dropped the displaced row.
    from agentv2.gateway import apply
    from agentv2.gateway.memory import InMemoryStore
    import asyncio

    async def run_it():
        store = InMemoryStore(goal_ctx())
        await apply(cs(planner_task()), store)
        return await apply(cs(event()), store), store

    result, store = asyncio.run(run_it())
    assert result.displaced_goals == ["g"]
    assert "p" not in store.blocks4 and "e" in store.blocks4


def test_a_planner_session_on_a_blocked_day_is_rejected():
    ctx = goal_ctx(blocked_dates=frozenset({DAY}))
    assert [v.rule for v in validate(cs(planner_task()), ctx)] == ["blocked_date"]


def test_capacity_applies_to_planner_sessions():
    ctx = goal_ctx(daily_capacity_hours=1.0)
    assert [v.rule for v in validate(cs(planner_task(start=time(9), end=time(11))), ctx)] == ["capacity"]


def test_editing_a_planner_session_onto_an_event_is_rejected():
    ctx = goal_ctx(
        blocks=(event_row(start=time(16), end=time(17)),
                BlockRow("p", DAY, time(9), time(10), "tentative", "Study", "g")),
        items={"p": TaskBlock(id="p", title="Study", goal_id="g", day=DAY,
                              start=time(9), end=time(10), placed_by="planner")},
    )
    moved = EditItem(id="p", block=TaskBlock(
        id="p", title="Study", goal_id="g", day=DAY,
        start=time(16, 30), end=time(17, 30), placed_by="planner"))
    assert [v.rule for v in validate(cs(moved), ctx)] == ["no_overlap"]


def test_editing_an_unknown_item_stays_permissive():
    # An id the context does not hold is the store's to resolve, as before.
    moved = EditItem(id="gone", block=TaskBlock(
        id="gone", title="Study", goal_id="g", day=DAY,
        start=time(9), end=time(10), placed_by="planner"))
    assert validate(cs(moved), goal_ctx(blocks=(event_row(),))) == []
