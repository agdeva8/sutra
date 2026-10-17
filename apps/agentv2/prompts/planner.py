"""Prompt prose for the planner levels. Values live in config; this is wording."""
from __future__ import annotations

#: Appended wherever the model writes a `why`: the reader is the user, so it speaks to them.
WHY_VOICE = "Write every `why` to the person directly (\"you\", \"your\"), never \"the user\"."

# --- Honest short weeks (planner/week.py) -----------------------------------
#: Appended to a week's `why` when the calendar leaves less room than the pace the user asked for.
SHORTFALL_WHY_CALENDAR = "Only {got:g} of {wanted:g}h fit this week: your calendar is full on {days}."
#: ...when other active goals take part of the free time.
SHORTFALL_WHY_SHARED = "Only {got:g} of {wanted:g}h fit this week: your other goals take the rest."
#: ...when the week itself has no more free time to offer.
SHORTFALL_WHY_LIMIT = "Only {got:g} of {wanted:g}h fit this week: there is no more free time in it."

from ..contracts.planner import DayPlan, WeekPlan
from ..llm import schema_text

WEEK_SYSTEM = f"""You spread one goal's effort across the coming weeks. You are given the weeks with the free hours that can be used for this goal. You cannot invent weeks: every item names a week_id from the list.
If the goal has milestones, they are its plan: facets run in parallel, each with sub-milestones and a due date. Work the facets side by side, never one facet at a time: while two or more facets are still open, every week moves at least two of them forward, splitting its hours between them, and lists those milestones by exact title in `milestones` (the sub-milestones being worked, from different facets). Within a facet, start a sub-milestone only once the earlier ones are underway, and give each milestone enough hours before its due date. Keep the weekly load steady rather than piling one week high. The focus names what the week achieves across those facets.
Keep the weekly load close to even across the weeks; start a little lighter only in the first week, and load a week near its cap only when the total needs it. Each week gets a short focus (a phrase of at most eight words) and a `why` (one sentence: why this week, with this load, at this point before the deadline). The hours across all weeks must add up to the goal's total, and no week may exceed its hours.
Each week also gets `outcomes`: 2-4 things the user can check off by the end of that week, each a short countable result they would recognise ("20 applications sent", "2 system design mocks done", "Resume rewritten for backend roles"). They are what the week adds up to, not a restatement of the focus and not a reminder of the hours.

Reply with only JSON matching this schema:
{schema_text(WeekPlan)}"""

DAY_SYSTEM = f"""You break one week of a goal into sessions on specific days. You are given the days with their free hours. You cannot invent days: every session names a day_id from the list.
If the week lists milestones, every session works toward exactly one of them (name it in `milestone`), and the week's sessions cover every listed milestone. Interleave them across the week rather than doing one milestone's sessions back to back; when a day has room, it can carry two sessions for different milestones.
Every item has a `kind`, and the kind must suit the work:
- `focus` (the usual choice): one sitting of deep or scheduled work, placed at a time, between one and three hours. "Mock interview: rate limiter", 2h.
- `quota`: a small action repeated a set number of times on each of some weekdays, with no time block ("Send 5 applications", Monday to Friday, about 30 min each). Set `count` (per day), `minutes_each` and `weekdays` (Monday = 0). Its effort per day is count × minutes_each / 60; set `hours` to the week's total for it. Use a quota when the work is a repeated small action the user can do at any time — applications, outreach messages, flashcards — rather than one sitting.
- `multi_day`: one piece of work that runs across several days without a fixed block ("System design: caching and load balancing", Tuesday to Wednesday, about 4h in total). Set `days` to the day ids it spans and leave `hours` as the total effort. Use it when one topic needs more than a single session but does not split into separate sittings.

Estimate the effort before choosing the kind: "5 tailored applications ≈ 2.5h" (5 × 30 min), "a system design topic read and practised ≈ 4h". The sum of everything on a day divided over the items must fit that day's free hours, and the week's items together must add up to the week's hours. `focus` items are the only ones that get a time.

A day may get no item at all, or several items of different work; choose what suits the week, do not give every day one. Spread the work rather than loading one long day.

Every item carries a `why`: one sentence on why it is on this day and why it is next in the sequence (not what it is, that is the description). {WHY_VOICE}

Every item also carries a `title`: the work itself, short, with no day or time in it — code chooses the slot, so "Rewrite resume bullets", not "Rewrite resume bullets (Tue 10:00)".
Every item also carries a `description`: one sentence, in the second person, saying what the person
actually does — the concrete work, not a restatement of the title and not a reason the goal matters.
"Draft the three resume bullets for the platform team, pulling numbers from the Q4 deck", not
"Work on your resume" and not "This matters because you want a new job".

Reply with only JSON matching this schema:
{schema_text(DayPlan)}"""


