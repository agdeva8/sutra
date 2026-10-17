"""The SQL implementation of agentv2's `Store` interface.

agentv2 never imports a database driver; this module is where its changes become
rows. `apps/api` imports `agentv2`, never the reverse.

Mapping (each is a deliberate fit onto the v1 schema, not a new table, except
reminders):

  AddGoal      -> goals
  AddMilestone -> milestones
  AddPlanMonth -> plan_items, horizon "monthly" (hours in `note`, like a task)
  AddPlanWeek  -> plan_items, horizon "weekly" (hours rounded to the column's integer)
  AddTask      -> plan_items, undated (horizon "daily", effort kept in `note`)
  AddBlock     -> timetable_blocks; `kind` carries committed vs tentative
  CompleteItem -> UPDATE plan_items / milestones SET status = done
  MoveBlock    -> UPDATE timetable_blocks
  LinkSource   -> UPDATE sources (goal and a text summary of what the photo holds)
  AddReminder  -> reminders
  proposal     -> proposals with a NULL message (raised outside chat)
  audit        -> audit_log, `agent:apply` / `agent:reject`, in the same transaction
"""
from __future__ import annotations

import re

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, time, timedelta

from agentv2.config import BLOCK_COMMITTED, BLOCK_TENTATIVE, ITEM_TYPE_TODO
from agentv2.contracts import (
    AddBlock, AddBlocker, AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddGoal, AddMilestone, ReplaceMilestones, AddPlanMonth, AddPlanWeek, AddReminder, AddTask, AddTodo, EditTodo, Change, ChangeSet, LinkSource, MoveBlock, Origin, Proposal,
)
from agentv2.contracts.blocks import AddItem, EditItem, DeleteItem, Block, BLOCK_ADAPTER, MilestoneBlock
from agentv2.core.milestones import replacement_targets
from agentv2.contracts import ChangeSet as _ChangeSet
from agentv2.contracts.planner import MilestoneSpec
from agentv2.core.calendar import week_start
from agentv2.core.context import BlockRow, Context, GoalHours, PlanMonthRow, PlanWeekRow, RecurringRow, untimed_load_by_day
from agentv2.core.profile import UserProfile, to_planner
from agentv2.core.recurring import occurrences
from pydantic import TypeAdapter
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .ids import new_id
from .models import AuditEntry, Blocker, CalendarBlock, Goal, RecurringBlock, User, Milestone, PlanItem, Proposal as ProposalRow, Reminder, Source, TimetableBlock
from .models import GOAL_HORIZONS

#: A goal the agent creates from a one-line note has no horizon yet; intake
#: refines it. Must be one of GOAL_HORIZONS.
AGENT_DEFAULT_GOAL_HORIZON = "medium"
assert AGENT_DEFAULT_GOAL_HORIZON in GOAL_HORIZONS

#: `timetable_blocks.kind` values this store reads and writes. Any other kind the
#: user created ("class", "meeting") is treated as committed, which is the safe side.
KIND_COMMITTED = "commitment"
KIND_TENTATIVE = "tentative"

#: How far ahead the context loads blocks. Generous: it only bounds a query.
CONTEXT_DAYS_AHEAD = 120

#: How many open tasks and milestones the triage model is shown. Generous: it bounds a query.
OPEN_ITEMS_LIMIT = 200
STATUS_OPEN = "open"
STATUS_DONE = "done"
STATUS_SKIPPED = "skipped"

#: A planned week runs Monday to Sunday: its end date is six days after its start.
WEEK_LAST_DAY_OFFSET = 6
#: Shown on a dated to-do that has a time of day ("by 5 PM"); it is a deadline, not a scheduled block.
DUE_BY = "Due by {time}"

CHANGE_ADAPTER = TypeAdapter(Change)

SOURCE_AGENT = "agent"
SOURCE_RECURRING = "recurring"
AUDIT_APPLY = "agent:apply"
AUDIT_REJECT = "agent:reject"


#: The keys of `users.availability`, Monday first (index = Python's weekday()).
WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _weekday_hours(availability: dict | None) -> dict[int, float] | None:
    """Hours per weekday from the user's availability, or None if they have not set any (then the
    default capacity applies). A weekday left out of a non-empty setting is a day off."""
    if not availability:
        return None
    return {i: float(availability[k]) for i, k in enumerate(WEEKDAY_KEYS) if isinstance(availability.get(k), (int, float))}


def _milestone_trees(rows) -> dict[str, tuple[MilestoneSpec, ...]]:
    """Open milestones per goal in the planner's order: each facet, then its sub-milestones."""
    titles = {m.id: m.title for m in rows}
    out: dict[str, list[MilestoneSpec]] = {}
    facets = sorted((m for m in rows if not m.parent_id or m.parent_id not in titles), key=lambda m: m.target_date)
    for f in facets:
        kids = sorted((m for m in rows if m.parent_id == f.id), key=lambda m: m.target_date)
        out.setdefault(f.goal_id, []).extend(
            MilestoneSpec(id=m.id, title=m.title, due=m.target_date, hours=float(m.hours or 0), parent=f.title if m is not f else "")
            for m in (f, *kids))
    return {g: tuple(ms) for g, ms in out.items()}


def _effort(note: str | None) -> float:
    """A task's hours, kept in its note as "3h" (plan_items has no column for effort)."""
    try:
        return float((note or "").rstrip("h"))
    except ValueError:
        return 0.0


