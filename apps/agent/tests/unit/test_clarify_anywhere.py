"""Clarify from any stage — offline, with the deterministic stub as the model.

The interrupt used to be reachable only from `n_intake` and always looped back
to it. These pin the generalisation: any stage that can find a material unknown
may divert, the origin declares where execution resumes, and the forcing rule
still cannot be talked out of asking.

The instrument throughout is a *recording* `complete`. The stub is tidy by
construction, so "which stage asked, and what was it shown" cannot be read off
the result — only off the calls.
"""
from __future__ import annotations

import inspect

import pytest
from langgraph.graph import END

from app.contracts import schemas as S
from app.graph import nodes as N
from app.graph import routers as R
from app.graph.build import _RECURSION_LIMIT, run_plan, run_replan
from app.graph.state import initial_state
from app.llm.client import stub_complete

MON_FRI = {"mon": 2, "tue": 2, "wed": 2, "thu": 2, "fri": 2, "sat": 0, "sun": 0}

#: A message the stub plans without asking anything — hours and domain are both
#: settled, so intake produces no unknown and any clarify must come from deeper.
CLEAN = "I want to learn system design, 8 hours a week over 3 months"

#: A message that trips the stub's forcing rule at intake.
JOB = "I want to change my job"


def _kw(**over):
    base = dict(
        today="2026-01-05",
        availability=MON_FRI,
        blocked_dates=[],
        weekly_budget_hours=10,
        capacity_hours=40,
    )
    base.update(over)
    return base


def _recorder(calls, *, unknown_at=None, unknown="target level", always=False):
    """A `complete` that records every call, and can make one stage report an unknown.

    The unknown goes back through `model_validate` rather than `model_copy`, so
    the question is synthesised by the real validator — the same path a model
    that listed an unknown and forgot to ask would take.
    """
    seen: dict[str, int] = {}

    async def complete(system, user, schema):
        calls.append((schema, user))
        out = await stub_complete(system, user, schema)
        if schema is unknown_at:
            seen["n"] = seen.get("n", 0) + 1
            if always or seen["n"] == 1:
                data = out.model_dump()
                data["material_unknowns"] = [unknown]
                out = schema.model_validate(data)
        return out

    return complete


def _two_stage_recorder(calls):
    """Reports one unknown at the plan stage, then one at decompose."""
    seen: dict[str, int] = {}

    async def complete(system, user, schema):
        calls.append((schema, user))
        out = await stub_complete(system, user, schema)
        if schema in (S.PlanSpec, S.DecomposeSpec):
            key = schema.__name__
            seen[key] = seen.get(key, 0) + 1
            if seen[key] == 1:
                data = out.model_dump()
                data["material_unknowns"] = [f"unknown at {key}"]
                out = schema.model_validate(data)
        return out

    return complete


# --------------------------------------------------------------------------
# any stage may originate
# --------------------------------------------------------------------------


async def test_intake_asks_nothing_for_a_settled_goal():
    """The control: without it, the next test proves nothing."""
    res = await run_plan(message=CLEAN, complete=_recorder([]), **_kw())
    assert res["kind"] == "ok", res


async def test_a_mid_graph_stage_can_originate_a_clarify():
    calls = []
    first = await run_plan(message=CLEAN, complete=_recorder(calls, unknown_at=S.PlanSpec), **_kw())
    assert first["kind"] == "clarify", first
    assert any("target level" in q["question"] for q in first["questions"])
    assert S.PlanSpec in [s for s, _ in calls]


async def test_the_origin_declares_where_execution_resumes():
    """Not intake. The plan stage asked, so the plan stage is where the answer lands."""
    calls = []
    complete = _recorder(calls, unknown_at=S.PlanSpec)
    first = await run_plan(message=CLEAN, complete=complete, **_kw())
    assert first["kind"] == "clarify"

    calls.clear()
    second = await run_plan(
        message=CLEAN,
        complete=complete,
        thread_id=first["thread_id"],
        resume=[{"id": first["questions"][0]["id"], "answer": "beginner"}],
        **_kw(),
    )
    assert second["kind"] == "ok", second
    assert calls[0][0] is S.PlanSpec, f"resumed at {calls[0][0].__name__}, not the plan stage"


