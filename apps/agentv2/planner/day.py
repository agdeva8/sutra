"""Day level: break one week's hours into sessions on days, then into real blocks.

The model picks days from the list code offers and code checks each day's free
hours. The model then picks each session's time inside the day's free windows, retried with
the exact problem if it breaks a rule. There is no mechanical fallback: a session that still
cannot be placed stays on its day, unscheduled.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime, time, timedelta

from ..config import BLOCK_TENTATIVE, FIX_MAX_LOOPS, MAX_GOAL_HOURS_PER_DAY, MIN_GAP_BETWEEN_SESSIONS_MIN, MIN_SESSION_HOURS
from ..contracts import AddBlock, AddTask, Change
from ..contracts.planner import DayPlan, GoalSpec
from ..core.budget import check_allocation, even_split
from ..core.calendar import free_hours_by_day, windows_on
from ..core.context import BlockRow, Context
from ..core.ids import new_id
from ..core.slots import busy_by_day, pad_after, picks_to_blocks, validate_picks
from ..llm import complete_json
from ..contracts.planner import SessionPlan
from ..prompts.planner import DAY_SYSTEM, SESSION_SLOT_SYSTEM, day_user, session_slot_user
from .week import WeekAlloc

DAY_PREFIX = "d_"


def _room(ctx: Context, day: date) -> float:
    """What is left of the user's hours for `day` after what is already planned on it."""
    planned = sum((datetime.combine(day, b.end) - datetime.combine(day, b.start)).total_seconds() / 3600
                  for b in ctx.blocks if b.day == day and b.status == BLOCK_TENTATIVE)
    return max(0.0, ctx.capacity_on(day) - planned)


def _clock(d: date, t) -> datetime:
    return datetime.combine(d, t)


def _model_slots(chat, goal: GoalSpec, sessions: list[tuple[str, str, float, str, str]], ctx: Context, now: datetime):
    """Let the model choose each session's time, seeing what is occupied. Returns one
    (window, offset) per session, or None if the reply is unusable in any way (the caller then
    falls back to first-fit, so a bad reply never loses a session)."""
    days = sorted({date.fromisoformat(d[len(DAY_PREFIX):]) for d, *_ in sessions})
    windows = {w.id: w for d in days for w in windows_on(ctx, now, d)}
    busy = busy_by_day(ctx, now, (days[-1] - now.date()).days + 1) if days else {}
    blocks = []
    for d in days:
        occupied = ", ".join(f"{s:%H:%M}-{e:%H:%M} {t} ({k})" for s, e, t, k in busy.get(d, [])) or "nothing"
        free = ", ".join(f"{w.id} ({w.start:%H:%M}-{w.end:%H:%M})" for w in windows.values() if w.day == d) or "none"
        blocks.append(f"{d:%a %d %b}: occupied: {occupied}. free windows: {free}")
    listed = "\n".join(f"- s{i}: {title}, {hours:g}h on {date.fromisoformat(did[len(DAY_PREFIX):]):%a %d %b}" for i, (did, title, hours, *_) in enumerate(sessions))
    problem: str | None = None
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, SESSION_SLOT_SYSTEM, session_slot_user(f"{now:%A %d %b %H:%M}", goal.title, "\n".join(blocks), listed, problem), SessionPlan)
        if plan is None:
            return None, "unreadable reply"
        result, problem = _check_slots(plan, sessions, windows)
        if result is not None:
            return result, None
    return None, problem