def _status(kind: str) -> str:
    return BLOCK_TENTATIVE if kind == KIND_TENTATIVE else BLOCK_COMMITTED


def _note_hours(note: str | None) -> float:
    """Hours held in a plan row's `note` ("1.5h"), or 0 when it holds none."""
    m = re.match(r"^\s*([\d.]+)\s*h\s*$", note or "")
    return float(m.group(1)) if m else 0.0


def _plan_outcomes(description: str | None) -> tuple[str, ...]:
    """A plan row's outcomes, stored one per line in its `description` column."""
    return tuple(line.strip() for line in (description or "").splitlines() if line.strip())


class SqlStore:
    """One user's view of the database, for the length of one request."""

    def __init__(self, session: AsyncSession, user_id: str, *, today: date | None = None) -> None:
        self.session = session
        self.user_id = user_id
        self.today = today or date.today()

    async def context(self) -> Context:
        goals = (await self.session.execute(
            select(Goal.id, Goal.title, Goal.target_date, Goal.weekly_hours, Goal.status).where(Goal.user_id == self.user_id, Goal.status != "dropped")
        )).all()
        goal_rows = goals
        until = self.today + timedelta(days=CONTEXT_DAYS_AHEAD)
        blocks = (await self.session.execute(
            select(TimetableBlock).where(
                TimetableBlock.user_id == self.user_id,
                TimetableBlock.block_date >= self.today,
                TimetableBlock.block_date <= until,
            )
        )).scalars().all()
        tasks = (await self.session.execute(
            select(PlanItem.id, PlanItem.title).where(
                PlanItem.user_id == self.user_id, PlanItem.status == STATUS_OPEN, PlanItem.horizon.in_(("daily", "weekly")))
            .order_by(PlanItem.created_at.desc()).limit(OPEN_ITEMS_LIMIT)
        )).all()
        miles = (await self.session.execute(
            select(Milestone.id, Milestone.title).where(
                Milestone.user_id == self.user_id, Milestone.status == STATUS_OPEN).limit(OPEN_ITEMS_LIMIT)
        )).all()
        goal_miles = (await self.session.execute(
            select(Milestone).where(Milestone.user_id == self.user_id, Milestone.status == STATUS_OPEN,
                                    Milestone.goal_id.is_not(None), Milestone.target_date.is_not(None))
        )).scalars().all()
        weekly = (await self.session.execute(
            select(PlanItem).where(
                PlanItem.user_id == self.user_id, PlanItem.horizon == "weekly", PlanItem.status == STATUS_OPEN,
                PlanItem.goal_id.is_not(None), PlanItem.start_date >= week_start(self.today))
        )).scalars().all()
        # The month rows, for the plan context the coach reads (THIS MONTH). Older rows have no outcomes.
        monthly = (await self.session.execute(
            select(PlanItem).where(
                PlanItem.user_id == self.user_id, PlanItem.horizon == "monthly", PlanItem.status == STATUS_OPEN,
                PlanItem.goal_id.is_not(None), PlanItem.start_date >= self.today.replace(day=1))
        )).scalars().all()
        titles = {g.id: g.title for g in goals}
        blockers = (await self.session.execute(select(Blocker).where(Blocker.user_id == self.user_id, Blocker.end_date >= self.today))).scalars().all()
        blocked: set[date] = set()
        for bl in blockers:
            d = max(bl.start_date, self.today)
            while d <= bl.end_date and (d - self.today).days <= CONTEXT_DAYS_AHEAD:
                blocked.add(d)
                d += timedelta(days=1)
        user = await self.session.get(User, self.user_id)
        rules = (await self.session.execute(select(RecurringBlock).where(
            RecurringBlock.user_id == self.user_id, (RecurringBlock.end_date.is_(None)) | (RecurringBlock.end_date >= self.today)))).scalars().all()
        totals = {g.id: g.total_hours for g in (await self.session.execute(
            select(Goal.id, Goal.total_hours).where(Goal.user_id == self.user_id, Goal.status != "dropped", Goal.total_hours.is_not(None)))).all()}
        done_rows = (await self.session.execute(
            select(PlanItem.goal_id, PlanItem.note).where(PlanItem.user_id == self.user_id, PlanItem.status == STATUS_DONE,
                                                          PlanItem.horizon == "daily", PlanItem.goal_id.is_not(None)))).all()
        done: dict[str, float] = {}
        for gid, note in done_rows:
            done[gid] = done.get(gid, 0.0) + _effort(note)
        # The "about you" profile: waking hours, work or study hours, weekly hours for goals. A per-day
        # availability the user set explicitly is more specific, so it wins over the weekly figure.
        planner = to_planner(UserProfile.from_json(user.profile if user else None))
        weekday_hours = _weekday_hours(user.availability if user else None)

        # P0 §5: Read calendar_blocks into ctx.items
        items: dict[str, Block] = {}
        cal_blocks = (await self.session.execute(
            select(CalendarBlock).where(CalendarBlock.user_id == self.user_id)
        )).scalars().all()
        for row in cal_blocks:
            try:
                blk = BLOCK_ADAPTER.validate_python(row.data)
                items[row.id] = blk
            except Exception:
                pass  # Log parse failures instead of swallowing them silently

        # §5: Context folding — fold items into planner structures
        # Block rows for the hour grid. The old rows are converted to `BlockRow` here: the fold
        # downstream assumes that shape, and `calendar_blocks` is the table still being written.
        old_blocks = [
            BlockRow(id=b.id, day=b.block_date, start=b.start_time, end=b.end_time,
                     status=BLOCK_TENTATIVE if b.kind == KIND_TENTATIVE else BLOCK_COMMITTED,
                     title=b.label, goal_id=b.goal_id)
            for b in blocks
        ]
        new_blocks: list[BlockRow] = list(old_blocks)
        # Blocked dates — start with old blockers, add Away
        new_blocked_dates = set(blocked)
        # Open items — start with old tasks/milestones, add open Tasks and Milestones
        new_open_items = {**{t.id: t.title for t in tasks}, **{m.id: m.title for m in miles}}
        # Goal milestones — start with old milestones, add Milestone blocks
        new_goal_milestones = dict(_milestone_trees(goal_miles))  # copy to mutate
        # Goal hours done — start with old done, add done Tasks
        new_goal_hours_done = dict(done)
        # Expanded weeks — start with old tentative, add planner Tasks
        new_expanded_weeks: set[tuple[str, date]] = set(
            (b.goal_id, week_start(b.day)) for b in old_blocks if b.goal_id and b.status == BLOCK_TENTATIVE)
        # Untimed planner work (quotas, multi-day items) uses hours without holding a clock slot.
        new_untimed_hours: dict[date, float] = {}

        for blk_id, blk in items.items():
            bk = blk.block_kind
            if bk == "event":
                # Timed event -> committed BlockRow
                if blk.start is not None and blk.end is not None:
                    if blk.repeat:
                        # Expand repeat occurrences
                        for occ_day, occ_start, occ_end in occurrences(
                            tuple(blk.repeat.weekdays), blk.start, blk.end,
                            blk.day, blk.repeat.until, self.today, CONTEXT_DAYS_AHEAD
                        ):
                            new_blocks.append(BlockRow(
                                id=f"{blk_id}:{occ_day.isoformat()}",
                                day=occ_day, start=occ_start, end=occ_end,
                                status=BLOCK_COMMITTED, title=blk.title, goal_id=blk.goal_id
                            ))
                    else:
                        new_blocks.append(BlockRow(
                            id=blk_id, day=blk.day, start=blk.start, end=blk.end,
                            status=BLOCK_COMMITTED, title=blk.title, goal_id=blk.goal_id
                        ))
            elif bk == "task":
                # Untimed planner work (a quota or a multi-day item) uses hours without a clock
                # slot; fold what it asks of each day so capacity checks see it as taken.
                if (getattr(blk, "placed_by", "user") == "planner" and blk.day is not None
                        and blk.start is None and blk.end is None and not blk.done):
                    for d, hours in untimed_load_by_day(
                            blk, self.today, self.today + timedelta(days=CONTEXT_DAYS_AHEAD)).items():
                        new_untimed_hours[d] = new_untimed_hours.get(d, 0.0) + hours
                # Timed task -> BlockRow (tentative if planner, committed if user)
                if blk.start is not None and blk.end is not None:
                    placed_by = getattr(blk, 'placed_by', 'user')
                    status = BLOCK_TENTATIVE if placed_by == 'planner' else BLOCK_COMMITTED
                    new_blocks.append(BlockRow(
                        id=blk_id, day=blk.day, start=blk.start, end=blk.end,
                        status=status, title=blk.title, goal_id=blk.goal_id
                    ))
                    if placed_by == 'planner' and blk.goal_id:
                        new_expanded_weeks.add((blk.goal_id, week_start(blk.day)))
                # Open task -> open_items
                if not blk.done:
                    new_open_items[blk_id] = blk.title
                # Done task -> goal_hours.done
                else:
                    if blk.goal_id:
                        effort = blk.effort_hours or 0.0
                        new_goal_hours_done[blk.goal_id] = new_goal_hours_done.get(blk.goal_id, 0.0) + effort
            elif bk == "away":
                # Away -> blocked_dates
                d = blk.start_date
                while d <= blk.end_date:
                    if (d - self.today).days <= CONTEXT_DAYS_AHEAD:
                        new_blocked_dates.add(d)
                    d += timedelta(days=1)
            elif bk == "milestone":
                # Milestone -> goal_milestones (if open)
                # Check if reached - assume open if no 'reached' field or if False
                reached = getattr(blk, 'reached', False)
                if not reached:
                    # Build a MilestoneSpec from the block
                    # We need to handle parent_id if it exists
                    parent_title = ""
                    if blk.parent_id and blk.parent_id in items:
                        parent_title = items[blk.parent_id].title if hasattr(items[blk.parent_id], 'title') else ""

                    from agentv2.contracts.planner import MilestoneSpec
                    spec = MilestoneSpec(
                        id=blk_id, title=blk.title, due=blk.target_date,
                        hours=blk.hours or 0.0, parent=parent_title
                    )
                    new_goal_milestones.setdefault(blk.goal_id, []).append(spec)
                    new_open_items[blk_id] = blk.title

        # The backfill kept ids, so a row can exist in both tables. The `calendar_blocks` row is
        # appended last and therefore wins, while the dict keeps the id's first position.
        new_blocks = list({b.id: b for b in new_blocks}.values())
        for goal_id, specs in list(new_goal_milestones.items()):
            new_goal_milestones[goal_id] = tuple({s.id: s for s in specs}.values())

        return Context(
            active_spans=planner.active_spans,
            busy_weekly=planner.busy_weekly,
            recurring=tuple(RecurringRow(r.id, r.title, tuple(r.weekdays), r.start_time, r.end_time, r.end_date) for r in rules),
            goal_hours={g: GoalHours(float(t), new_goal_hours_done.get(g, 0.0)) for g, t in totals.items()},
            weekday_hours=weekday_hours if weekday_hours is not None else planner.weekday_hours,
            weekly_cap_hours=planner.weekly_cap_hours,
            blocked_dates=frozenset(new_blocked_dates),
            goal_targets={g.id: g.target_date for g in goal_rows if g.target_date},
            today=self.today,
            plan_weeks=tuple(
                PlanWeekRow(w.goal_id, titles.get(w.goal_id, ""), w.start_date, w.title, float(w.weekly_hours or 0),
                            w.why or "", _plan_outcomes(w.description))
                for w in weekly if w.goal_id in titles),
            plan_months=tuple(
                PlanMonthRow(m.goal_id, titles.get(m.goal_id, ""), m.start_date, m.title, _note_hours(m.note),
                             m.why or "", _plan_outcomes(m.description))
                for m in monthly if m.goal_id in titles),
            expanded_weeks=frozenset(new_expanded_weeks),
            open_items=new_open_items,
            goal_ids=frozenset(g.id for g in goals),
            active_goal_ids=frozenset(g.id for g in goals if g.status == "active"),
            goal_titles={g.id: g.title for g in goals},
            goal_weekly_hours={g.id: float(g.weekly_hours) for g in goal_rows if g.weekly_hours},
            goal_milestones={g: tuple(ms) for g, ms in new_goal_milestones.items()},
            blocks=tuple(new_blocks),
            untimed_hours_by_day=new_untimed_hours,
            items=items,
        )

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        # A savepoint: the caller owns the outer commit, and a failure here undoes
        # only the gateway's writes (change rows and audit row together).
        async with self.session.begin_nested():
            yield

    async def write(self, change: Change, origin: Origin) -> None:
        s = self.session
        if isinstance(change, AddGoal):
            s.add(Goal(id=change.id, user_id=self.user_id, title=change.title, horizon=AGENT_DEFAULT_GOAL_HORIZON,
                       why=change.why, life_area=change.life_area, start_date=change.start_date, target_date=change.target_date,
                       total_hours=change.total_hours))
        elif isinstance(change, AddRecurring):
            s.add(RecurringBlock(id=change.id, user_id=self.user_id, title=change.title, weekdays=list(change.weekdays),
                                 start_time=change.start, end_time=change.end, start_date=change.start_date, end_date=change.end_date))
            await s.flush()
            await self._lay_out(change.id, change.title, change.weekdays, change.start, change.end, change.start_date, change.end_date, self.today)
        elif isinstance(change, StopRecurring):
            await s.execute(update(RecurringBlock).where(RecurringBlock.id == change.rule_id, RecurringBlock.user_id == self.user_id)
                            .values(end_date=change.from_date - timedelta(days=1)))
            await s.execute(delete(TimetableBlock).where(
                TimetableBlock.user_id == self.user_id, TimetableBlock.source == SOURCE_RECURRING,
                TimetableBlock.source_id == change.rule_id, TimetableBlock.block_date >= change.from_date))
        elif isinstance(change, ClearGoalPlan):
            # Only the planner's own work: blocks it placed for this goal from the date on, the tasks behind
            # them, and the goal's unfinished weekly rows. Tasks the user filed from Scratch carry no goal on
            # their blocks, so they are left alone.
            blocks = (await s.execute(select(TimetableBlock.id, TimetableBlock.source_id).where(
                TimetableBlock.user_id == self.user_id, TimetableBlock.goal_id == change.goal_id,
                TimetableBlock.kind == KIND_TENTATIVE, TimetableBlock.block_date >= change.from_date))).all()
            task_ids = {b.source_id for b in blocks if b.source_id}
            if blocks:
                await s.execute(delete(TimetableBlock).where(TimetableBlock.id.in_([b.id for b in blocks])))
            if task_ids:
                await s.execute(delete(PlanItem).where(PlanItem.id.in_(task_ids), PlanItem.status == STATUS_OPEN))
            await s.execute(delete(PlanItem).where(
                PlanItem.user_id == self.user_id, PlanItem.goal_id == change.goal_id, PlanItem.horizon == "weekly",
                PlanItem.status == STATUS_OPEN, PlanItem.start_date >= week_start(change.from_date)))
            await s.execute(delete(PlanItem).where(
                PlanItem.user_id == self.user_id, PlanItem.goal_id == change.goal_id, PlanItem.horizon == "monthly",
                PlanItem.status == STATUS_OPEN, PlanItem.start_date >= change.from_date.replace(day=1)))
            # §4c: Also clear the goal's planner TaskBlocks from that date on in calendar_blocks
            # Fetch all planner TaskBlocks for this goal and filter by day in Python
            planner_rows = (await s.execute(select(CalendarBlock).where(
                CalendarBlock.user_id == self.user_id,
                CalendarBlock.block_kind == 'task',
                CalendarBlock.data.contains({'placed_by': 'planner', 'goal_id': change.goal_id})
            ))).scalars().all()
            ids_to_delete = []
            for row in planner_rows:
                try:
                    blk = BLOCK_ADAPTER.validate_python(row.data)
                    if blk.block_kind == "task" and blk.day is not None and blk.day >= change.from_date:
                        ids_to_delete.append(row.id)
                except Exception:
                    pass
            if ids_to_delete:
                await s.execute(delete(CalendarBlock).where(CalendarBlock.id.in_(ids_to_delete)))
        elif isinstance(change, CompleteItem) and change.outcome != "full":
            row = await s.get(PlanItem, change.item_id)
            if row is not None and row.user_id == self.user_id:
                if change.outcome == "skip":
                    row.status = STATUS_SKIPPED
                else:  # part done: the row stays open, with how much of its hours is finished
                    row.done_hours = round((change.fraction or 0) * _note_hours(row.note), 2)
            await self._mark_calendar_block_done(change.item_id, outcome=change.outcome, fraction=change.fraction)
        elif isinstance(change, CompleteItem):
            # Ids are prefixed by table, so one id names exactly one row.
            await s.execute(update(PlanItem).where(PlanItem.id == change.item_id, PlanItem.user_id == self.user_id).values(status=STATUS_DONE, done_at=func.now()))
            await s.execute(update(Milestone).where(Milestone.id == change.item_id, Milestone.user_id == self.user_id).values(status=STATUS_DONE))
            # A finished task no longer needs the time the agent set aside for it.
            await s.execute(delete(TimetableBlock).where(
                TimetableBlock.user_id == self.user_id, TimetableBlock.source_id == change.item_id,
                TimetableBlock.kind == KIND_TENTATIVE, TimetableBlock.block_date >= self.today))
            # The 4-kind path: the same item may be a `calendar_blocks` row (a planner session is
            # one task row whose id is the task's own id), so it is marked done there too.
            await self._mark_calendar_block_done(change.item_id)
        elif isinstance(change, AddBlocker):
            s.add(Blocker(id=change.id, user_id=self.user_id, title=change.title, start_date=change.start_date, end_date=change.end_date))
        elif isinstance(change, AddMilestone):
            goal = await s.get(Goal, change.goal_id)
            s.add(Milestone(id=change.id, user_id=self.user_id, goal_id=change.goal_id,
                            goal_title=goal.title if goal else "", title=change.title, target_date=change.target_date,
                            parent_id=change.parent_id, hours=change.hours or None))
        elif isinstance(change, ReplaceMilestones):
            await self._replace_milestones(change)
        elif isinstance(change, AddPlanMonth):
            last = (change.month_start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            # Outcomes live one per line in `description`: the column already exists, so no migration.
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="monthly", title=change.focus,
                           note=f"{change.hours:g}h", start_date=change.month_start, end_date=last, due_date=last,
                           description="\n".join(change.outcomes) or None, why=change.why or None))
        elif isinstance(change, AddPlanWeek):
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="weekly", title=change.focus,
                           start_date=change.week_start, end_date=change.week_start + timedelta(days=WEEK_LAST_DAY_OFFSET),
                           weekly_hours=round(change.hours), description="\n".join(change.outcomes) or None,
                           why=change.why or None))
        elif isinstance(change, AddTask):
            # `note` keeps the effort (the UI reads it as "3h"); `day` is what puts the task on a
            # calendar, and `description` is the session's own sentence, not the goal's.
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="daily",
                           title=change.title, note=f"{change.effort_hours:g}h" if change.effort_hours else "",
                           start_date=change.day, due_date=change.day,
                           description=change.description or (DUE_BY.format(time=change.due_time.strftime("%-I:%M %p")) if change.due_time else None),
                           why=change.why or None, milestone_id=change.milestone_id))
        elif isinstance(change, AddTodo):
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="daily",
                           item_type=ITEM_TYPE_TODO, priority=change.priority, title=change.title,
                           description=change.description or None, start_date=change.day, due_date=change.day,
                           due_time=change.due_time))
        elif isinstance(change, EditTodo):
            await s.execute(update(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == self.user_id,
                                                   PlanItem.item_type == ITEM_TYPE_TODO).values(**_todo_columns(change)))
        elif isinstance(change, AddReminder):
            s.add(Reminder(id=change.id, user_id=self.user_id, goal_id=change.goal_id, title=change.title,
                           days=[d.isoformat() for d in change.days],
                           times=[t.strftime("%H:%M") for t in change.times],
                           source=origin.source, source_id=origin.ref))
        elif isinstance(change, AddBlock):
            goal = await s.get(Goal, change.goal_id) if change.goal_id else None
            s.add(TimetableBlock(
                id=change.id, user_id=self.user_id, block_date=change.day, start_time=change.start,
                end_time=change.end, label=change.title, source=SOURCE_AGENT,
                source_id=change.task_id, goal_id=change.goal_id, goal_title=goal.title if goal else "",
                kind=KIND_COMMITTED if change.status == BLOCK_COMMITTED else KIND_TENTATIVE,
                why=change.why or None))
        elif isinstance(change, LinkSource):
            goal = await s.get(Goal, change.goal_id) if change.goal_id else None
            src = await s.get(Source, change.source_id)
            if src is not None and src.user_id == self.user_id:
                src.goal_id = goal.id if goal else None
                src.goal_title = goal.title if goal else ""
                # Don't overwrite text the extractor already produced.
                if not src.text_excerpt:
                    src.text_excerpt = f"{change.title}\n{change.summary}".strip()
        elif isinstance(change, MoveBlock):
            await s.execute(update(TimetableBlock).where(
                TimetableBlock.id == change.block_id, TimetableBlock.user_id == self.user_id
            ).values(block_date=change.day, start_time=change.start, end_time=change.end))
        elif isinstance(change, AddItem):
            s.add(CalendarBlock(
                id=change.block.id, user_id=self.user_id,
                block_kind=change.block.block_kind, title=change.block.title,
                data=change.block.model_dump(mode="json")))
        elif isinstance(change, EditItem):
            row = await s.get(CalendarBlock, change.id)
            if row is not None:
                row.data = change.block.model_dump(mode="json")
                row.title = change.block.title
                row.block_kind = change.block.block_kind
        elif isinstance(change, DeleteItem):
            await s.execute(delete(CalendarBlock).where(
                CalendarBlock.id == change.id, CalendarBlock.user_id == self.user_id))
        await s.flush()

    async def _milestone_blocks(self, goal_id: str | None = None) -> list[tuple[CalendarBlock, MilestoneBlock]]:
        """The user's milestone rows from `calendar_blocks`, parsed, optionally for one goal.

        An unparseable row is skipped rather than raised: one bad row must not make an edit fail.
        """
        rows = list((await self.session.execute(
            select(CalendarBlock).where(
                CalendarBlock.user_id == self.user_id, CalendarBlock.block_kind == "milestone")
        )).scalars())
        out: list[tuple[CalendarBlock, MilestoneBlock]] = []
        for row in rows:
            try:
                blk = BLOCK_ADAPTER.validate_python(row.data or {})
            except Exception:
                continue
            if blk.block_kind != "milestone":
                continue
            if goal_id is not None and blk.goal_id != goal_id:
                continue
            out.append((row, blk))
        return out

    async def _replace_milestones(self, change: ReplaceMilestones) -> None:
        """Replace a goal's open milestones with `change.milestones`, keeping the done ones.

        Milestones live in two tables (`milestones` before the 4-kind switch, `calendar_blocks`
        after), and a goal may have rows in both, so both are read and both open sets are cleared.
        A milestone is done when either copy says so; keeping it is the safe direction, since
        deleting a finished milestone would erase work the user already achieved.
        """
        s, uid = self.session, self.user_id
        goal = await s.get(Goal, change.goal_id)
        goal_title = goal.title if goal else ""

        old = list((await s.execute(
            select(Milestone).where(Milestone.user_id == uid, Milestone.goal_id == change.goal_id)
        )).scalars())
        blocks = await self._milestone_blocks(change.goal_id)

        done = {m.id for m in old if m.status == STATUS_DONE}
        done.update(row.id for row, blk in blocks if blk.reached)
        existing = {m.id for m in old} | {row.id for row, _blk in blocks}
        keep, replace = replacement_targets((mid, mid in done) for mid in existing)

        if replace:
            # The blocks may carry ids whose legacy copy was already deleted by an earlier change;
            # deleting by id is harmless when the row is not there.
            await s.execute(delete(Milestone).where(
                Milestone.user_id == uid, Milestone.id.in_(list(replace))))
            await s.execute(delete(CalendarBlock).where(
                CalendarBlock.user_id == uid, CalendarBlock.id.in_(list(replace))))

        for m in change.milestones:
            if m.id in keep:
                continue  # done is fixed; an incoming copy of it is ignored
            # A `MilestoneBlock` requires a date. An undated input (a goal with no deadline, and a
            # model that offered no date) keeps the legacy row, which allows one — never a validation
            # error on a confirmed plan.
            if m.target_date is not None:
                s.add(CalendarBlock(
                    id=m.id, user_id=uid, block_kind="milestone", title=m.title,
                    data=MilestoneBlock(
                        id=m.id, title=m.title, goal_id=change.goal_id, target_date=m.target_date,
                        parent_id=m.parent_id, hours=m.hours,
                    ).model_dump(mode="json"),
                ))
            else:
                s.add(Milestone(
                    id=m.id, user_id=uid, goal_id=change.goal_id, goal_title=goal_title,
                    title=m.title, target_date=m.target_date, parent_id=m.parent_id,
                    hours=m.hours or None,
                ))

    async def _mark_calendar_block_done(self, item_id: str, *, outcome: str = "full", fraction: float | None = None) -> None:
        """Mirror `CompleteItem` onto a `calendar_blocks` row of the same id.

        The old writer updates `plan_items` and `milestones`; on the 4-kind path the same item
        lives in `calendar_blocks`, so it has to change there too. A milestone becomes reached.
        A task keeps its row and records the outcome: the row is the session itself, so deleting
        it would take a finished session off the board and its hours out of the goal's done total
        (`context()` counts done tasks).
        """
        row = await self.session.get(CalendarBlock, item_id)
        if row is None or row.user_id != self.user_id:
            return
        try:
            blk = BLOCK_ADAPTER.validate_python(row.data)
        except Exception:
            return
        if blk.block_kind == "milestone":
            if outcome != "full":
                return  # a milestone is reached or not; part-done and skip apply to tasks
            blk.reached = True
        elif blk.block_kind == "task":
            if outcome == "skip":
                blk.state = "skip"
            elif outcome == "full":
                blk.done, blk.state, blk.done_fraction = True, "done", 1.0
            else:  # part done: still open, with how much of it is finished
                blk.state, blk.done_fraction = "partial", fraction or 0.0
        else:
            return
        row.data = blk.model_dump(mode="json")

    async def _lay_out(self, rule_id, title, weekdays, start, end, start_date, end_date, today) -> int:
        """Insert the rule's occurrences that are not there yet. Returns how many were added."""
        have = set((await self.session.execute(
            select(TimetableBlock.block_date).where(TimetableBlock.user_id == self.user_id, TimetableBlock.source_id == rule_id,
                                                    TimetableBlock.source == SOURCE_RECURRING))).scalars())
        added = 0
        for day, s_, e_ in occurrences(weekdays, start, end, start_date, end_date, today):
            if day in have:
                continue
            self.session.add(TimetableBlock(
                id=f"{rule_id}:{day.isoformat()}", user_id=self.user_id, block_date=day, start_time=s_, end_time=e_,
                label=title, kind=KIND_COMMITTED, source=SOURCE_RECURRING, source_id=rule_id))
            added += 1
        await self.session.flush()
        return added

    async def extend_recurring(self, today) -> int:
        rules = (await self.session.execute(select(RecurringBlock).where(
            RecurringBlock.user_id == self.user_id, (RecurringBlock.end_date.is_(None)) | (RecurringBlock.end_date >= today)))).scalars().all()
        added = 0
        for r in rules:
            added += await self._lay_out(r.id, r.title, r.weekdays, r.start_time, r.end_time, r.start_date, r.end_date, today)
        return added

    async def remove_blocks(self, block_ids: list[str]) -> None:
        if block_ids:
            # Remove tentative timetable blocks
            await self.session.execute(delete(TimetableBlock).where(
                TimetableBlock.id.in_(block_ids), TimetableBlock.user_id == self.user_id, TimetableBlock.kind == KIND_TENTATIVE))

            # Remove planner task blocks from calendar_blocks
            # Planner tasks have placed_by='planner' in their JSON data.
            await self.session.execute(
                delete(CalendarBlock).where(
                    CalendarBlock.id.in_(block_ids),
                    CalendarBlock.user_id == self.user_id,
                    CalendarBlock.block_kind == 'task',
                    CalendarBlock.data.contains({'placed_by': 'planner'})
                )
            )
            await self.session.flush()

    async def load_audit(self, audit_id: str):
        row = await self.session.get(AuditEntry, audit_id)
        if row is None or row.user_id != self.user_id or row.type != AUDIT_APPLY:
            return None
        p = row.payload or {}
        cs = _ChangeSet(origin=p["origin"], changes=[CHANGE_ADAPTER.validate_python(c) for c in p["changes"]])
        return cs, list(p.get("applied", [])), bool(p.get("undone"))

    async def revert(self, change: Change) -> None:
        s, uid = self.session, self.user_id
        if isinstance(change, CompleteItem):
            await s.execute(update(PlanItem).where(PlanItem.id == change.item_id, PlanItem.user_id == uid).values(status=STATUS_OPEN, done_hours=None, done_at=None))
            await s.execute(update(Milestone).where(Milestone.id == change.item_id, Milestone.user_id == uid).values(status=STATUS_OPEN))
            # The 4-kind copy of the same milestone, when there is one (the backfill kept ids).
            row = await s.get(CalendarBlock, change.item_id)
            if row is not None and row.user_id == uid:
                try:
                    blk = BLOCK_ADAPTER.validate_python(row.data)
                except Exception:
                    blk = None
                if blk is not None and blk.block_kind == "milestone":
                    blk.reached = False
                    row.data = blk.model_dump(mode="json")
                elif blk is not None and blk.block_kind == "task":
                    blk.done, blk.state, blk.done_fraction = False, "open", None
                    row.data = blk.model_dump(mode="json")
        elif isinstance(change, AddRecurring):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.user_id == uid, TimetableBlock.source_id == change.id))
            await s.execute(delete(RecurringBlock).where(RecurringBlock.id == change.id, RecurringBlock.user_id == uid))
        elif isinstance(change, AddGoal):
            await s.execute(delete(Milestone).where(Milestone.goal_id == change.id, Milestone.user_id == uid))
            await s.execute(delete(Goal).where(Goal.id == change.id, Goal.user_id == uid))  # cascades its plan rows
        elif isinstance(change, AddTodo):
            await s.execute(delete(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid))
        elif isinstance(change, EditTodo):
            if change.before:
                await s.execute(update(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid).values(**_todo_columns_from(change.before)))
        elif isinstance(change, AddTask):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.source_id == change.id, TimetableBlock.user_id == uid))
            await s.execute(delete(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid))
        elif isinstance(change, (AddBlock,)):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.id == change.id, TimetableBlock.user_id == uid))
        elif isinstance(change, (AddPlanWeek, AddPlanMonth)):
            await s.execute(delete(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid))
        elif isinstance(change, AddBlocker):
            await s.execute(delete(Blocker).where(Blocker.id == change.id, Blocker.user_id == uid))
        elif isinstance(change, AddMilestone):
            await s.execute(delete(Milestone).where(Milestone.id == change.id, Milestone.user_id == uid))
        elif isinstance(change, ReplaceMilestones):
            # Undo: remove what the set wrote (from either table) and restore the open milestones
            # it replaced. Done milestones were never touched, so they need no restoring.
            ids = [m.id for m in change.milestones]
            if ids:
                # A done milestone is never written by the replacement, so undo must not delete one
                # just because the set listed it: that would erase work the user had already done.
                done_rows = set((await s.execute(
                    select(Milestone.id).where(
                        Milestone.user_id == uid, Milestone.id.in_(ids), Milestone.status == STATUS_DONE
                    )
                )).scalars())
                done_rows |= {
                    row.id for row, blk in await self._milestone_blocks(change.goal_id)
                    if row.id in ids and blk.reached
                }
                ids = [i for i in ids if i not in done_rows]
                if ids:
                    await s.execute(delete(Milestone).where(Milestone.user_id == uid, Milestone.id.in_(ids)))
                    await s.execute(delete(CalendarBlock).where(CalendarBlock.user_id == uid, CalendarBlock.id.in_(ids)))
            for m in change.before:
                s.add(Milestone(
                    id=m.id, user_id=uid, goal_id=change.goal_id, goal_title="",
                    title=m.title, target_date=m.target_date, parent_id=m.parent_id,
                    hours=m.hours or None,
                ))
        elif isinstance(change, AddReminder):
            await s.execute(delete(Reminder).where(Reminder.id == change.id, Reminder.user_id == uid))
        elif isinstance(change, AddItem):
            await s.execute(delete(CalendarBlock).where(CalendarBlock.id == change.block.id, CalendarBlock.user_id == uid))
        elif isinstance(change, EditItem):
            if change.before:
                # Restore from the before snapshot
                row = await s.get(CalendarBlock, change.id)
                if row is not None:
                    row.data = change.before
                    row.title = change.before.get("title", "")
                    row.block_kind = change.before.get("block_kind", "")
        elif isinstance(change, DeleteItem):
            # Restore the deleted block from the snapshot
            blk = change.block.model_dump(mode="json")
            s.add(CalendarBlock(id=change.id, user_id=uid, block_kind=blk["block_kind"],
                                title=blk.get("title", ""), data=blk))
        elif isinstance(change, LinkSource):
            await s.execute(update(Source).where(Source.id == change.source_id, Source.user_id == uid).values(goal_id=None, goal_title="", text_excerpt=None))
        await s.flush()

    async def mark_undone(self, audit_id: str) -> None:
        row = await self.session.get(AuditEntry, audit_id)
        row.payload = {**row.payload, "undone": True}
        await self.session.flush()

    async def add_proposal(self, change: Change, reason: str, origin: Origin) -> str:
        row = ProposalRow(id=new_id("proposal"), user_id=self.user_id, action=change.kind,
                          args={"change": change.model_dump(mode="json"), "reason": reason,
                                "origin": origin.model_dump()})
        self.session.add(row)
        await self.session.flush()
        return row.id

    async def bump_version(self) -> int:
        result = await self.session.execute(
            update(User).where(User.id == self.user_id).values(board_version=User.board_version + 1).returning(User.board_version)
        )
        row = result.one()
        await self.session.flush()
        return int(row[0])

    async def write_audit(self, cs: ChangeSet, applied: list[int], proposed: list[Proposal]) -> str:
        row = AuditEntry(
            id=new_id("audit"), user_id=self.user_id, type=AUDIT_APPLY,
            summary=f"{len(applied)} applied, {len(proposed)} proposed ({cs.origin.source})",
            payload={"origin": cs.origin.model_dump(), "applied": applied,
                     "proposed": [p.model_dump() for p in proposed],
                     "changes": [c.model_dump(mode="json") for c in cs.changes]})
        self.session.add(row)
        await self.session.flush()
        return row.id

    async def log_reject(self, cs: ChangeSet, violations: list) -> None:
        self.session.add(AuditEntry(
            id=new_id("audit"), user_id=self.user_id, type=AUDIT_REJECT,
            summary=f"rejected: {len(violations)} violation(s)",
            payload={"origin": cs.origin.model_dump(), "violations": [v.model_dump() for v in violations]}))
        await self.session.flush()


