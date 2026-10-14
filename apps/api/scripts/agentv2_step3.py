"""Step 3: triage -> gateway -> real Postgres.

The step-2 entries, but every write lands in the local database from
`infra/docker-compose.yml` (port 5433). Run from apps/api:

    PYTHONPATH=.. DATABASE_URL=postgresql+asyncpg://sutra:sutra@localhost:5433/sutra \
        .venv/bin/python scripts/agentv2_step3.py

It refuses to run against anything but localhost: the deployed database is shared.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime

from agentv2.config import load_settings
from agentv2.contracts import Origin
from agentv2.gateway import apply
from agentv2.model import build_model
from agentv2.triage import classify, route
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from sutra_api.ids import new_id
from sutra_api.agent_store import SqlStore
from sutra_api.models import Goal, User

LOCAL_HOSTS = ("localhost", "127.0.0.1")
DEMO_USER = "user_agentv2_demo"
NOW = datetime(2026, 10, 14, 10, 0)
ENTRIES = [
    "boss gave me the Q4 deck, needs to be out before offsite, probably 3 hours",
    "dentist thursday 4pm",
    "Rx: Amoxicillin 500mg, 1 tab TDS x 5 days after food",
    "i have to learn driving now in 3 months",
]


async def main() -> None:
    url = os.environ["DATABASE_URL"]
    if not any(f"@{h}" in url for h in LOCAL_HOSTS):
        sys.exit("refusing to run: DATABASE_URL is not localhost")
    engine = create_async_engine(url)
    chat = build_model(load_settings())

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        if not await session.get(User, DEMO_USER):
            session.add(User(id=DEMO_USER, name="agentv2 demo"))
        if not (await session.execute(select(Goal).where(Goal.user_id == DEMO_USER))).first():
            session.add(Goal(id="goal_demo_career", user_id=DEMO_USER, title="Career: ship Q4 work", horizon="medium"))
        await session.commit()

        store = SqlStore(session, DEMO_USER, today=NOW.date())
        for text_in in ENTRIES:
            print(f"\n> {text_in}")
            ctx = await store.context()
            r = classify(chat, text_in, ctx, NOW)
            if r is None:
                print("  triage: unusable reply")
                continue
            routed = route(chat, r, ctx, NOW, Origin(source="scratch", ref=new_id("entry")))
            print(f"  triage: {r.bucket} (confidence {r.confidence})")
            if routed.waiting or routed.changeset is None:
                print(f"  not applied: {routed.waiting or routed.notes}")
                continue
            res = await apply(routed.changeset, store)
            print(f"  gateway: {type(res).__name__} {routed.notes}")
            await session.commit()

    async with engine.connect() as c:
        print("\n--- rows now in Postgres for the demo user ---")
        for label, sql in {
            "goals": "select id, title from goals where user_id=:u",
            "plan_items": "select id, title, note, start_date from plan_items where user_id=:u",
            "timetable_blocks": "select block_date, start_time, end_time, label, kind from timetable_blocks where user_id=:u order by block_date, start_time",
            "reminders": "select title, days, times from reminders where user_id=:u",
            "audit_log": "select type, summary from audit_log where user_id=:u order by created_at",
        }.items():
            print(f"\n{label}")
            for row in (await c.execute(text(sql), {"u": DEMO_USER})).all():
                print("  ", tuple(row))
    await engine.dispose()


asyncio.run(main())
