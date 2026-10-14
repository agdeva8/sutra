"""The twelve nodes, one function each.

Every node obeys the same two rules:

* **Never raise for a model/solver failure.** Set `result` and let the router
  end the turn. A programmer error still propagates (HLD §13).
* **The LLM is injected**, never imported — `complete` arrives via closure.

Nodes are deliberately granular (HLD §6): `place`, `verify`, `headroom` and
`validate` are separate nodes rather than calls inside `n_plan`, because each is
pure, independently retryable, and independently testable.
"""
from __future__ import annotations

from typing import Any

from langgraph.types import interrupt

from app import prompts
from app.contracts import schemas as S
from app.core.headroom import RENEGOTIATION_OPTIONS, check_headroom
from app.core.lattice import build_lattice
from app.core.place import place
from app.core.staleness import build_adjustments, classify_change, make_change
from app.core.util import add_days, days_between
from app.core.validate import cross_validate, summarise, verify_placement
from app.llm.client import CompleteFn, LlmError

#: The clarify budget for one turn. Not the livelock guard any more — `dedupe
#: on the unknown name` is (see `_clarify_request`) — because several stages can
#: now ask, and a budget spent refusing to repeat a question is a budget that
#: silently stops a *legitimate* one. This is the backstop on user patience.
MAX_CLARIFYING_ROUNDS = 3
MAX_REVIEW_ROUNDS = 2
MAX_EMIT_ATTEMPTS = 2

#: Intents that must reach the plan stage even when the turn looks conversational.
SCOPED_ACTION_INTENTS = frozenset({"review_progress", "edit_goal", "plan_day", "replan"})


def _reject(state: dict, stage: str, reason: str) -> list[dict]:
    """One observability row per rejection, so reject rate is measurable per stage."""
    return [
        {
            "intent": state.get("intent"),
            "stage": stage,
            "reason": reason[:400],
            "recovered": False,
        }
    ]


def _no_change(stage: str, reason: str, prose: str = "") -> dict:
    return {"kind": "no_change", "reason": f"{stage}: {reason}", "prose": prose}


# --------------------------------------------------------------------------
# Clarify — the one interrupt, and the one way to ask for it
# --------------------------------------------------------------------------

#: The delimiter `app.llm.client._answers` parses back out to drive the offline
#: stub. Changing it silently changes what the stub believes the user said.
_ANSWERS_HEADER = "ANSWERS ALREADY GIVEN:"


def _strip_answers(context: str) -> str:
    """Drop a previously folded answers block, so re-folding is idempotent.

    The fold runs once per clarify round now, and the guarantee that it ran at
    most once used to come from intake's `not clarify_answers` gate. Without the
    strip a second round appends a second block, and `client._answers` reads only
    the first — so the duplication is invisible and the context grows every round.
    """
    head, sep, _ = context.partition(f"\n\n{_ANSWERS_HEADER}\n")
    if sep:
        return head
    head, sep, _ = context.partition(f"{_ANSWERS_HEADER}\n")
    return head if sep else context


def _fold_answers(context: str, answers: list[dict]) -> str:
    """Fold every answer so far into the context every downstream stage reads.

    Written by `n_clarify` rather than `n_intake` because a mid-plan resume can
    land on a stage that never re-enters intake — and that stage still has to see
    the answer, or it plans around the question it just asked.
    """
    lines = "\n".join(f"- {a.get('id')}: {a.get('answer')}" for a in answers)
    return f"{_strip_answers(context or '')}\n\n{_ANSWERS_HEADER}\n{lines}"


