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
from ..contracts import Change
from ..contracts.blocks import AddItem, Repeat, TaskBlock
from ..contracts.planner import DAY_ITEM_FOCUS, DayItem, DayPlan, GoalSpec
from ..core.budget import check_allocation, even_split
from ..core.calendar import free_hours_by_day, windows_on
from ..core.context import BlockRow, Context
from ..core.ids import new_id
from ..core.slots import busy_by_day, pad_after, validate_picks
from ..llm import complete_json
from ..contracts.planner import SessionPlan
from ..prompts.planner import DAY_SYSTEM, SESSION_SLOT_SYSTEM, day_user, session_slot_user
from .week import WeekAlloc

DAY_PREFIX = "d_"
#: The kinds a day item can be (contracts.planner.DayItemKind).
KIND_FOCUS = DAY_ITEM_FOCUS  # "focus"
KIND_QUOTA = "quota"
KIND_MULTI_DAY = "multi_day"
MINUTES_PER_HOUR = 60


def _week_day_id(week: date, weekday: int) -> str:
    """The day id of `weekday` (Monday = 0) inside `week`."""
    return f"{DAY_PREFIX}{(week + timedelta(days=weekday)).isoformat()}"


def _day_id_date(day_id: str) -> date | None:
    try:
        return date.fromisoformat(day_id[len(DAY_PREFIX):])
    except ValueError:
        return None


def _quota_effort(item: DayItem) -> float:
    """The hours one day of a quota holds: count × minutes each."""
    return round(item.count * item.minutes_each / MINUTES_PER_HOUR, 2)


def _per_day_effort(item: DayItem, week: date) -> dict[str, float]:
    """How many hours the item asks of each day it touches. The week-level check adds these up."""
    if item.kind == KIND_QUOTA:
        each = _quota_effort(item)
        return {_week_day_id(week, wd): each for wd in dict.fromkeys(item.weekdays)}
    if item.kind == KIND_MULTI_DAY:
        days = list(dict.fromkeys(item.days))
        return {d: item.hours / len(days) for d in days} if days and item.hours > 0 else {}
    return {item.day_id: item.hours}


def _item_problem(item: DayItem, week: date) -> str | None:
    """What is malformed about an item's kind and its own numbers, before the day budgets are checked."""
    if item.kind == KIND_QUOTA:
        if item.count < 1:
            return f"{item.title}: a quota needs a count of at least 1"
        if item.minutes_each <= 0:
            return f"{item.title}: a quota needs minutes_each above 0"
        if not item.weekdays:
            return f"{item.title}: a quota needs at least one weekday"
        if any(not 0 <= d <= 6 for d in item.weekdays):
            return f"{item.title}: quota weekdays must be Monday to Sunday"
    if item.kind == KIND_MULTI_DAY:
        if not item.days:
            return f"{item.title}: a multi-day item needs at least one day"
        if item.hours <= 0:
            return f"{item.title}: a multi-day item needs hours"
        week_days = {week + timedelta(days=i) for i in range(7)}
        for d in item.days:
            when = _day_id_date(d)
            if when is None or when not in week_days:
                return f"{item.title}: {d} is not in this week"
    if item.kind == KIND_FOCUS and _day_id_date(item.day_id) is None:
        return f"{item.title}: {item.day_id} is not a day id"
    return None


def _keeps(item: DayItem) -> bool:
    """Whether an item in an accepted reply is worth writing. A zero-hour focus session is not;
    a quota's effort is derived and a multi-day item was already checked for hours."""
    return item.kind != KIND_FOCUS or item.hours > 0