async def test_the_answer_reaches_the_stage_that_asked():
    """The point of moving the fold out of intake.

    `n_decompose` is the sharpest case: it never re-enters intake, and its prompt
    had no `{context}` slot at all before this change — so a resume there would
    have re-decomposed the same weekly rows, blind to the answer it just asked for.
    """
    calls = []
    complete = _recorder(calls, unknown_at=S.DecomposeSpec)
    first = await run_plan(message=CLEAN, complete=complete, **_kw())
    assert first["kind"] == "clarify", first

    calls.clear()
    second = await run_plan(
        message=CLEAN,
        complete=complete,
        thread_id=first["thread_id"],
        resume=[{"id": first["questions"][0]["id"], "answer": "complete beginner"}],
        **_kw(),
    )
    assert second["kind"] == "ok", second
    shown = [u for s, u in calls if s is S.DecomposeSpec]
    assert shown, "the resumed turn must re-run the stage that asked"
    assert any("ANSWERS ALREADY GIVEN:" in u and "complete beginner" in u for u in shown), (
        "the resumed stage was not shown the answer it asked for"
    )


async def test_two_rounds_at_two_stages_run_to_a_plan():
    """Two origins, two resumes, the whole suffix — the longest realistic path."""
    calls = []
    complete = _two_stage_recorder(calls)

    first = await run_plan(message=CLEAN, complete=complete, **_kw())
    assert first["kind"] == "clarify", first

    second = await run_plan(
        message=CLEAN,
        complete=complete,
        thread_id=first["thread_id"],
        resume=[{"id": first["questions"][0]["id"], "answer": "a"}],
        **_kw(),
    )
    assert second["kind"] == "clarify", second

    third = await run_plan(
        message=CLEAN,
        complete=complete,
        thread_id=second["thread_id"],
        resume=[{"id": second["questions"][0]["id"], "answer": "b"}],
        **_kw(),
    )
    assert third["kind"] == "ok", third
    assert third["plan_items"]


# --------------------------------------------------------------------------
# the fold
# --------------------------------------------------------------------------


def test_the_answers_fold_is_idempotent():
    """Two rounds must leave ONE block.

    The old guarantee was intake's `not clarify_answers` gate, which ran the fold
    at most once. With several origins that guarantee is gone — and a second
    block would be invisible, because `client._answers` reads only the first.
    """
    once = N._fold_answers("some context", [{"id": "a", "answer": "1"}])
    twice = N._fold_answers(once, [{"id": "a", "answer": "1"}, {"id": "b", "answer": "2"}])

    assert twice.count("ANSWERS ALREADY GIVEN:") == 1
    assert "- a: 1" in twice and "- b: 2" in twice
    assert twice.startswith("some context")


def test_the_fold_keeps_the_string_the_offline_stub_parses():
    """With no API key every stage IS the stub, and it reads this back out."""
    from app.llm.client import _answers

    folded = N._fold_answers("", [{"id": "hours", "answer": "10"}])
    assert _answers(folded) == {"hours": "10"}


# --------------------------------------------------------------------------
# the forcing rule still cannot be talked out of asking
# --------------------------------------------------------------------------


async def test_a_repeated_unknown_is_not_asked_twice():
    """Dedupe, not the budget, is what stops the loop.

    A stage that re-detects the unknown it was just answered on would otherwise
    burn the whole clarify budget repeating itself — and then plan around the
    unknown anyway.
    """
    calls = []
    complete = _recorder(calls, unknown_at=S.PlanSpec, always=True)
    first = await run_plan(message=CLEAN, complete=complete, **_kw())
    assert first["kind"] == "clarify"

    second = await run_plan(
        message=CLEAN,
        complete=complete,
        thread_id=first["thread_id"],
        resume=[{"id": first["questions"][0]["id"], "answer": "beginner"}],
        **_kw(),
    )
    assert second["kind"] != "clarify", second
    assert second["kind"] in {"ok", "no_change"}, second


