"""Hard rules, pure. A failure here is a bug in whatever built the change set.

Judgment ("is this a good use of the evening?") belongs to the critic in step 5;
this module only answers "is it well-formed and physically possible".

Whether a change is safe to apply unasked is NOT decided here. That is the
gateway's classification: the validator rejects the impossible, the gateway
downgrades the risky to a proposal.
"""
from __future__ import annotations

from datetime import date, datetime

from ..config import BLOCK_COMMITTED, BLOCK_TENTATIVE
from .context import BlockRow, Context
from ..contracts import AddBlocker, AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddBlock, AddGoal, AddMilestone, ReplaceMilestones, AddPlanMonth, AddPlanWeek, AddReminder, AddTask, AddTodo, EditTodo, ChangeSet, LinkSource, MoveBlock, Violation
from ..contracts.blocks import AddItem, EditItem, DeleteItem, Block, BlockKind

RULE_GOAL_EXISTS = "goal_exists"
RULE_BLOCK_EXISTS = "block_exists"
RULE_BLOCK_ORDER = "block_start_before_end"
RULE_NO_OVERLAP = "no_overlap"
RULE_DUPLICATE_ID = "duplicate_id"
RULE_CAPACITY = "capacity"
RULE_ITEM_EXISTS = "item_exists"
RULE_ITEM4_EXISTS = "item4_exists"
RULE_NOT_IN_PAST = "not_in_past"
RULE_BLOCKED_DATE = "blocked_date"
RULE_RECURRING = "recurring"


def _hours(start, end) -> float:
    anchor = date.min
    return (datetime.combine(anchor, end) - datetime.combine(anchor, start)).total_seconds() / 3600


def _check_repeat(i: int, r, fail) -> None:
    if any(not 0 <= d <= 6 for d in r.weekdays):
        fail(i, RULE_RECURRING, f"repeat: weekdays must be Monday to Sunday")
    if r.until is not None and r.until < date.today():
        fail(i, RULE_RECURRING, f"repeat: until date has already passed")


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


def _timed(blk) -> bool:
    """A block that occupies hours on one day. Repeating items are laid out as occurrences
    elsewhere, so they are not checked as a single block."""
    return (blk.block_kind in ("event", "task") and blk.day is not None
            and blk.start is not None and blk.end is not None and blk.repeat is None)


def _item_status(blk) -> str:
    """A task the planner placed is tentative; an event, or a task the user placed, is committed."""
    if blk.block_kind == "task" and getattr(blk, "placed_by", "user") == "planner":
        return BLOCK_TENTATIVE
    return BLOCK_COMMITTED


