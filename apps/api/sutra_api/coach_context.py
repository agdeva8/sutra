"""The live-state block the chat coach reads: everything it needs to plan for *this* user.

Assembled per turn by `/chat/stream` (`api/chat.py`). It carries the user's own words about their
week (the profile), the free hours the planner will actually have, the fixed commitments in the
coming weeks, the goals in flight, durable facts the coach has learned, and goals that were paused or
dropped. The last group is labelled as neutral facts on purpose: the guardrails in
`agentv2.coach.prompts` forbid using history to judge the user, and the label is where that starts.

The DB reads are in `build_coach_context`; the formatting is in pure functions so it is testable.
Limits are generous (CLAUDE.md principle 6): they bound a query, not what the coach is allowed to know.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from agentv2.config import BLOCK_TENTATIVE
from agentv2.core.calendar import free_hours_by_week, week_start
from agentv2.core.context import Context
from agentv2.core.plan_context import plan_sections
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .agent_store import KIND_TENTATIVE, SOURCE_RECURRING, SqlStore
from .models import CalendarBlock, RecurringBlock, TimetableBlock, User, UserFact
from .profile import profile_lines
from .store import repo

#: Weeks ahead the coach sees free hours and fixed commitments for.
CONTEXT_WEEKS_AHEAD = 4
#: Upper bounds on each list. Generous: they keep a pathological account from flooding the prompt.
MAX_GOALS = 100
MAX_MILESTONES = 200
MAX_PLAN_ITEMS = 300
MAX_OVERDUE_LINES = 20
MAX_IN_FLIGHT_LINES = 30
MAX_COMMITMENT_LINES = 80
MAX_FACTS = 60
MAX_INACTIVE_GOALS = 30
GOAL_ACTIVE = "active"
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

HEADER_PROFILE = "ABOUT THE USER (they told us this once; do not ask it again):"
HEADER_PROFILE_EMPTY = "ABOUT THE USER: not given. Do not assume their hours; ask about time only if the plan depends on it."
HEADER_HOURS = "TIME AVAILABLE FOR GOALS (by week, from their calendar and profile):"
HEADER_COMMITMENTS = f"FIXED COMMITMENTS, next {CONTEXT_WEEKS_AHEAD} weeks (never plan over these):"
HEADER_TODAY = "TODAY'S TIMETABLE (already on the calendar; keep it, plan around it):"
HEADER_RECURRING = "RECURRING COMMITMENTS:"
HEADER_GOALS = "ACTIVE GOALS:"
HEADER_OVERDUE = "OVERDUE MILESTONES:"
HEADER_IN_FLIGHT = "IN FLIGHT:"
HEADER_FACTS = "WHAT THE COACH HAS LEARNED ABOUT THEM:"
HEADER_INACTIVE = (
    "PAUSED OR DROPPED GOALS (neutral facts. Never mention them to judge or warn; use one only if it "
    "changes this plan, and then without counting or blaming):"
)
NO_ACTIVE_GOALS = "No active goals yet."


@dataclass
class WeekHours:
    monday: date
    free: float
    capacity: float
    planned: float

    @property
    def left(self) -> float:
        return max(0.0, min(self.free, self.capacity) - self.planned)


@dataclass
class CoachFacts:
    """Everything the block is rendered from. Plain data, so `render` is pure."""

    today: date
    profile: dict = field(default_factory=dict)
    weeks: list[WeekHours] = field(default_factory=list)
    commitments: list[tuple[date, time, time, str]] = field(default_factory=list)
    #: Everything on today's calendar, planner-placed prep sessions included (`commitments` leaves those out).
    today_blocks: list[tuple[time, time, str]] = field(default_factory=list)
    recurring: list[tuple[str, list[int], time, time]] = field(default_factory=list)
    goals: list[str] = field(default_factory=list)
    #: THIS MONTH / THIS WEEK / TODAY per goal: focus, outcomes, hours planned and done, today's items.
    plan: list[str] = field(default_factory=list)
    overdue: list[str] = field(default_factory=list)
    in_flight: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    inactive: list[str] = field(default_factory=list)


def week_hours(ctx: Context, now: datetime, n_weeks: int = CONTEXT_WEEKS_AHEAD) -> list[WeekHours]:
    """Free calendar hours, goal capacity and already-planned hours per week, from today."""
    free = free_hours_by_week(ctx, now, n_weeks)
    out: list[WeekHours] = []
    for monday, hours in free.items():
        days = [monday + timedelta(days=i) for i in range(7)]
        days = [d for d in days if d >= now.date() and d not in ctx.blocked_dates]
        capacity = sum(ctx.capacity_on(d) for d in days)
        planned = sum(
            (datetime.combine(b.day, b.end) - datetime.combine(b.day, b.start)).total_seconds() / 3600
            for b in ctx.blocks if b.status == BLOCK_TENTATIVE and b.day in days
        )
        planned += sum(w.hours for w in ctx.plan_weeks if w.week_start == monday
                       and not any((w.goal_id, monday) == e for e in ctx.expanded_weeks))
        out.append(WeekHours(monday, hours, capacity, planned))
    return out


def render(f: CoachFacts) -> str:
    lines: list[str] = [f"Today is {f.today.isoformat()} ({DAY_NAMES[f.today.weekday()]})."]
    about = profile_lines(f.profile)
    lines.append("")
    lines.append(HEADER_PROFILE if about else HEADER_PROFILE_EMPTY)
    lines.extend(about)
    if f.weeks:
        lines += ["", HEADER_HOURS]
        lines += [
            f"- Week of {w.monday:%d %b}: {w.free:.0f}h free in the calendar, goal capacity {w.capacity:.0f}h, "
            f"{w.planned:.0f}h already planned, about {w.left:.0f}h left for a new goal"
            for w in f.weeks
        ]
    if f.today_blocks:
        lines += ["", HEADER_TODAY]
        lines += [f"- {s:%H:%M}-{e:%H:%M} {label}" for s, e, label in f.today_blocks[:MAX_COMMITMENT_LINES]]
    if f.recurring:
        lines += ["", HEADER_RECURRING]
        lines += [f"- {t}: {', '.join(DAY_NAMES[d] for d in days if 0 <= d < 7)} {s:%H:%M}-{e:%H:%M}"
                  for t, days, s, e in f.recurring]
    if f.commitments:
        lines += ["", HEADER_COMMITMENTS]
        lines += [f"- {d:%a %d %b} {s:%H:%M}-{e:%H:%M} {label}" for d, s, e, label in f.commitments[:MAX_COMMITMENT_LINES]]
    if f.goals:
        lines += ["", HEADER_GOALS, *f.goals]
    else:
        lines += ["", NO_ACTIVE_GOALS]
    if f.plan:
        lines += ["", *f.plan]
    if f.overdue:
        lines += ["", HEADER_OVERDUE, *f.overdue[:MAX_OVERDUE_LINES]]
    if f.in_flight:
        lines += ["", HEADER_IN_FLIGHT, *f.in_flight[:MAX_IN_FLIGHT_LINES]]
    if f.facts:
        lines += ["", HEADER_FACTS, *(f"- {x}" for x in f.facts[:MAX_FACTS])]
    if f.inactive:
        lines += ["", HEADER_INACTIVE, *f.inactive[:MAX_INACTIVE_GOALS]]
    return "\n".join(lines)


async def build_coach_context(session: AsyncSession, *, user_id: str, now: datetime) -> str:
    from agentv2.contracts.blocks import BLOCK_ADAPTER
    from agentv2.core.recurring import occurrences as _occurrences
    from agentv2.config import RECURRING_HORIZON_DAYS

    today = now.date()
    user = await session.get(User, user_id)
    goals = await repo.list_goals(session, user_id=user_id, limit=MAX_GOALS)
    milestones = await repo.list_milestones(session, user_id=user_id, limit=MAX_MILESTONES)
    items = await repo.list_plan_items(session, user_id=user_id, limit=MAX_PLAN_ITEMS)
    ctx = await SqlStore(session, user_id, today=today).context()

    until = today + timedelta(weeks=CONTEXT_WEEKS_AHEAD)
    facts = (await session.execute(
        select(UserFact.fact).where(UserFact.user_id == user_id)
        .order_by(UserFact.confidence.desc(), UserFact.updated_at.desc()).limit(MAX_FACTS)
    )).scalars().all()

    # Phase 5: Read calendar_blocks exclusively
    cal_blocks = (await session.execute(
        select(CalendarBlock).where(CalendarBlock.user_id == user_id)
    )).scalars().all()

    cal_fixed: list[tuple[date, time, time, str]] = []
    cal_today: list[tuple[time, time, str]] = []
    cal_recurring: list[tuple[str, list[int], time, time]] = []

    for row in cal_blocks:
        try:
            blk = BLOCK_ADAPTER.validate_python(row.data)
        except Exception:
            continue
        bk = blk.block_kind
        if bk == "event":
            if blk.repeat and blk.start and blk.end:
                # Add to recurring list
                cal_recurring.append((blk.title, list(blk.repeat.weekdays), blk.start, blk.end))
                # Expand and add to fixed commitments
                occs = _occurrences(
                    tuple(blk.repeat.weekdays), blk.start, blk.end,
                    blk.day, blk.repeat.until, today, RECURRING_HORIZON_DAYS
                )
                for occ_day, occ_start, occ_end in occs:
                    if today <= occ_day < until:
                        cal_fixed.append((occ_day, occ_start, occ_end, blk.title))
                    if occ_day == today:
                        cal_today.append((occ_start, occ_end, blk.title))
            elif blk.start and blk.end:
                if blk.day >= today and blk.day < until:
                    cal_fixed.append((blk.day, blk.start, blk.end, blk.title))
                if blk.day == today:
                    cal_today.append((blk.start, blk.end, blk.title))
        elif bk == "task":
            # Tasks are shown in today_blocks if they have a time
            if blk.start and blk.end and blk.day == today:
                cal_today.append((blk.start, blk.end, blk.title))

    active = [g for g in goals if g.status == GOAL_ACTIVE]
    inactive = sorted((g for g in goals if g.status != GOAL_ACTIVE), key=lambda g: g.updated_at or g.created_at, reverse=True)
    return render(CoachFacts(
        today=today,
        profile=dict(user.profile or {}) if user else {},
        weeks=week_hours(ctx, now),
        commitments=cal_fixed,
        today_blocks=cal_today,
        recurring=cal_recurring,
        goals=[
            f"- {g.title} ({g.horizon})"
            + (f" -> {g.target_date}" if g.target_date else "")
            + (f", {g.weekly_hours}h/week" if g.weekly_hours else "")
            for g in active
        ],
        plan=plan_sections(ctx, now),
        overdue=[f"- {m.title} (was due {m.target_date})" for m in milestones
                 if m.target_date and m.target_date < today and m.status != "done"],
        in_flight=[f"- {i.title} ({i.start_date})" for i in items
                   if i.horizon in ("daily", "weekly") and i.status != "done" and i.start_date],
        facts=list(facts),
        inactive=[f"- {g.title}: {g.status}" for g in inactive],
    ))