def test_a_stage_that_is_ending_the_turn_does_not_also_ask():
    """`result` wins — structurally, so no future router has to be careful."""
    state = initial_state(message="x")
    state["result"] = {"kind": "no_change"}
    assert N._clarify_request(
        state,
        origin="n_plan",
        resume="n_plan",
        prompt="p",
        unknowns=["u"],
        questions=[{"id": "q", "question": "?"}],
    ) == {}


def test_the_budget_is_a_backstop_not_the_livelock_guard():
    state = initial_state(message="x")
    state["clarify_rounds"] = N.MAX_CLARIFYING_ROUNDS
    assert N._clarify_request(
        state,
        origin="n_plan",
        resume="n_plan",
        prompt="p",
        unknowns=["something new"],
        questions=[{"id": "q", "question": "?"}],
    ) == {}


async def test_a_critique_that_asks_does_not_also_reject():
    """`PlacementCritique` already coerces a delta-less rejection to ok.

    An unknown-bearing critique that fell through would give this one node two
    overlapping escape hatches for "the placement is wrong", and the model would
    take whichever is cheaper to emit.
    """

    async def complete(system, user, schema):
        return S.PlacementCritique.model_validate(
            {"ok": False, "material_unknowns": ["whether weekends are available"]}
        )

    state = initial_state(message="x")
    state["place"] = {"slots": [{"task_id": "w0s0", "date": "2026-01-06"}]}
    out = await N.n_review(state, complete=complete)

    assert out.get("clarify_request"), out
    assert "review_rounds" not in out
    assert "result" not in out
    assert out["critique"]["ok"] is True, "the coerced rejection must not also stand"


# --------------------------------------------------------------------------
# reroute — regressing without asking anything
# --------------------------------------------------------------------------


def test_a_reroute_carries_no_questions_and_spends_no_round():
    """The "the answer invalidated the plan" case: move, don't ask."""
    state = initial_state(message="x")
    out = N._reroute(state, origin="n_decompose", resume="n_plan", reason="premise changed")

    req = out["clarify_request"]
    assert req["questions"] == []
    assert req["resume"] == "n_plan"
    assert "clarify_asked" not in out, "nothing was asked, so there is nothing to dedupe"


def test_a_reroute_payload_has_no_questions_to_ask():
    state = initial_state(message="x")
    state.update(N._reroute(state, origin="n_decompose", resume="n_plan", reason="r"))

    questions, _, resume = N._clarify_payload(state)
    assert questions == []
    assert resume == "n_plan"


def test_a_stage_with_nothing_to_ask_is_not_a_reroute():
    """The ordinary case. Conflating the two makes every stage divert forever."""
    state = initial_state(message="x")
    assert N._clarify_request(
        state,
        origin="n_plan",
        resume="n_plan",
        prompt="",
        unknowns=[],
        questions=[],
    ) == {}


# --------------------------------------------------------------------------
# routers
# --------------------------------------------------------------------------


def test_early_prefers_result_over_a_pending_request():
    state = initial_state(message="x")
    state["clarify_request"] = {"resume": "n_plan"}
    assert R._early(state) == "n_clarify"

    state["result"] = {"kind": "ok"}
    assert R._early(state) == END


def test_early_is_silent_when_there_is_nothing_to_do():
    assert R._early(initial_state(message="x")) is None


