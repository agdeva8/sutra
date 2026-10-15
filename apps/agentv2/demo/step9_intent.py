"""Scratch intent: a to-do, a reminder and a block should each file in one shot, never interrogate."""
from __future__ import annotations

from datetime import datetime

from ..agent import triage_entry
from ..config import load_settings
from ..core.context import Context
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
NOTES = ["I am unavailable from 3 nov to 5 nov", "remind me to call mom tomorrow at 6pm", "dentist thursday 4pm", "buy milk"]


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g1"}), goal_titles={"g1": "Crack Google interview"}))
    for text in NOTES:
        out = await triage_entry(store, text, now=NOW, chat=chat)
        print(f"\n> {text}\n  {out.status} [{out.bucket}]: {out.lines or out.question}")
        for bl in store.blockers.values():
            print("    blocker:", bl.title, bl.start_date, "->", bl.end_date)
        store.blockers.clear()
        for r in store.reminders.values():
            print("    stored:", r.title, [d.isoformat() for d in r.days], [t.strftime("%H:%M") for t in r.times])
        store.reminders.clear()
