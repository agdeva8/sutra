"""The over-commitment chip — the load-level judgement on the dashboard.

Ported verbatim from v1's `api/lib/over-commitment.ts`, which was itself mirrored
from the original Python backend's `load_state`. The messages are **not**
paraphrased: they render on the dashboard chip and in the "strained" callout, and
a re-worded one would be a silent product change.

Two details worth keeping:

* Only `active` goals count. A paused goal is not a load, and a dropped one is
  the *fix*.
* `conflicting` is populated only at `critical` and `high`, with at most three
  titles — it is the "pause one of these" callout, and above three it stops
  being actionable.
* `open_commitments` is **always 0**. v1 hardcoded it because the `commitments`
  entity was removed in migration 0013 and folded into `plan_items`. Emitting a
  real count would be inventing a number nothing agrees on.
"""
from __future__ import annotations

from typing import Iterable, Literal, TypedDict

OverCommitmentLevel = Literal["clear", "moderate", "high", "critical"]

#: The level below which nothing is worth saying.
CLEAR_MESSAGE = "A steady, focused load."


class OverCommitmentGoal(TypedDict, total=False):
    id: str
    title: str
    status: str


class OverCommitment(TypedDict):
    level: OverCommitmentLevel
    message: str
    conflicting: list[str]
    active_goals: int
    open_commitments: int


def compute_over_commitment(goals: Iterable[OverCommitmentGoal]) -> OverCommitment:
    active = [g for g in goals if g.get("status") == "active"]

    level: OverCommitmentLevel = "clear"
    message = CLEAR_MESSAGE
    conflicting: list[str] = []
    n = len(active)

    if n >= 7:
        level = "critical"
        message = (
            f"{n} goals at once is a wish-list, not a week. "
            "Something needs to be paused."
        )
        conflicting.extend(g.get("title", "") for g in active[:3])
    elif n >= 5:
        level = "high"
        message = f"{n} goals in flight — your attention is stretched thin."
        conflicting.extend(g.get("title", "") for g in active[:3])
    elif n >= 3:
        level = "moderate"
        message = f"{n} goals in play. Doable, but only one can lead this week."

    return {
        "level": level,
        "message": message,
        "conflicting": conflicting,
        "active_goals": n,
        "open_commitments": 0,
    }