def _clarify_request(
    state: dict,
    *,
    origin: str,
    resume: str,
    prompt: str,
    unknowns: list[str],
    questions: list[dict],
    reason: str = "",
) -> dict:
    """The one way a stage asks the graph to interrupt. `{}` when it may not.

    Every stage that can find a material unknown calls this instead of calling
    `interrupt()` itself — it *cannot* call it: LangGraph re-executes a node from
    its first line on resume (`langgraph/types.py`: "The graph resumes from the
    start of the node, re-executing all logic"), so an interrupt placed after a
    model call would replay that call on every resume. Worse than paying twice,
    the second completion is what the resumed turn proceeds with, while the user
    answered questions from the first. One interrupt node, kept free of model and
    solver work above the `interrupt()` call, is what avoids that.

    The forcing rule (HLD §10) lives here rather than in a router, so it is one
    gate instead of two that can disagree.

    `origin` and `resume` are code constants, never model output: the model may
    divert to the interrupt, but it never chooses where control returns. That is
    what keeps the reachable path set statically enumerable (HLD §6).
    """
    if state.get("result") is not None:
        # A stage that is ending the turn must not also ask. `_early` would drop
        # the request anyway, but making it structural means no future router has
        # to be careful about the order.
        return {}

    if not questions and not unknowns:
        # Nothing to ask — the ordinary case for a stage that found no unknown.
        # A *deliberate* move without a question is `_reroute`, not this: they
        # are not the same request and conflating them makes every stage divert.
        return {}

    asked = list(state.get("clarify_asked") or [])
    fresh = [u for u in unknowns if u not in asked]
    if not fresh:
        # Nothing new to ask. This is what stops a resumed stage re-asking the
        # unknown it was just answered on — without it a turn burns its whole
        # budget repeating itself and then plans around the unknown anyway.
        return {}
    if state.get("clarify_rounds", 0) >= MAX_CLARIFYING_ROUNDS:
        return {}

    return {
        "clarify_request": {
            "origin": origin,
            "resume": resume,
            "prompt": prompt,
            "questions": questions,
            "reason": reason,
        },
        "clarify_asked": [*asked, *fresh],
    }


def _reroute(state: dict, *, origin: str, resume: str, reason: str) -> dict:
    """Ask the graph to move, without asking the user anything.

    A resumed stage that finds the answer has invalidated the plan needs to
    regress — `n_decompose` was answered "complete beginner" and the milestones
    assume five years. It expresses that as a clarify request carrying a target
    and no questions, which travels the same key, node and edges as a real one:
    the router diverts, `n_clarify` finds nothing to ask, and simply re-routes.

    Reusing the clarify plumbing rather than adding a routing key of its own is
    deliberate. A routing key would have to be cleared by whichever node it
    landed on, and every origin router reads it — so a stale value would send the
    graph back to the same node forever. This one is consumed by `n_clarify` in
    the same turn it was written, so it cannot outlive its use.
    """
    if state.get("result") is not None:
        return {}
    return {
        "clarify_request": {
            "origin": origin,
            "resume": resume,
            "prompt": "",
            "questions": [],
            "reason": reason,
        }
    }


def _clarify_payload(state: dict) -> tuple[list[dict], str, str]:
    """Resolve `(questions, prompt, resume)` for this `n_clarify` invocation.

    Split out of the node so the compatibility promise below is testable:
    `interrupt()` needs a running task's scratchpad, so a node that calls it
    cannot be invoked directly from a test.

    The `intake` fallback is compatibility, not defensiveness — a thread paused
    here by an older deploy has no `clarify_request` in its checkpoint, and
    `n_clarify` re-executes from its first line when that thread resumes
    (HLD §11.1). Without it, every already-paused thread comes back with nothing
    to ask.
    """
    req = state.get("clarify_request") or {}
    intake = state.get("intake") or {}
    questions = req.get("questions") or intake.get("clarifying_questions") or []
    prompt = req.get("prompt") or intake.get("framing_line") or ""
    return questions, prompt, req.get("resume") or "n_intake"


# --------------------------------------------------------------------------
# 1. intake
# --------------------------------------------------------------------------


