"""Coach-chat turns with the real model: captures are filed, changes become proposals, questions pass through."""
from __future__ import annotations

from datetime import datetime

from ..agent import chat_turn
from ..config import load_settings
from ..core.context import Context
from ..contracts import AddTask
from ..gateway.memory import InMemoryStore
from ..model import build_model

NOW = datetime(2026, 10, 14, 10, 0)
MESSAGES = [
    "push my driving goal deadline to the end of December",
    "I'm travelling from 20 Oct to 25 Oct, nothing should be planned then",
    "pause the google prep for now",
    "boss gave me the Q4 deck, about 3 hours",
    "done with shortlisting venues",
    "what should I focus on this week?",
    "change my goal",
]


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(goal_ids=frozenset({"g1", "g2"}), goal_titles={"g1": "Learn driving", "g2": "Google interview prep"}))
    store.tasks["t1"] = AddTask(id="t1", goal_id="g2", title="Shortlist 3 offsite venues", effort_hours=1)
    for m in MESSAGES:
        t = await chat_turn(store, m, now=NOW, chat=chat)
        print(f"\n> {m}\n  {t.kind}: {t.prose}")
        for q in t.questions:
            print("  ?", q)
        for p in t.proposals:
            print("  proposal:", p)
        for a in t.applied:
            print("  applied:", a)
