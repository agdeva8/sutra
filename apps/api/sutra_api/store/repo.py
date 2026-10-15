"""Data access — domain rows only. No HTTP, no request objects.

Every function takes an `AsyncSession` and leaves the transaction open for the
caller, because almost every write here must commit **together** with its audit
row. A helper that committed on its own would make that impossible, and an audit
row that can be missing is not an audit trail.

`user_id` is a parameter on every query, never inferred and never read from a
body. v1 called that out explicitly; it is the difference between "scoped to me"
and "scoped to whoever I name".
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Sequence

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..ids import new_id
from ..models import (
    AuditEntry,
    Blocker,
    Conversation,
    DailyLog,
    Goal,
    Memory,
    Message,
    Milestone,
    PlanItem,
    Proposal,
    Source,
    TimetableBlock,
)


def now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# Audit — written inside the caller's transaction, always
# ---------------------------------------------------------------------------


async def write_audit(
    session: AsyncSession,
    *,
    user_id: str,
    type: str,
    summary: str,
    payload: dict | None = None,
) -> AuditEntry:
    """Append one ledger row. `type` follows v1's `<verb>:<object>` convention."""
    row = AuditEntry(
        id=new_id("audit"),
        user_id=user_id,
        type=type,
        summary=summary,
        payload=payload or {},
    )
    session.add(row)
    return row


async def list_audit(
    session: AsyncSession, *, user_id: str, limit: int = 50, type_prefix: str = ""
) -> list[AuditEntry]:
    stmt = select(AuditEntry).where(AuditEntry.user_id == user_id)
    if type_prefix:
        stmt = stmt.where(AuditEntry.type.like(f"{type_prefix}%"))
    stmt = stmt.order_by(AuditEntry.created_at.desc(), AuditEntry.id.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars())


async def recent_audit(
    session: AsyncSession, *, user_id: str, limit: int = 10
) -> list[AuditEntry]:
    """Newest first — the dashboard's slice, and `replan_suggestions`' input."""
    return await list_audit(session, user_id=user_id, limit=limit)


# ---------------------------------------------------------------------------
# Goals
# ---------------------------------------------------------------------------


async def list_goals(
    session: AsyncSession, *, user_id: str, limit: int = 500, active_only: bool = False
) -> list[Goal]:
    stmt = select(Goal).where(Goal.user_id == user_id)
    if active_only:
        stmt = stmt.where(Goal.status == "active")
    stmt = stmt.order_by(Goal.created_at.asc()).limit(limit)
    return list((await session.execute(stmt)).scalars())


async def get_goal(session: AsyncSession, *, user_id: str, goal_id: str) -> Goal | None:
    """Ownership is part of the lookup, not a check afterwards.

    A missing row and a row belonging to someone else are the same answer —
    404 — so a caller cannot enumerate other users' ids by watching for 403.
    """
    stmt = select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_goal(
    session: AsyncSession,
    *,
    user_id: str,
    title: str,
    horizon: str,
    why: str = "",
    next_action: str = "",
    start_date: date | None = None,
    target_date: date | None = None,
    weekly_hours: int | None = None,
    phase_objectives: dict | None = None,
    life_area: str = "",
    status: str = "active",
) -> Goal:
    if start_date is None:
        start_date = now().date()
    row = Goal(
        id=new_id("goal"),
        user_id=user_id,
        title=title,
        horizon=horizon,
        why=why,
        next_action=next_action,
        start_date=start_date,
        target_date=target_date,
        weekly_hours=weekly_hours,
        phase_objectives=phase_objectives or {},
        life_area=life_area,
        status=status,
    )
    session.add(row)
    await session.flush()
    return row


async def update_goal(
    session: AsyncSession, *, goal: Goal, **fields: Any
) -> Goal:
    """Apply a patch. `updated_at` is set explicitly — v1 has no trigger.

    `None` values are skipped rather than written, so a partial patch cannot
    null a column the caller did not mention. Clearing a nullable field is done
    by passing the sentinel-free path: the routes that need it set it directly.
    """
    for key, value in fields.items():
        if value is None:
            continue
        setattr(goal, key, value)
    goal.updated_at = now()
    await session.flush()
    return goal


# ---------------------------------------------------------------------------
# Milestones
# ---------------------------------------------------------------------------