#: To-do fields (agentv2 `EditTodo`) to their `plan_items` columns; `day` is both start and due date.
_TODO_FIELD_COLUMNS = {"title": ("title",), "goal_id": ("goal_id",), "day": ("start_date", "due_date"),
                       "due_time": ("due_time",), "priority": ("priority",), "description": ("description",)}


def _todo_columns_from(fields: dict) -> dict:
    """Column values for a dict of to-do fields (`done` maps to `status`). Dates and times may arrive as
    ISO strings, from the audit row's JSON."""
    out: dict = {}
    for k, v in fields.items():
        if k == "done":
            out["status"] = STATUS_DONE if v else STATUS_OPEN
            out["done_at"] = func.now() if v else None
        elif k == "day":
            v = date.fromisoformat(v) if isinstance(v, str) else v
            out.update(start_date=v, due_date=v)
        elif k == "due_time":
            out["due_time"] = time.fromisoformat(v) if isinstance(v, str) else v
        elif k in _TODO_FIELD_COLUMNS:
            out[_TODO_FIELD_COLUMNS[k][0]] = v
    return out


def _todo_columns(change: EditTodo) -> dict:
    """The columns an edit sets: the fields it gives, and the ones it clears as NULL."""
    given = {k: v for k, v in change.model_dump(include=set(_TODO_FIELD_COLUMNS) | {"done"}).items() if v is not None}
    given.update({k: None for k in change.clear})
    return _todo_columns_from(given)
