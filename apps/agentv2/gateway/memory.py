"""Dict-backed store with real rollback, so the transaction contract is exercised.

Backs the demo and the tests. The SQL store lives in `apps/api`.
"""
from __future__ import annotations

import itertools
from contextlib import asynccontextmanager
from typing import AsyncIterator

from ..core.calendar import week_start as _monday
from ..core.context import BlockRow, Context, GoalHours, PlanWeekRow, RecurringRow
from datetime import date as _date, timedelta as _timedelta

from ..core.recurring import occurrences
from ..contracts import AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddBlock, AddBlocker, AddGoal, AddMilestone, AddPlanMonth, AddPlanWeek, AddReminder, AddTask, AddTodo, EditTodo, Change, ChangeSet, LinkSource, MoveBlock, Origin, Proposal
from ..contracts.blocks import AddItem, EditItem, DeleteItem, Block


class InMemoryStore:
    """Dict-backed store with real rollback, so the transaction contract is exercised."""

    def __init__(self, ctx: Context | None = None) -> None:
        base = ctx or Context()
        self.goals: dict[str, str] = {g: base.goal_titles.get(g, g) for g in base.goal_ids}
        self.blocks: dict[str, BlockRow] = {b.id: b for b in base.blocks}
        self.capacity = base.daily_capacity_hours
        #: The user's own week (waking hours, work hours, weekly cap, away days), carried through unchanged.
        self.base = base
        self.today = base.today
        self.tasks: dict[str, AddTask] = {}
        self.reminders: dict[str, AddReminder] = {}
        #: To-dos as plain dicts of their current fields (an edit changes them in place); `done` included.
        self.todos: dict[str, dict] = {}
        self.sources: dict[str, LinkSource] = {}
        self.weeks: dict[str, AddPlanWeek] = {}
        self.months: dict[str, AddPlanMonth] = {}
        self.ticks: dict[str, CompleteItem] = {}
        self.blockers: dict[str, AddBlocker] = {}
        #: block id -> why, which the trimmed `BlockRow` does not carry.
        self.block_why: dict[str, str] = {}
        self.milestones: dict[str, AddMilestone] = {}
        self.done: set[str] = set()
        self.recurring: dict[str, AddRecurring] = {}
        self.goal_total: dict[str, float] = {}
        self.block_rule: dict[str, str] = {}
        self.block_task: dict[str, str] = {}
        self.block_goal: dict[str, str] = {}
        self.proposals: list[dict] = []
        self.audit: list[dict] = []
        self.rejects: list[dict] = []
        self.blocks4: dict[str, Block] = {}  # four-kind blocks: event, task, away, milestone
        self.version: int = 0
        self._seq = itertools.count(1)

    async def context(self) -> Context:
        # Start with old structures
        new_blocked_dates = set(self.base.blocked_dates)
        for b in self.blockers.values():
            new_blocked_dates.update(b.start_date + _timedelta(days=n) for n in range((b.end_date - b.start_date).days + 1))

        # Fold blocks4 into planner structures
        new_blocks = list(self.blocks.values())
        new_open_items = {i: t.title for i, t in self.tasks.items() if i not in self.done}
        new_goal_hours_done = {g: sum(self.tasks[i].effort_hours or 0 for i in self.done if i in self.tasks and self.tasks[i].goal_id == g) for g, t in self.goal_total.items()}
        new_expanded_weeks = frozenset((g, _monday(self.blocks[b].day)) for b, g in self.block_goal.items() if b in self.blocks and self.blocks[b].status == "tentative")
        new_goal_milestones: dict = {}  # goal_id -> list of MilestoneSpec

        from ..config import BLOCK_COMMITTED, BLOCK_TENTATIVE
        from ..contracts.planner import MilestoneSpec

        for blk_id, blk in self.blocks4.items():
            bk = blk.block_kind
            if bk == "event":
                if blk.start is not None and blk.end is not None:
                    if blk.repeat:
                        for occ_day, occ_start, occ_end in occurrences(
                            tuple(blk.repeat.weekdays), blk.start, blk.end,
                            blk.day, blk.repeat.until, self.today or _date.today(), 120
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
                if blk.start is not None and blk.end is not None:
                    placed_by = getattr(blk, 'placed_by', 'user')
                    status = BLOCK_TENTATIVE if placed_by == 'planner' else BLOCK_COMMITTED
                    new_blocks.append(BlockRow(
                        id=blk_id, day=blk.day, start=blk.start, end=blk.end,
                        status=status, title=blk.title, goal_id=blk.goal_id
                    ))
                    if placed_by == 'planner' and blk.goal_id:
                        new_expanded_weeks = new_expanded_weeks | {(blk.goal_id, _monday(blk.day))}
                if not blk.done:
                    new_open_items[blk_id] = blk.title
                else:
                    if blk.goal_id:
                        effort = blk.effort_hours or 0.0
                        new_goal_hours_done[blk.goal_id] = new_goal_hours_done.get(blk.goal_id, 0.0) + effort
            elif bk == "away":
                d = blk.start_date
                while d <= blk.end_date:
                    new_blocked_dates.add(d)
                    d += _timedelta(days=1)
            elif bk == "milestone":
                reached = getattr(blk, 'reached', False)
                if not reached:
                    parent_title = ""
                    if blk.parent_id and blk.parent_id in self.blocks4:
                        parent_title = self.blocks4[blk.parent_id].title
                    spec = MilestoneSpec(
                        id=blk_id, title=blk.title, due=blk.target_date,
                        hours=blk.hours or 0.0, parent=parent_title
                    )
                    new_goal_milestones.setdefault(blk.goal_id, []).append(spec)
                    new_open_items[blk_id] = blk.title

        return Context(
            goal_ids=frozenset(self.goals),
            goal_titles=dict(self.goals),
            goal_hours={g: GoalHours(t, new_goal_hours_done.get(g, 0.0)) for g, t in self.goal_total.items()},
            recurring=tuple(RecurringRow(r.id, r.title, tuple(r.weekdays), r.start, r.end, r.end_date) for r in self.recurring.values()
                            if r.end_date is None or r.end_date >= (self.today or _date.today())),
            today=self.today,
            plan_weeks=tuple(PlanWeekRow(w.goal_id, self.goals.get(w.goal_id, ""), w.week_start, w.focus, w.hours) for w in self.weeks.values()),
            expanded_weeks=new_expanded_weeks,
            open_items=new_open_items,
            blocks=tuple(new_blocks),
            daily_capacity_hours=self.capacity,
            active_spans=self.base.active_spans, busy_weekly=self.base.busy_weekly,
            weekly_cap_hours=self.base.weekly_cap_hours,
            blocked_dates=frozenset(new_blocked_dates),
            items=dict(self.blocks4),
            goal_milestones={g: tuple(ms) for g, ms in new_goal_milestones.items()},
        )

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        snap = (dict(self.goals), dict(self.blocks), dict(self.tasks), dict(self.reminders),
                list(self.proposals), list(self.audit), dict(self.blocks4), self.version)
        try:
            yield
        except BaseException:
            self.goals, self.blocks, self.tasks, self.reminders, self.proposals, self.audit, self.blocks4, self.version = snap
            raise

    async def write(self, change: Change, origin: Origin) -> None:
        if isinstance(change, AddGoal):
            self.goals[change.id] = change.title
            if change.total_hours:
                self.goal_total[change.id] = change.total_hours
        elif isinstance(change, AddTask):
            self.tasks[change.id] = change
        elif isinstance(change, AddTodo):
            self.todos[change.id] = {**change.model_dump(exclude={"kind", "id"}), "done": False}
        elif isinstance(change, EditTodo):
            row = self.todos.get(change.id)
            if row is not None:
                row.update(_todo_patch(change))
        elif isinstance(change, AddReminder):
            self.reminders[change.id] = change
        elif isinstance(change, AddRecurring):
            self.recurring[change.id] = change
            self._lay_out(change, self.today or _date.today())
        elif isinstance(change, StopRecurring):
            r = self.recurring.get(change.rule_id)
            if r is not None:
                self.recurring[change.rule_id] = r.model_copy(update={"end_date": change.from_date - _timedelta(days=1)})
            for b in [b for b, rid in self.block_rule.items() if rid == change.rule_id and b in self.blocks and self.blocks[b].day >= change.from_date]:
                self.blocks.pop(b, None)
                self.block_rule.pop(b, None)
        elif isinstance(change, ClearGoalPlan):
            gone = [b for b, g in self.block_goal.items() if g == change.goal_id and b in self.blocks
                    and self.blocks[b].status == "tentative" and self.blocks[b].day >= change.from_date]
            for b in gone:
                self.tasks.pop(self.block_task.get(b, ""), None)
                self.blocks.pop(b, None)
            self.weeks = {k: w for k, w in self.weeks.items() if not (w.goal_id == change.goal_id and w.week_start >= _monday(change.from_date))}
            self.months = {k: m for k, m in self.months.items() if not (m.goal_id == change.goal_id and m.month_start >= change.from_date.replace(day=1))}
            # §4c: Also clear the goal's planner TaskBlocks from that date on
            planner_task_ids = [
                bid for bid, blk in self.blocks4.items()
                if blk.block_kind == "task" and blk.goal_id == change.goal_id
                and getattr(blk, 'placed_by', 'user') == 'planner'
                and blk.day is not None and blk.day >= change.from_date
            ]
            for tid in planner_task_ids:
                self.blocks4.pop(tid, None)
        elif isinstance(change, CompleteItem) and change.outcome != "full":
            self.ticks[change.item_id] = change  # part done or skipped: still on the list, not finished
        elif isinstance(change, CompleteItem):
            self.done.add(change.item_id)
            for bid in [b for b, t in self.block_task.items() if t == change.item_id]:
                self.blocks.pop(bid, None)
        elif isinstance(change, AddMilestone):
            self.milestones[change.id] = change
        elif isinstance(change, AddBlocker):
            self.blockers[change.id] = change
        elif isinstance(change, AddPlanWeek):
            self.weeks[change.id] = change
        elif isinstance(change, AddPlanMonth):
            self.months[change.id] = change
        elif isinstance(change, LinkSource):
            self.sources[change.source_id] = change
        elif isinstance(change, AddBlock):
            self.blocks[change.id] = BlockRow(change.id, change.day, change.start, change.end, change.status, change.title, change.goal_id)
            self.block_why[change.id] = change.why
            if change.task_id:
                self.block_task[change.id] = change.task_id
            if change.goal_id:
                self.block_goal[change.id] = change.goal_id
        elif isinstance(change, MoveBlock):
            old = self.blocks[change.block_id]
            self.blocks[change.block_id] = BlockRow(old.id, change.day, change.start, change.end, old.status, old.title, old.goal_id)
        elif isinstance(change, AddItem):
            self.blocks4[change.block.id] = change.block
        elif isinstance(change, EditItem):
            self.blocks4[change.id] = change.block
        elif isinstance(change, DeleteItem):
            self.blocks4.pop(change.id, None)

    async def add_proposal(self, change: Change, reason: str, origin: Origin) -> str:
        pid = f"prop_{next(self._seq)}"
        self.proposals.append({"id": pid, "status": "pending", "reason": reason,
                               "change": change.model_dump(mode="json"), "origin": origin.model_dump()})
        return pid

    async def write_audit(self, cs: ChangeSet, applied: list[int], proposed: list[Proposal]) -> str:
        aid = f"audit_{next(self._seq)}"
        self.audit.append({"id": aid, "cs": cs, "origin": cs.origin.model_dump(), "applied": applied,
                           "proposed": [p.model_dump() for p in proposed]})
        return aid

    def _lay_out(self, rule: AddRecurring, today) -> int:
        have = {(self.blocks[b].day) for b, rid in self.block_rule.items() if rid == rule.id and b in self.blocks}
        added = 0
        for day, start, end in occurrences(rule.weekdays, rule.start, rule.end, rule.start_date, rule.end_date, today):
            if day in have:
                continue
            # a fixed block takes the agent's planned time
            for b in [k for k, v in self.blocks.items() if v.status == "tentative" and v.day == day and start < v.end and v.start < end]:
                self.blocks.pop(b)
            bid = f"{rule.id}:{day.isoformat()}"
            self.blocks[bid] = BlockRow(bid, day, start, end, "committed", rule.title)
            self.block_rule[bid] = rule.id
            added += 1
        return added

    async def extend_recurring(self, today) -> int:
        return sum(self._lay_out(r, today) for r in list(self.recurring.values()))

    async def remove_blocks(self, block_ids: list[str]) -> None:
        for b in block_ids:
            # Remove from old timetable blocks
            if b in self.blocks and self.blocks[b].status == "tentative":
                self.blocks.pop(b)
                self.block_task.pop(b, None)
                self.block_goal.pop(b, None)
            # Remove planner task blocks from blocks4
            if b in self.blocks4:
                blk = self.blocks4[b]
                if blk.block_kind == "task" and getattr(blk, 'placed_by', 'user') == 'planner':
                    self.blocks4.pop(b, None)

    async def load_audit(self, audit_id: str):
        for a in self.audit:
            if a["id"] == audit_id:
                return a["cs"], a["applied"], a.get("undone", False)
        return None

    async def revert(self, change: Change) -> None:
        if isinstance(change, AddTodo):
            self.todos.pop(change.id, None)
        elif isinstance(change, EditTodo):
            row = self.todos.get(change.id)
            if row is not None:
                row.update(change.before)
        elif isinstance(change, AddRecurring):
            self.recurring.pop(change.id, None)
            for b in [b for b, rid in self.block_rule.items() if rid == change.id]:
                self.blocks.pop(b, None)
                self.block_rule.pop(b, None)
        elif isinstance(change, CompleteItem):
            self.done.discard(change.item_id)
            self.ticks.pop(change.item_id, None)
        elif isinstance(change, AddGoal):
            self.goals.pop(change.id, None)
        elif isinstance(change, AddTask):
            self.tasks.pop(change.id, None)
            self.blocks = {k: b for k, b in self.blocks.items() if self.block_task.get(k) != change.id}
        elif isinstance(change, AddBlock):
            self.blocks.pop(change.id, None)
        elif isinstance(change, AddReminder):
            self.reminders.pop(change.id, None)
        elif isinstance(change, AddPlanWeek):
            self.weeks.pop(change.id, None)
        elif isinstance(change, AddPlanMonth):
            self.months.pop(change.id, None)
        elif isinstance(change, AddMilestone):
            self.milestones.pop(change.id, None)
        elif isinstance(change, AddBlocker):
            self.blockers.pop(change.id, None)
        elif isinstance(change, LinkSource):
            self.sources.pop(change.source_id, None)
        elif isinstance(change, AddItem):
            self.blocks4.pop(change.block.id, None)
        elif isinstance(change, EditItem):
            if change.before:
                # Rebuild block from the before snapshot dict
                block = _block_from_dict(change.before)
                self.blocks4[change.id] = block
        elif isinstance(change, DeleteItem):
            self.blocks4[change.id] = change.block

    async def mark_undone(self, audit_id: str) -> None:
        for a in self.audit:
            if a["id"] == audit_id:
                a["undone"] = True

    async def log_reject(self, cs: ChangeSet, violations: list) -> None:
        self.rejects.append({"origin": cs.origin.model_dump(), "violations": [v.model_dump() for v in violations]})


    async def bump_version(self) -> int:
        self.version += 1
        return self.version


def _todo_patch(change: EditTodo) -> dict:
    """The fields an edit sets: the given ones, plus the cleared ones as None."""
    out = {k: v for k, v in change.model_dump(include={"title", "goal_id", "day", "due_time", "priority", "description", "done"}).items() if v is not None}
    out.update({k: None for k in change.clear})
    return out


def _block_from_dict(d: dict) -> Block:
    """Reconstruct a Block from a snapshot dict (used by revert)."""
    from ..contracts.blocks import Block
    return Block.model_validate(d)
