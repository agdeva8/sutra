"""Free windows and placement. Pure.

Code lists the free windows; the model picks among them by id; code turns a pick
into a block. `first_fit` is both the fallback when the model's pick is unusable
and the shape later planner levels will reuse.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from ..config import (
    SLOT_GRID_MINUTES, PROFILE_WORK_LABEL,
    BLOCK_COMMITTED, BLOCK_TENTATIVE, EFFORT_TOLERANCE_HOURS,
    MIN_GAP_BETWEEN_SESSIONS_MIN, MIN_WINDOW_MINUTES, SLOT_WINDOW_DAYS,
)
from ..contracts import AddBlock
from .context import BlockRow, Context
from .ids import new_id

_MIN = 60.0


def picks_to_task_blocks(picks: list[Pick], windows: list[Window], title: str, *, goal_id: str | None = None, milestone_id: str | None = None, effort_hours: float | None = None, description: str = "", why: str = "") -> list:
    """Turn window picks into TaskBlocks for the new 4-kind path."""
    from ..contracts.blocks import AddItem, TaskBlock
    by_id = {w.id: w for w in windows}
    blocks = []
    for wid, hours, offset in picks:
        w = by_id[wid]
        begin = _at(w.day, w.start) + timedelta(minutes=offset)
        end = begin + timedelta(hours=hours)
        blocks.append(AddItem(block=TaskBlock(
            id=new_id("task"), title=title, day=w.day, start=begin.time(), end=end.time(),
            goal_id=goal_id, milestone_id=milestone_id, effort_hours=hours if effort_hours is None else effort_hours,
            description=description, why=why, placed_by="planner"
        )))
    return blocks


@dataclass(frozen=True)
class Window:
    id: str
    day: date
    start: time
    end: time

    @property
    def hours(self) -> float:
        a = datetime.combine(self.day, self.start)
        return (datetime.combine(self.day, self.end) - a).total_seconds() / 3600


def _at(day: date, t: time) -> datetime:
    return datetime.combine(day, t)


def _day_rows(ctx: Context, day: date) -> list[BlockRow]:
    """The day's blocks plus the user's weekly work or study hours, as fixed rows."""
    rows = [b for b in ctx.blocks if b.day == day]
    rows += [BlockRow(f"work_{day.isoformat()}_{s:%H%M}", day, s, e, BLOCK_COMMITTED, PROFILE_WORK_LABEL)
             for s, e in ctx.busy_weekly.get(day.weekday(), ())]
    return sorted(rows, key=lambda b: b.start)


def free_windows(ctx: Context, now: datetime, days: int = SLOT_WINDOW_DAYS) -> list[Window]:
    """Free gaps inside the user's waking hours for the next `days` days (today from `now`)."""
    out: list[Window] = []
    for offset in range(days):
        day = now.date() + timedelta(days=offset)
        if day in ctx.blocked_dates:
            continue  # the user is away: zero capacity
        rows = _day_rows(ctx, day)
        for span_start, span_end in ctx.active_spans:
            lo, hi = _at(day, span_start), _at(day, span_end)
            if offset == 0:
                # Round up to the next half hour so we never offer a slot that has started.
                minutes = (now.hour * 60 + now.minute + 29) // 30 * 30
                lo = max(lo, datetime.combine(day, time()) + timedelta(minutes=minutes))
            cursor = lo
            for b in rows:
                bs, be = _at(day, b.start), _at(day, b.end)
                if bs > cursor:
                    _emit(out, day, cursor, min(bs, hi))
                cursor = max(cursor, be)
            if cursor < hi:
                _emit(out, day, cursor, hi)
    return out


def _emit(out: list[Window], day: date, a: datetime, b: datetime) -> None:
    if (b - a).total_seconds() / _MIN >= MIN_WINDOW_MINUTES:
        out.append(Window(id=f"w_{day.isoformat()}_{a:%H%M}", day=day, start=a.time(), end=b.time()))


#: A choice of where to put (part of) a task: (window id, hours, minutes after the window opens).
Pick = tuple[str, float, int]


def first_fit(effort_hours: float, windows: list[Window]) -> list[Pick]:
    """Fill windows in order, each from its start. The fallback when the model's pick is unusable."""
    left, picks = effort_hours, []
    for w in windows:
        if left <= 0:
            break
        take = min(left, w.hours)
        picks.append((w.id, take, 0))
        left -= take
    return picks


def validate_picks(picks: list[Pick], effort_hours: float, windows: list[Window]) -> str | None:
    """None if usable; otherwise why not."""
    by_id = {w.id: w for w in windows}
    seen: set[str] = set()
    total = 0.0
    for wid, hours, offset in picks:
        w = by_id.get(wid)
        if w is None:
            return f"window {wid} was not offered"
        if wid in seen:
            return f"window {wid} used twice"
        seen.add(wid)
        if hours <= 0:
            return f"{hours}h is not a length"
        if offset < 0 or offset % SLOT_GRID_MINUTES:
            return f"start offset {offset} is not on the {SLOT_GRID_MINUTES}-minute grid"
        if offset + hours * 60 > w.hours * 60 + 1e-6:
            return f"{hours}h starting {offset} min in does not fit window {wid} ({w.hours:g}h)"
        total += hours
    if abs(total - effort_hours) > EFFORT_TOLERANCE_HOURS:
        return f"placed {total}h but the task needs {effort_hours}h"
    return None


def picks_to_blocks(picks: list[Pick], windows: list[Window], title: str, *, task_id: str | None = None, goal_id: str | None = None, why: str = "") -> list[AddBlock]:
    by_id = {w.id: w for w in windows}
    blocks = []
    for wid, hours, offset in picks:
        w = by_id[wid]
        begin = _at(w.day, w.start) + timedelta(minutes=offset)
        end = begin + timedelta(hours=hours)
        blocks.append(AddBlock(id=new_id("blk"), title=title, day=w.day, start=begin.time(), end=end.time(), status=BLOCK_TENTATIVE, task_id=task_id, goal_id=goal_id, why=why))
    return blocks


def pad_after(rows) -> tuple[BlockRow, ...]:
    """A short "gap" row after each planned (tentative) block, so a window search leaves breathing room.
    Used only to search for windows; these rows are never written."""
    out = []
    for r in rows:
        if r.status != BLOCK_TENTATIVE:
            continue
        end = datetime.combine(r.day, r.end) + timedelta(minutes=MIN_GAP_BETWEEN_SESSIONS_MIN)
        out.append(BlockRow(r.id + "_gap", r.day, r.end, end.time() if end.date() == r.day else time(23, 59), BLOCK_TENTATIVE, "gap"))
    return tuple(out)


def busy_by_day(ctx: Context, now: datetime, days: int = SLOT_WINDOW_DAYS) -> dict[date, list[tuple[time, time, str, str]]]:
    """The occupied time per day: (start, end, title, "fixed" | "planned"). What the model needs to see to
    judge a day, for instance to leave room after a heavy block instead of stacking."""
    out: dict[date, list[tuple[time, time, str, str]]] = {}
    last = now.date() + timedelta(days=days)
    for offset in range(days):
        day = now.date() + timedelta(days=offset)
        if day >= last:
            break
        for b in _day_rows(ctx, day):
            out.setdefault(b.day, []).append((b.start, b.end, b.title or "busy", "fixed" if b.status == BLOCK_COMMITTED else "planned"))
    return out
