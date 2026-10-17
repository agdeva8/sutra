"""`/todos` writes a to-do `TaskBlock` through the gateway; an old `plan_items` to-do still edits in place.
Pure: stand-in rows and a fake session, no database and no model."""
from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, time, timedelta
from types import SimpleNamespace

from agentv2.contracts.blocks import AddItem, EditItem, TaskBlock
from sutra_api.api import plan_items as api
from sutra_api.models import CalendarBlock, PlanItem

USER = SimpleNamespace(user_id="u")
#: A day the route will accept: it rejects a day already gone, so the test cannot pin a fixed date.
DAY = date.today() + timedelta(days=1)


class Request:
    headers: dict = {}

    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


class Session:
    """`get` answers by model: a plan row, a block row, or nothing."""

    def __init__(self, plan=None, block=None):
        self.plan, self.block = plan, block

    async def get(self, model, _id):
        if model is PlanItem:
            return self.plan
        if model is CalendarBlock:
            return self.block
        return None

    async def refresh(self, _row):
        return None

    async def commit(self):
        return None


def plan_row(**over):
    fields = dict(
        id="todo_1", user_id="u", goal_id=None, horizon="daily", phase="", title="Pay rent", note="",
        description=None, why=None, done_hours=None, start_date=None, end_date=None, due_date=None,
        weekly_hours=None, status="open", item_type="todo", priority="normal", due_time=None,
        done_at=None, created_at=datetime(2026, 10, 14, tzinfo=UTC),
    )
    fields.update(over)
    return SimpleNamespace(**fields)


def capture(monkeypatch):
    """Tick the gateway call and return a stub result; the change is kept for the assertions."""
    seen = {}

    async def fake_apply(session, request, user_id, change, today):
        seen["change"] = change
        return SimpleNamespace(audit_id="audit_1")

    monkeypatch.setattr(api, "_apply_via_gateway", fake_apply)
    return seen


def test_posting_a_todo_writes_a_marked_task_block(monkeypatch):
    seen = capture(monkeypatch)
    row = SimpleNamespace(created_at=datetime(2026, 10, 15, 9, tzinfo=UTC))
    session = Session(block=row)
    out = asyncio.run(api.create_todo(Request({"title": "Pay rent", "day": DAY.isoformat(), "due_time": "17:00", "priority": "high"}), session, USER))

    change = seen["change"]
    assert isinstance(change, AddItem) and isinstance(change.block, TaskBlock)
    blk = change.block
    assert (blk.title, blk.day, blk.at, blk.priority, blk.todo) == ("Pay rent", DAY, time(17), "high", True)
    assert blk.start is None and blk.end is None and blk.placed_by == "user"
    assert out["plan_item"]["id"] == blk.id and out["plan_item"]["item_type"] == "todo"
    assert out["plan_item"]["due_time"] == "17:00" and out["block"]["todo"] is True


def test_patching_a_legacy_todo_row_still_edits_that_row(monkeypatch):
    seen = capture(monkeypatch)
    session = Session(plan=plan_row(title="Pay rent", due_date=date(2026, 10, 15)))
    out = asyncio.run(api.edit_todo("todo_1", Request({"title": "Pay the rent"}), session, USER))

    change = seen["change"]
    assert type(change).__name__ == "EditTodo" and change.id == "todo_1" and change.title == "Pay the rent"
    assert out["plan_item"]["id"] == "todo_1" and "block" not in out


def test_patching_a_todo_block_writes_an_edit_item_with_undo_state(monkeypatch):
    seen = capture(monkeypatch)
    current = TaskBlock(id="todo_2", title="Buy milk", day=date(2026, 10, 15), at=time(18), todo=True, placed_by="user")
    session = Session(block=SimpleNamespace(
        user_id="u", block_kind="task", created_at=datetime(2026, 10, 15, 8, tzinfo=UTC),
        data=current.model_dump(mode="json"),
    ))
    out = asyncio.run(api.edit_todo("todo_2", Request({"due_time": "19:00", "done": True}), session, USER))

    change = seen["change"]
    assert isinstance(change, EditItem) and change.id == "todo_2"
    assert (change.block.at, change.block.done, change.block.state) == (time(19), True, "done")
    assert change.before["title"] == "Buy milk" and change.before["todo"] is True
    assert out["plan_item"]["status"] == "done" and out["block"]["state"] == "done"