async def n_intake(state: dict, *, complete: CompleteFn) -> dict:
    """Classify the turn. May route to clarify, or end the turn early."""
    user = prompts.INTAKE.format(
        today=state.get("today"),
        existing=", ".join(state.get("existing_goal_titles") or []) or "none",
        context=state.get("context") or "none",
        message=state.get("message", ""),
    )
    try:
        intake = await complete(prompts.BASE, user, S.IntakeSpec)
    except (LlmError, ValueError) as exc:
        return {
            "intake": None,
            "rejects": _reject(state, "intake", str(exc)),
            "result": _no_change("intake", str(exc)),
        }

    updates: dict[str, Any] = {"intake": intake.model_dump(), "intent": intake.intent}
    # The mandatory-clarify invariant (HLD §10), through the same gate every
    # other stage uses. The answers reach this prompt via `state["context"]`,
    # which `n_clarify` folds — intake no longer folds them itself, because a
    # mid-plan resume can reach a stage that never comes back through here.
    updates.update(
        _clarify_request(
            state,
            origin="n_intake",
            resume="n_intake",
            prompt=intake.framing_line,
            unknowns=intake.material_unknowns,
            questions=[q.model_dump() for q in intake.clarifying_questions],
            reason="material unknown at intake",
        )
    )
    return updates


async def n_clarify(state: dict) -> dict:
    """Pause for the user — or re-route. One `interrupt()` per invocation (HLD §6).

    Deliberately does no model or solver work before the `interrupt()` call:
    LangGraph re-executes this node from its first line on resume, so anything
    expensive above it would be paid for twice, and the second result is the one
    that would drive the resumed turn.
    """
    questions, prompt, resume = _clarify_payload(state)

    if not questions:
        # A reroute, not a question: the origin saw the answer and the premise
        # changed. No round is spent and no interrupt is raised.
        return {"clarify_request": None, "clarify_resume": resume}

    answers = interrupt(
        {
            "kind": "clarify",
            "prompt": prompt or "A couple of details would change the plan meaningfully:",
            "questions": questions,
        }
    )
    if isinstance(answers, dict):
        answers = [answers]
    all_answers = [*(state.get("clarify_answers") or []), *list(answers or [])]

    return {
        "clarify_answers": all_answers,
        "clarify_rounds": state.get("clarify_rounds", 0) + 1,
        "context": _fold_answers(state.get("context") or "", all_answers),
        "clarify_request": None,  # consume the inbox
        "clarify_resume": resume,  # publish the outbox
    }


# --------------------------------------------------------------------------
# 2. plan — MEANING ONLY
# --------------------------------------------------------------------------


async def n_plan(state: dict, *, complete: CompleteFn) -> dict:
    """MEANING ONLY: the goal, its phases and its milestones.

    No dates — those come from the solver in `n_place`. A plan with no goal is
    a rejection, not a plan to repair.
    """
    user = prompts.PLAN.format(
        today=state.get("today"),
        existing=", ".join(state.get("existing_goal_titles") or []) or "none",
        context=state.get("context") or "none",
        message=state.get("message", ""),
    )
    try:
        plan = await complete(prompts.BASE, user, S.PlanSpec)
    except (LlmError, ValueError) as exc:
        return {"rejects": _reject(state, "plan", str(exc)), "result": _no_change("plan", str(exc))}

    if plan.goal is None:
        return {
            "rejects": _reject(state, "plan", "no goal in plan"),
            "result": _no_change("plan", "the model returned no goal"),
        }

    updates: dict[str, Any] = {
        "plan": plan.model_dump(),
        "intent": state.get("intent") or "add_goal",
    }
    updates.update(
        _clarify_request(
            state,
            origin="n_plan",
            resume="n_plan",
            prompt=plan.framing_line,
            unknowns=plan.material_unknowns,
            questions=[q.model_dump() for q in plan.clarifying_questions],
            reason="material unknown at plan",
        )
    )
    return updates


# --------------------------------------------------------------------------
# 3. lattice — pure structure
# --------------------------------------------------------------------------