def validate(cs: ChangeSet, ctx: Context) -> list[Violation]:
    """Check `cs` against `ctx` and against itself. Empty list means well-formed."""
    out: list[Violation] = []

    goals = set(ctx.goal_ids)
    # Blocks as they will stand once earlier changes in this set have landed, so a
    # change set cannot create two overlapping blocks that each look fine alone.
    blocks: dict[str, BlockRow] = {b.id: b for b in ctx.blocks}
    seen_ids: set[str] = set()

    def fail(i: int, rule: str, msg: str) -> None:
        out.append(Violation(rule=rule, change_index=i, message=msg))

    def check_block(i: int, bid: str, day, start, end, status: str, title: str = "", goal_id: str | None = None,
                    *, allow_committed_overlap: bool = False) -> None:
        """Check a block against the ones already there.

        `allow_committed_overlap` is for a block the user committed themselves (an event, or a task
        they placed): people double-book, and every calendar app allows it. It never lets a
        *tentative* block clash — the planner's own placement still has to fit.
        """
        if start >= end:
            fail(i, RULE_BLOCK_ORDER, f"block {bid}: start {start} is not before end {end}")
            return
        displaced: list[str] = []
        for other in list(blocks.values()):
            if other.id != bid and other.day == day and _overlaps(start, end, other.start, other.end):
                if status == BLOCK_COMMITTED and other.status == BLOCK_TENTATIVE:
                    displaced.append(other.id)  # a fixed block wins; the agent's planned time gives way
                    continue
                if allow_committed_overlap and status == BLOCK_COMMITTED and other.status == BLOCK_COMMITTED:
                    continue  # two things the user committed may overlap
                fail(i, RULE_NO_OVERLAP, f"block {bid} overlaps {other.id} ({other.status}) on {day}")
        for gone in displaced:
            blocks.pop(gone, None)
        if status == BLOCK_TENTATIVE and day in ctx.blocked_dates:
            fail(i, RULE_BLOCKED_DATE, f"{title or bid}: {day} is a day you are unavailable")
        blocks[bid] = BlockRow(id=bid, day=day, start=start, end=end, status=status, title=title, goal_id=goal_id)
        if status == BLOCK_TENTATIVE:
            planned = ctx.planned_hours.get(day, 0.0) + sum(
                _hours(b.start, b.end) for b in blocks.values() if b.day == day and b.status == BLOCK_TENTATIVE
            )
            if planned > ctx.capacity_on(day):
                fail(i, RULE_CAPACITY, f"{day}: {planned:.1f}h planned exceeds capacity {ctx.capacity_on(day):.1f}h")

    def check_item(i: int, bid: str, blk) -> None:
        """A timed 4-kind item goes through the same check as an `AddBlock`."""
        if not _timed(blk):
            return
        status = _item_status(blk)
        check_block(i, bid, blk.day, blk.start, blk.end, status, blk.title, blk.goal_id,
                    allow_committed_overlap=status == BLOCK_COMMITTED)

    for i, c in enumerate(cs.changes):
        new_id = getattr(c, "id", None)
        if new_id is not None:
            if new_id in seen_ids:
                fail(i, RULE_DUPLICATE_ID, f"id {new_id} appears twice in this change set")
            seen_ids.add(new_id)

        if ctx.today is not None:
            when = getattr(c, "day", None) or getattr(c, "target_date", None)
            if isinstance(c, (AddBlock, AddMilestone, AddTodo)) and when is not None and when < ctx.today:
                fail(i, RULE_NOT_IN_PAST, f"{c.title}: {when} has already passed")

        if isinstance(c, AddGoal):
            goals.add(c.id)
        elif isinstance(c, AddTask):
            if c.goal_id is not None and c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"task {c.id}: goal {c.goal_id} does not exist")
        elif isinstance(c, (AddTodo, EditTodo)):
            if c.goal_id is not None and c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"to-do {c.id}: goal {c.goal_id} does not exist")
            if isinstance(c, AddTodo) and not c.title.strip():
                fail(i, RULE_ITEM_EXISTS, "a to-do needs a title")
        elif isinstance(c, AddBlocker):
            if c.end_date < c.start_date:
                fail(i, RULE_BLOCK_ORDER, f"{c.title}: it ends ({c.end_date}) before it starts ({c.start_date})")
            elif ctx.today is not None and c.end_date < ctx.today:
                fail(i, RULE_NOT_IN_PAST, f"{c.title}: {c.end_date} has already passed")
        elif isinstance(c, AddRecurring):
            if any(not 0 <= d <= 6 for d in c.weekdays):
                fail(i, RULE_RECURRING, f"{c.title}: weekdays must be Monday to Sunday")
            if c.start >= c.end:
                fail(i, RULE_RECURRING, f"{c.title}: start {c.start} is not before end {c.end}")
            if c.end_date is not None and c.end_date < c.start_date:
                fail(i, RULE_RECURRING, f"{c.title}: it ends before it starts")
        elif isinstance(c, StopRecurring):
            if c.rule_id not in {r.id for r in ctx.recurring}:
                fail(i, RULE_ITEM_EXISTS, f"{c.rule_id} is not an active recurring commitment")
        elif isinstance(c, ClearGoalPlan):
            if c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"goal {c.goal_id} does not exist")
            # The cleared time is free again for what is planned after it in this change set.
            for gone in [k for k, b in blocks.items() if b.goal_id == c.goal_id and b.status == BLOCK_TENTATIVE and b.day >= c.from_date]:
                blocks.pop(gone)
        elif isinstance(c, CompleteItem):
            if c.item_id not in ctx.open_items:
                fail(i, RULE_ITEM_EXISTS, f"{c.item_id} is not an open item")
        elif isinstance(c, AddMilestone):
            if c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"milestone {c.id}: goal {c.goal_id} does not exist")
        elif isinstance(c, ReplaceMilestones):
            if c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"milestones for goal {c.goal_id}: goal {c.goal_id} does not exist")
            owned = {m.id for m in c.milestones}
            if len(owned) != len(c.milestones):
                fail(i, RULE_DUPLICATE_ID, f"goal {c.goal_id}: a milestone id appears twice in the replacement set")
            for m in c.milestones:
                if not m.title.strip():
                    fail(i, RULE_ITEM_EXISTS, f"milestone {m.id}: a milestone needs a title")
                if ctx.today is not None and m.target_date is not None and m.target_date < ctx.today:
                    fail(i, RULE_NOT_IN_PAST, f"{m.title}: {m.target_date} has already passed")
        elif isinstance(c, AddPlanMonth):
            if c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"plan month {c.id}: goal {c.goal_id} does not exist")
        elif isinstance(c, AddPlanWeek):
            if c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"plan week {c.id}: goal {c.goal_id} does not exist")
        elif isinstance(c, AddReminder):
            if c.goal_id is not None and c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"reminder {c.id}: goal {c.goal_id} does not exist")
        elif isinstance(c, LinkSource):
            if c.goal_id is not None and c.goal_id not in goals:
                fail(i, RULE_GOAL_EXISTS, f"source {c.source_id}: goal {c.goal_id} does not exist")
        elif isinstance(c, AddBlock):
            check_block(i, c.id, c.day, c.start, c.end, c.status, c.title, c.goal_id)
        elif isinstance(c, MoveBlock):
            current = blocks.get(c.block_id)
            if current is None:
                fail(i, RULE_BLOCK_EXISTS, f"block {c.block_id} does not exist")
            else:
                check_block(i, c.block_id, c.day, c.start, c.end, current.status, current.title, current.goal_id)
        elif isinstance(c, AddItem):
            blk = c.block
            if not blk.title.strip():
                fail(i, RULE_ITEM_EXISTS, "a block needs a title")
            bk = blk.block_kind
            if bk == "event":
                if blk.start is not None and blk.end is not None and blk.start >= blk.end:
                    fail(i, RULE_BLOCK_ORDER, "event: start is not before end")
                if blk.repeat:
                    _check_repeat(i, blk.repeat, fail)
            elif bk == "task":
                if blk.start is not None and blk.end is not None and blk.start >= blk.end:
                    fail(i, RULE_BLOCK_ORDER, "task: start is not before end")
                if blk.goal_id is not None and blk.goal_id not in goals:
                    fail(i, RULE_GOAL_EXISTS, f"task {blk.id}: goal {blk.goal_id} does not exist")
                if blk.repeat:
                    _check_repeat(i, blk.repeat, fail)
                if blk.quota is not None and blk.quota < 1:
                    fail(i, RULE_RECURRING, "task: a quota must be at least 1")
                if ctx.today is not None and blk.day is not None and blk.day < ctx.today:
                    fail(i, RULE_NOT_IN_PAST, f"task: {blk.day} has already passed")
            elif bk == "away":
                if blk.end_date < blk.start_date:
                    fail(i, RULE_BLOCK_ORDER, f"away: ends before it starts")
                if ctx.today is not None and blk.end_date < ctx.today:
                    fail(i, RULE_NOT_IN_PAST, f"away: {blk.end_date} has already passed")
            elif bk == "milestone":
                if blk.goal_id not in goals:
                    fail(i, RULE_GOAL_EXISTS, f"milestone: goal {blk.goal_id} does not exist")
                if ctx.today is not None and blk.target_date < ctx.today:
                    fail(i, RULE_NOT_IN_PAST, f"milestone: {blk.target_date} has already passed")
            check_item(i, blk.id or f"new:{i}", blk)
        elif isinstance(c, DeleteItem):
            # Kept permissive: the store removes what it can see by id.
            pass
        elif isinstance(c, EditItem):
            current = ctx.items.get(c.id)
            if current is not None:
                # A known 4-kind row: the new time is checked exactly like a create of the same item.
                check_item(i, c.id, c.block)
            # An id the context does not hold stays permissive; the store validates it.

    return out
