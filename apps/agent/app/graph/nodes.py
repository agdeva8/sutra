"""The eleven nodes, one function each.

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

MAX_CLARIFYING_ROUNDS = 2
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
# 1. intake
# --------------------------------------------------------------------------


async def n_intake(state: dict, *, complete: CompleteFn) -> dict:
    """Classify the turn. May route to clarify, or end the turn early."""
    answers = state.get("clarify_answers") or []
    context = state.get("context") or ""
    if answers:
        # Fold prior answers into context so the next intake pass sees them —
        # this is what makes the clarify loop terminate. The augmented context
        # is WRITTEN BACK to state, not just used locally: every downstream
        # stage (plan, decompose, review, propose) needs to know what the user
        # said, or it plans around the question it just asked.
        lines = "\n".join(f"- {a.get('id')}: {a.get('answer')}" for a in answers)
        context = f"{context}\n\nANSWERS ALREADY GIVEN:\n{lines}"

    user = prompts.INTAKE.format(
        today=state.get("today"),
        existing=", ".join(state.get("existing_goal_titles") or []) or "none",
        context=context or "none",
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

    data = intake.model_dump()
    updates: dict[str, Any] = {"intake": data, "intent": intake.intent, "context": context}

    # The mandatory-clarify invariant (HLD §10). `IntakeSpec` already refuses a
    # material unknown without a question; this is the second gate — the graph
    # will not plan around an unknown even if a question was asked and ignored.
    rounds = state.get("clarify_rounds", 0)
    if intake.material_unknowns and not answers and rounds < MAX_CLARIFYING_ROUNDS:
        return updates  # router sends us to n_clarify

    return updates


async def n_clarify(state: dict) -> dict:
    """Pause for the user. One `interrupt()` per invocation (HLD §6)."""
    intake = state.get("intake") or {}
    questions = intake.get("clarifying_questions") or []
    answers = interrupt(
        {
            "kind": "clarify",
            "prompt": intake.get("framing_line")
            or "A couple of details would change the plan meaningfully:",
            "questions": questions,
        }
    )
    if isinstance(answers, dict):
        answers = [answers]
    return {
        "clarify_answers": list(answers or []),
        "clarify_rounds": state.get("clarify_rounds", 0) + 1,
    }


# --------------------------------------------------------------------------
# 2. plan — MEANING ONLY
# --------------------------------------------------------------------------


async def n_plan(state: dict, *, complete: CompleteFn) -> dict:
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

    return {"plan": plan.model_dump(), "intent": state.get("intent") or "add_goal"}


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

    return {"proposals": [action.model_dump()], "attempts": state.get("attempts", 0) + 1}


# --------------------------------------------------------------------------
# 10. validate — grounding, verdict in code
# --------------------------------------------------------------------------


async def n_validate(state: dict) -> dict:
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
