"""Merge branches that each planned from the same snapshot. Pure.

Two goals planned in parallel can pick the same slot. The higher-priority branch
(lower number) keeps it; the loser's block is re-placed in the next free window,
or dropped to undated work if nothing is free.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime

from ..config import BLOCK_TENTATIVE, DAY_WINDOW_WEEKS
from ..contracts import Change
from ..contracts.blocks import AddItem
from ..core.context import BlockRow, Context
from ..core.ids import new_id
from ..core.slots import first_fit, free_windows, pad_after, picks_to_task_blocks, validate_picks


def _overlaps_new(block, taken: list[BlockRow]) -> bool:
    # An untimed task (a day item, or one with no day) holds no hours, so it cannot clash.
    if block.day is None or block.start is None or block.end is None:
        return False
    return any(t.day == block.day and block.start < t.end and t.start < block.end for t in taken)


def _hours_new(block) -> float:
    return (block.end.hour * 60 + block.end.minute - block.start.hour * 60 - block.start.minute) / 60


def merge(branches: list[tuple[int, list[Change]]], ctx: Context, now: datetime) -> list[Change]:
    taken = list(ctx.blocks)
    out: list[Change] = []
    for _, changes in sorted(branches, key=lambda b: b[0]):
        for c in changes:
            is_new_task = isinstance(c, AddItem) and c.block.block_kind == "task" and c.block.placed_by == "planner"

            if is_new_task:
                blk = c.block
                if not _overlaps_new(blk, taken):
                    out.append(c)
                    if blk.start and blk.end:
                        taken.append(BlockRow(blk.id, blk.day, blk.start, blk.end, BLOCK_TENTATIVE, blk.title, goal_id=blk.goal_id))
                    continue
                # Lost the slot: re-place
                windows = free_windows(replace(ctx, blocks=tuple(taken) + pad_after(taken)), now, days=DAY_WINDOW_WEEKS * 7)
                need = _hours_new(blk)
                picks = first_fit(need, windows)
                if validate_picks(picks, need, windows):
                    continue  # nothing free: keep it undated
                for new_item in picks_to_task_blocks(picks, windows, blk.title, goal_id=blk.goal_id, milestone_id=blk.milestone_id, effort_hours=blk.effort_hours, description=blk.description, why=blk.why):
                    new_item.block.id = new_id("task")
                    out.append(new_item)
                    if new_item.block.start and new_item.block.end:
                        taken.append(BlockRow(new_item.block.id, new_item.block.day, new_item.block.start, new_item.block.end, BLOCK_TENTATIVE, new_item.block.title, goal_id=new_item.block.goal_id))
            else:
                out.append(c)
    return out
