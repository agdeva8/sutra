"""The staleness ledger — persistence, and nothing else.

The *rules* are not here. `sutra_api/core/staleness.py` already owns
`classify_change` (blast radius → tier), `build_adjustments` (the toaster
sentences), `rollup_counts` (the refresh-button count) and `next_baseline`, all
pure. This module only moves rows in and out of the two tables.

That split is the point of the in-process boundary: the agent decides what a
change *means*, the service decides where it is *stored*. Re-deriving the tier
table here would give the product two opinions about what escalates, and the one
in the toaster is the one the user sees.

## Why generation, not timestamps

`plan_staleness.generation` is bumped **only by a confirmed plan write**.
Counting is then `changes whose generation == the goal's current generation`.

v1's own note explains why timestamps fail: a change recorded in the same clock
tick as the confirm — which is the normal case, since both happen in one request
— would compare equal and flicker in and out of the count. Generation-only makes
the count monotonic inside a window and *exactly* zero after a confirm.

An automatic re-solve must never bump the generation: it would silently reset
the user's "N changes" indicator and hide work they have not seen.
"""
from __future__ import annotations

from datetime import UTC, datetime

from ..core.staleness import (
    Change,
    Baseline,
    build_adjustments,
    classify_change,
    next_baseline,
    rollup_counts,
)
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..ids import new_id
from ..models import PlanChange, PlanStaleness

__all__ = [
    "Baseline",
    "build_adjustments",
    "classify_change",
    "current_baseline",
    "mark_planned",
    "mark_planned_all",
    "next_baseline",
    "pending_changes",
    "record_change",
    "rollup",
    "rollup_counts",
]


def _now() -> datetime:
    return datetime.now(UTC)


async def current_baseline(
    session: AsyncSession, *, user_id: str, goal_id: str
) -> Baseline:
    """The goal's last confirmed plan write, or generation 1 if never planned.

    `generation=1` for a missing row is not a placeholder — it is the value
    `record_change` stamps on its INSERT, so a goal that has never been planned
    counts its changes from 1. Getting this wrong would make the first change on
    a new goal invisible.
    """
    row = await session.get(PlanStaleness, (user_id, goal_id))
    if row is None:
        return Baseline(goal_id=goal_id, generation=1, last_planned_at="")
    return Baseline(
        goal_id=goal_id,
        generation=row.generation,
        last_planned_at=row.last_planned_at.isoformat() if row.last_planned_at else "",
    )


async def baselines_for(
    session: AsyncSession, *, user_id: str, goal_ids: list[str]
) -> dict[str, Baseline]:
    return {gid: await current_baseline(session, user_id=user_id, goal_id=gid) for gid in goal_ids}


async def record_change(
    session: AsyncSession,
    *,
    user_id: str,
    goal_id: str,
    kind: str,
    horizons_moved: list[str],
    milestone_moved: bool = False,
    summary: str = "",
    detail: dict | None = None,
) -> Change:
    """Append a change against the goal's *live* generation.

    The window row is created if absent (`ON CONFLICT DO NOTHING`) so the
    generation always exists before it is read back — otherwise two concurrent
    first-changes would race and one would stamp generation 0.
    """
    await session.execute(
        pg_insert(PlanStaleness)
        .values(
            user_id=user_id,
            goal_id=goal_id,
            generation=1,
            updated_at=_now(),
        )
        .on_conflict_do_nothing(index_elements=["user_id", "goal_id"])
    )
    generation = (
        await session.execute(
            select(PlanStaleness.generation).where(
                PlanStaleness.user_id == user_id, PlanStaleness.goal_id == goal_id
            )
        )
    ).scalar_one()

    change = Change(
        goal_id=goal_id,
        kind=kind,
        horizons_moved=list(horizons_moved),
        milestone_moved=milestone_moved,
        detail={"summary": summary, **(detail or {})},
        created_at=_now().isoformat(),
        generation=generation,
    )

    session.add(
        PlanChange(
            id=new_id("chg"),
            user_id=user_id,
            goal_id=goal_id,
            generation=generation,
            kind=kind,
            horizons_moved=list(horizons_moved),
            milestone_moved=milestone_moved,
            summary=summary,
        )
    )
    await session.flush()
    return change


