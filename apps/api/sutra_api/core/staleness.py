"""Staleness + blast radius, pure. Moved into the API from the v1 agent so the service no longer
imports `apps/agent`; the logic and tests are unchanged.

The count is arithmetic: changes recorded against a goal's **current plan
generation**, after its last confirmed plan write. Generation (not timestamp) is
what makes the count monotonic inside a window and exactly zero after a confirm
— comparing timestamps would let a change recorded in the same clock tick as the
confirm flicker in and out.

`build_adjustments` renders the toaster strings deterministically: the sentence
*structure* is code (a fixed template per kind), only the noun phrases come from
data. Same ledger ⇒ same sentence order, so a re-render cannot reshuffle the
toast under the user's eyes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PlanHorizon = Literal["daily", "weekly", "monthly", "quarterly", "yearly"]
Tier = Literal["slim", "escalate"]

#: How far a change reaches, smallest first.
HORIZON_RANK = {"daily": 0, "weekly": 1, "monthly": 2, "quarterly": 3, "yearly": 4}


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Change(_Strict):
    """One recorded change, against the goal's plan generation."""

    goal_id: str
    kind: str
    horizons_moved: list[PlanHorizon] = Field(default_factory=list)
    milestone_moved: bool = False
    detail: dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""
    generation: int = 0


class Verdict(_Strict):
    """Blast radius -> tier. Computed in code, never by the LLM."""

    tier: Tier
    top_horizon: PlanHorizon | None = None
    reason: str = ""


VERDICT_SLIM = "slim"
VERDICT_ESCALATE = "escalate"

#: Daily-only changes are `slim`; anything at weekly or above escalates.
#: A milestone moving always escalates, whatever its horizon says.
SLIM_MAX_RANK = 0


@dataclass
class Baseline:
    """The goal's last confirmed plan write."""

    goal_id: str
    generation: int = 0
    last_planned_at: str = ""


def top_horizon(horizons: list[str]) -> PlanHorizon | None:

    known = [h for h in horizons if h in HORIZON_RANK]
    if not known:
        return None
    return max(known, key=lambda h: HORIZON_RANK[h])  # type: ignore[return-value]


def classify_change(
    horizons_moved: list[str],
    *,
    milestone_moved: bool = False,
) -> Verdict:
    """Blast radius → tier. Pure; the caller derives the radius and passes it in."""
    top = top_horizon(horizons_moved)

    if milestone_moved:
        return Verdict(
            tier=VERDICT_ESCALATE,
            top_horizon=top,
            reason="a milestone moved — outcome layer changed",
        )


    if top is None:
        return Verdict(tier=VERDICT_SLIM, top_horizon=None, reason="no horizon moved")

    if HORIZON_RANK[top] <= SLIM_MAX_RANK:
        return Verdict(
            tier=VERDICT_SLIM,
            top_horizon=top,
            reason="day-level only — applied silently by the solver",
        )
    return Verdict(
        tier=VERDICT_ESCALATE,
        top_horizon=top,
        reason=f"{top} or higher moved — needs the confirm modal",
    )


# --------------------------------------------------------------------------
# The toaster — fixed templates per kind (HLD §9.5, option B)
# --------------------------------------------------------------------------

#: Sentence template per change kind. `{n}` = horizons moved, `{detail}` = the
#: noun phrase supplied by the route that recorded the change.
_TEMPLATES: dict[str, str] = {
    "blocker.add": "Adjusting {n} around {detail}",
    "blocker.remove": "Reclaiming {n} freed by {detail}",
    "daily_log": "Re-flowing {n} after today's log",
    "goal.edit": "Re-laying {n} for {detail}",
    "goal.dates": "Re-spreading {n} across the new timeline",
    "milestone.edit": "Moving {n} to match {detail}",
    "plan_item.edit": "Reconciling {n} with your edit",
    "source.add": "Folding {detail} into {n}",
    "source.remove": "Removing {detail} from {n}",
    "timetable.edit": "Re-slotting {n} around your blocks",
    "goal.pause": "Pausing {n} for {detail}",
    "goal.drop": "Clearing {n} for {detail}",
}

_HORIZON_NOUN: dict[str, str] = {
    "daily": "day task",
    "weekly": "week",
    "monthly": "month",
    "quarterly": "quarter",
    "yearly": "year",
}


def _noun_phrase(change: Change) -> str:

    horizons = change.horizons_moved or ["daily"]
    ranked = sorted(set(horizons), key=lambda h: HORIZON_RANK.get(h, 0))
    top = ranked[-1] if ranked else "daily"
    noun = _HORIZON_NOUN.get(top, "task")
    return f"{len(horizons)} {noun}" + ("s" if len(horizons) > 1 else "")


def describe_change(change: Change) -> str:
    """One deterministic sentence for one change."""
    template = _TEMPLATES.get(change.kind, "Adjusting {n}")
    detail = str(change.detail.get("label") or change.detail.get("title") or "").strip()
    sentence = template.format(n=_noun_phrase(change), detail=detail or "the change")
    return sentence.rstrip(" .") + "."


def build_adjustments(changes: list[Change], limit: int = 4) -> list[str]:
    """The `adjustments[]` the slim-replan toast renders. Deterministic order."""
    ordered = sorted(changes, key=lambda c: (c.created_at, c.kind, c.goal_id))
    seen: set[str] = set()
    out: list[str] = []
    for c in ordered:
        s = describe_change(c)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= limit:
            break
    return out


def count_pending(changes: list[Change], baseline: Baseline | None) -> int:
    """Changes against the goal's CURRENT plan generation.

    Generation-only, deliberately — no timestamp comparison. Comparing
    timestamps reintroduces exactly the bug this design exists to avoid: a
    change recorded in the same clock tick as the confirm (which is the normal
    case, since both happen in one request) would compare equal and flicker out
    of the count. A confirm bumps the generation, so every earlier change stops
    counting at once, and every later one counts from zero. Monotonic inside a
    window, exactly zero after a confirm.
    """
    if baseline is None:
        return len(changes)
    return sum(1 for c in changes if c.generation == baseline.generation)


def rollup_counts(changes: list[Change], baselines: dict[str, Baseline]) -> dict:
    """App-level rollup for the persistent refresh button."""
    by_goal: dict[str, int] = {}
    for c in changes:
        by_goal.setdefault(c.goal_id, 0)
    for goal_id in list(by_goal):
        by_goal[goal_id] = count_pending(
            [c for c in changes if c.goal_id == goal_id], baselines.get(goal_id)
        )
    total = sum(by_goal.values())
    return {
        "total": total,
        "by_goal": {k: v for k, v in by_goal.items() if v},
        "label": f"{total} change{'s' if total != 1 else ''} since last planning",
    }


def next_baseline(
    baseline: Baseline | None, *, goal_id: str, at: str | None = None
) -> Baseline:
    """Advance the generation. Called on every CONFIRMED plan write."""
    at = at or now_utc()
    gen = (baseline.generation if baseline else 0) + 1
    return Baseline(goal_id=goal_id, generation=gen, last_planned_at=at)


def make_change(
    goal_id: str,
    kind: str,
    horizons_moved: list[str],
    *,
    milestone_moved: bool = False,
    detail: dict | None = None,
    generation: int = 0,
) -> Change:
    return Change(
        goal_id=goal_id,
        kind=kind,
        horizons_moved=list(horizons_moved),  # type: ignore[arg-type]
        milestone_moved=milestone_moved,
        detail=detail or {},
        created_at=now_utc(),
        generation=generation,
    )
