"""Drift — the plan-vs-actual gap, snapshot-based.

Ported verbatim from v1's `api/lib/goal-planner/drift.ts`.

**One rule is implemented, and that is deliberate.** A milestone whose
`target_date` has passed without completing. Two further PRD rules are named in
v1's source as *not implemented*, and the honest thing is to keep them named
rather than quietly drop the mention:

2. "Three or more open commitments whose `due` fell in the last 7 days" —
   unimplementable, because the `commitments` entity was removed app-wide and
   folded into `plan_items`.
3. "completed_hours < 60% of target_hours for two consecutive weeks" — nothing
   tracks hours *spent*. A goal carries an estimate, never actuals.

Snapshot-based means it reads current rows, not a history log, so the answer is
recomputed rather than accumulated. That is why a deadline that passed while the
user was away is still detected on their return.
"""
from __future__ import annotations

from typing import Iterable, Literal, TypedDict

DriftStatus = Literal["on_track", "at_risk"]


class DriftMilestone(TypedDict, total=False):
    title: str
    #: ISO `YYYY-MM-DD`, or None when the milestone has no date yet.
    targetDate: str | None
    #: `open` | `done` — anything that is not exactly `done` counts as open.
    status: str


class DriftResult(TypedDict):
    status: DriftStatus
    reasons: list[str]


def compute_drift(today: str, milestones: Iterable[DriftMilestone]) -> DriftResult:
    """`today` is ISO `YYYY-MM-DD`. String comparison is safe for that format."""
    reasons: list[str] = []

    for m in milestones:
        target = m.get("targetDate")
        if isinstance(target, str) and target < today and m.get("status") != "done":
            reasons.append(
                f'Milestone "{m.get("title", "")}" passed its target date '
                f"({target}) without completing."
            )

    return {
        "status": "at_risk" if reasons else "on_track",
        "reasons": reasons,
    }
