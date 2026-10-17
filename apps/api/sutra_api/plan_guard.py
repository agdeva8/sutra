"""Keep a background re-plan off a goal whose schedule build is already running.

`POST /plan/change` takes a lease (`api.plan.build_in_flight`) before it rebuilds a goal's schedule.
Two other paths re-plan goals without asking: the conflict re-plan after a calendar change
(`agent_background.replan_conflicts_for`) and the nightly tick (`/agent/tick`). Neither can skip a goal
inside `agentv2` — it owns the loops — so both hand it a store whose `context()` leaves the goals with
a live build out. The planner then sees the board as it will be when that build finishes: no
tentative rows to displace, no week to expand, no hours to re-plan.

The decisions are pure functions here so the skip is unit-testable without a database.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime

from agentv2.config import BLOCK_TENTATIVE
from agentv2.core.context import Context
from agentv2.gateway.store import Store
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .api.plan import build_in_flight
from .models import Goal


def live_build_goal_ids(rows, now: datetime) -> frozenset[str]:
    """The goals whose schedule build still holds its lease, from `(id, plan_status, plan_started_at)` rows."""
    return frozenset(
        goal_id
        for goal_id, status, started_at in rows
        if goal_id and build_in_flight(status, started_at, now)
    )


async def live_builds(
    session: AsyncSession, *, user_id: str, now: datetime
) -> frozenset[str]:
    """Read the caller's goals and return the ones a live build owns."""
    rows = (
        await session.execute(
            select(Goal.id, Goal.plan_status, Goal.plan_started_at).where(
                Goal.user_id == user_id
            )
        )
    ).all()
    return live_build_goal_ids(rows, now)


def without_live_builds(ctx: Context, live: frozenset[str]) -> Context:
    """The context with `live` goals left out of everything a background re-plan walks.

    Committed rows stay: they are the user's own time, and another goal's re-plan must still see them
    as busy. Only the tentative rows (the agent's own planned time), plan weeks and goal hours go,
    because those are what `replan_conflicts` and `tick` would otherwise start rebuilding.
    """
    if not live:
        return ctx
    return replace(
        ctx,
        blocks=tuple(
            b
            for b in ctx.blocks
            if not (b.goal_id in live and b.status == BLOCK_TENTATIVE)
        ),
        plan_weeks=tuple(w for w in ctx.plan_weeks if w.goal_id not in live),
        plan_months=tuple(m for m in ctx.plan_months if m.goal_id not in live),
        expanded_weeks=frozenset((g, d) for g, d in ctx.expanded_weeks if g not in live),
        goal_hours={g: h for g, h in ctx.goal_hours.items() if g not in live},
    )


class _GuardedStore:
    """A `Store` proxy whose context leaves out the goals being built. Everything else delegates."""

    def __init__(self, store: Store, live: frozenset[str]) -> None:
        self._store = store
        self._live = live

    async def context(self) -> Context:
        return without_live_builds(await self._store.context(), self._live)

    def __getattr__(self, name):
        return getattr(self._store, name)


def guarded(store: Store, live: frozenset[str]) -> Store:
    """`store`, with a context that skips the goals a live build owns."""
    return _GuardedStore(store, live) if live else store
