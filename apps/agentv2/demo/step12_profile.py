"""A user who wakes at 9:30, sleeps at 1:00 and works 9:30 to 18:30 on weekdays: where does the planner put sessions?"""
from __future__ import annotations

from datetime import datetime, timedelta

from ..agent import plan_goals
from ..config import load_settings
from ..contracts.planner import GoalSpec
from ..core.context import Context
from ..core.profile import UserProfile, to_planner
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
PROFILE = {"work_days": ["mon", "tue", "wed", "thu", "fri"], "work_start": "09:30", "work_end": "18:30", "wake": "09:30", "sleep": "01:00"}


async def run() -> None:
    planner = to_planner(UserProfile.from_json(PROFILE))
    print("active spans:", [(f"{a:%H:%M}", f"{b:%H:%M}") for a, b in planner.active_spans])
    ctx = Context(goal_ids=frozenset({"g"}), goal_titles={"g": "Switch employer"}, active_spans=planner.active_spans, busy_weekly=planner.busy_weekly)
    store = InMemoryStore(ctx)
    goal = GoalSpec(id="g", title="Switch to the same role at a different employer", total_hours=40, deadline=NOW.date() + timedelta(weeks=8))
    await plan_goals(store, [goal], now=NOW, chat=build_model(load_settings()))
    for b in sorted(store.blocks.values(), key=lambda b: (b.day, b.start))[:14]:
        print(f"  {b.day:%a %d %b}  {b.start:%H:%M}-{b.end:%H:%M}  {b.title}")
