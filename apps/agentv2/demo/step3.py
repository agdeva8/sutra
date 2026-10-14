"""Step 3: plan two goals with the real model, merge, and apply through the gateway."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from ..config import load_settings
from ..contracts import Origin
from ..contracts.planner import GoalSpec
from ..core.context import BlockRow, Context
from ..gateway import apply
from ..gateway.memory import InMemoryStore
from ..model import build_model
from ..planner.plan import plan_goals
from ..triage.process import describe

NOW = datetime(2026, 10, 14, 10, 0)


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(
        goal_ids=frozenset({"g_drive", "g_google"}),
        goal_titles={"g_drive": "Learn driving", "g_google": "Google interview prep"},
        blocks=(BlockRow("b_work_wed", date(2026, 10, 14), time(11), time(18), "committed"),
                BlockRow("b_wedding", date(2026, 10, 17), time(9), time(22), "committed")),
    ))
    goals = [
        GoalSpec(id="g_google", title="Google interview prep", total_hours=60, deadline=NOW.date() + timedelta(weeks=10), priority=1),
        GoalSpec(id="g_drive", title="Learn driving", total_hours=24, deadline=NOW.date() + timedelta(weeks=12), priority=2),
    ]
    cs, notes = await plan_goals(chat, goals, await store.context(), NOW, Origin(source="goal", ref="demo"))
    print("planner notes:"); [print("  -", n) for n in notes]
    res = await apply(cs, store)
    print(f"\ngateway: {type(res).__name__}", getattr(res, "violations", ""))
    print(f"\nweekly rows: {len(store.weeks)}   tasks: {len(store.tasks)}   blocks: {len(store.blocks)}")
    for w in sorted(store.weeks.values(), key=lambda w: (w.week_start, w.goal_id)):
        print(f"  {w.week_start}  {w.goal_id:9} {w.hours:>5g}h  {w.focus}")
    print("\nfirst two weeks, day by day (F = fixed, p = planned):")
    titles = {b: next((t.title for t in store.tasks.values() if store.block_task.get(b) == t.id), "") for b in store.blocks}
    for b in sorted(store.blocks.values(), key=lambda b: (b.day, b.start)):
        if b.day < NOW.date() + timedelta(days=14):
            print(f"  {b.day:%a %d %b} {b.start:%H:%M}-{b.end:%H:%M} {'F' if b.status == 'committed' else 'p'}  {titles.get(b.id) or b.title}")