def _check_slots(plan: SessionPlan, sessions, windows):
    """(placements, None) if every session is placed legally with room around it; else (None, why)."""
    by_session = {p.session_id: p for p in plan.placements}
    out, taken = [], []
    for i, (did, _, hours, *_) in enumerate(sessions):
        p = by_session.get(f"s{i}")
        w = windows.get(p.window_id) if p else None
        if w is None or w.day != date.fromisoformat(did[len(DAY_PREFIX):]):
            return None, f"session s{i} needs a window on its own day"
        why = validate_picks([(w.id, hours, p.start_offset_min)], hours, [w])
        if why:
            return None, f"session s{i}: {why}"
        start = _clock(w.day, w.start) + timedelta(minutes=p.start_offset_min)
        end = start + timedelta(hours=hours)
        gap = timedelta(minutes=MIN_GAP_BETWEEN_SESSIONS_MIN)
        if any(start < e + gap and s < end + gap for s, e in taken):
            return None, f"session s{i} is too close to another session (leave {MIN_GAP_BETWEEN_SESSIONS_MIN} minutes between them) or overlaps it"
        taken.append((start, end))
        out.append((w, p.start_offset_min, p.why))
    return out, None


def plan_day_level(chat, goal: GoalSpec, wk: WeekAlloc, ctx: Context, now: datetime, feedback: str | None = None) -> tuple[list[Change], Context, str]:
    """(changes, ctx with the new blocks in it, how). `ctx` is returned so the next week/goal sees them."""
    free = free_hours_by_day(ctx, now, wk.week)
    # One goal may take at most MAX_GOAL_HOURS_PER_DAY of any day, however much is free.
    cap = {f"{DAY_PREFIX}{d.isoformat()}": min(h, MAX_GOAL_HOURS_PER_DAY, _room(ctx, d)) for d, h in free.items() if h > 0}
    cap = {k: v for k, v in cap.items() if v > 0}
    listed = "\n".join(f"- {did}: {h:g}h" for did, h in cap.items())

    sessions: list[tuple[str, str, float, str, str, str]] | None = None
    problem: str | None = feedback
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, DAY_SYSTEM, day_user(goal.title, wk.focus, wk.hours, listed, problem, wk.milestones), DayPlan)
        if plan is None:
            break
        per_day: dict[str, float] = {}
        for s in plan.sessions:
            per_day[s.day_id] = per_day.get(s.day_id, 0.0) + s.hours
        problem = check_allocation(per_day, cap, wk.hours)
        short = [s.title for s in plan.sessions if 0 < s.hours < MIN_SESSION_HOURS]
        if problem is None and short:
            problem = f"sessions must be at least {MIN_SESSION_HOURS:g}h; too short: {short[0]}"
        if problem is None:
            sessions = [(s.day_id, s.title, s.hours, s.description, s.why, s.milestone) for s in plan.sessions if s.hours > 0]
            break
    how = "model"
    if sessions is None:
        how = "even_split"
        sessions = [(did, wk.focus, h, "", "", "") for did, h in even_split(wk.hours, cap).items()]

    placed, slot_problem = _model_slots(chat, goal, sessions, ctx, now)
    if placed is None:
        how += f"; times not placed ({slot_problem or 'no reply'})"
    gap_ctx = ctx  # placement view only: the real ctx never gets the gap padding
    changes: list[Change] = []
    milestone_ids = {m.title: m.id for m in goal.milestones if m.id}
    for i, (day_id, title, hours, description, why, milestone) in enumerate(sessions):
        day = date.fromisoformat(day_id[len(DAY_PREFIX):])
        # The day travels with the task. Without it the row has no date, so the week and day views have
        # nowhere to draw it — the task existed but was invisible on every calendar.
        task = AddTask(id=new_id("task"), goal_id=goal.id, title=title, effort_hours=hours, day=day, description=description, why=why, milestone_id=milestone_ids.get(milestone))
        blocks: list[AddBlock] = []
        if placed is not None:
            window, offset, slot_why = placed[i]
            blocks = picks_to_blocks([(window.id, hours, offset)], [window], title, task_id=task.id, goal_id=goal.id, why=slot_why)
        changes.append(task)
        changes += blocks
        new_rows = tuple(BlockRow(b.id, b.day, b.start, b.end, BLOCK_TENTATIVE, b.title) for b in blocks)
        ctx = replace(ctx, blocks=ctx.blocks + new_rows)
        # The next session may not start until the gap has passed.
        gap_ctx = replace(gap_ctx, blocks=gap_ctx.blocks + new_rows + pad_after(new_rows))
    return changes, ctx, how
