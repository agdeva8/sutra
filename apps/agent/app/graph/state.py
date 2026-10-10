"""Graph state. Raw data only — prompts are formatted inside nodes.

Two rules from HLD §7 that this module is shaped by:

* **Store raw data, not formatted text.** `plan`, `items`, `slots` are data;
  the node that needs a prompt formats it.
* **New keys are `NotRequired`** (this is a `total=False` TypedDict) because
  LangGraph always runs the newest graph against previously persisted state —
  adding a key is a compatibility promise, not a free change.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict


class PlanState(TypedDict, total=False):
    # --- request -----------------------------------------------------------
    intent: str
    message: str
    context: str
    today: str
    mode: str
    user_id: str
    availability: dict
    blocked_dates: list[str]
    weekly_budget_hours: float | None
    existing_goal_titles: list[str]
    active_goal_weekly_hours: list[float]
    capacity_hours: float
    goal_id: str | None

    # --- intake ------------------------------------------------------------
    intake: dict | None
    clarify_rounds: int
    clarify_answers: list[dict]

    # --- planning ----------------------------------------------------------
    plan: dict | None
    lattice: dict | None
    tasks: list[dict]
    items: list[dict]
    place: dict | None

    # --- verification / review --------------------------------------------
    verify_errors: list[str]
    deltas: list[dict]
    critique: dict | None
    review_rounds: int

    # --- capacity / proposals ---------------------------------------------
    headroom: dict | None
    renegotiation: dict | None
    proposals: list[dict]
    cv_errors: list[str]
    attempts: int

    # --- replan ------------------------------------------------------------
    #: `"plan"` or `"replan"`. Added as `NotRequired` (this TypedDict is
    #: `total=False`) and defaulted to `"plan"` so a checkpoint written before it
    #: existed reads as a fresh plan rather than falling down the replan path —
    #: HLD §11.1, "never tighten a field".
    entry: str
    change: dict | None
    tier: str | None
    adjustments: list[str]

    # --- bookkeeping -------------------------------------------------------
    #: Concatenating reducer: accumulates across nodes AND across resumes.
    rejects: Annotated[list[dict], operator.add]
    result: dict | None


def initial_state(**kw: Any) -> dict:
    """A clean starting state. `result` stays None so routers keep going."""
    base: dict[str, Any] = {
        "intent": "add_goal",
        "message": "",
        "context": "",
        "mode": "ask",
        "user_id": "local",
        "availability": {},
        "blocked_dates": [],
        "weekly_budget_hours": None,
        "existing_goal_titles": [],
        "active_goal_weekly_hours": [],
        "capacity_hours": 40.0,
        "goal_id": None,
        "intake": None,
        "clarify_rounds": 0,
        "clarify_answers": [],
        "plan": None,
        "lattice": None,
        "tasks": [],
        "items": [],
        "place": None,
        "verify_errors": [],
        "deltas": [],
        "critique": None,
        "review_rounds": 0,
        "headroom": None,
        "renegotiation": None,
        "proposals": [],
        "cv_errors": [],
        "attempts": 0,
        "change": None,
        "tier": None,
        "adjustments": [],
        "entry": "plan",
        "rejects": [],
        "result": None,
    }
    base.update(kw)
    return base