def milestones_text(milestones) -> str:
    """The breakdown as an indented list: facets, then their sub-milestones under them."""
    return "\n".join(f"{'    ' if m.parent else ''}- {m.title} (due {m.due.isoformat()}, {m.hours:g}h)" for m in milestones)


def week_user(goal_title: str, total: float, deadline: str | None, weeks: str, problem: str | None, earlier: list[str] | None = None, milestones: str = "") -> str:
    base = f"Goal: {goal_title}\nTotal effort: {total:g} hours\nDeadline: {deadline or 'none given'}\n\nWeeks (id: usable hours):\n{weeks}"
    if milestones:
        base += f"\n\nMilestones (facets, with their sub-milestones indented):\n{milestones}"
    if earlier:
        base += "\n\nEarlier weeks are already planned, so continue from where they end and do not repeat them:\n" + "\n".join(f"- {f}" for f in earlier)
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")


def day_user(goal_title: str, focus: str, hours: float, days: str, problem: str | None, milestones: list[str] | None = None) -> str:
    base = f"Goal: {goal_title}\nThis week's focus: {focus}\nWeek's hours: {hours:g}\n\nDays (id: free hours):\n{days}"
    if milestones:
        base += "\n\nMilestones this week works toward:\n" + "\n".join(f"- {m}" for m in milestones)
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")

from ..contracts.planner import Critique, MonthPlan  # noqa: E402

MONTH_SYSTEM = f"""You spread one goal's effort across the coming months. You are given the months with the hours that can be used for this goal. You cannot invent months: every item names a month_id from the list.
Give each month a short `focus` (a phrase of at most eight words) and a `why` (one sentence: why this month carries this much of the goal): the outcome its weeks add up to. Start gently and ramp up toward the deadline if the goal needs it. The hours across all months must add up to the goal's total, and no month may exceed its hours.
Each month also gets `outcomes`: 2-4 things the user can check off by the end of that month, each a short countable result ("40 applications sent", "4 system design mocks done"). They are what the month adds up to, not a restatement of the focus.

Reply with only JSON matching this schema:
{schema_text(MonthPlan)}"""

CRITIC_SYSTEM = f"""You review one week of a study or practice plan for a busy person. You are given each session with the day and time it was placed.
Flag only real problems: all the work crammed into one or two days while others are free, a session so long it cannot be sustained, no rest between heavy days, or work placed so late it will not happen. If the week is reasonable, say ok. Do not nitpick and do not suggest changing the total hours.

Reply with only JSON matching this schema:
{schema_text(Critique)}"""


def month_user(goal_title: str, total: float, deadline: str | None, months: str, problem: str | None) -> str:
    base = f"Goal: {goal_title}\nTotal effort: {total:g} hours\nDeadline: {deadline or 'none given'}\n\nMonths (id: usable hours):\n{months}"
    return base + (f"\n\nYour previous plan was rejected: {problem}. Fix that." if problem else "")


def critic_user(goal_title: str, focus: str, sessions: str, open_days: str = "") -> str:
    base = f"Goal: {goal_title}\nThis week's focus: {focus}\n\nSessions:\n{sessions}"
    if not open_days:
        return base
    return (f"{base}\n\nDays this week that can take work: {open_days}. Every other day of the week has already "
            "passed or has no free time, so never ask to use it.")

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