async def list_milestones(
    session: AsyncSession, *, user_id: str, limit: int = 1000
) -> list[Milestone]:
    stmt = (
        select(Milestone)
        .where(Milestone.user_id == user_id)
        .order_by(Milestone.target_date.asc().nulls_last())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get_milestone(
    session: AsyncSession, *, user_id: str, milestone_id: str
) -> Milestone | None:
    stmt = select(Milestone).where(
        Milestone.id == milestone_id, Milestone.user_id == user_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_milestone(
    session: AsyncSession,
    *,
    user_id: str,
    title: str,
    goal_id: str | None = None,
    goal_title: str = "",
    target_date: date | None = None,
    phase: str = "",
    status: str = "open",
    parent_id: str | None = None,
    hours: float | None = None,
) -> Milestone:
    row = Milestone(
        parent_id=parent_id,
        hours=hours,
        id=new_id("mile"),
        user_id=user_id,
        title=title,
        goal_id=goal_id,
        goal_title=goal_title,
        target_date=target_date,
        phase=phase,
        status=status,
    )
    session.add(row)
    await session.flush()
    return row


# ---------------------------------------------------------------------------
# Plan items — the schedule of record
# ---------------------------------------------------------------------------


async def list_plan_items(
    session: AsyncSession, *, user_id: str, limit: int = 2000
) -> list[PlanItem]:
    stmt = (
        select(PlanItem)
        .where(PlanItem.user_id == user_id)
        .order_by(PlanItem.start_date.asc().nulls_last())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get_plan_item(
    session: AsyncSession, *, user_id: str, item_id: str
) -> PlanItem | None:
    stmt = select(PlanItem).where(PlanItem.id == item_id, PlanItem.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def replace_plan_items_for_goal(
    session: AsyncSession, *, user_id: str, goal_id: str, rows: Sequence[dict]
) -> list[PlanItem]:
    """**Replace-on-write** — the one invariant that makes replanning safe.

    HLD §9.4: every write to a goal's `plan_items` is `DELETE WHERE goal_id = ?`
    followed by `INSERT`, inside one transaction. v1 spent three backlog slices
    chasing append-duplicates and orphan rows across four code paths; having
    exactly one writer per goal makes that bug unrepresentable rather than
    merely unlikely.

    `status` is normalised on the way in: the agent's `PlanItemRow` defaults to
    `pending`, while v1 stores and returns `open`. Storing both would split the
    vocabulary and break the "is it done" comparison in the UI.
    """
    # Scoped by `user_id` as well as `goal_id`. A goal id is unique in practice,
    # but this is the one unconditional DELETE in the codebase: if a caller ever
    # passes a goal_id it does not own, the blast radius should be zero rows, not
    # another user's schedule.
    await session.execute(
        delete(PlanItem).where(
            PlanItem.goal_id == goal_id, PlanItem.user_id == user_id
        )
    )

    created: list[PlanItem] = []
    for row in rows:
        status = row.get("status") or "open"
        if status == "pending":
            status = "open"
        item = PlanItem(
            id=new_id("pi"),
            user_id=user_id,
            goal_id=goal_id,
            horizon=row["horizon"],
            phase=row.get("phase", ""),
            title=row["title"],
            note=row.get("note", ""),
            start_date=_as_date(row.get("start_date")),
            end_date=_as_date(row.get("end_date")),
            due_date=_as_date(row.get("due_date")),
            weekly_hours=row.get("weekly_hours"),
            status=status,
        )
        session.add(item)
        created.append(item)
    await session.flush()
    return created


async def create_user_plan_item(
    session: AsyncSession,
    *,
    user_id: str,
    title: str,
    due_date: date,
    goal_id: str | None = None,
    note: str = "",
) -> PlanItem:
    """A user-owned daily task — the one plan item a user writes directly.

    `horizon` is forced to `daily` and the three dates are the same day: it is a
    task on a day, not a scheduled span. The solver never writes this row, so
    replace-on-write does not touch it.
    """
    row = PlanItem(
        id=new_id("pi"),
        user_id=user_id,
        goal_id=goal_id,
        horizon="daily",
        phase="",
        title=title,
        note=note,
        start_date=due_date,
        end_date=due_date,
        due_date=due_date,
        weekly_hours=None,
        status="open",
    )
    session.add(row)
    await session.flush()
    return row


def _as_date(v: Any) -> date | None:
    if v is None or isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Blockers
# ---------------------------------------------------------------------------


async def list_blockers(
    session: AsyncSession, *, user_id: str, limit: int = 500
) -> list[Blocker]:
    stmt = (
        select(Blocker)
        .where(Blocker.user_id == user_id)
        .order_by(Blocker.start_date.asc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get_blocker(
    session: AsyncSession, *, user_id: str, blocker_id: str
) -> Blocker | None:
    stmt = select(Blocker).where(Blocker.id == blocker_id, Blocker.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_blocker(
    session: AsyncSession,
    *,
    user_id: str,
    title: str,
    start_date: date,
    end_date: date | None,
    note: str = "",
) -> Blocker:
    row = Blocker(
        id=new_id("blk"),
        user_id=user_id,
        title=title,
        start_date=start_date,
        # An omitted end date means a single day, not an open-ended window —
        # v1's rule, and the one the solver expects.
        end_date=end_date or start_date,
        note=note,
    )
    session.add(row)
    await session.flush()
    return row


# ---------------------------------------------------------------------------
# Timetable blocks
# ---------------------------------------------------------------------------


async def list_time_blocks(
    session: AsyncSession, *, user_id: str, limit: int = 1000
) -> list[TimetableBlock]:
    stmt = (
        select(TimetableBlock)
        .where(TimetableBlock.user_id == user_id)
        .order_by(TimetableBlock.block_date.asc(), TimetableBlock.start_time.asc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get_time_block(
    session: AsyncSession, *, user_id: str, block_id: str
) -> TimetableBlock | None:
    stmt = select(TimetableBlock).where(
        TimetableBlock.id == block_id, TimetableBlock.user_id == user_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


#: A `sources` row's purpose when it is material for a goal (as opposed to a memory photo).
SOURCE_PURPOSE_SOURCE = "source"


async def list_sources(
    session: AsyncSession,
    *,
    user_id: str,
    goal_id: str | None = None,
    limit: int = 500,
) -> list[Source]:
    stmt = (
        select(Source)
        .where(Source.user_id == user_id, Source.is_deleted.is_(False), Source.purpose == SOURCE_PURPOSE_SOURCE)
        .order_by(Source.created_at.desc())
        .limit(limit)
    )
    if goal_id:
        stmt = stmt.where(Source.goal_id == goal_id)
    return list((await session.execute(stmt)).scalars())


async def get_source(
    session: AsyncSession, *, user_id: str, source_id: str
) -> Source | None:
    """Soft-deleted rows are invisible, which is why `is_deleted` is in the WHERE."""
    stmt = select(Source).where(
        Source.id == source_id,
        Source.user_id == user_id,
        Source.is_deleted.is_(False),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def sources_by_ids(
    session: AsyncSession, *, user_id: str, ids: Sequence[str]
) -> list[Source]:
    """For linking uploads to a goal. Capped at the caller's id list."""
    if not ids:
        return []
    stmt = select(Source).where(
        Source.user_id == user_id,
        Source.id.in_(list(ids)),
        Source.is_deleted.is_(False),
    )
    return list((await session.execute(stmt)).scalars())


# ---------------------------------------------------------------------------
# Memories
# ---------------------------------------------------------------------------


async def list_memories(
    session: AsyncSession, *, user_id: str, limit: int = 200
) -> list[Memory]:
    stmt = (
        select(Memory)
        .where(Memory.user_id == user_id)
        .order_by(Memory.created_at.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get_memory(
    session: AsyncSession, *, user_id: str, memory_id: str
) -> Memory | None:
    stmt = select(Memory).where(Memory.id == memory_id, Memory.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Daily log
# ---------------------------------------------------------------------------


async def get_daily_log(
    session: AsyncSession, *, user_id: str, log_date: date
) -> DailyLog | None:
    stmt = select(DailyLog).where(
        DailyLog.user_id == user_id, DailyLog.log_date == log_date
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_daily_logs(
    session: AsyncSession, *, user_id: str, since: date
) -> list[DailyLog]:
    stmt = (
        select(DailyLog)
        .where(DailyLog.user_id == user_id, DailyLog.log_date >= since)
        .order_by(DailyLog.log_date.desc())
    )
    return list((await session.execute(stmt)).scalars())


def merge_by_id(existing: list[dict] | None, patch: list[dict] | None, key: str) -> list[dict]:
    """Merge a patch over existing rows, keyed by `key`.

    v1's `mergeDailyLog`. A *merge*, not a replace: two surfaces both write the
    daily log — the tick-off UI and the note editor — and a replace would make
    whichever ran second silently erase the other's notes.
    """
    existing = existing or []
    patch = patch or []
    if not patch:
        return existing
    by_key = {row.get(key): dict(row) for row in existing}
    for row in patch:
        k = row.get(key)
        merged = by_key.get(k, {})
        merged.update({kk: vv for kk, vv in row.items() if vv is not None})
        by_key[k] = merged
    return list(by_key.values())