def _room(ctx: Context, day: date) -> float:
    """What is left of the user's hours for `day` after what is already planned on it."""
    planned = sum((datetime.combine(day, b.end) - datetime.combine(day, b.start)).total_seconds() / 3600
                  for b in ctx.blocks if b.day == day and b.status == BLOCK_TENTATIVE)
    # Untimed planner work (a quota, a multi-day item) uses hours without holding a clock slot.
    return max(0.0, ctx.capacity_on(day) - planned - ctx.untimed_hours_by_day.get(day, 0.0))


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

    items: list[DayItem] | None = None
    problem: str | None = feedback
    for _ in range(1 + FIX_MAX_LOOPS):
        plan = complete_json(chat, DAY_SYSTEM, day_user(goal.title, wk.focus, wk.hours, listed, problem, wk.milestones), DayPlan)
        if plan is None:
            break
        per_day: dict[str, float] = {}
        problems = [p for p in (_item_problem(s, wk.week) for s in plan.sessions) if p]
        for s in plan.sessions:
            for day_id, hours in _per_day_effort(s, wk.week).items():
                per_day[day_id] = per_day.get(day_id, 0.0) + hours
        problem = problems[0] if problems else check_allocation(per_day, cap, wk.hours)
        short = [s.title for s in plan.sessions if s.kind == KIND_FOCUS and 0 < s.hours < MIN_SESSION_HOURS]
        if problem is None and short:
            problem = f"focus sessions must be at least {MIN_SESSION_HOURS:g}h; too short: {short[0]}"
        if problem is None:
            items = [s for s in plan.sessions if _keeps(s)]
            break
    how = "model"
    if items is None:
        how = "even_split"
        # The code fallback knows one shape only: timed focus sessions.
        items = [DayItem(day_id=did, title=wk.focus, hours=h, kind=KIND_FOCUS) for did, h in even_split(wk.hours, cap).items()]

    # Only a focus item gets a time on the clock; a quota and a multi-day item are done any time.
    focus = [(s.day_id, s.title, s.hours, s.description, s.why, s.milestone) for s in items if s.kind == KIND_FOCUS]
    placed: list | None = []
    if focus:
        placed, slot_problem = _model_slots(chat, goal, focus, ctx, now)
        if placed is None:
            how += f"; times not placed ({slot_problem or 'no reply'})"
    gap_ctx = ctx  # placement view only: the real ctx never gets the gap padding
    untimed = dict(ctx.untimed_hours_by_day)  # the load this week's items add, for later weeks/goals
    changes: list[Change] = []
    milestone_ids = {m.title: m.id for m in goal.milestones if m.id}
    focus_i = 0
    for item in items:
        milestone_id = milestone_ids.get(item.milestone)
        if item.kind == KIND_FOCUS:
            placement = placed[focus_i] if placed is not None else None
            focus_i += 1
        else:
            placement = None
        changes.append(_four_kind_change(goal, item, placement, milestone_id, wk.week))
        rows = _placed_rows(changes[-1])
        ctx = replace(ctx, blocks=ctx.blocks + rows)
        # Untimed items hold no clock slot, but they do use the user's hours: record what this
        # item asks of each day so the next week (or goal) in the run sees it as taken.
        if item.kind != KIND_FOCUS:
            for day_id, hours in _per_day_effort(item, wk.week).items():
                day = _day_id_date(day_id)
                if day is not None:
                    untimed[day] = untimed.get(day, 0.0) + hours
            ctx = replace(ctx, untimed_hours_by_day=untimed)
        # The next session may not start until the gap has passed.
        gap_ctx = replace(gap_ctx, blocks=gap_ctx.blocks + rows + pad_after(rows))
    return changes, ctx, how


def _four_kind_change(goal: GoalSpec, item: DayItem, placement, milestone_id: str | None, week: date) -> AddItem:
    """One 4-kind change for a day item: a timed focus session, or an untimed quota / multi-day task."""
    if item.kind == KIND_QUOTA:
        days = sorted(set(item.weekdays))
        return AddItem(block=TaskBlock(
            id=new_id("task"), title=item.title, goal_id=goal.id, day=week + timedelta(days=days[0]),
            repeat=Repeat(weekdays=days, until=week + timedelta(days=days[-1])),
            quota=item.count, effort_hours=_quota_effort(item),
            description=item.description, why=item.why, milestone_id=milestone_id, placed_by="planner",
        ))
    if item.kind == KIND_MULTI_DAY:
        dates = sorted({_day_id_date(d) for d in item.days})
        return AddItem(block=TaskBlock(
            id=new_id("task"), title=item.title, goal_id=goal.id, day=dates[0],
            repeat=Repeat(weekdays=sorted({d.weekday() for d in dates}), until=dates[-1]),
            effort_hours=item.hours,
            description=item.description, why=item.why, milestone_id=milestone_id, placed_by="planner",
        ))
    # §4b: One TaskBlock, placed or unplaced.
    # Placed: has day/start/end. Unplaced: has day but no start/end.
    block = TaskBlock(
        id=new_id("task"), title=item.title, goal_id=goal.id, day=date.fromisoformat(item.day_id[len(DAY_PREFIX):]),
        effort_hours=item.hours, description=item.description, why=item.why,
        milestone_id=milestone_id, placed_by="planner",
    )
    if placement is not None:
        window, offset, slot_why = placement
        begin = _clock(window.day, window.start) + timedelta(minutes=offset)
        block.day = window.day
        block.start = begin.time()
        block.end = (begin + timedelta(hours=item.hours)).time()
        block.why = slot_why
    return AddItem(block=block)


def _placed_rows(change: AddItem) -> tuple[BlockRow, ...]:
    """The timed rows a new item adds to the calendar view, for the next week's placement search."""
    block = change.block
    if block.start is None or block.end is None:
        return ()  # untimed work holds no hours on the clock
    return (BlockRow(block.id, block.day, block.start, block.end, BLOCK_TENTATIVE, block.title, goal_id=block.goal_id),)
