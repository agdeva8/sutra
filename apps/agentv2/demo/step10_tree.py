"""Plan one long goal and print what the agent wrote as a tree: month > week > day > time slot."""
from __future__ import annotations

from datetime import datetime, timedelta

from ..agent import plan_goals
from ..config import load_settings
from ..contracts.planner import GoalSpec
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
GOAL = GoalSpec(id="g", title="Crack the Google SWE interview", total_hours=90, deadline=NOW.date() + timedelta(weeks=16))


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g"}), goal_titles={"g": GOAL.title}))
    out = await plan_goals(store, [GOAL], now=NOW, chat=chat)
    print(f"{GOAL.title}: {GOAL.total_hours:g}h by {GOAL.deadline}  ({out.status}, notes: {out.notes[:3]})\n")
    print("rows:", len(store.months), "months,", len(store.weeks), "weeks,", len(store.tasks), "tasks,", len(store.blocks), "blocks; proposals:", len(store.proposals), "applied/proposed:", out.applied, out.proposed)
    tasks_by_day: dict = {}
    for t in store.tasks.values():
        tasks_by_day.setdefault(t.day, []).append(t)
    slots = {}
    for b in store.blocks.values():
        slots.setdefault(store.block_task.get(b.id), []).append(b)
    for m in sorted(store.months.values(), key=lambda m: m.month_start):
        print(f"MONTH {m.month_start:%b %Y}  {m.hours:g}h  - {m.focus}\n      why: {m.why}")
        for w in sorted((w for w in store.weeks.values() if w.week_start.replace(day=1) == m.month_start), key=lambda w: w.week_start):
            print(f"  WEEK {w.week_start:%d %b}  {w.hours:g}h  - {w.focus}\n        why: {w.why}")
            for i in range(7):
                d = w.week_start + timedelta(days=i)
                ts = tasks_by_day.get(d, [])
                if not ts and not any(tasks_by_day.get(w.week_start + timedelta(days=j)) for j in range(7)):
                    if i == 0:
                        print("    (days not planned yet: the nightly tick fills them in when the week is close)")
                    continue
                if not ts:
                    print(f"    {d:%a %d}  (nothing)")
                for t in ts:
                    when = ", ".join(f"{b.start:%H:%M}-{b.end:%H:%M}" for b in slots.get(t.id, [])) or "unplaced"
                    print(f"    {d:%a %d}  {t.effort_hours:g}h  {when}  {t.title}\n          day why: {t.why}")
                    for b in slots.get(t.id, []):
                        print(f"          slot why: {store.block_why.get(b.id, '')}")
