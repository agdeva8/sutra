"""Phase 5: backfill calendar_blocks from old tables.

This script is idempotent: running it twice causes no harm (the first run
populates `calendar_blocks`; the second run skips rows that already exist).

It keeps ids, so every block's uid in the ICS feed stays the same and the
web UI's local state does not go stale.

Mappings (§11 of the plan):

| Old row                           | New block                                  |
|-----------------------------------|--------------------------------------------|
| `plan_items` daily, todo          | Task, placed_by=user, at=due_time         |
| `plan_items` goal task + blocks   | Task per block: first keeps task id        |
| `timetable_blocks` committed      | Event; goal colour if it has goal_id      |
| `timetable_blocks` recurring src  | Not copied (regenerated as occurrences)   |
| `recurring_blocks`                | Event with repeat; id = the rule id       |
| `blockers`                        | Away; NULL end_date → start_date          |
| `milestones`                      | Milestone; reached from status             |
| `reminders`                       | Task(s) with at; repeat when multi-day    |

Usage:
    cd apps/api
    source .env && source ../agentv2/.env
    python scripts/backfill_blocks.py        # dry run (count first)
    python scripts/backfill_blocks.py --apply # actually write
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date, time, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from tabulate import tabulate

from sutra_api.config import settings
from sutra_api.db import get_session_maker
from sutra_api.ids import new_id
from sutra_api.models import (
    Blocker,
    CalendarBlock,
    Goal,
    Milestone,
    PlanItem,
    RecurringBlock,
    Reminder,
    TimetableBlock,
)
from agentv2.contracts.blocks import (
    AwayBlock,
    EventBlock,
    MilestoneBlock,
    Repeat,
    TaskBlock,
)

# The committed sources that map to Event (vs recurring-rule).
COMMITTED_SOURCES = {"manual", "agent", "plan"}


def _task_state(pi: PlanItem) -> str:
    if pi.status == "done":
        return "done"
    if pi.done_hours and pi.done_hours > 0:
        return "partial"
    return "open"


def _task_done_fraction(pi: PlanItem) -> float | None:
    if pi.done_hours and pi.effort_hours:
        return pi.done_hours / pi.effort_hours
    return None


def _goal_effort(pi: PlanItem) -> float | None:
    # Estimate effort from plan_item fields if available
    # (pi.effort_hours is not in the model, so we leave it None unless done_hours is set)
    return pi.done_hours or None


def _build_task_from_todo(pi: PlanItem) -> TaskBlock:
    return TaskBlock(
        id=pi.id,
        title=pi.title,
        day=pi.due_date,
        at=pi.due_time,
        goal_id=pi.goal_id,
        milestone_id=pi.milestone_id,
        state=_task_state(pi),
        done_fraction=_task_done_fraction(pi),
        description=pi.note or "",
        placed_by="user",
    )


def _build_tasks_from_goal_task(
    pi: PlanItem, blocks: list[TimetableBlock]
) -> list[TaskBlock]:
    tasks = []
    total_blocks = len(blocks)

    # Estimate total effort from done_hours or weekly_hours
    total_effort: float | None = pi.done_hours or None
    if total_effort is None and pi.goal_id:
        # We don't have done_hours, but we might have weekly_hours on the goal.
        # We can't know the exact session effort without it, so we'll leave it None
        # for now if done_hours is not set.
        pass

    for i, blk in enumerate(blocks):
        # First block keeps the plan_item id; extra blocks get new ids.
        blk_id = pi.id if i == 0 else new_id("task")
        # Split effort across blocks if total > 1
        split_effort = (total_effort / total_blocks) if total_effort else None
        tasks.append(
            TaskBlock(
                id=blk_id,
                title=pi.title,
                day=blk.block_date,
                start=blk.start_time,
                end=blk.end_time,
                goal_id=pi.goal_id,
                milestone_id=pi.milestone_id,
                effort_hours=split_effort,
                description=pi.note or "",
                why=pi.why or "",
                placed_by="planner",
            )
        )
    return tasks


def _build_task_no_block(pi: PlanItem) -> TaskBlock:
    return TaskBlock(
        id=pi.id,
        title=pi.title,
        day=pi.start_date,
        goal_id=pi.goal_id,
        milestone_id=pi.milestone_id,
        description=pi.note or "",
        why=pi.why or "",
        placed_by="planner",
    )


def _build_event_from_block(
    blk: TimetableBlock, goals: dict[str, Goal]
) -> EventBlock:
    goal = goals.get(blk.goal_id)
    return EventBlock(
        id=blk.id,
        title=blk.label,
        day=blk.block_date,
        start=blk.start_time,
        end=blk.end_time,
        goal_id=blk.goal_id,
        note=blk.note or "",
    )


def _build_event_from_recurring(rb: RecurringBlock) -> EventBlock:
    return EventBlock(
        id=rb.id,
        title=rb.title,
        day=rb.start_date,
        start=rb.start_time,
        end=rb.end_time,
        repeat=Repeat(
            weekdays=list(rb.weekdays or []),
            until=rb.end_date,
        ),
    )


def _build_away_from_blocker(bl: Blocker) -> AwayBlock:
    return AwayBlock(
        id=bl.id,
        title=bl.title,
        start_date=bl.start_date,
        end_date=bl.end_date or bl.start_date,
    )


def _build_milestone(m: Milestone) -> MilestoneBlock:
    return MilestoneBlock(
        id=m.id,
        title=m.title,
        goal_id=m.goal_id or "",
        target_date=m.target_date or date.today(),
        parent_id=m.parent_id,
        hours=m.hours or 0,
        reached=m.status == "done",
    )


def _build_tasks_from_reminder(r: Reminder) -> list[TaskBlock]:
    tasks = []
    days = r.days or []
    times = r.times or []
    if not days or not times:
        return tasks

    # D8: one repeating Task per time of day
    for idx, hhmm in enumerate(times):
        try:
            t = time.fromisoformat(str(hhmm))
        except ValueError:
            continue

        # Use index to ensure unique ids
        task_id = r.id if len(times) == 1 and len(days) == 1 else f"{r.id}-{idx}"

        if len(days) == 1:
            # Single day: one task per time
            try:
                d = date.fromisoformat(str(days[0]))
            except ValueError:
                continue
            tasks.append(
                TaskBlock(
                    id=task_id,
                    title=r.title,
                    day=d,
                    at=t,
                    goal_id=r.goal_id,
                )
            )
        else:
            # Multi-day: one repeating task per time
            first_day = None
            all_weekdays = set()
            for day in days:
                try:
                    d = date.fromisoformat(str(day))
                except ValueError:
                    continue
                if first_day is None:
                    first_day = d
                all_weekdays.add(d.weekday())

            if first_day:
                tasks.append(
                    TaskBlock(
                        id=task_id,
                        title=r.title,
                        day=first_day,
                        at=t,
                        goal_id=r.goal_id,
                        repeat=Repeat(weekdays=sorted(all_weekdays)),
                    )
                )
    return tasks


async def _count_existing(session_maker) -> dict:
    async with session_maker() as session:
        result = await session.execute(
            select(CalendarBlock.id, CalendarBlock.block_kind)
        )
        rows = result.all()
        counts = {"event": 0, "task": 0, "away": 0, "milestone": 0}
        for _, kind in rows:
            if kind in counts:
                counts[kind] += 1
        return counts


async def _count_plan_items(session_maker) -> dict:
    async with session_maker() as session:
        # Todos
        result = await session.execute(
            select(PlanItem).where(
                PlanItem.horizon == "daily",
                PlanItem.item_type == "todo",
            )
        )
        todos = len(result.scalars().all())

        # Goal tasks
        result = await session.execute(
            select(PlanItem).where(
                PlanItem.horizon == "daily",
                PlanItem.item_type.is_(None),
            )
        )
        goal_tasks = len(result.scalars().all())

        # Timetable committed
        result = await session.execute(
            select(TimetableBlock).where(
                TimetableBlock.source.in_(COMMITTED_SOURCES)
            )
        )
        committed_blocks = len(result.scalars().all())

        # Recurring blocks
        result = await session.execute(select(RecurringBlock))
        recurring = len(result.scalars().all())

        # Blockers
        result = await session.execute(select(Blocker))
        blockers = len(result.scalars().all())

        # Milestones
        result = await session.execute(select(Milestone))
        milestones = len(result.scalars().all())

        # Reminders
        result = await session.execute(select(Reminder))
        reminders = len(result.scalars().all())

        return {
            "todos": todos,
            "goal_tasks": goal_tasks,
            "committed_blocks": committed_blocks,
            "recurring": recurring,
            "blockers": blockers,
            "milestones": milestones,
            "reminders": reminders,
        }


async def _run_backfill(session_maker, dry_run: bool = True):
    existing = await _count_existing(session_maker)
    counts = await _count_plan_items(session_maker)

    print("Existing calendar_blocks:", existing)
    print("Source rows to backfill:")
    print(
        tabulate(
            [
                ["Todos", counts["todos"]],
                ["Goal tasks", counts["goal_tasks"]],
                ["Committed timetable blocks", counts["committed_blocks"]],
                ["Recurring blocks", counts["recurring"]],
                ["Blockers", counts["blockers"]],
                ["Milestones", counts["milestones"]],
                ["Reminders", counts["reminders"]],
            ],
            headers=["Kind", "Count"],
        )
    )

    if dry_run:
        print("\n(Dry run — no changes written. Pass --apply to write.)")
        return

    async with session_maker() as session:
        # Load goals for colour lookup
        goals = {g.id: g for g in (await session.execute(select(Goal))).scalars().all()}

        # Load existing ids to avoid duplicates
        existing_ids = set(
            r[0]
            for r in (await session.execute(select(CalendarBlock.id))).scalars().all()
        )

        new_blocks: list[CalendarBlock] = []
        skipped = 0

        # --- Todos ---
        result = await session.execute(
            select(PlanItem).where(
                PlanItem.horizon == "daily",
                PlanItem.item_type == "todo",
            )
        )
        for pi in result.scalars().all():
            if pi.id in existing_ids:
                skipped += 1
                continue
            blk = _build_task_from_todo(pi)
            row = CalendarBlock(
                id=blk.id,
                user_id=pi.user_id,
                block_kind="task",
                title=blk.title,
                data=blk.model_dump(mode="json"),
            )
            new_blocks.append(row)

        # --- Goal tasks + their tentative blocks ---
        # Fetch all goal tasks
        result = await session.execute(
            select(PlanItem).where(
                PlanItem.horizon == "daily",
                PlanItem.item_type.is_(None),
            )
        )
        goal_tasks = {pi.id: pi for pi in result.scalars().all()}
        goal_task_ids = list(goal_tasks.keys())

        # Fetch all tentative blocks for these tasks in one query
        tentative_blocks_map: dict[str, list[TimetableBlock]] = {}
        if goal_task_ids:
            blocks_result = await session.execute(
                select(TimetableBlock).where(
                    TimetableBlock.source_id.in_(goal_task_ids),
                    TimetableBlock.kind == "tentative",
                )
            )
            for blk in blocks_result.scalars().all():
                if blk.source_id:
                    tentative_blocks_map.setdefault(blk.source_id, []).append(blk)

        for pi in goal_tasks.values():
            blocks = tentative_blocks_map.get(pi.id, [])
            # Sort blocks by start time for consistent effort splitting
            blocks.sort(key=lambda b: (b.block_date, b.start_time))
            if blocks:
                tasks = _build_tasks_from_goal_task(pi, blocks)
            else:
                tasks = [_build_task_no_block(pi)]

            for task in tasks:
                if task.id in existing_ids:
                    skipped += 1
                    continue
                row = CalendarBlock(
                    id=task.id,
                    user_id=pi.user_id,
                    block_kind="task",
                    title=task.title,
                    data=task.model_dump(mode="json"),
                )
                new_blocks.append(row)

        # --- Committed timetable blocks ---
        result = await session.execute(
            select(TimetableBlock).where(
                TimetableBlock.source.in_(COMMITTED_SOURCES)
            )
        )
        for blk in result.scalars().all():
            if blk.id in existing_ids:
                skipped += 1
                continue
            evt = _build_event_from_block(blk, goals)
            row = CalendarBlock(
                id=evt.id,
                user_id=blk.user_id,
                block_kind="event",
                title=evt.title,
                data=evt.model_dump(mode="json"),
            )
            new_blocks.append(row)

        # --- Recurring blocks ---
        result = await session.execute(select(RecurringBlock))
        for rb in result.scalars().all():
            if rb.id in existing_ids:
                skipped += 1
                continue
            evt = _build_event_from_recurring(rb)
            row = CalendarBlock(
                id=evt.id,
                user_id=rb.user_id,
                block_kind="event",
                title=evt.title,
                data=evt.model_dump(mode="json"),
            )
            new_blocks.append(row)

        # --- Blockers ---
        result = await session.execute(select(Blocker))
        for bl in result.scalars().all():
            if bl.id in existing_ids:
                skipped += 1
                continue
            away = _build_away_from_blocker(bl)
            row = CalendarBlock(
                id=away.id,
                user_id=bl.user_id,
                block_kind="away",
                title=away.title,
                data=away.model_dump(mode="json"),
            )
            new_blocks.append(row)

        # --- Milestones ---
        result = await session.execute(select(Milestone))
        for m in result.scalars().all():
            if m.id in existing_ids:
                skipped += 1
                continue
            ms = _build_milestone(m)
            row = CalendarBlock(
                id=ms.id,
                user_id=m.user_id,
                block_kind="milestone",
                title=ms.title,
                data=ms.model_dump(mode="json"),
            )
            new_blocks.append(row)

        # --- Reminders ---
        result = await session.execute(select(Reminder))
        for r in result.scalars().all():
            tasks = _build_tasks_from_reminder(r)
            for task in tasks:
                if task.id in existing_ids:
                    skipped += 1
                    continue
                row = CalendarBlock(
                    id=task.id,
                    user_id=r.user_id,
                    block_kind="task",
                    title=task.title,
                    data=task.model_dump(mode="json"),
                )
                new_blocks.append(row)

        session.add_all(new_blocks)
        await session.commit()

        print(f"\nWrote {len(new_blocks)} new blocks. Skipped {skipped} existing.")


def main():
    parser = argparse.ArgumentParser(description="Backfill calendar_blocks")
    parser.add_argument("--apply", action="store_true", help="Write changes (default is dry run)")
    args = parser.parse_args()

    engine = create_async_engine(settings.database_url, echo=False)
    session_maker = get_session_maker(engine)

    asyncio.run(_run_backfill(session_maker, dry_run=not args.apply))


if __name__ == "__main__":
    main()
