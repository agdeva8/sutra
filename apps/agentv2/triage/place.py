"""Placing a task: the model picks among free windows, code builds the blocks.

If the model's pick is unusable (an id it was not offered, hours that do not fit
or do not add up) the task is placed by `first_fit` instead. A task is never
dropped because a model reply was bad.
"""
from __future__ import annotations

from datetime import datetime

from ..contracts import AddBlock
from ..contracts.triage import SlotPick
from ..core.context import Context
from ..core.slots import Window, busy_by_day, first_fit, free_windows, picks_to_blocks, validate_picks
from ..llm import complete_json
from ..prompts.triage import SLOT_SYSTEM, slot_user


def _describe(windows: list[Window]) -> str:
    return "\n".join(f"- {w.id}: {w.day:%a %d %b} {w.start:%H:%M}-{w.end:%H:%M} ({w.hours:g}h)" for w in windows)


def _describe_busy(ctx: Context, now: datetime) -> str:
    rows = [f"- {d:%a %d %b} {s:%H:%M}-{e:%H:%M}  {t} ({kind})" for d, items in busy_by_day(ctx, now).items() for s, e, t, kind in items]
    return "\n".join(rows) or "(nothing)"


def place_task(chat, title: str, effort_hours: float, ctx: Context, now: datetime, *, task_id: str | None = None, goal_id: str | None = None) -> tuple[list[AddBlock], str]:
    """Returns (blocks, how) where `how` is 'model', 'first_fit' or 'no_room'."""
    windows = free_windows(ctx, now)
    if not windows:
        return [], "no_room"
    pick = complete_json(chat, SLOT_SYSTEM, slot_user(title, effort_hours, _describe(windows), _describe_busy(ctx, now), now), SlotPick)
    picks = [(p.window_id, p.hours, p.start_offset_min) for p in pick.placements] if pick else []
    if not pick or validate_picks(picks, effort_hours, windows):
        picks, how = first_fit(effort_hours, windows), "first_fit"
    else:
        how = "model"
    if validate_picks(picks, effort_hours, windows):
        return [], "no_room"  # not enough free time in the window to hold the task
    return picks_to_blocks(picks, windows, title, task_id=task_id, goal_id=goal_id), how
