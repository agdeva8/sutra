"""The goal-drop impact preview: what a drop will remove, and how it is priced.

Read-only and session-only — the fake session answers the queries in call order,
so no database is involved.
"""
from datetime import date, time
from types import SimpleNamespace as NS

from sutra_api.store import goal_drop


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def __iter__(self):
        return iter(self.rows)

    def all(self):
        return list(self.rows)


class Result:
    def __init__(self, rows):
        self.rows = rows

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalars(self):
        return Rows(self.rows)


class FakeSession:
    """Answers, in order: goal, milestones, event blocks, task blocks, all goals."""

    def __init__(self, *, goal, milestones=(), events=(), tasks=(), goals=()):
        self.results = [[goal], list(milestones), list(events), list(tasks), list(goals)]

    async def execute(self, *_a, **_k):
        return Result(self.results.pop(0))

    async def get(self, *_a):
        return NS(available_weekly_hours=20)


GOAL = NS(id="g1", title="Switch jobs", weekly_hours=6, status="active")
OTHER_GOAL = NS(id="g2", title="Run a half marathon", weekly_hours=4, status="active")


def event(block_id, *, goal_id="g1", title="Mock interview", day="2026-10-20"):
    return NS(
        id=block_id,
        data={
            "block_kind": "event",
            "title": title,
            "day": day,
            "start": "07:00",
            "end": "08:00",
            "goal_id": goal_id,
        },
    )


def task(block_id, *, goal_id="g1", placed_by="planner", title="Revise DSA", day="2026-10-21"):
    data = {"block_kind": "task", "title": title, "goal_id": goal_id, "placed_by": placed_by}
    if day is not None:
        data.update({"day": day, "start": "19:00", "end": "20:00"})
    return NS(id=block_id, data=data)


async def impact_for(session):
    ref = goal_drop.GoalRef(goal_id="g1", goal_title="Switch jobs")
    return await goal_drop.compute_goal_drop_impact(session, user_id="u1", ref=ref)


async def test_events_and_planner_tasks_are_listed_in_the_wire_shape():
    session = FakeSession(
        goal=GOAL,
        events=[event("b1")],
        tasks=[task("b2"), task("b3", day=None, title="Pick a course")],
        goals=[GOAL, OTHER_GOAL],
    )

    impact = await impact_for(session)

    assert impact.counts == {"milestones": 0, "timetable_blocks": 3}
    assert [b["label"] for b in impact.timetable_blocks] == [
        "Mock interview",
        "Revise DSA",
        "Pick a course",
    ]
    first = impact.timetable_blocks[0]
    assert first == {
        "id": "b1",
        "label": "Mock interview",
        "block_date": date(2026, 10, 20).isoformat(),
        "start_time": time(7, 0).strftime("%H:%M"),
        "end_time": time(8, 0).strftime("%H:%M"),
    }
    # An undated planner task has no day to report.
    assert impact.timetable_blocks[2]["block_date"] is None


async def test_user_placed_and_other_goal_tasks_are_not_counted():
    session = FakeSession(
        goal=GOAL,
        tasks=[
            task("user", placed_by="user"),
            task("other", goal_id="g2"),
        ],
        goals=[GOAL, OTHER_GOAL],
    )

    impact = await impact_for(session)

    assert impact.timetable_blocks == []
    assert impact.counts == {"milestones": 0, "timetable_blocks": 0}


async def test_the_sentence_names_the_counts_and_the_freed_hours():
    milestones = [
        NS(id="m1", title="Apply to 10 roles", target_date=date(2026, 11, 1)),
        NS(id="m2", title="Mock interviews", target_date=date(2026, 12, 1)),
    ]
    session = FakeSession(
        goal=GOAL,
        milestones=milestones,
        events=[event("b1")],
        tasks=[task("b2")],
        goals=[GOAL, OTHER_GOAL],
    )

    sentence = goal_drop.drop_impact_sentence(await impact_for(session))

    assert "2" in sentence  # milestones
    assert "6" in sentence  # freed hours/week
