"""To-dos through the gateway: add, edit, tick, and undo, against the in-memory store."""
import asyncio
from datetime import date, time

from agentv2.contracts import AddTodo, ChangeSet, EditTodo, Origin, Rejected
from agentv2.core.context import Context
from agentv2.gateway import apply, undo
from agentv2.gateway.memory import InMemoryStore

TODAY = date(2026, 10, 15)
ORIGIN = Origin(source="manual")


def run(coro):
    return asyncio.run(coro)


def store():
    return InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Goal"}, today=TODAY))


def cs(*changes):
    return ChangeSet(origin=ORIGIN, changes=list(changes))


def test_a_todo_is_added_with_its_optional_fields():
    s = store()
    run(apply(cs(AddTodo(id="t", title="Pay rent", day=TODAY, due_time=time(17), priority="high", goal_id="g")), s))
    assert s.todos["t"]["priority"] == "high" and s.todos["t"]["done"] is False


def test_a_todo_in_the_past_or_without_a_title_or_for_an_unknown_goal_is_rejected():
    for bad in (AddTodo(id="t", title="x", day=date(2026, 10, 1)), AddTodo(id="t", title="  "), AddTodo(id="t", title="x", goal_id="nope")):
        assert isinstance(run(apply(cs(bad), store())), Rejected)


def test_ticking_a_todo_keeps_it_and_undo_restores_the_old_values():
    s = store()
    run(apply(cs(AddTodo(id="t", title="Pay rent", priority="high", due_time=time(11))), s))
    res = run(apply(cs(EditTodo(id="t", done=True, priority="low", clear=["due_time"],
                                before={"done": False, "priority": "high", "due_time": time(11)})), s))
    assert s.todos["t"]["done"] is True and s.todos["t"]["priority"] == "low" and s.todos["t"]["due_time"] is None
    run(undo(s, res.audit_id))
    assert s.todos["t"]["done"] is False and s.todos["t"]["priority"] == "high" and s.todos["t"]["due_time"] == time(11)


def test_undoing_the_add_removes_the_todo():
    s = store()
    res = run(apply(cs(AddTodo(id="t", title="Buy milk")), s))
    run(undo(s, res.audit_id))
    assert "t" not in s.todos
