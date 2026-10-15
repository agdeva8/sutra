"""Placing a task: the model picks among free windows, code builds the blocks.

Placement is a judgement about the user's preferences and their day, so there is no mechanical
fallback: a pick that breaks a rule goes back to the model with the exact problem, up to
`FIX_MAX_LOOPS` times. If it still cannot be placed, the task is kept unscheduled and says so.
"""
from __future__ import annotations

from datetime import datetime

from ..config import FIX_MAX_LOOPS
from ..contracts import AddBlock
from ..contracts.triage import SlotPick
from ..core.context import Context
from ..core.slots import Window, busy_by_day, free_windows, picks_to_blocks, validate_picks
from ..llm import complete_json
from ..prompts.triage import SLOT_SYSTEM, slot_user


def _describe(windows: list[Window]) -> str:
    return "\n".join(f"- {w.id}: {w.day:%a %d %b} {w.start:%H:%M}-{w.end:%H:%M} ({w.hours:g}h)" for w in windows)


def _describe_busy(ctx: Context, now: datetime) -> str:
    rows = [f"- {d:%a %d %b} {s:%H:%M}-{e:%H:%M}  {t} ({kind})" for d, items in busy_by_day(ctx, now).items() for s, e, t, kind in items]
    return "\n".join(rows) or "(nothing)"


def place_task(chat, title: str, effort_hours: float, ctx: Context, now: datetime, *, task_id: str | None = None, goal_id: str | None = None) -> tuple[list[AddBlock], str]:
    """Returns (blocks, how) where `how` is 'model', 'no_room' (nothing free) or 'unplaced' (the model
    could not produce a legal placement)."""
    windows = free_windows(ctx, now)
    if not windows:
        return [], "no_room"
    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        pick = complete_json(chat, SLOT_SYSTEM, slot_user(title, effort_hours, _describe(windows), _describe_busy(ctx, now), now, problem), SlotPick)
        if pick is None:
            problem = "the reply was not valid JSON for the schema"
            continue
        picks = [(p.window_id, p.hours, p.start_offset_min) for p in pick.placements]
        problem = validate_picks(picks, effort_hours, windows)
        if problem is None:
            why = " ".join(p.why for p in pick.placements if p.why)
            return picks_to_blocks(picks, windows, title, task_id=task_id, goal_id=goal_id, why=why), "model"
    return [], "unplaced"
