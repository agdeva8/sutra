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
from ..contracts import AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddBlock, AddGoal, AddMilestone, AddPlanWeek, AddReminder, AddTask, Change, ChangeSet, LinkSource, MoveBlock, Origin, Proposal


class InMemoryStore:
    """Dict-backed store with real rollback, so the transaction contract is exercised."""

    def __init__(self, ctx: Context | None = None) -> None:
        base = ctx or Context()
        self.goals: dict[str, str] = {g: base.goal_titles.get(g, g) for g in base.goal_ids}
        self.blocks: dict[str, BlockRow] = {b.id: b for b in base.blocks}
        self.capacity = base.daily_capacity_hours
        self.today = base.today
        self.tasks: dict[str, AddTask] = {}
        self.reminders: dict[str, AddReminder] = {}
        self.sources: dict[str, LinkSource] = {}
        self.weeks: dict[str, AddPlanWeek] = {}
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
        self._seq = itertools.count(1)

    async def context(self) -> Context:
        return Context(
            goal_ids=frozenset(self.goals),
            goal_titles=dict(self.goals),
            goal_hours={g: GoalHours(t, sum(self.tasks[i].effort_hours for i in self.done if i in self.tasks and self.tasks[i].goal_id == g))
                        for g, t in self.goal_total.items()},
            recurring=tuple(RecurringRow(r.id, r.title, tuple(r.weekdays), r.start, r.end, r.end_date) for r in self.recurring.values()
                            if r.end_date is None or r.end_date >= (self.today or _date.today())),
            today=self.today,
            plan_weeks=tuple(PlanWeekRow(w.goal_id, self.goals.get(w.goal_id, ""), w.week_start, w.focus, w.hours) for w in self.weeks.values()),
            expanded_weeks=frozenset((g, _monday(self.blocks[b].day)) for b, g in self.block_goal.items() if b in self.blocks and self.blocks[b].status == "tentative"),
            open_items={i: t.title for i, t in self.tasks.items() if i not in self.done},
            blocks=tuple(self.blocks.values()),
            daily_capacity_hours=self.capacity,
        )

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        snap = (dict(self.goals), dict(self.blocks), dict(self.tasks), dict(self.reminders),
                list(self.proposals), list(self.audit))
        try:
            yield
        except BaseException:
            self.goals, self.blocks, self.tasks, self.reminders, self.proposals, self.audit = snap
            raise

    async def write(self, change: Change, origin: Origin) -> None:
        if isinstance(change, AddGoal):
            self.goals[change.id] = change.title
            if change.total_hours:
                self.goal_total[change.id] = change.total_hours
        elif isinstance(change, AddTask):
            self.tasks[change.id] = change
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
        elif isinstance(change, CompleteItem):
            self.done.add(change.item_id)
            for bid in [b for b, t in self.block_task.items() if t == change.item_id]:
                self.blocks.pop(bid, None)
        elif isinstance(change, AddMilestone):
            self.milestones[change.id] = change
        elif isinstance(change, AddPlanWeek):
            self.weeks[change.id] = change
        elif isinstance(change, LinkSource):
            self.sources[change.source_id] = change
        elif isinstance(change, AddBlock):
            self.blocks[change.id] = BlockRow(change.id, change.day, change.start, change.end, change.status, change.title, change.goal_id)
            if change.task_id:
                self.block_task[change.id] = change.task_id
            if change.goal_id:
                self.block_goal[change.id] = change.goal_id
        elif isinstance(change, MoveBlock):
            old = self.blocks[change.block_id]
            self.blocks[change.block_id] = BlockRow(old.id, change.day, change.start, change.end, old.status, old.title, old.goal_id)

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
            if b in self.blocks and self.blocks[b].status == "tentative":
                self.blocks.pop(b)
                self.block_task.pop(b, None)
                self.block_goal.pop(b, None)

    async def load_audit(self, audit_id: str):
        for a in self.audit:
            if a["id"] == audit_id:
                return a["cs"], a["applied"], a.get("undone", False)
        return None

    async def revert(self, change: Change) -> None:
        if isinstance(change, AddRecurring):
            self.recurring.pop(change.id, None)
            for b in [b for b, rid in self.block_rule.items() if rid == change.id]:
                self.blocks.pop(b, None)
                self.block_rule.pop(b, None)
        elif isinstance(change, CompleteItem):
            self.done.discard(change.item_id)
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
        elif isinstance(change, AddMilestone):
            self.milestones.pop(change.id, None)
        elif isinstance(change, LinkSource):
            self.sources.pop(change.source_id, None)

    async def mark_undone(self, audit_id: str) -> None:
        for a in self.audit:
            if a["id"] == audit_id:
                a["undone"] = True

    async def log_reject(self, cs: ChangeSet, violations: list) -> None:
        self.rejects.append({"origin": cs.origin.model_dump(), "violations": [v.model_dump() for v in violations]})
