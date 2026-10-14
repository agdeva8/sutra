"""Routers — every one reads `state["result"]` FIRST.

That single rule is what makes "never fail" structural rather than defensive: a
node sets `result` and the turn is over, cleanly, without each edge having to
know which failure produced it.

The origin routers read one more key before their default, through `_early`: a
pending `clarify_request` diverts to the interrupt. Only an *origin's* router
reads it — `n_clarify` consumes the request in the same turn it was written, so
no other router can ever see one.
"""
from __future__ import annotations

from langgraph.graph import END

from app.graph.nodes import MAX_EMIT_ATTEMPTS, MAX_REVIEW_ROUNDS


def _done(state: dict) -> bool:
    return state.get("result") is not None


def _early(state: dict) -> str | None:
    """The two writes that pre-empt a router's default: `result`, then a request.

    `result` wins: a stage that is ending the turn must not also be asking, and
    `_clarify_request` refuses to build a request when `result` is set, so the
    ordering is belt-and-braces rather than the only guard.

    Deliberately NOT used by `at_start`, which runs against checkpointed state on
    every new turn — a request left behind by a crashed turn would hijack the
    next turn's entry. Staleness is handled where the state is seeded instead
    (`initial_state`, `_REPLAN_RESET`).
    """
    if _done(state):
        return END
    return "n_clarify" if state.get("clarify_request") else None


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
    # The mandatory-clarify invariant (HLD §10) is enforced by `n_intake`'s call
    # to `_clarify_request`, not here — one gate for every stage that can ask,
    # instead of a router gate and a node gate that can drift apart.
    return _early(state) or "n_plan"


def after_clarify(state: dict) -> str:
    """Resume where the origin said, defaulting to intake.

    The origin declares the target in `clarify_request["resume"]` and `n_clarify`
    republishes it as `clarify_resume`. Both are code constants per stage, never
    model output — which is what keeps the set of reachable destinations
    enumerable even though any stage may now divert here.
    """
    return _early(state) or state.get("clarify_resume") or "n_intake"


def after_plan(state: dict) -> str:
    return _early(state) or "n_lattice"


def after_lattice(state: dict) -> str:
    # A lattice failure is non-fatal by contract: only `result` ends the turn.
    return END if _done(state) else "n_decompose"


def after_decompose(state: dict) -> str:
    return _early(state) or "n_place"


def after_place(state: dict) -> str:
    return END if _done(state) else "n_verify"


def after_verify(state: dict) -> str:
    return END if _done(state) else "n_review"


def after_review(state: dict) -> str:
    early = _early(state)
    if early:
        return early
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
    return _early(state) or "n_validate"


def after_validate(state: dict) -> str:
    if _done(state):
        return END
    if state.get("cv_errors") and state.get("attempts", 0) < MAX_EMIT_ATTEMPTS:
        return "n_propose"  # retry once with the diff
    return END