async def n_lattice(state: dict) -> dict:
    """Build the structure. A failure here is NON-FATAL (HLD §13)."""
    plan = state.get("plan") or {}
    if not plan.get("goal"):
        return {"result": _no_change("lattice", "no plan to lay out")}

    goal = S.GoalSpec.model_validate(plan["goal"])
    milestones = [S.MilestoneSpec.model_validate(m) for m in plan.get("milestones", [])]
    out = build_lattice(goal=goal, milestones=milestones, today=state.get("today", goal.start_date))

    updates: dict[str, Any] = {
        "lattice": {
            "items": [i.model_dump() for i in out.items],
            "milestones": [m.__dict__ for m in out.milestones],
            "spans": [s.__dict__ for s in out.spans],
            "error": out.error,
        },
        "items": [i.model_dump() for i in out.items],
    }
    if out.error:
        # Carried, not fatal: the plan continues with whatever structure exists.
        updates["rejects"] = _reject(state, "lattice", out.error)
    return updates


# --------------------------------------------------------------------------
# 4. decompose — the LLM's CONSTRAINT input
# --------------------------------------------------------------------------


async def n_decompose(state: dict, *, complete: CompleteFn) -> dict:
    """Weekly rows → steps carrying effort, priority, dependencies.

    This is where the LLM contributes *constraint knowledge* the solver cannot
    infer — how long a step takes, what must precede it. It contributes no dates.
    """
    items = [S.PlanItemRow.model_validate(i) for i in state.get("items", [])]
    weekly = [i for i in items if i.horizon == "weekly"]
    if not weekly:
        return {"tasks": []}

    rows = "\n".join(f"- {i.title} | {i.weekly_hours or 2:g}h" for i in weekly)
    user = prompts.DECOMPOSE.format(
        availability=state.get("availability") or "{}",
        rows=rows,
        context=state.get("context") or "none",
    )
    try:
        spec = await complete(prompts.BASE, user, S.DecomposeSpec)
    except (LlmError, ValueError) as exc:
        # Fallback: one deterministic step per week, so nothing vanishes.
        spec = S.DecomposeSpec(
            steps={
                i.title: [S.DecomposeStep(title=f"{i.title} — step 1/1", est_hours=float(i.weekly_hours or 2))]
                for i in weekly
            }
        )
        note = _reject(state, "decompose", str(exc))

    tasks = _tasks_from(spec, weekly, state)
    updates: dict[str, Any] = {"tasks": [t.model_dump() for t in tasks]}
    if "note" in dir():
        updates["rejects"] = note
    updates.update(
        _clarify_request(
            state,
            origin="n_decompose",
            resume="n_decompose",
            prompt=spec.framing_line,
            unknowns=spec.material_unknowns,
            questions=[q.model_dump() for q in spec.clarifying_questions],
            reason="material unknown at decompose",
        )
    )
    return updates


def _tasks_from(
    spec: S.DecomposeSpec, weekly: list[S.PlanItemRow], state: dict
) -> list[S.HorizonTask]:
    """One `HorizonTask` per step, windowed to its week. No date is chosen here."""
    goal = (state.get("plan") or {}).get("goal") or {}
    goal_hours = float(goal.get("weekly_hours") or 8)
    tasks: list[S.HorizonTask] = []

    for i, row in enumerate(weekly):
        steps = spec.steps.get(row.title) or []
        window_start = row.start_date or state.get("today", "")
        window_end = row.end_date or window_start
        if days_between(window_start, window_end) < 0:
            window_end = add_days(window_start, 6)

        # The 20% buffer shortens the LAST band of every span (a 7-day band can
        # come out 3 days). A short band cannot hold a full week's work, so the
        # effort is scaled to its real length — otherwise every span ends with
        # systematically unplaceable steps.
        band_days = days_between(window_start, window_end) + 1
        scale = min(1.0, band_days / 7.0)

        for j, step in enumerate(steps[:7]):
            tid = f"w{i}s{j}"
            tasks.append(
                S.HorizonTask(
                    id=tid,
                    title=step.title,
                    phase=row.phase,
                    window_start=window_start,
                    window_end=window_end,
                    est_hours=max(0.5, round(step.est_hours * scale, 1)),
                    priority=step.priority,
                    order=j,
                    goal_id=state.get("goal_id") or "goal",
                    goal_priority=int(goal.get("priority") or 3),
                    depends_on=[d for d in step.depends_on if d],
                    session_max_hours=step.session_max_hours,
                )
            )

    # Dependencies arrive by TITLE; the solver needs ids.
    by_title = {t.title: t.id for t in tasks}
    out: list[S.HorizonTask] = []
    for t in tasks:
        deps = [by_title[d] for d in t.depends_on if d in by_title and by_title[d] != t.id]
        out.append(t.model_copy(update={"depends_on": deps}))
    return out


