"""Step 2: triage with the real model, then the real gateway. Prints every stage."""
from __future__ import annotations

from datetime import datetime, time, date

from ..config import load_settings
from ..core.context import BlockRow, Context
from ..contracts import Origin
from ..gateway import apply
from ..gateway.memory import InMemoryStore
from ..model import build_model
from ..triage import classify, route

#: A fixed "now" so the output is reproducible: Wednesday morning.
NOW = datetime(2026, 10, 14, 10, 0)

ENTRIES = [
    "boss gave me the Q4 deck, needs to be out before offsite, probably 3 hours",
    "dentist thursday 4pm",
    "Rx: Amoxicillin 500mg, 1 tab TDS x 5 days after food",
    "i have to learn driving now in 3 months",
    "interview prep: think about system design more",
]


async def run() -> None:
    chat = build_model(load_settings())
    store = InMemoryStore(Context(
        goal_ids=frozenset({"g_career", "g_google"}),
        goal_titles={"g_career": "Career: ship Q4 work", "g_google": "Google interview prep"},
        blocks=(BlockRow("b_standup", date(2026, 10, 14), time(11), time(12), "committed"),),
    ))
    for text in ENTRIES:
        print(f"\n> {text}")
        r = classify(chat, text, await store.context(), NOW)
        if r is None:
            print("  triage: unusable reply -> entry waits as 'couldn't read this'")
            continue
        print(f"  triage: bucket={r.bucket_label} items={len(r.items)} confidence={r.confidence} question={r.question!r}")
        routed = route(chat, r, await store.context(), NOW, Origin(source="scratch", ref=text[:24]))
        if routed.waiting:
            print(f"  WAITING: {routed.waiting}")
            continue
        if routed.changeset is None:
            print(f"  {routed.notes}")
            continue
        res = await apply(routed.changeset, store)
        print(f"  gateway: {type(res).__name__}  {routed.notes}")
        for c in routed.changeset.changes:
            print("    +", c.model_dump(mode="json", exclude_none=True))
