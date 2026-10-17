"""Drift's write path — recompute, persist the transitions, audit them.

The *rule* is `sutra_api/core/drift.py`, pure. This module is the part that
touches rows.

Two v1 behaviours are kept because each fixes a real symptom:

* **Throttled to once per user per UTC day** on the dashboard read. Without it,
  a deadline that passed while the user was away is only noticed when something
  *else* changes — so a user returning after a fortnight sees a dashboard that
  still claims everything is on track.
* **Best-effort, never fatal.** Drift is a diagnostic; a failure here must not
  fail the mutation that triggered it. Every caller wraps this, and the
  dashboard swallows the error too.
"""
from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.drift import compute_drift
from ..models import Goal
from . import repo
from .repo import write_audit

#: `user_id -> last checked on` (a UTC date). Process-local: at worst a second
#: instance re-checks, which is idempotent — the cost is one extra read, so a
#: shared cache would be more machinery than the problem deserves.
_checked_on: dict[str, date] = {}
_MAX_TRACKED = 200


def _remember(user_id: str, on: date) -> None:
    if len(_checked_on) >= _MAX_TRACKED:
        # Crude FIFO eviction. This map only exists to avoid a repeated read, so
        # an evicted entry costs one extra query, never correctness.
        for key in list(_checked_on)[: _MAX_TRACKED // 4]:
            _checked_on.pop(key, None)
    _checked_on[user_id] = on


def already_checked_today(user_id: str, today: date) -> bool:
    return _checked_on.get(user_id) == today


async def recompute_goal_drift(
    session: AsyncSession, *, user_id: str, goal_ids: list[str] | None = None
) -> list[dict]:
    """Recompute and persist. Returns the transitions, for the caller's log.

    Only **active** goals are examined: a paused goal is not drifting, it is
    stopped, and marking it `at_risk` would put a "re-plan this" prompt on the
    dashboard for work the user deliberately parked.
    """
    today = datetime.now(UTC).date().isoformat()

    stmt = select(Goal).where(Goal.user_id == user_id, Goal.status == "active")
    if goal_ids:
        stmt = stmt.where(Goal.id.in_(goal_ids))
    goals = list((await session.execute(stmt)).scalars())
    if not goals:
        return []

    ms_rows = await repo.list_milestones(session, user_id=user_id)

    transitions: list[dict] = []
    for goal in goals:
        verdict = compute_drift(
            today,
            [
                {
                    "title": m.title,
                    "targetDate": m.target_date.isoformat() if m.target_date else None,
                    "status": m.status,
                }
                for m in ms_rows
                if m.goal_id == goal.id
            ],
        )
        if verdict["status"] == goal.drift_status:
            continue

        goal.drift_status = verdict["status"]
        goal.updated_at = datetime.now(UTC)
        await write_audit(
            session,
            user_id=user_id,
            type="drift:goal",
            summary=(
                f"Drift: '{goal.title}' now at risk"
                if verdict["status"] == "at_risk"
                else f"Drift cleared: '{goal.title}' back on track"
            ),
            payload={
                "goal_id": goal.id,
                "from": goal.drift_status,
                "to": verdict["status"],
                "reasons": verdict["reasons"],
            },
        )
        transitions.append(
            {
                "goal_id": goal.id,
                "title": goal.title,
                "to": verdict["status"],
                "reasons": verdict["reasons"],
            }
        )

    if transitions:
        await session.flush()
    return transitions


async def refresh_drift_for_dashboard(session: AsyncSession, *, user_id: str) -> None:
    """The throttled daily sweep. Errors are swallowed by the caller."""
    today = datetime.now(UTC).date()
    if already_checked_today(user_id, today):
        return
    await recompute_goal_drift(session, user_id=user_id)
    _remember(user_id, today)


def reset_drift_throttle() -> None:
    """Test seam — the throttle is process state, which is otherwise sticky."""
    _checked_on.clear()
