"""Background work that follows a change to the calendar.

A fixed block or an away period added in the app can land on time the agent had planned for a goal.
After the response goes out, this plans those goals again around the new calendar. It runs on its
own session, never fails the request that triggered it, and does nothing when there is no conflict.
"""
from __future__ import annotations

import logging

from agentv2 import local_now, replan_conflicts
from sqlalchemy.ext.asyncio import async_sessionmaker

from .agent_store import SqlStore
from .db import get_engine
from .plan_guard import guarded, live_builds

log = logging.getLogger(__name__)


async def replan_conflicts_for(user_id: str, tz: str | None = None) -> None:
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as session:
        try:
            now = local_now(tz)
            # A goal whose schedule build is live is being rebuilt right now; planning it again here
            # would race that build. Leave it out of the context the conflict re-plan reads.
            live = await live_builds(session, user_id=user_id, now=now)
            if live:
                log.info(
                    "replan_conflicts skipped goals with a live build for %s: %s",
                    user_id, ", ".join(sorted(live)),
                )
            out = await replan_conflicts(
                guarded(SqlStore(session, user_id, today=now.date()), live), now=now
            )
            if out.status == "applied":
                await session.commit()
            else:
                await session.rollback()
        except Exception:  # noqa: BLE001 - a replan failure is a missing nicety, never a failed request
            await session.rollback()
            log.exception("replan after a calendar change failed for %s", user_id)
