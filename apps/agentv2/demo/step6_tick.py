"""The tick: plan a goal (4 weeks get days), jump ahead 3 weeks, tick, and see new weeks expand."""
from __future__ import annotations

from datetime import datetime, timedelta

from ..agent import plan_goals, tick
from ..config import load_settings
from ..contracts.planner import GoalSpec
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)


def _expanded(store) -> int:
    return len({(g, store.blocks[b].day.isocalendar()[1]) for b, g in store.block_goal.items() if b in store.blocks})


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Learn driving"}))
    await plan_goals(store, [GoalSpec(id="g", title="Learn driving", total_hours=24, deadline=NOW.date() + timedelta(weeks=12))], now=NOW, chat=chat)
    print(f"after planning: {len(store.weeks)} weekly rows, weeks with days = {_expanded(store)}")
    later = NOW + timedelta(weeks=3)
    out = await tick(store, now=later, chat=chat)
    print(f"tick on {later:%d %b}: {out.status}, {out.applied} changes")
    for n in out.notes:
        print("  -", n)
    print(f"weeks with days now = {_expanded(store)}")
    out2 = await tick(store, now=later, chat=chat)
    print(f"tick again: {out2.notes}")
