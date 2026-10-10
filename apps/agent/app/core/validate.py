"""Verification — two layers, both in code. PURE.

`verify_placement` is layer 1 (HLD §8.6): hard invariants the solver must never
violate. A failure here means the solver is buggy or the fallback ran — it is a
bug to fix, not a plan to renegotiate, so the caller ends the turn `no_change`.

`cross_validate` is the grounding check: every proposed action must trace to the
plan or to an existing goal. **The verdict is computed here, never by the LLM.**
"""
from __future__ import annotations

from collections import defaultdict

from app.contracts.schemas import (
    Availability,
    HorizonTask,
    PlaceResult,
    PlanItemRow,
    ReplanAction,
)
from app.core.util import iso_year_week


def verify_placement(
    tasks: list[HorizonTask],
    availability: Availability,
    result: PlaceResult,
) -> list[str]:
    """Return every hard-invariant violation. Empty list ⇒ sound placement.

    Structural placement is exempt from the capacity checks by design: it is the
    degraded path and is *expected* to overflow. Its slots are still checked for
    window containment, which it cannot violate.
    """
    violations: list[str] = []
    by_id = {t.id: t for t in tasks}
    slots = result.by_task()

    unknown = set(slots) - set(by_id)
    if unknown:
        violations.append(f"slots reference unknown tasks: {sorted(unknown)}")

    # A task MAY span several days — a step longer than one day's capacity has
    # to be split, or it can never be placed at all. What must hold is that a
    # task is never given more hours than it asked for.
    hours_by_task = result.hours_by_task()
    for tid, hours in hours_by_task.items():
        t = by_id.get(tid)
        if t is not None and hours > t.est_hours + 1e-6:
            violations.append(
                f"task {tid}: {hours:g}h placed against a {t.est_hours:g}h estimate"
            )

    # window containment + blocked days
    blocked = set(availability.blocked_dates)
    for s in result.slots:
        t = by_id.get(s.task_id)
        if t is None:
            continue
        if not (t.window_start <= s.date <= t.window_end):
            violations.append(
                f"task {tid_label(s.task_id)} placed on {s.date}, outside "
                f"{t.window_start}..{t.window_end}"
            )
        if s.date in blocked:
            violations.append(f"task {s.task_id} placed on blocked day {s.date}")

    # capacity + shared weekly budget — only meaningful for a real solve, and
    # only for tasks the solver actually claimed to place. Tasks on
    # `unscheduled` are kept at their window start *because* they do not fit;
    # flagging them again would be double-counting a known shortfall.
    if result.solver == "cpsat" and result.feasible:
        over = set(result.unscheduled)
        claimed = [s for s in result.slots if s.task_id not in over]
        per_day: dict[str, float] = defaultdict(float)
        for s in claimed:
            per_day[s.date] += s.hours
        for date, hours in per_day.items():
            cap = availability.cap_for(date)
            if hours > cap + 1e-6:
                violations.append(f"{date}: {hours:g}h placed against {cap:g}h capacity")

        if availability.weekly_budget_hours:
            per_week: dict[tuple[int, int], float] = defaultdict(float)
            for s in claimed:
                per_week[iso_year_week(s.date)] += s.hours
            for (_, week), hours in per_week.items():
                if hours > availability.weekly_budget_hours + 1e-6:
                    violations.append(
                        f"ISO week {week}: {hours:g}h placed against a "
                        f"{availability.weekly_budget_hours:g}h shared budget"
                    )

    return violations


def tid_label(tid: str) -> str:
    return tid


def cross_validate(
    actions: list[ReplanAction],
    plan_items: list[PlanItemRow],
    *,
    existing_goal_titles: list[str] | None = None,
    plan_goal_title: str | None = None,
    planned_milestone_titles: list[str] | None = None,
) -> list[str]:
    """Every action must trace to the plan or to an existing goal.

    A mismatch is retried once with the diff, then the turn ends `no_change`.
    """
    errors: list[str] = []
    known = set(existing_goal_titles or [])
    if plan_goal_title:
        known.add(plan_goal_title)

    planned_titles = {i.title for i in plan_items if i.horizon in ("weekly", "monthly")}
    planned_titles |= {i.phase for i in plan_items}
    if planned_milestone_titles:
        planned_titles |= set(planned_milestone_titles)

    if not actions:
        errors.append("no actions proposed")
        return errors

    for a in actions:
        if a.intent == "add_goal":
            title = (a.changes.title or "").strip()
            if not title:
                errors.append("add_goal without a title")
            elif plan_goal_title and title != plan_goal_title:
                errors.append(
                    f"add_goal title {title!r} does not match the planned goal "
                    f"{plan_goal_title!r}"
                )
        else:
            if not a.goal_id:
                errors.append(f"{a.intent}: no goal_id — cannot trace to an existing goal")

        # Milestone titles must exist in the plan whenever the plan produced any
        # — a milestone the plan never named is the classic ungrounded emit.
        if a.changes.milestones and planned_titles:
            for m in a.changes.milestones:
                if m.title not in planned_titles:
                    errors.append(f"milestone {m.title!r} is not grounded in the plan")

    return errors


def summarise(violations: list[str], limit: int = 6) -> str:
    """A short, deterministic digest — used as retry feedback."""
    if not violations:
        return ""
    shown = violations[:limit]
    extra = len(violations) - len(shown)
    body = "\n".join(f"- {v}" for v in shown)
    return body + (f"\n- …and {extra} more" if extra > 0 else "")
