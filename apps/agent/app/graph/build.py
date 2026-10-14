"""Graph construction + the run/resume entry point.

`complete` is captured in the node closures, never imported by a node — the DI
seam that makes the whole graph testable without a model (HLD §15). The
checkpointer is the shared, durable piece.
"""
from __future__ import annotations

import inspect
import uuid
from typing import Any, Callable

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.graph import routers as R
from app.graph.nodes import (
    n_clarify,
    n_decompose,
    n_headroom,
    n_intake,
    n_lattice,
    n_place,
    n_plan,
    n_propose,
    n_replan_done,
    n_review,
    n_validate,
    n_verify,
)
from app.graph.state import PlanState, initial_state
from app.llm.client import CompleteFn
from app.observability import configure_tracing, run_url, turn_trace


def _node_meta(fn: Callable[..., Any]) -> dict[str, Any]:
    """The node's docstring, as node metadata, for the Studio node panel.

    LangGraph has no description field on a node in this version: `add_node(...,
    description=…)` is accepted and then silently dropped, and the served graph
    payload carries only `{"name": "n_intake"}`. `metadata` *is* forwarded into
    that payload (`Pregel.get_graph` → `draw_graph` → `Graph.add_node`), so the
    docstring rides there rather than being written a second time next to it.

    First paragraph only: the rest of these docstrings argues about HLD rules,
    which is the right thing to read in the source and the wrong thing in a
    side panel. The node function's own docstring stays the single source.
    """
    summary = (inspect.getdoc(fn) or "").split("\n\n", 1)[0].strip()
    return {"description": summary} if summary else {}


def build_plan_graph(*, complete: CompleteFn, checkpointer: Any):
    """Compile the planner graph.

    Built per invocation because `complete` is captured in the node closures;
    the checkpointer is the shared piece that makes HITL durable.
    """
    g = StateGraph(PlanState)

    # Explicit async wrappers, not lambdas: a lambda that *returns* a coroutine
    # is not detected as an async node by LangGraph, which then rejects the
    # coroutine as a state update. These await, so the node is unambiguously
    # async and `complete` stays captured in the closure.
    async def _intake(s: dict) -> dict:
        return await n_intake(s, complete=complete)

    async def _plan(s: dict) -> dict:
        return await n_plan(s, complete=complete)

    async def _decompose(s: dict) -> dict:
        return await n_decompose(s, complete=complete)

    async def _review(s: dict) -> dict:
        return await n_review(s, complete=complete)

    async def _propose(s: dict) -> dict:
        return await n_propose(s, complete=complete)

    # `metadata` carries each node's own docstring into the graph payload
    # Studio draws from — see `_node_meta`. The wrapper closures have no
    # docstring of their own, so each points at the node it wraps.
    g.add_node("n_intake", _intake, metadata=_node_meta(n_intake))
    g.add_node("n_clarify", n_clarify, metadata=_node_meta(n_clarify))
    g.add_node("n_plan", _plan, metadata=_node_meta(n_plan))
    g.add_node("n_lattice", n_lattice, metadata=_node_meta(n_lattice))
    g.add_node("n_decompose", _decompose, metadata=_node_meta(n_decompose))
    g.add_node("n_place", n_place, metadata=_node_meta(n_place))
    g.add_node("n_verify", n_verify, metadata=_node_meta(n_verify))
    g.add_node("n_review", _review, metadata=_node_meta(n_review))
    g.add_node("n_headroom", n_headroom, metadata=_node_meta(n_headroom))
    g.add_node("n_propose", _propose, metadata=_node_meta(n_propose))
    g.add_node("n_validate", n_validate, metadata=_node_meta(n_validate))
    g.add_node("n_replan_done", n_replan_done, metadata=_node_meta(n_replan_done))

    # START is conditional so a replan can enter deeper (HLD §9.1). Safe for
    # threads paused before this edge existed: edge topology is not part of a
    # checkpoint, so a thread waiting at `n_clarify` resumes exactly as it did.
    g.add_conditional_edges(START, R.at_start, ["n_intake", "n_place"])
    g.add_conditional_edges("n_intake", R.after_intake, ["n_clarify", "n_plan", END])
    # The resume set is every origin's declared `resume` constant plus intake.
    # It is a fixed list, not a dynamic one: which node execution returns to is
    # decided by code, never by the model, so the reachable paths stay
    # enumerable even though any of five stages may divert here (HLD §6).
    g.add_conditional_edges(
        "n_clarify",
        R.after_clarify,
        ["n_intake", "n_plan", "n_decompose", "n_review", "n_propose"],
    )
    g.add_conditional_edges("n_plan", R.after_plan, ["n_clarify", "n_lattice", END])
    g.add_conditional_edges("n_lattice", R.after_lattice, ["n_decompose", END])
    g.add_conditional_edges("n_decompose", R.after_decompose, ["n_clarify", "n_place", END])
    g.add_conditional_edges("n_place", R.after_place, ["n_verify", END])
    g.add_conditional_edges("n_verify", R.after_verify, ["n_review", END])
    g.add_conditional_edges(
        "n_review",
        R.after_review,
        ["n_clarify", "n_headroom", "n_place", "n_replan_done", END],
    )
    g.add_edge("n_replan_done", END)
    g.add_conditional_edges("n_headroom", R.after_headroom, ["n_propose", END])
    g.add_conditional_edges("n_propose", R.after_propose, ["n_clarify", "n_validate", END])
    g.add_conditional_edges("n_validate", R.after_validate, ["n_propose", END])

    return g.compile(checkpointer=checkpointer)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


