"""Replacing a goal's open milestone set: the done/open split, the change's rules, and both tables."""
import asyncio
from datetime import date

from agentv2.contracts import (
    AddGoal, AddMilestone, ChangeSet, MilestoneInput, Origin, ReplaceMilestones,
)
from agentv2.contracts.blocks import MilestoneBlock
from agentv2.core.context import Context
from agentv2.core.milestones import replacement_targets
from agentv2.core.validate import validate
from agentv2.gateway import apply, undo
from agentv2.gateway.memory import InMemoryStore

TODAY = date(2026, 10, 15)
ORIGIN = Origin(source="chat", ref="g")


def run(coro):
    return asyncio.run(coro)


def store():
    return InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Switch jobs"}))


def cs(*changes):
    return ChangeSet(origin=ORIGIN, changes=list(changes))


def item(mid, title, day=date(2026, 12, 1)):
    return MilestoneInput(id=mid, title=title, target_date=day)


# -- the pure split ---------------------------------------------------------


def test_done_milestones_are_kept_and_open_ones_are_replaced():
    keep, replace = replacement_targets([("a", True), ("b", False)])
    assert keep == {"a"} and replace == {"b"}


def test_a_milestone_is_either_kept_or_replaced_never_both():
    keep, replace = replacement_targets([("a", False), ("b", True)])
    assert keep | replace == {"a", "b"} and not (keep & replace)


def test_nothing_existing_means_nothing_to_keep():
    assert replacement_targets([]) == (set(), set())


# -- validation -------------------------------------------------------------


def test_the_goal_must_exist():
    ctx = Context(today=TODAY)
    v = validate(cs(ReplaceMilestones(goal_id="nope", milestones=[item("m", "One")])), ctx)
    assert [x.rule for x in v] == ["goal_exists"]


def test_a_milestone_needs_a_title():
    ctx = Context(goal_ids=frozenset({"g"}), today=TODAY)
    v = validate(cs(ReplaceMilestones(goal_id="g", milestones=[item("m", "  ")])), ctx)
    assert [x.rule for x in v] == ["item_exists"]


def test_a_replacement_cannot_move_a_milestone_into_the_past():
    ctx = Context(goal_ids=frozenset({"g"}), today=TODAY)
    v = validate(cs(ReplaceMilestones(goal_id="g", milestones=[item("m", "One", date(2026, 1, 1))])), ctx)
    assert [x.rule for x in v] == ["not_in_past"]


def test_the_same_id_twice_in_one_set_is_rejected():
    ctx = Context(goal_ids=frozenset({"g"}), today=TODAY)
    v = validate(
        cs(ReplaceMilestones(goal_id="g", milestones=[item("m", "One"), item("m", "Two")])), ctx
    )
    assert [x.rule for x in v] == ["duplicate_id"]


def test_a_clean_replacement_validates():
    ctx = Context(goal_ids=frozenset({"g"}), today=TODAY)
    assert validate(cs(ReplaceMilestones(goal_id="g", milestones=[item("m", "One")])), ctx) == []


# -- writing, in both tables ------------------------------------------------


def test_open_milestones_in_both_tables_are_replaced_and_done_ones_survive():
    s = store()
    s.milestones["old_legacy"] = AddMilestone(
        id="old_legacy", goal_id="g", title="Old legacy", target_date=date(2026, 11, 1)
    )
    s.milestones["done_legacy"] = AddMilestone(
        id="done_legacy", goal_id="g", title="Done legacy", target_date=date(2026, 10, 1)
    )
    s.done.add("done_legacy")
    s.blocks4["old_block"] = MilestoneBlock(
        id="old_block", goal_id="g", title="Old block", target_date=date(2026, 11, 15)
    )
    s.blocks4["done_block"] = MilestoneBlock(
        id="done_block", goal_id="g", title="Done block", target_date=date(2026, 10, 2), reached=True
    )

    change = ReplaceMilestones(
        goal_id="g",
        milestones=[item("new_1", "New one"), item("new_2", "New two", date(2027, 1, 1))],
        before=[item("old_legacy", "Old legacy"), item("old_block", "Old block")],
    )
    res = run(apply(cs(change), s, approved=True))
    assert res.applied == [0]

    # Open work in both tables is gone; done work in both tables is untouched.
    assert "old_legacy" not in s.milestones and "old_block" not in s.blocks4
    assert "done_legacy" in s.milestones and "done_block" in s.blocks4
    # The whole new set is written, to both shapes.
    assert set(s.milestones) >= {"new_1", "new_2"}
    assert set(s.blocks4) >= {"new_1", "new_2"}


def test_a_done_milestone_listed_in_the_new_set_is_not_rewritten():
    s = store()
    s.milestones["done_legacy"] = AddMilestone(
        id="done_legacy", goal_id="g", title="Done", target_date=date(2026, 10, 1)
    )
    s.done.add("done_legacy")

    res = run(apply(cs(ReplaceMilestones(goal_id="g", milestones=[item("done_legacy", "Renamed")])), s, approved=True))
    assert res.applied == [0]
    assert s.milestones["done_legacy"].title == "Done"


def test_undo_restores_the_open_milestones_it_replaced():
    s = store()
    s.milestones["old"] = AddMilestone(
        id="old", goal_id="g", title="Old", target_date=date(2026, 11, 1)
    )
    change = ReplaceMilestones(
        goal_id="g",
        milestones=[item("new", "New")],
        before=[item("old", "Old", date(2026, 11, 1))],
    )
    res = run(apply(cs(change), s, approved=True))
    assert res.applied == [0]

    run(undo(s, res.audit_id))
    assert "old" in s.milestones and "new" not in s.milestones and "new" not in s.blocks4


def test_a_goal_created_in_the_same_set_can_receive_the_replacement():
    s = store()
    s.goals.clear()
    changes = cs(
        AddGoal(id="g2", title="New goal"),
        ReplaceMilestones(goal_id="g2", milestones=[item("m", "One")]),
    )
    res = run(apply(changes, s, approved=True))
    assert res.applied == [0, 1]
    assert "m" in s.blocks4