# --------------------------------------------------------------------------
# 5. place — the only writer of dates
# --------------------------------------------------------------------------


async def n_place(state: dict) -> dict:
    """One CP-SAT solve across every goal. Reproducible; never fails the turn."""
    tasks = [S.HorizonTask.model_validate(t) for t in state.get("tasks", [])]
    if not tasks:
        return {"place": S.PlaceResult(feasible=True, solver="cpsat", detail="no tasks").model_dump()}

    avail = S.Availability(
        hours=state.get("availability") or {},
        blocked_dates=state.get("blocked_dates") or [],
        weekly_budget_hours=state.get("weekly_budget_hours"),
    )
    deltas = [S.ConstraintDelta.model_validate(d) for d in state.get("deltas", [])]
    res = place(tasks, avail, deltas=deltas, today=state.get("today"))
    return {"place": res.model_dump()}


# --------------------------------------------------------------------------
# 6. verify — layer 1, code only
# --------------------------------------------------------------------------


async def n_verify(state: dict) -> dict:
    """Hard invariants. A violation is a BUG, so the turn ends `no_change`."""
    tasks = [S.HorizonTask.model_validate(t) for t in state.get("tasks", [])]
    place_raw = state.get("place")
    if not tasks or not place_raw:
        return {}

    avail = S.Availability(
        hours=state.get("availability") or {},
        blocked_dates=state.get("blocked_dates") or [],
        weekly_budget_hours=state.get("weekly_budget_hours"),
    )
    res = S.PlaceResult.model_validate(place_raw)
    violations = verify_placement(tasks, avail, res)
    if violations:
        return {
            "verify_errors": violations,
            "rejects": _reject(state, "verify", "; ".join(violations)),
            "result": _no_change(
                "verify",
                "placement violated a hard invariant — this is a solver bug",
            ),
        }
    return {"verify_errors": []}


# --------------------------------------------------------------------------
# 7. review — layer 2, semantic
# --------------------------------------------------------------------------


async def n_review(state: dict, *, complete: CompleteFn) -> dict:
    """Does the placement make SENSE? Rejection must carry constraint deltas.

    Without deltas the loop cannot converge: CP-SAT is deterministic, so
    re-solving unchanged input returns the identical plan (HLD §8.6).
    """
    place_raw = state.get("place") or {}
    slots = place_raw.get("slots") or []
    if not slots:
        return {"critique": {"ok": True, "deltas": [], "rationale": "nothing placed"}}

    placement = "\n".join(f"- {s['task_id']} {s['date']}" for s in slots)
    user = prompts.REVIEW.format(
        availability=state.get("availability") or "{}",
        blockers=state.get("blocked_dates") or "none",
        placement=placement,
        context=state.get("context") or "none",
    )
    try:
        critique = await complete(prompts.BASE, user, S.PlacementCritique)
    except (LlmError, ValueError) as exc:
        # A review we cannot parse must not block the plan — proceed, and record it.
        return {
            "critique": {"ok": True, "deltas": [], "rationale": f"review unavailable: {exc}"},
            "rejects": _reject(state, "review", str(exc)),
        }

    updates: dict[str, Any] = {"critique": critique.model_dump()}

    # A critique that reports a material unknown is ASKING, not rejecting, and
    # it short-circuits. `PlacementCritique` already coerces a delta-less
    # rejection to ok, so letting an unknown-bearing critique fall through would
    # give this one node two overlapping escape hatches for "the placement is
    # wrong" — and the model would take whichever is cheaper to emit.
    request = _clarify_request(
        state,
        origin="n_review",
        resume="n_plan",
        prompt=critique.framing_line,
        unknowns=critique.material_unknowns,
        questions=[q.model_dump() for q in critique.clarifying_questions],
        reason="material unknown at review",
    )
    if request:
        updates.update(request)
        return updates

    if not critique.ok:
        # Accumulate: round 2 sees round 1's constraints, so the loop converges.
        # `deltas` has no reducer (unlike `rejects`), so the merge is written out
        # explicitly — a bare assignment silently discards the earlier round's
        # constraints and makes this comment false.
        updates["deltas"] = [
            *(state.get("deltas") or []),
            *(d.model_dump() for d in critique.deltas),
        ]
        rounds = state.get("review_rounds", 0) + 1
        updates["review_rounds"] = rounds
        updates["rejects"] = _reject(state, "review", critique.rationale or "rejected")
        if rounds >= MAX_REVIEW_ROUNDS:
            # `after_review` sends us to END from here, so the terminal result has
            # to be written now. Without it `run_plan` synthesises a generic
            # `no_change`, and HLD §6's `renegotiate` — "feasible but not
            # sensible" — never reaches the user.
            updates["result"] = {
                "kind": "renegotiate",
                "reason": "feasible but not sensible after the review rounds",
                "prose": critique.rationale or "",
                "proposals": [],
            }
    return updates


