"""Step 4: goal intake with the real model, then create + plan the confirmed goal."""
from __future__ import annotations

from datetime import datetime

from ..agent import create_goal, intake_turn
from ..config import load_settings
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
#: Canned answers, used in order; a real user would pick or type their own.
ANSWERS = ["I have to learn driving now in 3 months", "Never driven, I'll take a driving school course", "Test date isn't fixed yet", "About 3 hours a week is fine"]


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context())
    state, step = None, None
    for answer in ANSWERS:
        print(f"\nuser: {answer}")
        step = intake_turn(state, answer, now=NOW, chat=chat)
        state = step.state
        if step.error:
            print("  error:", step.error); return
        if step.draft:
            break
        print(f"agent: {step.question}   options={step.options}")
    if not step.draft:
        print("\n(no draft after the canned answers)"); return
    d = step.draft
    print(f"\nDRAFT: {d.title} | {d.total_hours:g}h over {d.deadline_weeks} weeks | why={d.why!r}")
    for m in d.milestones:
        print(f"   milestone week {m.week}: {m.title}")
    out = await create_goal(store, d, now=NOW, chat=chat)
    print(f"\ncreate_goal -> plan {out.plan.status}: {out.plan.applied} changes applied")
    print(f"goals={len(store.goals)} milestones={len(store.milestones)} weeks={len(store.weeks)} tasks={len(store.tasks)} blocks={len(store.blocks)}")
    for m in sorted(store.milestones.values(), key=lambda m: m.target_date):
        print(f"   {m.target_date}  {m.title}")
