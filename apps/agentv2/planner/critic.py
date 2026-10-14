"""The critic: judgment rules the code checks cannot express (HLD §4).

Code has already made the week legal (no overlaps, within capacity). This asks
whether it is *sensible*. If not, the problems go back to the day level as
feedback and the week is planned again, up to `FIX_MAX_LOOPS` times. A critic that
cannot be reached never blocks a plan: no verdict means the plan stands.
"""
from __future__ import annotations

from datetime import date

from ..contracts import AddBlock, AddTask, Change
from ..contracts.planner import Critique, GoalSpec
from ..llm import complete_json
from ..prompts.planner import CRITIC_SYSTEM, critic_user
from .week import WeekAlloc


def _describe(changes: list[Change]) -> str:
    titles = {c.id: c.title for c in changes if isinstance(c, AddTask)}
    rows = sorted(
        (c for c in changes if isinstance(c, AddBlock)), key=lambda b: (b.day, b.start)
    )
    return "\n".join(f"- {b.day:%a %d %b} {b.start:%H:%M}-{b.end:%H:%M}  {titles.get(b.task_id, b.title)}" for b in rows) or "(nothing placed)"


def critique_week(chat, goal: GoalSpec, wk: WeekAlloc, changes: list[Change]) -> Critique | None:
    return complete_json(chat, CRITIC_SYSTEM, critic_user(goal.title, wk.focus, _describe(changes)), Critique)
