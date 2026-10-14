"""The nightly tick for every user. Shared by the scheduler route and `scripts/agent_tick.py`.

Each user is ticked in its own transaction, so one user's failure never blocks the rest.
"""
from __future__ import annotations

import logging

from agentv2 import tick
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from .agent_store import SqlStore
from .db import get_engine
from .models import Goal

log = logging.getLogger("nightly")


async def tick_all_users() -> dict[str, int]:
    """Tick every user with an active goal. Returns counts of users ticked and failed."""
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as s:
        users = (await s.execute(select(Goal.user_id).where(Goal.status == "active").distinct())).scalars().all()
    done = failed = 0
    for uid in users:
        async with maker() as s:
            try:
                out = await tick(SqlStore(s, uid))
                if out.status == "applied":
                    await s.commit()
                log.info("%s: %s, %d changes", uid, out.status, out.applied)
                done += 1
            except Exception:  # noqa: BLE001 - one user must not stop the others
                await s.rollback()
                log.exception("tick failed for %s", uid)
                failed += 1
    return {"ticked": done, "failed": failed}
