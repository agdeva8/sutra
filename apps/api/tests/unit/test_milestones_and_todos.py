"""The milestone tree as the planner reloads it, the to-do column mapping, and the to-do wire fields.
Pure: stand-in rows, no database."""
from __future__ import annotations

from datetime import UTC, date, datetime, time
from types import SimpleNamespace

from sutra_api.agent_store import STATUS_DONE, STATUS_OPEN, _milestone_trees, _todo_columns_from
from sutra_api.wire import plan_item


def mile(id, title, due, parent_id=None, hours=None, goal_id="g"):
    return SimpleNamespace(id=id, title=title, target_date=due, parent_id=parent_id, hours=hours, goal_id=goal_id)


def test_milestones_reload_as_facets_each_followed_by_its_sub_milestones():
    rows = [mile("s2", "Mocks", date(2026, 12, 1), "f1", 12), mile("f1", "Design", date(2026, 12, 1), hours=40),
            mile("s1", "Read", date(2026, 11, 1), "f1", 15), mile("f2", "Resume", date(2026, 11, 15))]
    tree = _milestone_trees(rows)["g"]
    assert [(m.id, m.parent) for m in tree] == [("f2", ""), ("f1", ""), ("s1", "Design"), ("s2", "Design")]
    assert tree[2].hours == 15 and tree[0].hours == 0


def test_a_milestone_whose_facet_is_done_or_gone_reloads_as_a_facet():
    tree = _milestone_trees([mile("s1", "Read", date(2026, 11, 1), "closed_facet")])["g"]
    assert tree[0].parent == ""


def test_ticking_a_todo_stamps_done_at_and_unticking_clears_it():
    done = _todo_columns_from({"done": True})
    assert done["status"] == STATUS_DONE and done["done_at"] is not None
    assert _todo_columns_from({"done": False}) == {"status": STATUS_OPEN, "done_at": None}


def test_todo_fields_from_the_audit_json_are_parsed():
    cols = _todo_columns_from({"day": "2026-10-16", "due_time": "17:00", "priority": "high"})
    assert cols == {"start_date": date(2026, 10, 16), "due_date": date(2026, 10, 16), "due_time": time(17), "priority": "high"}


def test_a_todo_on_the_wire_says_it_is_a_todo_and_when_it_was_done():
    row = SimpleNamespace(
        id="t", user_id="u", goal_id=None, horizon="daily", phase="", title="Pay rent", note="", description=None, why=None,
        done_hours=None, start_date=None, end_date=None, due_date=None, weekly_hours=None, status="done",
        item_type="todo", priority="high", due_time=time(17), done_at=datetime(2026, 10, 15, 9, tzinfo=UTC),
        created_at=datetime(2026, 10, 14, tzinfo=UTC))
    out = plan_item(row)
    assert out["item_type"] == "todo" and out["priority"] == "high" and out["due_time"] == "17:00"
    assert out["done_at"].startswith("2026-10-15")
