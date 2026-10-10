"""`check_headroom` — capacity gate. PURE.

Runs after placement, before proposals. Answers one question: does this plan
fit the user's real capacity, and if not, by how much? The verdict is computed
here in code — never asked of the LLM (HLD §8.5).
"""
from __future__ import annotations

from dataclasses import dataclass

#: Hours of overshoot tolerated before the plan is called over-committed.
CAP_TIGHT_SLACK_HOURS = 5.0

#: Verdicts, worst last.
PROCEED = "proceed"
PROCEED_TIGHT = "proceed_tight"
ADVISORY = "advisory"
RENEGOTIATE = "renegotiate"


@dataclass
class Headroom:
    verdict: str
    total_hours: float
    capacity_hours: float
    free_hours: float
    detail: str = ""

    @property
    def over(self) -> bool:
        return self.verdict == RENEGOTIATE


def check_headroom(
    *,
    new_goal_hours: float,
    active_goal_hours: list[float],
    capacity_hours: float,
    slack_hours: float = CAP_TIGHT_SLACK_HOURS,
) -> Headroom:
    """Compare demanded hours against the user's weekly capacity."""
    total = float(new_goal_hours) + sum(float(h or 0.0) for h in active_goal_hours)
    free = capacity_hours - total

    if free < -slack_hours:
        verdict = RENEGOTIATE
        detail = (
            f"{total:g}h/week against {capacity_hours:g}h capacity — "
            f"{abs(free):g}h over. Ask what to give up before planning."
        )
    elif free < 0:
        verdict = PROCEED_TIGHT
        detail = (
            f"{total:g}h/week against {capacity_hours:g}h — {abs(free):g}h over, "
            "inside the grace band. Name the tightness in the prose."
        )
    elif free < capacity_hours * 0.1:
        verdict = ADVISORY
        detail = f"{total:g}h/week against {capacity_hours:g}h — little headroom left."
    else:
        verdict = PROCEED
        detail = f"{total:g}h/week against {capacity_hours:g}h — {free:g}h free."

    return Headroom(
        verdict=verdict,
        total_hours=round(total, 1),
        capacity_hours=round(float(capacity_hours), 1),
        free_hours=round(free, 1),
        detail=detail,
    )


#: The four buttons offered when a plan is over-committed. The user picks one
#: instead of rejecting the plan outright.
RENEGOTIATION_OPTIONS: tuple[str, ...] = (
    "extend the timeline",
    "reduce the weekly hours",
    "pause or drop another goal",
    "keep it and accept the overload",
)
