"""Routers — every one reads `state["result"]` FIRST.

That single rule is what makes "never fail" structural rather than defensive: a
node sets `result` and the turn is over, cleanly, without each edge having to
know which failure produced it.
"""
from __future__ import annotations

from langgraph.graph import END

from app.graph.nodes import MAX_CLARIFYING_ROUNDS, MAX_EMIT_ATTEMPTS, MAX_REVIEW_ROUNDS


def _done(state: dict) -> bool:
    return state.get("result") is not None


def _replan_slim(state: dict) -> bool:
    return state.get("entry") == "replan" and state.get("tier") == "slim"


def at_start(state: dict) -> str:
    """Where a run enters: a fresh plan, or a replan at its own depth.

    HLD §9.1 — planning and replanning are the same graph, entered with a
    different intent. A replan never re-enters the meaning stages, because the
    meaning is what the user just edited by hand; re-deriving it would rewrite
    the plan they were looking at, which is the opposite of §9.2's "slim: `place`
    re-runs; day-level dates rewrite silently".

    A slim change re-solves the task set that is already in the checkpoint. When
    there is nothing to re-solve — no `change`, no `tier`, or no task set — the
    honest degradation is to behave like an ordinary turn rather than to invent
    a plan from an empty state.
    """
    if state.get("entry") != "replan":
        return "n_intake"
    if not state.get("change"):
        return "n_intake"
    if state.get("tier") == "slim" and state.get("tasks"):
        return "n_place"
    return "n_intake"


def after_intake(state: dict) -> str:
    if _done(state):
        return END
    intake = state.get("intake") or {}
    rounds = state.get("clarify_rounds", 0)
    # The mandatory-clarify invariant: a material unknown routes to the
    # interrupt even though the model already produced a plan-shaped answer.
    if intake.get("material_unknowns") and not state.get("clarify_answers"):
        if rounds < MAX_CLARIFYING_ROUNDS:
            return "n_clarify"
    return "n_plan"


def after_clarify(state: dict) -> str:
    """Always loop back to intake so the answers are folded into context."""
    return "n_intake"


def after_plan(state: dict) -> str:
    return END if _done(state) else "n_lattice"


def after_lattice(state: dict) -> str:
    # A lattice failure is non-fatal by contract: only `result` ends the turn.
    return END if _done(state) else "n_decompose"


def after_decompose(state: dict) -> str:
    return END if _done(state) else "n_place"


def after_place(state: dict) -> str:
    return END if _done(state) else "n_verify"


def after_verify(state: dict) -> str:
    return END if _done(state) else "n_review"


def after_review(state: dict) -> str:
    if _done(state):
        return END
    critique = state.get("critique") or {}
    if critique.get("ok", True):
        # A slim replan stops here. It re-solved a task set whose goal hours are
        # unchanged, so `n_headroom` would only re-ask a question the first plan
        # already answered — and a proposal is the wrong output for a change the
        # user was promised would be applied silently.
        return "n_replan_done" if _replan_slim(state) else "n_headroom"
    if state.get("review_rounds", 0) < MAX_REVIEW_ROUNDS:
        return "n_place"  # re-solve WITH the accumulated deltas
    # Out of rounds. `n_review` wrote the `renegotiate` result on its last
    # rejection, so `_done` above would already have ended the turn; this END is
    # the belt-and-braces path for a critique that arrived without one.
    return END


def after_headroom(state: dict) -> str:
    return END if _done(state) else "n_propose"


def after_propose(state: dict) -> str:
    return END if _done(state) else "n_validate"


def after_validate(state: dict) -> str:
    if _done(state):
        return END
    if state.get("cv_errors") and state.get("attempts", 0) < MAX_EMIT_ATTEMPTS:
        return "n_propose"  # retry once with the diff
    return END
