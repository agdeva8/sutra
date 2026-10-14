"""Replan: plan a goal, then a new commitment lands on its planned time, and the goal is planned again."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from ..agent import plan_goals, replan_goal
from ..config import load_settings
from ..contracts import AddBlock, ChangeSet, Origin
from ..contracts.planner import GoalSpec
from ..core.context import Context
from ..gateway import apply
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)


def _planned(store, goal):
    return sorted((b.day, b.start, b.end) for b in store.blocks.values() if b.status == "tentative" and store.block_goal.get(b.id) == goal and b.day < NOW.date() + timedelta(days=10))


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Learn driving"}))
    await plan_goals(store, [GoalSpec(id="g", title="Learn driving", total_hours=24, deadline=NOW.date() + timedelta(weeks=8))], now=NOW, chat=chat)
    before = _planned(store, "g")
    print("planned before:", [f"{d:%a %d} {s:%H:%M}-{e:%H:%M}" for d, s, e in before][:8])
    # A new fixed commitment covers a day the goal had planned time on.
    day = before[1][0]
    res = await apply(ChangeSet(origin=Origin(source="manual"), changes=[AddBlock(id="b_new", title="Offsite", day=day, start=time(7), end=time(22), status="committed")]), store)
    print("gateway:", type(res).__name__, "displaced goals:", getattr(res, "displaced_goals", None))
    print(f"\nnew commitment: all of {day:%a %d %b}, 07:00-22:00")
    out = await replan_goal(store, "g", now=NOW, chat=chat)
    print(f"replan: {out.status}, {out.applied} changes, notes: {out.notes[:2]}")
    after = _planned(store, "g")
    print("planned after: ", [f"{d:%a %d} {s:%H:%M}-{e:%H:%M}" for d, s, e in after][:8])
    print("anything left on the blocked day:", any(d == day for d, _, _ in after))
