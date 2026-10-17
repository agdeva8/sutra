"""The pure half of `POST /scratch/{id}/link-goal`: what a filing created, and the changes a re-link needs.

No database: the route's own reading of rows is exercised in the app, and this pins the decisions
that are easy to get wrong — which changes are actually re-linkable, and what each kind of row edits.
"""
from datetime import date, time

from agentv2.contracts import EditTodo, LinkSource
from agentv2.contracts.blocks import AwayBlock, EditItem, EventBlock, MilestoneBlock, TaskBlock
from sutra_api.api.scratch import (
    CreatedItem,
    SourceState,
    TodoState,
    can_relink,
    created_items,
    link_state,
    link_summary,
    relink_changes,
)

DAY = date(2026, 10, 17)

BLOCK_ID = "block_apply"
TODO_ID = "todo_call"
SOURCE_ID = "src_cv"


def _task(goal_id="g1"):
    return TaskBlock(id=BLOCK_ID, title="Apply to three jobs", day=DAY, start=time(9), end=time(10),
                     goal_id=goal_id, placed_by="user")


def _todo(goal_id=None):
    return TodoState(title="Call the recruiter", goal_id=goal_id, priority="normal",
                     description="", day=DAY, due_time="17:00", done=False)


def _source(goal_id=None):
    return SourceState(title="cv.pdf", summary="", goal_id=goal_id)


def _audit(applied=(0, 1, 2)):
    return {
        "applied": list(applied),
        "changes": [
            {"kind": "add_item", "block": {"block_kind": "task", "id": BLOCK_ID, "title": "Apply to three jobs"}},
            {"kind": "add_todo", "id": TODO_ID, "title": "Call the recruiter"},
            {"kind": "link_source", "source_id": SOURCE_ID, "title": "cv.pdf"},
        ],
    }


def test_created_items_reads_the_rows_the_filing_actually_wrote():
    items = created_items(_audit())
    assert items == [
        CreatedItem("block", BLOCK_ID),
        CreatedItem("todo", TODO_ID),
        CreatedItem("source", SOURCE_ID),
    ]


def test_created_items_skips_a_proposal_that_wrote_nothing():
    # Index 1 was proposed, not applied; its row does not exist, so it must not be re-linked.
    items = created_items(_audit(applied=(0, 2)))
    assert items == [CreatedItem("block", BLOCK_ID), CreatedItem("source", SOURCE_ID)]


def test_created_items_tolerates_an_entry_with_no_audit_payload():
    assert created_items(None) == []


def test_link_changes_each_row_for_each_kind():
    changes = relink_changes(
        created_items(_audit()), "g2",
        blocks={BLOCK_ID: _task()}, todos={TODO_ID: _todo()}, sources={SOURCE_ID: _source()},
    )
    block, todo, source = changes
    assert isinstance(block, EditItem) and block.id == BLOCK_ID
    assert block.block.goal_id == "g2"
    # The undo snapshot is the state before the link.
    assert block.before["goal_id"] == "g1"
    assert isinstance(todo, EditTodo) and todo.goal_id == "g2" and todo.clear == []
    assert todo.before == {
        "title": "Call the recruiter", "goal_id": None, "priority": "normal", "description": "",
        "day": DAY.isoformat(), "due_time": "17:00", "done": False,
    }
    assert isinstance(source, LinkSource) and source.source_id == SOURCE_ID and source.goal_id == "g2"


def test_no_goal_clears_a_blocks_goal_and_a_todos_goal():
    changes = relink_changes(
        created_items(_audit()), None,
        blocks={BLOCK_ID: _task()}, todos={TODO_ID: _todo(goal_id="g1")}, sources={SOURCE_ID: _source("g1")},
    )
    block, todo, source = changes
    assert block.block.goal_id is None
    # EditTodo only changes what it is given, so clearing is a named `clear`, never a silent None.
    assert todo.goal_id is None and todo.clear == ["goal_id"]
    assert source.goal_id is None


def test_a_deleted_row_is_left_out_rather_than_failing_the_link():
    changes = relink_changes(
        [CreatedItem("block", "gone"), CreatedItem("todo", "gone")], "g2",
        blocks={}, todos={}, sources={},
    )
    assert changes == []


def test_away_spans_cannot_carry_a_goal():
    away = AwayBlock(id="away_1", title="Trip", start_date=DAY, end_date=DAY)
    assert can_relink(away) is False
    assert relink_changes([CreatedItem("block", "away_1")], "g2",
                          blocks={"away_1": away}, todos={}, sources={}) == []


def test_a_milestone_is_relinked_but_never_unlinked():
    milestone = MilestoneBlock(id="ms_1", title="Finish CV", goal_id="g1", target_date=DAY)
    linked = relink_changes([CreatedItem("block", "ms_1")], "g2",
                            blocks={"ms_1": milestone}, todos={}, sources={})
    assert linked[0].block.goal_id == "g2"
    # A milestone always belongs to a goal; "No goal" cannot be represented, so it stays put.
    assert relink_changes([CreatedItem("block", "ms_1")], None,
                          blocks={"ms_1": milestone}, todos={}, sources={}) == []


def test_link_state_reports_the_one_goal_every_row_shares():
    items = [CreatedItem("block", BLOCK_ID), CreatedItem("todo", TODO_ID), CreatedItem("source", SOURCE_ID)]
    linkable, goal = link_state(items, blocks={BLOCK_ID: _task("g1")},
                                todos={TODO_ID: _todo("g1")}, sources={SOURCE_ID: _source("g1")})
    assert (linkable, goal) == (3, "g1")


def test_link_state_is_unlinked_when_no_row_has_a_goal():
    linkable, goal = link_state([CreatedItem("todo", TODO_ID)], blocks={},
                                todos={TODO_ID: _todo(None)}, sources={})
    assert (linkable, goal) == (1, None)


def test_link_state_answers_none_when_the_rows_disagree():
    # Mixed rows read as "Link to a goal": the next tap is what makes them agree.
    linkable, goal = link_state(
        [CreatedItem("block", BLOCK_ID), CreatedItem("todo", TODO_ID)],
        blocks={BLOCK_ID: _task("g1")}, todos={TODO_ID: _todo("g2")}, sources={})
    assert (linkable, goal) == (2, None)


def test_link_state_counts_only_rows_that_still_exist():
    linkable, goal = link_state([CreatedItem("block", "gone"), CreatedItem("todo", TODO_ID)],
                                blocks={}, todos={TODO_ID: _todo("g1")}, sources={})
    assert (linkable, goal) == (1, "g1")


def test_the_audit_row_says_what_happened():
    assert link_summary(2, "Switch jobs") == "Linked 2 items from Scratch to 'Switch jobs'"
    assert link_summary(1, "Switch jobs") == "Linked 1 item from Scratch to 'Switch jobs'"
    assert link_summary(2, None) == "Unlinked 2 items from Scratch"


def test_a_plain_event_is_relinkable():
    assert can_relink(EventBlock(id="evt", title="Dinner", day=DAY)) is True
