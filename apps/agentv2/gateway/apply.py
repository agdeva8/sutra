"""The only write path (HLD §9).

Re-validates, applies what is safe, turns what is risky into a proposal, and
writes the audit row in the same transaction as the mutation. Nothing else in
agentv2 writes: a node that wants a change builds a `ChangeSet` and calls
`apply`. The classification is done here, in code, from a diff against current
rows. A model that calls its own change "low-risk" is not consulted.
"""
from __future__ import annotations

from ..core.recurring import occurrences
from ..config import AUTO_APPLY_KINDS, BLOCK_COMMITTED, BLOCK_TENTATIVE, END_OF_DAY
from ..core.context import Context
from datetime import date, time, timedelta

from ..contracts import AddBlock, AddBlocker, AddRecurring, Applied, Change, ChangeSet, MoveBlock, Proposal, Rejected
from ..contracts.blocks import AddItem, EditItem
from .store import Store
from ..core.validate import validate

REASON_MOVES_COMMITTED = "moves a committed block"
REASON_NOT_AUTO = "this kind of change is never applied without asking"


def classify(change: Change, ctx: Context) -> str | None:
    """None if safe to apply; otherwise the reason it must be proposed."""
    if change.kind not in AUTO_APPLY_KINDS:
        if isinstance(change, MoveBlock):
            target = ctx.block(change.block_id)
            if target is not None and target.status == BLOCK_COMMITTED:
                return REASON_MOVES_COMMITTED
            return None  # moving the agent's own tentative block is safe
        return REASON_NOT_AUTO
    return None


async def apply(cs: ChangeSet, store: Store, *, approved: bool = False) -> Applied | Rejected:
    """`approved=True` means the user has confirmed these changes (a proposal they accepted), so the
    risky ones are applied instead of being proposed again. Validation still runs."""
    ctx = await store.context()
    violations = validate(cs, ctx)
    if violations:
        await store.log_reject(cs, violations)
        return Rejected(violations=violations)

    # A fixed block takes precedence over the agent's own planned time: remove what it covers.
    fixed = [(c.day, c.start, c.end) for c in cs.changes if isinstance(c, AddBlock) and c.status == BLOCK_COMMITTED]

    # Build set of planner task block IDs from items
    planner_task_ids = {
        bid for bid, blk in ctx.items.items()
        if blk.block_kind == "task" and getattr(blk, 'placed_by', 'user') == 'planner'
    }

    for c in cs.changes:
        if isinstance(c, AddBlocker):
            fixed += [(c.start_date + timedelta(days=n), time.min, END_OF_DAY) for n in range((c.end_date - c.start_date).days + 1)]
        if isinstance(c, AddRecurring):
            fixed += occurrences(c.weekdays, c.start, c.end, c.start_date, c.end_date, ctx.today or date.today())
        if isinstance(c, AddItem):
            blk = c.block
            bk = blk.block_kind
            # §5: New timed Event, Away, or user-placed Task displace planner tasks
            if bk == "event" and blk.start and blk.end:
                fixed.append((blk.day, blk.start, blk.end))
            elif bk == "away":
                d = blk.start_date
                while d <= blk.end_date:
                    fixed.append((d, time.min, END_OF_DAY))
                    d += timedelta(days=1)
            elif bk == "task" and blk.start and blk.end and getattr(blk, 'placed_by', 'user') == 'user':
                fixed.append((blk.day, blk.start, blk.end))
        if isinstance(c, EditItem):
            old = ctx.items.get(c.id)
            new = c.block
            # Displace if moving a planner task or adding a fixed block
            if old and old.block_kind == "task" and getattr(old, 'placed_by', 'user') == 'planner':
                # Moving a planner task: remove the old occurrence
                if old.start and old.end:
                    # We can't easily "un-fix" the old one without more context
                    # But the validation will catch the overlap anyway
                    pass
            # Displace for the new state if it's fixed
            if new.block_kind == "event" and new.start and new.end:
                fixed.append((new.day, new.start, new.end))
            elif new.block_kind == "task" and new.start and new.end and getattr(new, 'placed_by', 'user') == 'user':
                fixed.append((new.day, new.start, new.end))
            elif new.block_kind == "away":
                d = new.start_date
                while d <= new.end_date:
                    fixed.append((d, time.min, END_OF_DAY))
                    d += timedelta(days=1)

    displaced = {
        b.id: b.goal_id
        for day, start, end in fixed
        for b in ctx.blocks
        if b.status == BLOCK_TENTATIVE and b.day == day and start < b.end and b.start < end
    }
    # Also add planner tasks from items that are displaced
    # If a fixed block covers a day/time of a planner task, remove it
    for day, start, end in fixed:
        for tid in planner_task_ids:
            task = ctx.items.get(tid)
            if task and task.day == day and task.start and task.end and start < task.end and task.start < end:
                displaced[tid] = task.goal_id
    applied: list[int] = []
    proposed: list[Proposal] = []
    async with store.transaction():
        if displaced:
            await store.remove_blocks(list(displaced))
        for i, change in enumerate(cs.changes):
            reason = None if approved else classify(change, ctx)
            if reason is None:
                await store.write(change, cs.origin)
                applied.append(i)
            else:
                await store.add_proposal(change, reason, cs.origin)
                proposed.append(Proposal(change_index=i, reason=reason))
        audit_id = await store.write_audit(cs, applied, proposed)
        version = await store.bump_version()
    return Applied(applied=applied, proposed=proposed, audit_id=audit_id,
                   displaced_goals=sorted({g for g in displaced.values() if g}), version=version)