async def run_plan(
    *,
    message: str,
    complete: CompleteFn | None = None,
    checkpointer: Any = None,
    thread_id: str | None = None,
    resume: Any = None,
    **state_kw: Any,
) -> dict:
    """Run or resume the pipeline. Returns a result dict with a `kind`.

    `kind` is one of: `ok`, `early`, `no_change`, `renegotiate`, `clarify`.
    """
    from app.llm.client import get_complete

    complete = complete or get_complete()
    if checkpointer is None:
        checkpointer = _memory_checkpointer()

    graph = build_plan_graph(complete=complete, checkpointer=checkpointer)
    # `ephemeral-` marks a throwaway thread: nothing outside this call holds the
    # id, so it is never resumed and is safe to prune wholesale. A caller that
    # owns a durable thread (a conversation) passes `thread_id` and keeps
    # whatever prefix it chose — that is what makes the retention rule in
    # `store/checkpointer.py` expressible as a prefix match.
    thread = thread_id or f"ephemeral-{uuid.uuid4()}"
    run_config = {"configurable": {"thread_id": thread}, "recursion_limit": _RECURSION_LIMIT}

    graph_input = Command(resume=resume) if resume is not None else initial_state(message=message, **state_kw)

    # One trace per turn when LangSmith is configured; a null context otherwise.
    # The graph's own node runs nest under it, so a turn reads as one trace
    # rather than a dozen orphans.
    with turn_trace(
        "plan.turn",
        {"message": message, "resume": resume is not None},
        {"thread_id": thread, "mode": state_kw.get("mode", "ask")},
    ) as turn:
        out = await graph.ainvoke(graph_input, run_config)
    return _shape_result(out, thread, run_url(turn))


def _shape_result(out: dict, thread: str, trace_url: str | None) -> dict:
    """The public result shape. Shared so the two entry points cannot drift.

    `run_plan` and `run_replan` return the same dict because the service reads
    them with the same code; a second copy of this shaping is how one of them
    quietly stops reporting `rejects`.
    """
    pending = out.get("__interrupt__")
    if pending:
        first = pending[0]
        value = getattr(first, "value", first) or {}
        return {
            "kind": "clarify",
            "prose": value.get("prompt", ""),
            "questions": value.get("questions", []),
            "thread_id": thread,
            "trace_url": trace_url,
            "rejects": list(out.get("rejects") or []),
        }

    result = dict(
        out.get("result") or {"kind": "no_change", "reason": "pipeline produced no result"}
    )
    result["thread_id"] = thread
    result["trace_url"] = trace_url
    result["rejects"] = list(out.get("rejects") or [])
    result.setdefault("review_rounds", out.get("review_rounds", 0))
    # `adjustments` is safe to carry on every result. `tier` is deliberately NOT
    # defaulted from state: only `n_replan_done` writes it, and the *absence* of
    # it is meaningful — it says the run did not take the slim path. Defaulting
    # it from the state key would report "slim" for a replan that degraded to a
    # full re-plan, and the caller would apply dates it promised were silent.
    result.setdefault("adjustments", list(out.get("adjustments") or []))
    return result