@pytest.mark.parametrize(
    "router",
    [R.after_intake, R.after_plan, R.after_decompose, R.after_review, R.after_propose],
)
def test_every_origin_router_is_wired_to_divert(router):
    """Five origins, five edges. A missing one fails at runtime, not compile time.

    LangGraph rejects a router that returns an undeclared target, and that raises
    out of `ainvoke` — which is the "never fail" invariant broken, not a degrade.
    """
    state = initial_state(message="x")
    state["clarify_request"] = {"resume": "n_plan"}
    assert router(state) == "n_clarify"


def test_at_start_ignores_a_stale_request():
    """`at_start` runs against checkpointed state on every new turn.

    A request left behind by a turn that crashed must not hijack the next turn's
    entry — which is exactly why `_early` is not used there.
    """
    state = initial_state(message="x")
    state["clarify_request"] = {"resume": "n_plan"}
    assert R.at_start(state) == "n_intake"


def test_after_clarify_resumes_where_the_origin_said():
    assert R.after_clarify(initial_state(message="x")) == "n_intake"

    state = initial_state(message="x")
    state["clarify_resume"] = "n_plan"
    assert R.after_clarify(state) == "n_plan"


# --------------------------------------------------------------------------
# re-execution safety, and the budget
# --------------------------------------------------------------------------


def test_the_interrupt_node_takes_no_model():
    """LangGraph re-executes a node from its first line on resume.

    So an `interrupt()` placed after a model call replays that call — and the
    second completion is what the resumed turn proceeds with, while the user
    answered questions from the first.
    """
    assert "complete" not in inspect.signature(N.n_clarify).parameters


async def test_the_interrupt_turn_does_not_replay_a_model_call():
    calls = []
    first = await run_plan(message=JOB, complete=_recorder(calls), **_kw())
    assert first["kind"] == "clarify"
    assert [s for s, _ in calls].count(S.IntakeSpec) == 1


def test_the_recursion_budget_is_set_explicitly():
    """`GraphRecursionError` is neither `LlmError` nor `ValueError`.

    It would escape `ainvoke` and break the "never fail" invariant (HLD §13), so
    the budget has to be a decision rather than the default 25 nobody chose.
    """
    assert _RECURSION_LIMIT > 25


# --------------------------------------------------------------------------
# compatibility, and the escalated-replan bug
# --------------------------------------------------------------------------


def test_a_thread_paused_before_clarify_request_existed_still_asks():
    """HLD §11.1 — the worst failure mode this change could have.

    A thread paused at `n_clarify` by an older deploy has no `clarify_request` in
    its checkpoint, and `n_clarify` re-executes from its first line on resume. If
    the payload read only the new key, every already-paused thread would come back
    with nothing to ask.
    """
    legacy = initial_state(message="x")
    legacy["intake"] = {
        "clarifying_questions": [{"id": "domain", "question": "Which role?"}],
        "framing_line": "Planning a goal.",
    }

    questions, prompt, resume = N._clarify_payload(legacy)
    assert questions == [{"id": "domain", "question": "Which role?"}]
    assert prompt == "Planning a goal."
    assert resume == "n_intake"


async def test_an_escalated_replan_can_still_clarify():
    """The bug this fixed.

    `_REPLAN_RESET` did not clear the clarify bookkeeping, so an escalated replan
    entered `n_intake` with the *previous* turn's answers already recorded — and
    the gate read that as "the user has been asked", so the mandatory-clarify
    invariant could not fire on a replan at all.
    """
    first = await run_plan(message=JOB, complete=_recorder([]), **_kw())
    assert first["kind"] == "clarify"

    second = await run_plan(
        message=JOB,
        complete=_recorder([]),
        thread_id=first["thread_id"],
        resume=[
            {"id": "domain", "answer": "data engineering"},
            {"id": "hours", "answer": "10"},
        ],
        **_kw(),
    )
    assert second["kind"] == "ok", second

    third = await run_replan(
        change={"kind": "milestone.moved"},
        thread_id=first["thread_id"],
        tier="escalate",
        complete=_recorder([]),
        message=JOB,
        **_kw(),
    )
    assert third["kind"] == "clarify", third
