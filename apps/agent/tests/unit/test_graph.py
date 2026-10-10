"""Graph tests — offline, with the deterministic stub as the model.

These are the end-to-end tests: they drive the real LangGraph StateGraph,
including the clarify interrupt and the review loop, with no network.
"""
from __future__ import annotations

import pytest

from app.contracts import schemas as S
from app.graph.build import build_plan_graph, run_plan
from app.graph.state import initial_state
from app.llm.client import stub_complete

MON_FRI = {"mon": 2, "tue": 2, "wed": 2, "thu": 2, "fri": 2, "sat": 0, "sun": 0}


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


# --------------------------------------------------------------------------
# happy path
# --------------------------------------------------------------------------


async def test_add_goal_runs_to_ok_and_produces_a_plan():
    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=stub_complete,
        **_kw(),
    )
    assert res["kind"] == "ok", res
    items = res["plan_items"]
    assert items, "an ok run must produce plan items"
    horizons = {i["horizon"] for i in items}
    assert horizons == {"yearly", "quarterly", "monthly", "weekly", "daily"}
    assert res["prose"]


async def test_placement_is_recorded_and_verified_clean():
    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=stub_complete,
        **_kw(),
    )
    place = res["place"]
    assert place is not None
    assert place["solver"] == "cpsat"
    assert place["slots"], "the solver must place something"


# --------------------------------------------------------------------------
# clarify — the mandatory interrupt
# --------------------------------------------------------------------------


async def test_a_material_unknown_forces_a_clarifying_question():
    """The v1 bug: "change my job" assumed software engineering."""
    res = await run_plan(
        message="I want to change my job",
        complete=stub_complete,
        **_kw(),
    )
    assert res["kind"] == "clarify", res
    assert res["questions"], "a material unknown must produce a question"
    assert any("role" in q["question"].lower() for q in res["questions"])
    assert res["thread_id"]


async def test_resuming_with_an_answer_reaches_a_plan():
    first = await run_plan(
        message="I want to change my job",
        complete=stub_complete,
        **_kw(),
    )
    assert first["kind"] == "clarify"

    second = await run_plan(
        message="I want to change my job",
        complete=stub_complete,
        thread_id=first["thread_id"],
        resume=[{"id": "domain", "answer": "data engineering"}, {"id": "hours", "answer": "10"}],
        **_kw(),
    )
    assert second["kind"] == "ok", second
    assert second["plan_items"]


async def test_an_answer_reaches_the_plan_stage_not_just_intake():
    """The second half of the clarify bug.

    The answer has to persist into state's context, or every downstream stage
    plans around the question it just asked — intake knew the user said 10h, and
    the plan still used its own default.
    """
    first = await run_plan(message="I want to change my job", complete=stub_complete, **_kw())
    assert first["kind"] == "clarify"

    second = await run_plan(
        message="I want to change my job",
        complete=stub_complete,
        thread_id=first["thread_id"],
        resume=[{"id": "domain", "answer": "data engineering"}, {"id": "hours", "answer": "10"}],
        **_kw(),
    )
    assert second["kind"] == "ok"
    assert "weekly 10h" in second["prose"], second["prose"]
    # and the domain the user named shows up in the goal title
    assert any("data engineering" in i["title"] for i in second["plan_items"])


# --------------------------------------------------------------------------
# verify — layer 1 catches a forged bad placement
# --------------------------------------------------------------------------


async def test_verify_ends_the_turn_when_an_invariant_is_violated():
    """A solver bug must end the turn, not ship a bad plan."""
    from app.graph import nodes

    real_place = nodes.place

    def forged(tasks, availability, **kw):
        res = real_place(tasks, availability, **kw)
        if res.slots:
            res.slots[0].hours = 999.0  # breach capacity
        return res

    nodes.place = forged
    try:
        res = await run_plan(
            message="I want to learn system design, 8 hours a week over 3 months",
            complete=stub_complete,
            **_kw(),
        )
    finally:
        nodes.place = real_place

    assert res["kind"] == "no_change"
    assert "invariant" in res["reason"]


# --------------------------------------------------------------------------
# review — layer 2, and the determinism trap
# --------------------------------------------------------------------------


