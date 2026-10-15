"""Step 13: a goal broken into parallel facets with sub-milestones, then planned against them."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from ..agent import create_goal, intake_turn
from ..config import load_settings
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
ANSWERS = [
    "I want to switch jobs in 3 months, to a senior backend role",
    "I'm weak at system design and behavioural interviews; coding is fine. Resume is outdated. About 10 hours a week. Go ahead and plan it.",
]


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context())
    state = step = None
    for answer in ANSWERS:
        print(f"\nuser: {answer}")
        step = await intake_turn(state, answer, now=NOW, chat=chat)
        state = step.state
        if step.error or step.draft:
            break
        print(f"agent: {step.question}")
    if not step or not step.draft:
        print("no draft", step and step.error); return
    out = await create_goal(store, step.draft, now=NOW, chat=chat)
    ms = store.milestones
    print(f"\nplan {out.plan.status}; milestones={len(ms)} weeks={len(store.weeks)} tasks={len(store.tasks)} blocks={len(store.blocks)}\n")
    for m in ms.values():
        if not m.parent_id:
            print(f"{m.target_date}  {m.title}  [{m.hours:g}h]")
            for k in ms.values():
                if k.parent_id == m.id:
                    print(f"   {k.target_date}  {k.title}  [{k.hours:g}h]")
    per_day = defaultdict(list)
    for t in store.tasks.values():
        per_day[t.day].append(t)
    print("\nfirst two weeks of sessions:")
    for d in sorted(k for k in per_day if k)[:14]:
        for t in per_day[d]:
            print(f"   {d:%a %d %b}  {t.effort_hours:g}h  {t.title}  -> {ms[t.milestone_id].title if t.milestone_id in ms else '(none)'}")
    print("\nweeks:")
    for w in sorted(store.weeks.values(), key=lambda w: w.week_start):
        print(f"   {w.week_start}  {w.hours:g}h  {w.focus}")
    print(f"goal total_hours={step.draft.total_hours:g} weeks={step.draft.deadline_weeks}")