async def run_replan(
    *,
    change: dict,
    thread_id: str,
    tier: str = "slim",
    adjustments: list[str] | None = None,
    deltas: list[dict] | None = None,
    complete: CompleteFn | None = None,
    checkpointer: Any = None,
    **state_kw: Any,
) -> dict:
    """Re-solve an existing plan on its own thread. Same result shape as `run_plan`.

    Deliberately **not** seeded through `initial_state()`. That helper fills in
    every key — `tasks: []`, `plan: None`, `items: []` — and LangGraph merges
    whatever it is handed into the checkpointed state, so seeding with it would
    wipe the very task set this replan exists to re-solve. The slim path would
    then silently become a re-derive, or crash, with no error either way. A
    minimal delta is what leaves the checkpointed keys alone.

    `thread_id` is required and has no default: a replan with a fresh thread is
    not a replan, it is a new plan wearing the name.
    """
    from app.llm.client import get_complete

    complete = complete or get_complete()
    if checkpointer is None:
        checkpointer = _memory_checkpointer()

    graph = build_plan_graph(complete=complete, checkpointer=checkpointer)
    run_config = {"configurable": {"thread_id": thread_id}, "recursion_limit": _RECURSION_LIMIT}

    graph_input: dict[str, Any] = {
        **_REPLAN_RESET,
        "entry": "replan",
        "change": change,
        "tier": tier,
        "adjustments": list(adjustments or []),
        "deltas": list(deltas or []),
        **state_kw,
    }

    with turn_trace(
        "plan.replan",
        {"tier": tier, "change": change.get("kind") or change.get("action") or ""},
        {"thread_id": thread_id},
    ) as turn:
        out = await graph.ainvoke(graph_input, run_config)
    return _shape_result(out, thread_id, run_url(turn))


#: The superstep budget for one `ainvoke`, set explicitly rather than inherited.
#:
#: LangChain's default is 25 and it was never chosen here; the longest path (a
#: mid-graph clarify, its resume, a review-rejection round and a validate retry)
#: now runs ~18, leaving a margin that was a coincidence rather than a decision.
#: It matters because `GraphRecursionError` is neither `LlmError` nor `ValueError`
#: — it would escape `ainvoke` and break the "never fail" invariant (HLD §13).
_RECURSION_LIMIT = 50


#: The turn-scoped keys a replan has to clear before it runs.
#:
#: Every router opens with `_done(state)`, which is `state.get("result") is not
#: None`. A replan runs on a thread that already completed — so its checkpoint
#: still holds the previous turn's `result`, and without this reset the first
#: node to run would see a finished turn and route straight to END. The replan
#: would do nothing, return the *old* result, and report `ok`.
#:
#: The plan-scoped keys (`plan`, `lattice`, `items`, `tasks`) are deliberately
#: absent: those are what a replan exists to reuse.
_REPLAN_RESET: dict[str, Any] = {
    "result": None,
    "critique": None,
    "verify_errors": [],
    "cv_errors": [],
    "attempts": 0,
    "review_rounds": 0,
    "proposals": [],
    "renegotiation": None,
    "headroom": None,
    "place": None,
    # A stale request would divert the replan's first node. `clarify_asked` is
    # reset because a replan is a new turn: leaving it set is what made the
    # mandatory-clarify invariant unable to fire on an *escalated* replan — the
    # gate read the previous turn's answers and concluded the user had already
    # been asked. `clarify_answers` is deliberately kept: it is the fold's input,
    # and the answers are already folded into `context`, which a replan reuses.
    "clarify_request": None,
    "clarify_resume": None,
    "clarify_rounds": 0,
    "clarify_asked": [],
}

_MEMORY_CP: Any = None


def _memory_checkpointer() -> Any:
    """A process-wide in-memory saver — enough for the TUI and for tests."""
    global _MEMORY_CP
    if _MEMORY_CP is None:
        from langgraph.checkpoint.memory import InMemorySaver

        _MEMORY_CP = InMemorySaver()
    return _MEMORY_CP