async def test_review_loop_terminates_because_deltas_change_the_input():
    """A rejecting reviewer must produce deltas, and the loop must converge."""
    from app.contracts import schemas as S
    from app.graph import nodes

    calls = {"review": 0}

    async def always_reject_then_accept(system, user, schema):
        if schema is S.PlacementCritique:
            calls["review"] += 1
            if calls["review"] == 1:
                # reject once, with a real constraint
                return S.PlacementCritique(
                    ok=False,
                    deltas=[S.ConstraintDelta(kind="allowed_days", task_id="w0s0", value=[2])],
                    rationale="keep the first step off Monday",
                )
            return S.PlacementCritique(ok=True, rationale="now it reads fine")
        return await stub_complete(system, user, schema)

    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=always_reject_then_accept,
        **_kw(),
    )
    assert calls["review"] >= 2, "the loop must actually re-run the review"
    assert res["kind"] == "ok"
    assert res["review_rounds"] == 1


async def test_review_that_never_accepts_ends_as_renegotiate():
    from app.contracts import schemas as S

    async def never_accept(system, user, schema):
        if schema is S.PlacementCritique:
            return S.PlacementCritique(
                ok=False,
                deltas=[S.ConstraintDelta(kind="allowed_days", task_id="w0s0", value=[2])],
                rationale="never good enough",
            )
        return await stub_complete(system, user, schema)

    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=never_accept,
        **_kw(),
    )
    # The loop is capped, so it must not spin — and it must not silently claim ok.
    assert res["kind"] in ("no_change", "renegotiate", "ok")
    assert res.get("review_rounds", 0) <= 2


async def test_review_exhaustion_reports_renegotiate_not_a_generic_no_change():
    """Out of rounds with a still-rejecting reviewer is `renegotiate`.

    `after_review` returns END here, so `n_review` has to write the terminal
    result itself. Without it `run_plan` synthesises "pipeline produced no
    result" and HLD §6's `renegotiate` — feasible but not sensible — never
    reaches the user.
    """
    from app.contracts import schemas as S

    async def never_accept(system, user, schema):
        if schema is S.PlacementCritique:
            return S.PlacementCritique(
                ok=False,
                deltas=[S.ConstraintDelta(kind="allowed_days", task_id="w0s0", value=[2])],
                rationale="never good enough",
            )
        return await stub_complete(system, user, schema)

    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=never_accept,
        **_kw(),
    )
    assert res["kind"] == "renegotiate", res
    assert "pipeline produced no result" not in res.get("reason", "")
    assert res["prose"] == "never good enough"


async def test_review_deltas_accumulate_across_rounds():
    """`deltas` has no reducer, so `n_review` merges by hand.

    Round 2 must still carry round 1's constraints. A bare assignment would drop
    them, and the re-solve would forget what the previous rejection asked for —
    which is exactly the convergence property the loop claims.
    """
    from app.contracts import schemas as S
    from app.graph import nodes

    async def reject(system, user, schema):
        if schema is S.PlacementCritique:
            return S.PlacementCritique(
                ok=False,
                deltas=[S.ConstraintDelta(kind="allowed_days", task_id="w0s1", value=[2])],
                rationale="second constraint",
            )
        return await stub_complete(system, user, schema)

    out = await nodes.n_review(
        {
            "place": {"slots": [{"task_id": "w0s0", "date": "2026-01-06"}]},
            "deltas": [{"kind": "pin", "task_id": "w0s0", "value": 1}],
            "review_rounds": 0,
        },
        complete=reject,
    )
    assert {d["kind"] for d in out["deltas"]} == {"pin", "allowed_days"}, (
        "the earlier round's delta was dropped"
    )
    assert out["review_rounds"] == 1


# --------------------------------------------------------------------------
# headroom — renegotiation
# --------------------------------------------------------------------------


async def test_an_overcommitted_plan_returns_renegotiation_options():
    res = await run_plan(
        message="I want to learn system design, 20 hours a week over 3 months",
        complete=stub_complete,
        **_kw(capacity_hours=20, active_goal_weekly_hours=[8]),
    )
    assert res["kind"] == "renegotiate", res
    assert "extend the timeline" in res["prose"]


# --------------------------------------------------------------------------
# no_change — the model fails, the turn still ends cleanly
# --------------------------------------------------------------------------


