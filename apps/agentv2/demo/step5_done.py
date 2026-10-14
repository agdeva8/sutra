"""Marking things done from a Scratch note: no keyword rules, the model reads the open list."""
from __future__ import annotations

from datetime import datetime

from ..agent import triage_entry
from ..config import load_settings
from ..contracts import AddTask
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g1"}), goal_titles={"g1": "Career"}))
    for tid, title in [("t_deck", "Finish Q4 deck"), ("t_nda", "Ask legal about the NDA"), ("t_venue", "Shortlist 3 offsite venues")]:
        store.tasks[tid] = AddTask(id=tid, goal_id="g1", title=title, effort_hours=1)
    for text in ["done with the Q4 deck", "sent the NDA question to legal, finished", "finished that thing", "done"]:
        out = await triage_entry(store, text, now=NOW, chat=chat)
        print(f"\n> {text}\n  {out.status}: {out.lines or out.question}")
    print("\nmarked done:", sorted(store.done))
