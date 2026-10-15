"""Goal progress for the API: load rows, let `agentv2` compute the facts, cache the model's verdict.

The numbers are `agentv2.progress`'s (pure code). The verdict (a status and an honest note per goal,
month, week and milestone) is the model's, and costs a call, so it is stored in `goal_progress` against
a digest of the facts it was made from: a page view reads the cache, and only a changed digest (a task
ticked, a new day) asks for a fresh judgement.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import asdict
from datetime import date

from agentv2 import default_chat
from agentv2.progress import GoalFacts, MilestoneRow, PlanRow, build_goal_facts, judge_goal
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Goal, GoalProgress, Milestone, PlanItem

STATUS_DONE = "done"
GOAL_ACTIVE = "active"
#: Plan rows that carry hours in `note` as "3h" (days and months); weeks use `weekly_hours`.
_HOURS = re.compile(r"^\s*([\d.]+)\s*h\s*$")


def _hours(item: PlanItem) -> float:
    if item.horizon == "weekly":
        return float(item.weekly_hours or 0)
    m = _HOURS.match(item.note or "")
    return float(m.group(1)) if m else 0.0


def _row(item: PlanItem) -> PlanRow:
    hours = _hours(item)
    return PlanRow(item.id, item.horizon, item.title, item.start_date or item.due_date, item.end_date or item.due_date,
                   hours, hours if item.status == STATUS_DONE else min(hours, float(item.done_hours or 0)))


async def load_facts(session: AsyncSession, user_id: str, today: date) -> list[GoalFacts]:
    goals = list((await session.execute(select(Goal).where(Goal.user_id == user_id, Goal.status == GOAL_ACTIVE).order_by(Goal.created_at))).scalars())
    items = list((await session.execute(select(PlanItem).where(PlanItem.user_id == user_id, PlanItem.goal_id.is_not(None)))).scalars())
    miles = list((await session.execute(select(Milestone).where(Milestone.user_id == user_id, Milestone.goal_id.is_not(None)))).scalars())
    return [
        build_goal_facts(
            g.id, g.title, g.target_date,
            [_row(i) for i in items if i.goal_id == g.id],
            [MilestoneRow(m.id, m.title, m.target_date, m.status == STATUS_DONE) for m in miles if m.goal_id == g.id],
            today,
        )
        for g in goals
    ]


async def progress_payload(session: AsyncSession, user_id: str, today: date, *, judge: bool) -> list[dict]:
    """Per goal: the facts, plus the verdict when it is current. With `judge`, stale verdicts are made fresh first."""
    facts = await load_facts(session, user_id, today)
    cached = {p.goal_id: p for p in (await session.execute(select(GoalProgress).where(GoalProgress.user_id == user_id))).scalars()}
    stale = [f for f in facts if cached.get(f.goal_id) is None or cached[f.goal_id].digest != f.digest()]

    if judge and stale:
        chat = default_chat()
        verdicts = await asyncio.gather(*(asyncio.to_thread(judge_goal, chat, f) for f in stale))
        for f, v in zip(stale, verdicts):
            if v is None:  # an unreadable reply leaves the numbers without a verdict, never an error
                continue
            row = cached.get(f.goal_id) or GoalProgress(goal_id=f.goal_id, user_id=user_id)
            row.digest, row.verdict = f.digest(), v.model_dump()
            session.add(row)
            cached[f.goal_id] = row
        await session.flush()

    out = []
    for f in facts:
        row = cached.get(f.goal_id)
        fresh = row is not None and row.digest == f.digest()
        out.append({**jsonable_encoder(asdict(f)), "verdict": row.verdict if fresh else None, "stale": not fresh})
    return out