async def mark_planned(
    session: AsyncSession, *, user_id: str, goal_id: str
) -> int:
    """Bump the generation. **Only a confirmed plan write calls this.**

    Returns the new generation. The upsert-and-return is one statement so two
    confirms racing cannot both write generation N+1 and lose one.
    """
    stmt = (
        pg_insert(PlanStaleness)
        .values(
            user_id=user_id,
            goal_id=goal_id,
            generation=1,
            last_planned_at=_now(),
            updated_at=_now(),
        )
        .on_conflict_do_update(
            index_elements=["user_id", "goal_id"],
            set_={
                "generation": PlanStaleness.generation + 1,
                "last_planned_at": _now(),
                "updated_at": _now(),
            },
        )
        .returning(PlanStaleness.generation)
    )
    generation = (await session.execute(stmt)).scalar_one()
    await session.flush()
    return int(generation)


async def mark_planned_all(session: AsyncSession, *, user_id: str) -> None:
    """Bump every goal the user has.

    The planner places all active goals in one solve, so one confirm retires
    every outstanding change — bumping only the named goal would leave the badge
    showing changes that were just re-planned away.
    """
    goal_ids = list(
        (
            await session.execute(
                select(PlanStaleness.goal_id).where(PlanStaleness.user_id == user_id)
            )
        ).scalars()
    )
    for goal_id in goal_ids:
        await mark_planned(session, user_id=user_id, goal_id=goal_id)


async def pending_changes(
    session: AsyncSession, *, user_id: str, goal_id: str | None = None
) -> list[Change]:
    """Every change in the user's *current* generation, oldest first.

    A row whose window record is missing counts as generation 1 — the value
    `record_change` stamps on its own INSERT — which is why the comparison uses
    `COALESCE`, not an inner join. An inner join would silently drop the first
    change on every goal that has never been planned.
    """
    window = select(PlanStaleness.goal_id, PlanStaleness.generation).where(
        PlanStaleness.user_id == user_id
    )
    window_sq = window.subquery()

    stmt = (
        select(PlanChange, window_sq.c.generation)
        .outerjoin(
            window_sq,
            window_sq.c.goal_id == PlanChange.goal_id,
        )
        .where(
            PlanChange.user_id == user_id,
            PlanChange.generation == func_coalesce(window_sq.c.generation, 1),
        )
        .order_by(PlanChange.created_at.asc(), PlanChange.id.asc())
    )
    if goal_id:
        stmt = stmt.where(PlanChange.goal_id == goal_id)

    out: list[Change] = []
    for row, _gen in (await session.execute(stmt)).all():
        out.append(
            Change(
                goal_id=row.goal_id,
                kind=row.kind,
                horizons_moved=list(row.horizons_moved or []),
                milestone_moved=bool(row.milestone_moved),
                detail={"summary": row.summary},
                created_at=row.created_at.isoformat(),
                generation=row.generation,
            )
        )
    return out


def func_coalesce(col, fallback: int):
    from sqlalchemy import func

    return func.coalesce(col, fallback)


async def rollup(
    session: AsyncSession, *, user_id: str, goal_id: str | None = None
) -> dict:
    """`{total, by_goal, label}` — the refresh button's badge and sentence.

    `by_goal` drops zero entries, matching v1: the client renders one chip per
    entry, and a goal with nothing pending should not get one.
    """
    changes = await pending_changes(session, user_id=user_id, goal_id=goal_id)
    goal_ids = {c.goal_id for c in changes}
    baselines = await baselines_for(session, user_id=user_id, goal_ids=sorted(goal_ids))
    return rollup_counts(changes, baselines)


async def adjustments(
    session: AsyncSession, *, user_id: str, goal_id: str | None = None, limit: int = 4
) -> list[str]:
    """The toaster copy, backend-driven.

    PRD D8: the frontend renders these strings and never composes a sentence
    about a change itself. `build_adjustments` is deterministic, so a re-render
    cannot reshuffle the toast under the user's eyes.
    """
    changes = await pending_changes(session, user_id=user_id, goal_id=goal_id)
    return build_adjustments(changes, limit)


async def touch(session: AsyncSession, *, user_id: str, goal_id: str) -> None:
    """Set `updated_at` without changing the generation.

    Used when a change is recorded but the plan has not been re-laid — the
    baseline moves so the UI knows it is looking at a stale plan, while the
    count stays honest.
    """
    await session.execute(
        update(PlanStaleness)
        .where(PlanStaleness.user_id == user_id, PlanStaleness.goal_id == goal_id)
        .values(updated_at=_now())
    )
