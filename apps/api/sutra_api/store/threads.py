"""Which LangGraph thread holds a goal's plan.

Written on every **confirmed** plan write and read by the replan door. The two
are deliberately coupled: a thread id is only worth recording if the plan on it
was actually committed, because a replan re-solves that checkpointed state and
would otherwise re-solve a plan the user never accepted.

The upsert shape mirrors `staleness.mark_planned` — one statement, so two
confirms racing cannot both write and lose one.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import PlanThread


def _now() -> datetime:
    return datetime.now(UTC)


async def record_thread(
    session: AsyncSession, *, user_id: str, goal_id: str, thread_id: str
) -> None:
    """Point a goal at the thread its current plan lives on.

    Called from `/plan/confirm` only — the same rule `mark_planned` follows, and
    for the same reason: an automatic re-solve must not move the goal's thread
    out from under a confirm that is still pending.
    """
    stmt = (
        pg_insert(PlanThread)
        .values(
            user_id=user_id,
            goal_id=goal_id,
            thread_id=thread_id,
            updated_at=_now(),
        )
        .on_conflict_do_update(
            index_elements=["user_id", "goal_id"],
            set_={"thread_id": thread_id, "updated_at": _now()},
        )
    )
    await session.execute(stmt)
    await session.flush()


async def thread_for(
    session: AsyncSession, *, user_id: str, goal_id: str
) -> str | None:
    """The goal's thread, or `None` if no plan has been confirmed for it.

    `None` is a real answer, not an error: a goal that was planned before this
    ledger existed, or one whose confirm never landed, has no thread to re-solve.
    The caller turns that into an ordinary re-plan rather than a crash.
    """
    stmt = select(PlanThread.thread_id).where(
        PlanThread.user_id == user_id, PlanThread.goal_id == goal_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()