# --------------------------------------------------------------------------
# 8. headroom — pure capacity gate
# --------------------------------------------------------------------------


async def n_headroom(state: dict) -> dict:
    """Pure capacity gate: does the new goal fit beside the active ones?

    Over budget ends the turn as `renegotiate` with the options to pick from.
    Pure — no model call, no solver.
    """
    plan = state.get("plan") or {}
    goal = plan.get("goal") or {}
    new_hours = float(goal.get("weekly_hours") or 0)

    h = check_headroom(
        new_goal_hours=new_hours,
        active_goal_hours=list(state.get("active_goal_weekly_hours") or []),
        capacity_hours=float(state.get("capacity_hours") or 40),
    )
    updates: dict[str, Any] = {"headroom": h.__dict__}

    if h.over:
        updates["result"] = {
            "kind": "renegotiate",
            "reason": h.detail,
            "prose": "Pick one:\n"
            + "\n".join(f"  {i}. {o}" for i, o in enumerate(RENEGOTIATION_OPTIONS, 1)),
            "proposals": [],
        }
    return updates


# --------------------------------------------------------------------------
# 9. propose — one action, intent-discriminated
# --------------------------------------------------------------------------


async def n_propose(state: dict, *, complete: CompleteFn) -> dict:
    """One action, discriminated by intent, emitted as a `ReplanAction`.

    On a retry the previous rejection is folded back into the prompt — that is
    what makes the re-emit a repair rather than a fresh guess.
    """
    plan = state.get("plan") or {}
    goal = plan.get("goal") or {}
    context = state.get("context") or "none"

    if state.get("cv_errors"):
        context = (
            f"{context}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n"
            f"{summarise(state['cv_errors'])}\nFix exactly these and re-emit."
        )

    user = (
        f"{prompts.PROPOSE}\n\nGoal: {goal.get('title')}\n"
        f"Intent: {state.get('intent')}\nContext: {context}\n"
        f"User: {state.get('message', '')}"
    )
    try:
        action = await complete(prompts.BASE, user, S.ReplanAction)
    except (LlmError, ValueError) as exc:
        return {
            "attempts": state.get("attempts", 0) + 1,
            "rejects": _reject(state, "propose", str(exc)),
            "result": _no_change("propose", str(exc)),
        }

    # Attach the goal id when the action targets an existing goal.
    if action.intent != "add_goal" and not action.goal_id:
        action = action.model_copy(update={"goal_id": state.get("goal_id") or "goal"})

    updates: dict[str, Any] = {
        "proposals": [action.model_dump()],
        "attempts": state.get("attempts", 0) + 1,
    }
    updates.update(
        _clarify_request(
            state,
            origin="n_propose",
            resume="n_propose",
            prompt=action.framing_line,
            unknowns=action.material_unknowns,
            questions=[q.model_dump() for q in action.clarifying_questions],
            reason="material unknown at propose",
        )
    )
    return updates


