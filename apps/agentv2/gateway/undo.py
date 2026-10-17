"""Undo: reverse what one audit row applied. Only the gateway's own writes can be undone.

A change set is recorded in its audit row, so "undo" is the audit row read backwards.
Two things are not restored: a moved block's old position (the audit row does not
keep it) and the tentative blocks cleared when a task was finished (the next plan
tick lays new ones). Both are reported, not hidden.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts import ClearGoalPlan, MoveBlock, StopRecurring
from .store import Store


@dataclass
class UndoResult:
    reverted: int = 0
    not_restored: list[str] = field(default_factory=list)
    already_undone: bool = False
    found: bool = True


async def undo(store: Store, audit_id: str) -> UndoResult:
    loaded = await store.load_audit(audit_id)
    if loaded is None:
        return UndoResult(found=False)
    cs, applied, undone = loaded
    if undone:
        return UndoResult(already_undone=True)

    out = UndoResult()
    async with store.transaction():
        # Newest first, so a task is removed before the goal it hangs off.
        for i in sorted(applied, reverse=True):
            change = cs.changes[i]
            if isinstance(change, MoveBlock):
                out.not_restored.append("a moved block's previous position")
                continue
            if isinstance(change, StopRecurring):
                out.not_restored.append("the recurring commitment that was stopped (add it again)")
                continue
            if isinstance(change, ClearGoalPlan):
                out.not_restored.append("the plan that was cleared (plan it again to rebuild)")
                continue
            await store.revert(change)
            out.reverted += 1
        await store.mark_undone(audit_id)
        await store.bump_version()
    return out
