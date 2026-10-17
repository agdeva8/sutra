"""Dropping a goal — resolve it, price it, then do it in one transaction.

Ported verbatim from v1's `api/lib/goal-drop.ts`, including the sentences: they
are shown to the user (the confirm card's impact preview and the result toast),
and a re-worded one is a silent product change.

**Why the cascade exists at all.** Before it, dropping a goal only flipped
`goals.status`. The goal's commitments stayed open, its milestones and scheduled
blocks stayed on the board, and the capacity it freed was never mentioned — so
the app looked like it had ignored the user. The cascade is what makes a drop
*mean* something.

`resolve_goal_ref` is shared by three callers — the executor, the DELETE route,
and the planner route — which is why it lives here rather than in any of them.
The model never sees goal ids; it sees titles, so a title lookup has to be as
good as an id lookup.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Blocker, CalendarBlock, Goal, Milestone, TimetableBlock, User
from agentv2.contracts.blocks import BLOCK_ADAPTER
from . import repo
from .repo import write_audit

#: Cap on the item lists returned for display / prompt injection.
MAX_LIST = 10

#: A partial title match needs at least this many characters, so a goal called
#: "Runn" can never land on "Running".
MIN_PARTIAL_LEN = 6


def _round1(n: float) -> float:
    return round(n * 10) / 10


def _hhmm(t) -> str:
    return t.strftime("%H:%M") if hasattr(t, "strftime") else str(t or "")


@dataclass
class GoalRef:
    goal_id: str
    goal_title: str


@dataclass
class GoalDropImpact:
    goal_id: str
    goal_title: str
    milestones: list[dict] = field(default_factory=list)
    timetable_blocks: list[dict] = field(default_factory=list)
    counts: dict = field(default_factory=lambda: {"milestones": 0, "timetable_blocks": 0})
    #: `goals.weekly_hours` — None when never estimated.
    freed_weekly_hours: float | None = None
    #: Σ of *active* goals' known `weekly_hours`.
    load_before: float = 0.0
    #: `load_before - freed`, floored at zero.
    load_after: float = 0.0
    #: `users.available_weekly_hours`; None = no budget set.
    budget_hours: float | None = None
    other_active_goals: int = 0

    def as_wire(self) -> dict:
        """The shape the confirm card and the planner prompt both carry."""
        return {
            "goal_id": self.goal_id,
            "goal_title": self.goal_title,
            "milestones": self.milestones,
            "timetable_blocks": self.timetable_blocks,
            "counts": self.counts,
            "freed_weekly_hours": self.freed_weekly_hours,
            "load_before": self.load_before,
            "load_after": self.load_after,
            "budget_hours": self.budget_hours,
            "other_active_goals": self.other_active_goals,
        }


async def resolve_goal_ref(
    session: AsyncSession, *, user_id: str, goal_id: str = "", goal_title: str = ""
) -> GoalRef | None:
    """Find the goal a tool meant.

    An id that resolves wins; an id that does **not** falls through to the title
    rather than failing, because a stale id from a model that was shown a
    different list is a common case and the title still identifies the goal.
    """
    id_raw = (goal_id or "").strip()
    if id_raw:
        row = (
            await session.execute(
                select(Goal).where(Goal.user_id == user_id, Goal.id == id_raw).limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            return GoalRef(goal_id=row.id, goal_title=row.title)

    title_raw = (goal_title or "").strip()
    if not title_raw:
        return None

    rows = list(
        (
            await session.execute(
                select(Goal).where(Goal.user_id == user_id).limit(500)
            )
        ).scalars()
    )
    needle = title_raw.lower()
    for row in rows:
        if row.title.strip().lower() == needle:
            return GoalRef(goal_id=row.id, goal_title=row.title)
    if len(needle) >= MIN_PARTIAL_LEN:
        for row in rows:
            if needle in row.title.strip().lower():
                return GoalRef(goal_id=row.id, goal_title=row.title)
    return None


async def compute_goal_drop_impact(
    session: AsyncSession, *, user_id: str, ref: GoalRef
) -> GoalDropImpact:
    """Read-only. Enumerates exactly what the cascade will do, plus the freed hours.

    Safe to call repeatedly — it writes nothing — which is why the confirm card
    can price a drop before the user commits to it.
    """
    goal = (
        await session.execute(
            select(Goal).where(Goal.user_id == user_id, Goal.id == ref.goal_id).limit(1)
        )
    ).scalar_one_or_none()

    miles = [m for m in await repo.list_milestones(session, user_id=user_id) if m.goal_id == ref.goal_id]
    # Phase 5: Read timetable blocks from CalendarBlock
    cal_result = await session.execute(
        select(CalendarBlock).where(
            CalendarBlock.user_id == user_id,
            CalendarBlock.block_kind == "event",
        )
    )
    blocks = []
    for row in cal_result.scalars().all():
        try:
            blk = BLOCK_ADAPTER.validate_python(row.data)
            if blk.goal_id == ref.goal_id:
                blocks.append({
                    "id": row.id,
                    "label": blk.title,
                    "block_date": blk.day.isoformat() if blk.day else None,
                    "start_time": _hhmm(blk.start),
                    "end_time": _hhmm(blk.end),
                })
        except Exception:
            continue
    # The planner's placed sessions go with the goal too (see `apply_goal_drop_cascade`), so the
    # same predicate selects them here: a preview that stayed quiet about blocks the delete
    # removes is the confirm card lying. A Task may be undated or unplaced, so `day`, `start`
    # and `end` can each be None.
    task_result = await session.execute(
        select(CalendarBlock).where(
            CalendarBlock.user_id == user_id,
            CalendarBlock.block_kind == "task",
        )
    )
    for row in task_result.scalars().all():
        data = row.data or {}
        if data.get("goal_id") != ref.goal_id or data.get("placed_by") != "planner":
            continue
        try:
            blk = BLOCK_ADAPTER.validate_python(data)
        except Exception:
            continue
        blocks.append({
            "id": row.id,
            "label": blk.title,
            "block_date": blk.day.isoformat() if blk.day else None,
            "start_time": _hhmm(blk.start),
            "end_time": _hhmm(blk.end),
        })
    all_goals = list(
        (
            await session.execute(
                select(Goal).where(Goal.user_id == user_id).limit(500)
            )
        ).scalars()
    )
    user_row = await session.get(User, user_id)

    goal_hours = (
        float(goal.weekly_hours)
        if goal is not None and isinstance(goal.weekly_hours, (int, float))
        else None
    )

    # Mirrors the headroom check: only ACTIVE goals count, and a null estimate is
    # excluded from the sum rather than treated as zero.
    active = [g for g in all_goals if g.status == "active"]
    load_before = _round1(
        float(sum(g.weekly_hours for g in active if isinstance(g.weekly_hours, (int, float))))
    )
    freed = goal_hours
    load_after = _round1(max(0.0, load_before - (freed or 0.0)))

    return GoalDropImpact(
        goal_id=ref.goal_id,
        goal_title=goal.title if goal is not None else ref.goal_title,
        milestones=[
            {
                "id": m.id,
                "title": m.title,
                "target_date": m.target_date.isoformat() if m.target_date else None,
            }
            for m in miles[:MAX_LIST]
        ],
        # Both loops above already build the wire shape, so the list is passed through — the
        # previous version re-mapped it as ORM rows and crashed on every goal that had a block.
        timetable_blocks=blocks[:MAX_LIST],
        counts={"milestones": len(miles), "timetable_blocks": len(blocks)},
        freed_weekly_hours=freed,
        load_before=load_before,
        load_after=load_after,
        budget_hours=(
            user_row.available_weekly_hours if user_row is not None else None
        ),
        other_active_goals=len([g for g in active if g.id != ref.goal_id]),
    )


def drop_impact_sentence(impact: GoalDropImpact) -> str:
    """The one-liner the coach surfaces before the user commits.

    Deterministic, so the same drop always reads the same — which matters
    because this string appears both in the proposal prose and in the toaster.
    """
    parts: list[str] = []
    if impact.counts["milestones"] > 0:
        n = impact.counts["milestones"]
        parts.append(f"{n} milestone{'' if n == 1 else 's'}")
    if impact.counts["timetable_blocks"] > 0:
        n = impact.counts["timetable_blocks"]
        parts.append(f"{n} scheduled block{'' if n == 1 else 's'}")

    cleanup = (
        "nothing else is attached"
        if not parts
        else f"this closes {', '.join(parts)}"
    )
    freed = (
        f" and frees {impact.freed_weekly_hours:g}h/week"
        if impact.freed_weekly_hours and impact.freed_weekly_hours > 0
        else ""
    )
    return (
        f'Dropping "{impact.goal_title}" will clean up its plan ({cleanup}){freed}.'
    )


def _result_line(goal_title: str, impact: GoalDropImpact, reason: str | None) -> str:
    cleaned: list[str] = []
    if impact.counts["milestones"] > 0:
        n = impact.counts["milestones"]
        cleaned.append(f"{n} milestone{'' if n == 1 else 's'}")
    if impact.counts["timetable_blocks"] > 0:
        n = impact.counts["timetable_blocks"]
        cleaned.append(f"{n} scheduled block{'' if n == 1 else 's'}")

    cleaned_txt = f"; cleaned up {', '.join(cleaned)}" if cleaned else ""
    freed_txt = (
        f"; freed {impact.freed_weekly_hours:g}h/week"
        if impact.freed_weekly_hours and impact.freed_weekly_hours > 0
        else ""
    )
    reason_txt = f" ({reason})" if reason else ""
    return f"Dropped goal '{goal_title}'{reason_txt}{cleaned_txt}{freed_txt}"


async def apply_goal_drop_cascade(
    session: AsyncSession,
    *,
    user_id: str,
    ref: GoalRef,
    audit_type: str,
    reason: str | None = None,
) -> tuple[GoalDropImpact, str]:
    """Drop the goal and clean up its scaffolding, in the caller's transaction.

    `audit_type` is `confirm:drop_goal` on the proposal path and `drop:goal` on
    the direct DELETE path — the two are distinguishable in the ledger, which is
    what lets `replan_suggestions` tell a confirmed drop from a direct one.

    The impact is captured **before** the deletes, so both the result line and
    the audit payload describe the rows that are about to go rather than the
    emptiness that follows.
    """
    impact = await compute_goal_drop_impact(session, user_id=user_id, ref=ref)

    goal = (
        await session.execute(
            select(Goal).where(Goal.user_id == user_id, Goal.id == ref.goal_id).limit(1)
        )
    ).scalar_one_or_none()
    if goal is not None:
        goal.status = "dropped"
        goal.updated_at = datetime.now(UTC)

    await session.execute(
        delete(Milestone).where(
            Milestone.user_id == user_id, Milestone.goal_id == ref.goal_id
        )
    )
    # The old tables are no longer written, but rows from before the switch are still there.
    # A `timetable_blocks.source_id` points at a blocker by convention, so those blockers go too.
    old_rows = list((await session.execute(
        select(TimetableBlock.id, TimetableBlock.source_id).where(
            TimetableBlock.user_id == user_id, TimetableBlock.goal_id == ref.goal_id)
    )).all())
    if old_rows:
        await session.execute(delete(TimetableBlock).where(TimetableBlock.id.in_([r.id for r in old_rows])))
    blocker_ids = {r.source_id for r in old_rows if r.source_id}
    if blocker_ids:
        await session.execute(delete(Blocker).where(
            Blocker.user_id == user_id, Blocker.id.in_(blocker_ids)))
    # Phase 5: Delete goal's timetable blocks from CalendarBlock
    from sqlalchemy import text
    await session.execute(
        delete(CalendarBlock).where(
            CalendarBlock.user_id == user_id,
            CalendarBlock.block_kind == "event",
            text(f"data->>'goal_id' = :gid"),
        ),
        {"gid": ref.goal_id}
    )
    # A milestone's `calendar_blocks` copy is counted in the impact, so it goes with the goal too.
    await session.execute(
        delete(CalendarBlock).where(
            CalendarBlock.user_id == user_id,
            CalendarBlock.block_kind == "milestone",
            text(f"data->>'goal_id' = :gid"),
        ),
        {"gid": ref.goal_id}
    )
    # Phase 3: Also delete planner task blocks from calendar_blocks
    cal_blocks = list((await session.execute(
        select(CalendarBlock).where(CalendarBlock.user_id == user_id, CalendarBlock.block_kind == "task")
    )).scalars())
    for row in cal_blocks:
        try:
            import json
            data = row.data or {}
            if data.get("goal_id") == ref.goal_id and data.get("placed_by") == "planner":
                await session.execute(delete(CalendarBlock).where(CalendarBlock.id == row.id))
        except Exception:
            pass

    line = _result_line(ref.goal_title, impact, reason)
    await write_audit(
        session,
        user_id=user_id,
        type=audit_type,
        summary=line,
        payload={
            "goal_id": ref.goal_id,
            "goal_title": ref.goal_title,
            "reason": reason,
            "cleaned": impact.counts,
            "freed_weekly_hours": impact.freed_weekly_hours,
            "load_before": impact.load_before,
            "load_after": impact.load_after,
        },
    )
    await session.flush()
    return impact, line