# --------------------------------------------------------------------------
# 10. validate — grounding, verdict in code
# --------------------------------------------------------------------------


async def n_validate(state: dict) -> dict:
    """Grounding: is every claimed item actually in the plan? Verdict in code.

    A failure bounces back to `n_propose` while attempts remain; past
    `MAX_EMIT_ATTEMPTS` the turn ends `no_change` rather than shipping an
    ungrounded proposal. Pure — no model call.
    """
    actions = [S.ReplanAction.model_validate(p) for p in state.get("proposals", [])]
    items = [S.PlanItemRow.model_validate(i) for i in state.get("items", [])]
    plan = state.get("plan") or {}
    milestones = [m.get("title") for m in (plan.get("milestones") or [])]

    errors = cross_validate(
        actions,
        items,
        existing_goal_titles=list(state.get("existing_goal_titles") or []),
        plan_goal_title=(plan.get("goal") or {}).get("title"),
        planned_milestone_titles=milestones,
    )
    if errors:
        attempts = state.get("attempts", 0)
        if attempts < MAX_EMIT_ATTEMPTS:
            return {"cv_errors": errors, "rejects": _reject(state, "validate", "; ".join(errors))}
        return {
            "cv_errors": errors,
            "rejects": _reject(state, "validate", "; ".join(errors)),
            "result": _no_change("validate", "actions could not be grounded in the plan"),
        }

    return {"cv_errors": [], "result": _ok(state)}


def _ok(state: dict) -> dict:
    plan = state.get("plan") or {}
    goal = plan.get("goal") or {}
    place_raw = state.get("place") or {}
    unscheduled = set(place_raw.get("unscheduled") or [])

    items = _mark_over_capacity(state.get("items", []), state.get("tasks", []), place_raw, unscheduled)

    return {
        "kind": "ok",
        "prose": plan.get("prose") or "",
        "proposals": state.get("proposals") or [],
        "plan_items": items,
        "place": place_raw,
        "review_rounds": state.get("review_rounds", 0),
        "goal_title": goal.get("title"),
        "headroom": state.get("headroom"),
        "rejects": [],
    }


async def n_replan_done(state: dict) -> dict:
    """The slim replan terminal — the solver's new dates, and nothing else.

    A day-level move is not a proposal. HLD §9.2 locks scheduling fields as auto
    and semantic fields as confirm, so `proposals` is emptied rather than
    populated: a slim replan has no modal to hold.

    It sits after `n_verify` *and* `n_review` on purpose. Skipping `n_verify`
    would punch a hole in the layer-1 invariant gate, and skipping `n_review`
    would mean a re-solve is never sanity-checked — and a re-solve is exactly
    when a constraint change can produce something absurd.
    """
    return {
        "proposals": [],
        "result": {
            **_ok(state),
            "proposals": [],
            "tier": "slim",
            "adjustments": list(state.get("adjustments") or []),
            "change": state.get("change"),
        },
    }


def _mark_over_capacity(
    items: list[dict], tasks: list[dict], place_raw: dict, unscheduled: set[str]
) -> list[dict]:
    """Stamp `(over capacity)` on the daily rows of steps that did not fit.

    The shortfall must be visible in the plan, not silently absent (HLD §8.4).
    """
    if not unscheduled:
        return items
    by_id = {t["id"]: t for t in tasks}
    titles = {by_id[t]["title"] for t in unscheduled if t in by_id}
    out = []
    for i in items:
        if i.get("horizon") == "daily" and any(t and t in (i.get("note") or "") for t in titles):
            i = {**i, "note": f"{i.get('note', '')} (over capacity)".strip()}
        out.append(i)
    return out
