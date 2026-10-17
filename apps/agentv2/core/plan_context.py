"""The live plan as the coach reads it: this month, this week and today, per goal. Pure.

The same block serves the coach chat (`coach_context`) and the review/re-plan chat (`chatplan`),
so both answer from the plan the user can actually see. It is rendered from `Context`: the plan
rows (`plan_weeks`, `plan_months`) and the four-kind task blocks (`items`), including a quota's
per-day done counts.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from .calendar import week_start
from .context import Context

HEADER_THIS_MONTH = "THIS MONTH, BY GOAL:"
HEADER_THIS_WEEK = "THIS WEEK, BY GOAL:"
HEADER_TODAY_PLAN = "TODAY'S GOAL WORK:"

#: Home of the plan context for a chat turn. A review chat needs to know what was already committed.
PLAN_BLOCK_HEADER = "THE PLAN SO FAR (already committed; review it, do not silently duplicate it):"


def _is_done(blk) -> bool:
    return bool(getattr(blk, "done", False)) or getattr(blk, "state", "open") == "done"


def _on_day(blk, day: date) -> bool:
    """Whether a repeated task block falls on `day`: inside its weekday set and its date span."""
    repeat = getattr(blk, "repeat", None)
    if repeat is None:
        return blk.day == day
    first = blk.day
    if first is not None and day < first:
        return False
    if repeat.until is not None and day > repeat.until:
        return False
    return day.weekday() in repeat.weekdays


def _done_hours(ctx: Context, goal_id: str, start: date, end: date) -> float:
    """Hours of a goal's work finished between `start` and `end`, quotas counted per done instance."""
    total = 0.0
    for blk in ctx.items.values():
        if blk.block_kind != "task" or blk.goal_id != goal_id:
            continue
        effort = blk.effort_hours or 0.0
        if blk.quota:
            for iso, count in (blk.quota_done or {}).items():
                try:
                    d = date.fromisoformat(iso)
                except ValueError:
                    continue
                if start <= d <= end:
                    total += effort * min(count, blk.quota) / blk.quota
        elif _is_done(blk) and blk.day is not None and start <= blk.day <= end:
            total += effort
    return total


def _outcomes_text(outcomes) -> str:
    return "; ".join(o for o in outcomes if o)


def _month_line(row, done: float) -> str:
    parts = [f'- {row.goal_title}: “{row.focus}”'] if row.focus else [f"- {row.goal_title}:"]
    if row.outcomes:
        parts.append(f"outcomes: {_outcomes_text(row.outcomes)}")
    parts.append(f"{row.hours:g}h planned, {done:g}h done this month")
    return "; ".join(parts)


def _week_line(row, done: float) -> str:
    parts = [f'- {row.goal_title}: “{row.focus}”'] if row.focus else [f"- {row.goal_title}:"]
    if row.outcomes:
        parts.append(f"outcomes: {_outcomes_text(row.outcomes)}")
    parts.append(f"{row.hours:g}h planned, {done:g}h done this week")
    return "; ".join(parts)


def _item_line(blk, today: date) -> str:
    """One of today's tasks, timed or untimed; a quota carries how many instances are done."""
    effort = blk.effort_hours or 0.0
    if blk.quota:
        done = int((blk.quota_done or {}).get(today.isoformat(), 0))
        each = round(effort * 60 / blk.quota) if blk.quota else 0
        return f"- {blk.title}: {done} of {blk.quota} done today" + (f", about {each} min each" if each else "")
    if blk.start is not None and blk.end is not None:
        line = f"- {blk.start:%H:%M}-{blk.end:%H:%M} {blk.title}"
    else:
        line = f"- {blk.title}"
    if effort:
        line += f" ({effort:g}h)"
    if _is_done(blk):
        line += " — done"
    return line


def plan_sections(ctx: Context, now: datetime) -> list[str]:
    """Header + lines for THIS MONTH, THIS WEEK and TODAY. Empty sections are left out."""
    today = now.date()
    month_start = today.replace(day=1)
    monday = week_start(today)
    titles = ctx.goal_titles
    goal_ids = sorted({r.goal_id for r in ctx.plan_months} | {r.goal_id for r in ctx.plan_weeks}
                      | {b.goal_id for b in ctx.items.values() if b.block_kind == "task" and b.goal_id},
                      key=lambda g: titles.get(g, g))
    sections: list[str] = []

    month_lines = [
        _month_line(r, _done_hours(ctx, r.goal_id, month_start, today))
        for g in goal_ids for r in ctx.plan_months
        if r.goal_id == g and r.month_start == month_start
    ]
    if month_lines:
        sections += [HEADER_THIS_MONTH, *month_lines]

    week_end = monday + timedelta(days=6)
    week_lines = [
        _week_line(r, _done_hours(ctx, r.goal_id, monday, week_end))
        for g in goal_ids for r in ctx.plan_weeks
        if r.goal_id == g and r.week_start == monday
    ]
    if week_lines:
        sections += [HEADER_THIS_WEEK, *week_lines]

    today_lines = [
        line for g in goal_ids
        for line in (_item_line(b, today) for b in ctx.items.values()
                     if b.block_kind == "task" and b.goal_id == g and _on_day(b, today))
    ]
    if today_lines:
        sections += [HEADER_TODAY_PLAN, *today_lines]
    return sections


def plan_block(ctx: Context, now: datetime) -> str:
    """The same sections as one string, for a prompt that has a single plan field."""
    return "\n".join(plan_sections(ctx, now))
