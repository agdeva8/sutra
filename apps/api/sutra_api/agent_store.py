"""The SQL implementation of agentv2's `Store` interface.

agentv2 never imports a database driver; this module is where its changes become
rows. `apps/api` imports `agentv2`, never the reverse.

Mapping (each is a deliberate fit onto the v1 schema, not a new table, except
reminders):

  AddGoal      -> goals
  AddMilestone -> milestones
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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, timedelta

from agentv2.config import BLOCK_COMMITTED, BLOCK_TENTATIVE
from agentv2.contracts import (
    AddBlock, AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddGoal, AddMilestone, AddPlanWeek, AddReminder, AddTask, Change, ChangeSet, LinkSource, MoveBlock, Origin, Proposal,
)
from agentv2.contracts import ChangeSet as _ChangeSet
from agentv2.core.calendar import week_start
from agentv2.core.context import BlockRow, Context, GoalHours, PlanWeekRow, RecurringRow
from agentv2.core.profile import UserProfile, to_planner
from agentv2.core.recurring import occurrences
from pydantic import TypeAdapter
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .ids import new_id
from .models import AuditEntry, Blocker, Goal, RecurringBlock, User, Milestone, PlanItem, Proposal as ProposalRow, Reminder, Source, TimetableBlock
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

#: A planned week runs Monday to Sunday: its end date is six days after its start.
WEEK_LAST_DAY_OFFSET = 6

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


def _effort(note: str | None) -> float:
    """A task's hours, kept in its note as "3h" (plan_items has no column for effort)."""
    try:
        return float((note or "").rstrip("h"))
    except ValueError:
        return 0.0


def _status(kind: str) -> str:
    return BLOCK_TENTATIVE if kind == KIND_TENTATIVE else BLOCK_COMMITTED


class SqlStore:
    """One user's view of the database, for the length of one request."""

    def __init__(self, session: AsyncSession, user_id: str, *, today: date | None = None) -> None:
        self.session = session
        self.user_id = user_id
        self.today = today or date.today()

    async def context(self) -> Context:
        goals = (await self.session.execute(
            select(Goal.id, Goal.title, Goal.target_date).where(Goal.user_id == self.user_id, Goal.status != "dropped")
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
        weekly = (await self.session.execute(
            select(PlanItem).where(
                PlanItem.user_id == self.user_id, PlanItem.horizon == "weekly", PlanItem.status == STATUS_OPEN,
                PlanItem.goal_id.is_not(None), PlanItem.start_date >= week_start(self.today))
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
        return Context(
            active_spans=planner.active_spans,
            busy_weekly=planner.busy_weekly,
            recurring=tuple(RecurringRow(r.id, r.title, tuple(r.weekdays), r.start_time, r.end_time, r.end_date) for r in rules),
            goal_hours={g: GoalHours(float(t), done.get(g, 0.0)) for g, t in totals.items()},
            weekday_hours=weekday_hours if weekday_hours is not None else planner.weekday_hours,
            weekly_cap_hours=planner.weekly_cap_hours,
            blocked_dates=frozenset(blocked),
            goal_targets={g.id: g.target_date for g in goal_rows if g.target_date},
            today=self.today,
            plan_weeks=tuple(PlanWeekRow(w.goal_id, titles.get(w.goal_id, ""), w.start_date, w.title, float(w.weekly_hours or 0)) for w in weekly if w.goal_id in titles),
            expanded_weeks=frozenset((b.goal_id, week_start(b.block_date)) for b in blocks if b.goal_id and b.kind == KIND_TENTATIVE),
            open_items={**{t.id: t.title for t in tasks}, **{m.id: m.title for m in miles}},
            goal_ids=frozenset(g.id for g in goals),
            goal_titles={g.id: g.title for g in goals},
            blocks=tuple(BlockRow(b.id, b.block_date, b.start_time, b.end_time, _status(b.kind), b.label, b.goal_id) for b in blocks),
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
        elif isinstance(change, CompleteItem):
            # Ids are prefixed by table, so one id names exactly one row.
            await s.execute(update(PlanItem).where(PlanItem.id == change.item_id, PlanItem.user_id == self.user_id).values(status=STATUS_DONE))
            await s.execute(update(Milestone).where(Milestone.id == change.item_id, Milestone.user_id == self.user_id).values(status=STATUS_DONE))
            # A finished task no longer needs the time the agent set aside for it.
            await s.execute(delete(TimetableBlock).where(
                TimetableBlock.user_id == self.user_id, TimetableBlock.source_id == change.item_id,
                TimetableBlock.kind == KIND_TENTATIVE, TimetableBlock.block_date >= self.today))
        elif isinstance(change, AddMilestone):
            goal = await s.get(Goal, change.goal_id)
            s.add(Milestone(id=change.id, user_id=self.user_id, goal_id=change.goal_id,
                            goal_title=goal.title if goal else "", title=change.title, target_date=change.target_date))
        elif isinstance(change, AddPlanWeek):
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="weekly", title=change.focus,
                           start_date=change.week_start, end_date=change.week_start + timedelta(days=WEEK_LAST_DAY_OFFSET),
                           weekly_hours=round(change.hours)))
        elif isinstance(change, AddTask):
            s.add(PlanItem(id=change.id, user_id=self.user_id, goal_id=change.goal_id, horizon="daily",
                           title=change.title, note=f"{change.effort_hours:g}h"))
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
                kind=KIND_COMMITTED if change.status == BLOCK_COMMITTED else KIND_TENTATIVE))
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
        await s.flush()

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
            await self.session.execute(delete(TimetableBlock).where(
                TimetableBlock.id.in_(block_ids), TimetableBlock.user_id == self.user_id, TimetableBlock.kind == KIND_TENTATIVE))
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
            await s.execute(update(PlanItem).where(PlanItem.id == change.item_id, PlanItem.user_id == uid).values(status=STATUS_OPEN))
            await s.execute(update(Milestone).where(Milestone.id == change.item_id, Milestone.user_id == uid).values(status=STATUS_OPEN))
        elif isinstance(change, AddRecurring):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.user_id == uid, TimetableBlock.source_id == change.id))
            await s.execute(delete(RecurringBlock).where(RecurringBlock.id == change.id, RecurringBlock.user_id == uid))
        elif isinstance(change, AddGoal):
            await s.execute(delete(Milestone).where(Milestone.goal_id == change.id, Milestone.user_id == uid))
            await s.execute(delete(Goal).where(Goal.id == change.id, Goal.user_id == uid))  # cascades its plan rows
        elif isinstance(change, AddTask):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.source_id == change.id, TimetableBlock.user_id == uid))
            await s.execute(delete(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid))
        elif isinstance(change, (AddBlock,)):
            await s.execute(delete(TimetableBlock).where(TimetableBlock.id == change.id, TimetableBlock.user_id == uid))
        elif isinstance(change, AddPlanWeek):
            await s.execute(delete(PlanItem).where(PlanItem.id == change.id, PlanItem.user_id == uid))
        elif isinstance(change, AddMilestone):
            await s.execute(delete(Milestone).where(Milestone.id == change.id, Milestone.user_id == uid))
        elif isinstance(change, AddReminder):
            await s.execute(delete(Reminder).where(Reminder.id == change.id, Reminder.user_id == uid))
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
