"""Milestones live in two tables for now; every reader sees one deduplicated list.

Pure: no session, no database. The backfill kept ids, so a milestone present in both tables is one
milestone and the `calendar_blocks` row is the copy that is still written.
"""
from datetime import date
from types import SimpleNamespace as NS

from sutra_api.store.repo import merge_milestones


def old(milestone_id, *, goal_id="g1", title="Apply", target_date=date(2026, 11, 1), status="open"):
    return NS(id=milestone_id, user_id="u1", goal_id=goal_id, goal_title="Switch jobs",
              title=title, target_date=target_date, phase="", status=status,
              parent_id=None, hours=None, created_at=None, updated_at=None)


def block(milestone_id, *, goal_id="g1", title="Apply", target_date="2026-11-01", reached=False):
    return NS(id=milestone_id, user_id="u1", created_at=None, updated_at=None, data={
        "block_kind": "milestone", "id": milestone_id, "title": title,
        "goal_id": goal_id, "target_date": target_date, "reached": reached,
    })


def test_old_rows_and_block_rows_are_merged():
    merged = merge_milestones([old("m1")], [block("m2", title="Interview", target_date="2026-11-15")])
    assert [(m.id, m.title) for m in merged] == [("m1", "Apply"), ("m2", "Interview")]


def test_a_row_in_both_tables_appears_once_and_the_block_wins():
    merged = merge_milestones([old("m1", title="Stale")], [block("m1", title="Fresh", reached=True)])
    assert len(merged) == 1
    assert merged[0].title == "Fresh" and merged[0].status == "done"


def test_the_block_shape_matches_the_old_one():
    view = merge_milestones([], [block("m1", goal_id="g1")], {"g1": "Switch jobs"})[0]
    assert (view.id, view.user_id, view.goal_id, view.goal_title, view.title, view.target_date,
            view.status, view.phase) == (
        "m1", "u1", "g1", "Switch jobs", "Apply", date(2026, 11, 1), "open", "")


def test_a_non_milestone_block_is_ignored():
    task = NS(id="t1", user_id="u1", data={
        "block_kind": "task", "title": "Study", "goal_id": "g1", "day": "2026-11-01"})
    assert merge_milestones([], [task]) == []


def test_malformed_block_json_is_ignored_rather_than_raising():
    assert merge_milestones([], [NS(id="x", user_id="u1", data={"block_kind": "milestone"})]) == []


def test_the_list_is_ordered_by_target_date_with_undated_last():
    merged = merge_milestones(
        [old("b", target_date=date(2026, 12, 1)), old("c", target_date=None)],
        [block("a", target_date="2026-10-01")],
    )
    assert [m.id for m in merged] == ["a", "b", "c"]
