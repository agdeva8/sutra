"""The critic: judgment rules the code checks cannot express (HLD §4).

Code has already made the week legal (no overlaps, within capacity). This asks
whether it is *sensible*. If not, the problems go back to the day level as
feedback and the week is planned again, up to `FIX_MAX_LOOPS` times. A critic that
cannot be reached never blocks a plan: no verdict means the plan stands.
"""
from __future__ import annotations

from datetime import date, time

from ..contracts import AddBlock, AddItem, AddTask, Change
from ..contracts.planner import Critique, GoalSpec
from ..llm import complete_json
from ..prompts.planner import CRITIC_SYSTEM, critic_user
from .week import WeekAlloc


def _describe(changes: list[Change]) -> str:
    """The week as the critic sees it, in either write shape.

    The 4-kind path emits `AddItem` (a task can be timed, a daily quota, or a span of days);
    the older path emits `AddTask` + `AddBlock`. Reading only the old path made every 4-kind
    week look empty to the critic, which then burned every retry asking for sessions.
    """
    titles = {c.id: c.title for c in changes if isinstance(c, AddTask)}
    rows: list[tuple[date, object, str]] = []
    for c in changes:
        if isinstance(c, AddBlock):
            rows.append((c.day, c.start, f"- {c.day:%a %d %b} {c.start:%H:%M}-{c.end:%H:%M}  {titles.get(c.task_id, c.title)}"))
        elif isinstance(c, AddItem):
            b = c.block
            if b.day is None:
                continue
            if b.start and b.end:
                when = f"{b.start:%H:%M}-{b.end:%H:%M}"
            elif b.quota:
                when = f"any time, {b.quota}×/day"
            elif b.repeat:
                when = f"any time, across {len(b.repeat.weekdays)} days"
            else:
                when = "any time"
            rows.append((b.day, b.start, f"- {b.day:%a %d %b} {when}  {b.title}"))
    rows.sort(key=lambda r: (r[0], r[1] or time.max))
    return "\n".join(line for _, _, line in rows) or "(nothing placed)"


def critique_week(chat, goal: GoalSpec, wk: WeekAlloc, changes: list[Change], open_days: list[date] | None = None) -> Critique | None:
    """`open_days` are the week's days that could take work at all; the rest have passed or are full."""
    days = ", ".join(f"{d:%a %d %b}" for d in open_days or [])
    return complete_json(chat, CRITIC_SYSTEM, critic_user(goal.title, wk.focus, _describe(changes), days), Critique)