async def test_a_model_failure_becomes_no_change_with_a_reject_row():
    from app.llm.client import LlmError

    async def broken(system, user, schema):
        raise LlmError("model unreachable")

    res = await run_plan(
        message="I want to learn system design, 8 hours a week",
        complete=broken,
        **_kw(),
    )
    assert res["kind"] == "no_change"
    assert res["rejects"], "a rejection must be recorded for observability"
    assert res["rejects"][0]["stage"] == "intake"


async def test_a_plan_with_no_goal_is_no_change_not_a_crash():
    from app.contracts import schemas as S

    async def goal_less(system, user, schema):
        if schema is S.PlanSpec:
            return S.PlanSpec(goal=None, milestones=[], prose="")
        return await stub_complete(system, user, schema)

    res = await run_plan(
        message="I want to learn system design, 8 hours a week",
        complete=goal_less,
        **_kw(),
    )
    assert res["kind"] == "no_change"


# --------------------------------------------------------------------------
# graph shape
# --------------------------------------------------------------------------


def test_the_graph_compiles_and_has_the_expected_nodes():
    from langgraph.checkpoint.memory import InMemorySaver

    g = build_plan_graph(complete=stub_complete, checkpointer=InMemorySaver())
    nodes = set(g.get_graph().nodes)
    expected = {
        "n_intake",
        "n_clarify",
        "n_plan",
        "n_lattice",
        "n_decompose",
        "n_place",
        "n_verify",
        "n_review",
        "n_headroom",
        "n_propose",
        "n_validate",
    }
    assert expected <= nodes, f"missing: {expected - nodes}"


def test_initial_state_has_no_result_so_routers_keep_going():
    s = initial_state(message="hi")
    assert s["result"] is None
    assert s["rejects"] == []


# --------------------------------------------------------------------------
# replan — the same graph, a different door (HLD §9)
# --------------------------------------------------------------------------


def test_at_start_sends_a_fresh_run_to_intake():
    from app.graph import routers as R

    assert R.at_start(initial_state(message="hi")) == "n_intake"


def test_at_start_sends_a_slim_replan_to_place():
    from app.graph import routers as R

    s = initial_state(entry="replan", change={"kind": "blocker.add"}, tier="slim")
    s["tasks"] = [{"id": "w0s0"}]
    assert R.at_start(s) == "n_place"


def test_at_start_falls_back_to_intake_when_it_cannot_re_solve():
    """No change, no tier, or no task set: behave like an ordinary turn.

    The alternative is inventing a plan from an empty state, which is worse than
    doing the ordinary thing.
    """
    from app.graph import routers as R

    assert R.at_start(initial_state(entry="replan", tier="slim")) == "n_intake"
    assert R.at_start(initial_state(entry="replan", change={"k": 1})) == "n_intake"
    s = initial_state(entry="replan", change={"k": 1}, tier="slim")
    assert R.at_start(s) == "n_intake", "tasks is still [] — nothing to re-solve"


def test_a_checkpoint_written_before_entry_existed_reads_as_a_fresh_plan():
    """HLD §11.1 — adding a key is a compatibility promise, not a free change.

    Every checkpoint written before `entry` existed lacks it, so anything but
    "plan" as the default would route a legacy thread down the replan path.
    """
    from app.graph import routers as R

    legacy = {k: v for k, v in initial_state(message="hi").items() if k != "entry"}
    assert R.at_start(legacy) == "n_intake"


async def test_a_slim_replan_keeps_the_tasks_and_calls_no_meaning_stage():
    """The replan door must not re-derive meaning.

    `run_replan` seeds a minimal delta rather than `initial_state()`. The latter
    fills in `tasks: []`, `plan: None` and `items: []`, and LangGraph merges
    whatever it is handed into the checkpoint — so seeding with it would erase
    the very task set the replan exists to re-solve, silently.
    """
    from langgraph.checkpoint.memory import InMemorySaver

    from app.graph.build import run_replan

    cp = InMemorySaver()
    thread = "ephemeral-test-replan"

    first = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=stub_complete,
        checkpointer=cp,
        thread_id=thread,
        **_kw(),
    )
    assert first["kind"] == "ok", first

    seen: list[type] = []

    async def spy(system, user, schema):
        seen.append(schema)
        return await stub_complete(system, user, schema)

    second = await run_replan(
        change={"kind": "blocker.add", "blocker": "Goa trip"},
        tier="slim",
        adjustments=["Adjusting 3 day tasks around your Goa trip."],
        complete=spy,
        checkpointer=cp,
        thread_id=thread,
        **_kw(today="2026-01-06"),
    )

    assert second["kind"] == "ok", second
    assert S.PlanSpec not in seen, "a slim replan must not re-plan the meaning"
    assert S.DecomposeSpec not in seen, "a slim replan must not re-decompose"
    assert S.IntakeSpec not in seen, "a slim replan must not re-classify the turn"
    assert second["tier"] == "slim"
    assert second["adjustments"] == ["Adjusting 3 day tasks around your Goa trip."]
    assert second["proposals"] == [], "a slim replan has no modal to hold"

    snapshot = await build_plan_graph(complete=stub_complete, checkpointer=cp).aget_state(
        {"configurable": {"thread_id": thread}}
    )
    assert snapshot.values.get("tasks"), "the task set did not survive the replan"


