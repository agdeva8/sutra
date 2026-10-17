"""The nightly tick for every user. Shared by the scheduler route and `scripts/agent_tick.py`.

Two entry points, on purpose:

* `enqueue_tick_jobs` is what `/cron/tick` calls now. It writes one `tick_user` job per
  user with an active goal and returns immediately; `/cron/jobs` runs them. A tick can
  take minutes per user, which is too long for the cron request that schedules it.
* `tick_all_users` still ticks inline, one user per transaction. `scripts/agent_tick.py`
  and a deployment that has not set up the queue drain use it.
"""
from __future__ import annotations

import logging

from agentv2 import tick
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from .agent_store import SqlStore
from .db import get_engine
from .jobs import enqueue
from .models import JOB_TICK_USER, Goal

log = logging.getLogger("nightly")


async def _active_user_ids() -> list[str]:
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as s:
        return list(
            (await s.execute(select(Goal.user_id).where(Goal.status == "active").distinct())).scalars()
        )


async def enqueue_tick_jobs() -> dict[str, int]:
    """Queue one nightly tick per user with an active goal. Dedupe keeps a double run to one job."""
    users = await _active_user_ids()
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    queued = 0
    async with maker() as s:
        try:
            for uid in users:
                await enqueue(s, user_id=uid, kind=JOB_TICK_USER)
                queued += 1
            await s.commit()
        except Exception:  # noqa: BLE001 - a failed enqueue must not lose the others
            await s.rollback()
            log.exception("could not enqueue the nightly tick")
            raise
    log.info("queued %d nightly tick job(s)", queued)
    return {"queued": queued}


async def tick_all_users() -> dict[str, int]:
    """Tick every user with an active goal. Returns counts of users ticked and failed."""
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    users = await _active_user_ids()
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
