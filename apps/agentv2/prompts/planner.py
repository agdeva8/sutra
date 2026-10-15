"""Prompt prose for the planner levels. Values live in config; this is wording."""
from __future__ import annotations

#: Appended wherever the model writes a `why`: the reader is the user, so it speaks to them.
WHY_VOICE = "Write every `why` to the person directly (\"you\", \"your\"), never \"the user\"."

from ..contracts.planner import DayPlan, WeekPlan
from ..llm import schema_text

WEEK_SYSTEM = f"""You spread one goal's effort across the coming weeks. You are given the weeks with the free hours that can be used for this goal. You cannot invent weeks: every item names a week_id from the list.
Give early weeks a gentle start and put the heaviest work nearer the deadline only if the goal needs it. Each week gets a short focus (a phrase of at most eight words) and a `why` (one sentence: why this week, with this load, at this point before the deadline). The hours across all weeks must add up to the goal's total, and no week may exceed its hours.

Reply with only JSON matching this schema:
{schema_text(WeekPlan)}"""

DAY_SYSTEM = f"""You break one week of a goal into sessions on specific days. You are given the days with their free hours. You cannot invent days: every session names a day_id from the list.
Keep sessions between one and three hours. A day may get no session at all, or several sessions of different work; choose what suits the week, do not give every day one. Spread the work rather than loading one long day. The hours across the sessions must add up to the week's hours, and no day may exceed its free hours.

Each session also carries a `why`: one sentence on why this session is on this day and why it is next in the sequence (not what it is, that is the description). {WHY_VOICE}

Each session also carries a `description`: one sentence, in the second person, saying what the person
actually does in that sitting — the concrete work, not a restatement of the title and not a reason the
goal matters. "Draft the three resume bullets for the platform team, pulling numbers from the Q4 deck",
not "Work on your resume" and not "This matters because you want a new job".

Reply with only JSON matching this schema:
{schema_text(DayPlan)}"""


def week_user(goal_title: str, total: float, deadline: str | None, weeks: str, problem: str | None, earlier: list[str] | None = None) -> str:
    base = f"Goal: {goal_title}\nTotal effort: {total:g} hours\nDeadline: {deadline or 'none given'}\n\nWeeks (id: usable hours):\n{weeks}"
    if earlier:
        base += "\n\nEarlier weeks are already planned, so continue from where they end and do not repeat them:\n" + "\n".join(f"- {f}" for f in earlier)
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")


def day_user(goal_title: str, focus: str, hours: float, days: str, problem: str | None) -> str:
    base = f"Goal: {goal_title}\nThis week's focus: {focus}\nWeek's hours: {hours:g}\n\nDays (id: free hours):\n{days}"
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")

from ..contracts.planner import Critique, MonthPlan  # noqa: E402

MONTH_SYSTEM = f"""You spread one goal's effort across the coming months. You are given the months with the hours that can be used for this goal. You cannot invent months: every item names a month_id from the list.
Give each month a short `focus` (a phrase of at most eight words) and a `why` (one sentence: why this month carries this much of the goal): the outcome its weeks add up to. Start gently and ramp up toward the deadline if the goal needs it. The hours across all months must add up to the goal's total, and no month may exceed its hours.

Reply with only JSON matching this schema:
{schema_text(MonthPlan)}"""

CRITIC_SYSTEM = f"""You review one week of a study or practice plan for a busy person. You are given each session with the day and time it was placed.
Flag only real problems: all the work crammed into one or two days while others are free, a session so long it cannot be sustained, no rest between heavy days, or work placed so late it will not happen. If the week is reasonable, say ok. Do not nitpick and do not suggest changing the total hours.

Reply with only JSON matching this schema:
{schema_text(Critique)}"""


def month_user(goal_title: str, total: float, deadline: str | None, months: str, problem: str | None) -> str:
    base = f"Goal: {goal_title}\nTotal effort: {total:g} hours\nDeadline: {deadline or 'none given'}\n\nMonths (id: usable hours):\n{months}"
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")


def critic_user(goal_title: str, focus: str, sessions: str) -> str:
    return f"Goal: {goal_title}\nThis week's focus: {focus}\n\nSessions:\n{sessions}"

from ..config import MIN_GAP_BETWEEN_SESSIONS_MIN, SLOT_GRID_MINUTES  # noqa: E402
from ..contracts.planner import SessionPlan  # noqa: E402

SESSION_SLOT_SYSTEM = f"""You fit one week of work sessions into a person's calendar. For each day you are shown what is already occupied (with what it is) and the free windows. Each session already has a day. You cannot invent a time: place a session by naming a window id on its own day and a "start_offset_min" after that window opens, a multiple of {SLOT_GRID_MINUTES}. A session must fit inside its window, two sessions must not overlap, and there must be at least {MIN_GAP_BETWEEN_SESSIONS_MIN} minutes between two sessions on the same day.
Use the occupied times the way a thoughtful person would: do not put focused work straight after a long or heavy block, leave a gap after something tiring, do not run two sessions of the same goal back to back, and keep part of a full evening free. Mornings (08:00 to 12:00) are the user's best focus hours, so prefer them when they are free.
Every placement carries a `why`: one sentence on why that time suits that session (what is around it, the gap it leaves). {WHY_VOICE}

Reply with only JSON matching this schema:
{schema_text(SessionPlan)}"""


def session_slot_user(now_text: str, goal_title: str, days_text: str, sessions_text: str, problem: str | None = None) -> str:
    base = f"It is now {now_text} for the user.\n\nGoal: {goal_title}\n\nThe days (occupied, then free windows):\n{days_text}\n\nSessions to place:\n{sessions_text}"
    return base + (f"\n\nYour previous placement was rejected: {problem}. Fix that." if problem else "")
