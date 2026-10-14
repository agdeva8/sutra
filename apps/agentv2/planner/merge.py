"""Merge branches that each planned from the same snapshot. Pure.

Two goals planned in parallel can pick the same slot. The higher-priority branch
(lower number) keeps it; the loser's block is re-placed in the next free window,
or dropped to undated work if nothing is free.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime

from ..config import BLOCK_TENTATIVE, DAY_WINDOW_WEEKS
from ..contracts import AddBlock, Change
from ..core.context import BlockRow, Context
from ..core.ids import new_id
from ..core.slots import first_fit, free_windows, pad_after, picks_to_blocks, validate_picks


def _overlaps(a: AddBlock, taken: list[BlockRow]) -> bool:
    return any(t.day == a.day and a.start < t.end and t.start < a.end for t in taken)


def _hours(b: AddBlock) -> float:
    return (b.end.hour * 60 + b.end.minute - b.start.hour * 60 - b.start.minute) / 60


def merge(branches: list[tuple[int, list[Change]]], ctx: Context, now: datetime) -> list[Change]:
    taken = list(ctx.blocks)
    out: list[Change] = []
    for _, changes in sorted(branches, key=lambda b: b[0]):
        for c in changes:
            if not (isinstance(c, AddBlock) and c.status == BLOCK_TENTATIVE and _overlaps(c, taken)):
                out.append(c)
                if isinstance(c, AddBlock):
                    taken.append(BlockRow(c.id, c.day, c.start, c.end, c.status, c.title))
                continue
            # Lost the slot: re-place the same hours in what is still free.
            windows = free_windows(replace(ctx, blocks=tuple(taken) + pad_after(taken)), now, days=DAY_WINDOW_WEEKS * 7)
            need = _hours(c)
            picks = first_fit(need, windows)
            if validate_picks(picks, need, windows):
                continue  # nothing free: the task stays as undated work
            for b in picks_to_blocks(picks, windows, c.title, task_id=c.task_id, goal_id=c.goal_id):
                b = b.model_copy(update={"id": new_id("blk")})
                out.append(b)
                taken.append(BlockRow(b.id, b.day, b.start, b.end, b.status, b.title))
    return out