async def test_a_fresh_run_is_unaffected_by_the_replan_door():
    """The conditional START must not change the ordinary path."""
    res = await run_plan(
        message="I want to learn system design, 8 hours a week over 3 months",
        complete=stub_complete,
        **_kw(),
    )
    assert res["kind"] == "ok", res
    # Absent, not `None` on purpose: only `n_replan_done` writes `tier`, and the
    # absence is what tells the caller the slim door was not taken.
    assert "tier" not in res, res
    assert res["adjustments"] == []


# --------------------------------------------------------------------------
# a real-model-shaped run — the payload that broke the first DeepSeek attempt
# --------------------------------------------------------------------------


async def test_a_run_survives_the_payload_shape_a_real_model_returns():
    """End to end, through `_parse` exactly as the real provider uses it.

    The stub is tidy by construction, so it never caught this: DeepSeek returned
    `material_unknowns` as `{key, reason}` dicts, omitted every question `id`,
    and volunteered `confidence` / `can_plan` / `next_action`. That was 23
    validation errors and no plan. Here the same shapes run the whole graph.
    """
    import json

    from app.llm.client import _parse

    payloads = {
        S.IntakeSpec: {
            "intent": "add_goal",
            "material_unknowns": [{"key": "hours_per_week", "reason": "not stated"}],
            "clarifying_questions": [
                {
                    "question": "How many hours a week?",
                    "options": [{"label": "3–5"}, {"label": "6–10"}],
                    "format": "single_choice",
                }
            ],
            "framing_line": "Planning a goal.",
            "confidence": 0.9,
            "can_plan": False,
        },
        S.PlanSpec: {
            "goal": {
                "title": "Learn system design",
                "horizon": "short",
                "why": "the user asked",
                "first_action": "Block 2h",
                "start_date": "2026-01-05",
                "target_date": "2026-04-05",
                "weekly_hours": 8,
                "phase_objectives": ["Foundations", "  ", "Mocks", "Full loops", "Extra"],
            },
            "milestones": [
                {"title": "Baseline done", "phase": "Foundations", "rationale": "r"},
                {"title": "Five mocks", "phase": "Mocks", "rationale": "r"},
            ],
            "prose": "90 days, 4 phases.",
            "confidence": 0.7,
        },
        S.DecomposeSpec: {
            "steps": {
                "Baseline done": {"steps": [{"title": "Read ch 1", "est_hours": 2, "priority": 4}]},
            },
            "notes": "generated",
        },
        S.PlacementCritique: {"ok": False, "rationale": "feels crammed", "confidence": 0.4},
        S.ReplanAction: {
            "intent": "add_goal",
            "changes": {"title": "Learn system design"},
            "rationale": "as asked",
            "next_action": "done",
        },
    }

    async def real_shaped(system: str, user: str, schema):
        return _parse(json.dumps(payloads[schema]), schema)

    first = await run_plan(message="I want to learn system design", complete=real_shaped, **_kw())
    # A material unknown routes to clarify rather than planning around a guess.
    assert first["kind"] == "clarify", first
    assert first["questions"][0]["id"], "the graph needs a key to hang the answer on"

    second = await run_plan(
        message="I want to learn system design",
        complete=real_shaped,
        thread_id=first["thread_id"],
        resume=[{"id": first["questions"][0]["id"], "answer": "8"}],
        **_kw(),
    )
    # The bare rejection was coerced to ok, so the plan lands rather than
    # spinning to the review cap.
    assert second["kind"] == "ok", second
    assert second["plan_items"]
    assert second["review_rounds"] == 0
