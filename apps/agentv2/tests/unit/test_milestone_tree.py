"""The goal's facet breakdown: how a draft becomes a valid milestone tree, and how the planner uses it.
No model: planner calls get a fake chat that replays canned JSON."""
import json
from datetime import date, datetime, timedelta

import pytest

import agentv2.intake.turn as intake_turn
import agentv2.planner.day as planner_day
from agentv2.contracts import AddItem
from agentv2.contracts.intake import GoalDraft, MilestoneDraft
from agentv2.contracts.planner import GoalSpec, MilestoneSpec
from agentv2.core.context import Context
from agentv2.intake.turn import draft_to_changes, milestone_tree
from agentv2.planner.day import DAY_PREFIX, plan_day_level
from agentv2.planner.week import WeekAlloc, plan_weeks


@pytest.fixture(autouse=True)
def _four_kind_writes(monkeypatch):
    """Pin the 4-kind path, the one the app is moving to, whatever the deployed default is."""
    monkeypatch.setattr(intake_turn, "FOUR_KIND_WRITES", True)
    monkeypatch.setattr(planner_day, "FOUR_KIND_WRITES", True)


START = date(2026, 10, 15)
NOW = datetime(2026, 10, 15, 8, 0)
RESUME, DESIGN = "Resume fixed and 40 applications sent", "System design ready"


def m(title, week, parent="", hours=0):
    return MilestoneDraft(title=title, week=week, parent=parent, hours=hours)


class ReplayChat:
    """Answers each call with the next canned reply; the last one repeats."""

    def __init__(self, *replies):
        self.replies = list(replies)

    def invoke(self, messages):
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return type("Msg", (), {"content": reply})()


def test_facets_come_first_each_followed_by_its_sub_milestones():
    tree = milestone_tree([m("Resume rewritten", 2, RESUME), m(DESIGN, 10), m(RESUME, 6), m("Fundamentals read", 3, DESIGN)], START, 12)
    assert [(t.title, t.parent) for t in tree] == [
        (RESUME, ""), ("Resume rewritten", RESUME), (DESIGN, ""), ("Fundamentals read", DESIGN)]


def test_milestones_may_share_a_deadline():
    tree = milestone_tree([m(RESUME, 6), m("Resume rewritten", 2, RESUME), m("Shortlist made", 2, RESUME)], START, 12)
    assert tree[1].due == tree[2].due == START + timedelta(weeks=2)


def test_a_facet_is_never_due_before_its_latest_sub_milestone():
    tree = milestone_tree([m(RESUME, 3), m("40 applications sent", 8, RESUME)], START, 12)
    assert tree[0].due == START + timedelta(weeks=8)


def test_weeks_are_clamped_to_the_goal_span():
    tree = milestone_tree([m("Too late", 40), m("Too early", 0)], START, 12)
    assert {t.title: t.due for t in tree} == {"Too early": START + timedelta(weeks=1), "Too late": START + timedelta(weeks=12)}


def test_an_unknown_parent_makes_the_milestone_a_facet():
    tree = milestone_tree([m("Orphan", 4, "No such facet")], START, 12)
    assert tree[0].parent == ""


def test_a_sub_milestone_cannot_be_the_parent_of_another():
    tree = milestone_tree([m(RESUME, 6), m("Resume rewritten", 2, RESUME), m("Bullets drafted", 1, "Resume rewritten")], START, 12)
    assert {t.title: t.parent for t in tree}["Bullets drafted"] == ""


def test_facet_hours_default_to_the_sum_of_its_sub_milestones():
    tree = milestone_tree([m(RESUME, 6), m("A", 2, RESUME, hours=4), m("B", 5, RESUME, hours=6)], START, 12)
    assert tree[0].hours == 10


def test_draft_to_changes_links_sub_milestones_to_their_facet_and_carries_the_pace():
    draft = GoalDraft(title="Switch jobs", total_hours=100, deadline_weeks=12, weekly_hours=10,
                      milestones=[m(RESUME, 6), m("Resume rewritten", 2, RESUME)])
    spec, changes = draft_to_changes(draft, NOW)
    miles = [c.block for c in changes if isinstance(c, AddItem) and c.block.block_kind == "milestone"]
    assert miles[1].parent_id == miles[0].id and miles[0].parent_id is None
    assert spec.weekly_hours == 10 and [s.id for s in spec.milestones] == [c.id for c in miles]


def test_no_planned_week_exceeds_the_goal_pace():
    # The model gives nothing usable, so the even split runs; it still respects the pace.
    goal = GoalSpec(id="g", title="G", total_hours=200, deadline=START + timedelta(weeks=8), weekly_hours=5)
    res = plan_weeks(ReplayChat("not json"), goal, Context(today=START), NOW)
    assert res.allocs and max(a.hours for a in res.allocs) <= 5


def test_a_session_is_linked_to_the_milestone_it_works_toward():
    ms = MilestoneSpec(id="mile_1", title="Fundamentals read", due=START + timedelta(weeks=3), hours=6)
    goal = GoalSpec(id="g", title="G", total_hours=6, deadline=START + timedelta(weeks=4), milestones=[ms])
    day_id = f"{DAY_PREFIX}{START.isoformat()}"
    day_plan = json.dumps({"sessions": [{"day_id": day_id, "title": "Read caching", "hours": 1, "milestone": "Fundamentals read"}]})
    week = WeekAlloc(START, "Fundamentals", 1, milestones=["Fundamentals read"])
    changes, _ctx, _how = plan_day_level(ReplayChat(day_plan, "not json"), goal, week, Context(goal_ids=frozenset({"g"}), today=START), NOW)
    task = next(c.block for c in changes if isinstance(c, AddItem) and c.block.block_kind == "task")
    assert task.milestone_id == "mile_1"
