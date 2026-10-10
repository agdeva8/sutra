"""`place` — the OR-Tools CP-SAT model. PURE.

One call, one model, **every** goal (HLD §8.2–8.3). The solver is the only
thing in this codebase that writes a date.

**A task may span several days.** The first cut of this model allowed one
sitting per task, which turned out to be wrong in a way the TUI demo made
obvious: a 2.7h step against a 2h/day availability could *never* be placed, so
24 of 36 steps fell through to the fallback. A real plan splits that step into
2h on one day and 0.7h on the next. `session_max_hours` therefore caps a single
*sitting*, which is what it always meant.

Two properties the module is built around:

* **Reproducible** — integer tenths of an hour and `num_search_workers = 1`, so
  the same input yields the same plan. This is also why `n_review` must return
  constraint deltas rather than prose: re-solving unchanged input is a no-op.
* **Never fails the caller** — an import error, timeout, or infeasibility
  degrades to structural placement (HLD §8.4). A task is never dropped.
"""
from __future__ import annotations

from collections import defaultdict

from app.contracts.schemas import (
    Availability,
    ConstraintDelta,
    HorizonTask,
    PlaceResult,
    Slot,
)
from app.core.fallback import structural_place
from app.core.util import days_between, iso_year_week, iter_dates, weekday_index

#: Solver wall-clock bound. The node has its own TimeoutPolicy; this is the
#: inner bound so a pathological model cannot eat the whole budget.
DEFAULT_MAX_SECONDS = 8.0

#: Objective weights. Goal priority must outrank task priority so contested
#: hours go to the more important goal (HLD §8.3).
GOAL_PRIO_WEIGHT = 100
TASK_PRIO_WEIGHT = 10

#: Big-M for the used-indicator linking.
_MAX_HOURS_TENTHS = 400  # 40h ceiling, matching HorizonTask.est_hours


def place(
    tasks: list[HorizonTask],
    availability: Availability,
    *,
    deltas: list[ConstraintDelta] | None = None,
    today: str | None = None,
    max_seconds: float = DEFAULT_MAX_SECONDS,
) -> PlaceResult:
    """Place every task's hours on days. Never raises; degrades instead."""
    if not tasks:
        return PlaceResult(feasible=True, slots=[], solver="cpsat", detail="no tasks")

    try:
        result = _solve_cpsat(
            tasks, availability, deltas=list(deltas or []), max_seconds=max_seconds
        )
    except ImportError as exc:
        return structural_place(tasks, reason=f"ortools unavailable: {exc}")
    except Exception as exc:  # a solver bug must not reach the user
        return structural_place(tasks, reason=f"{type(exc).__name__}: {exc}")

    if not result.feasible:
        return structural_place(
            tasks,
            reason=result.detail or "infeasible under the current constraints",
            unplaced=result.unscheduled,
        )

    # Tasks the model could not fit at all are KEPT at their window start and
    # stay on `unscheduled`, so no work ever vanishes (HLD §8.4).
    if result.unscheduled:
        placed = {s.task_id for s in result.slots}
        for t in tasks:
            if t.id not in placed:
                result.slots.append(Slot(task_id=t.id, date=t.window_start, hours=t.est_hours))
        result.detail += f" · {len(result.unscheduled)} kept at window start (over capacity)"

    return result


# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------


def _solve_cpsat(
    tasks: list[HorizonTask],
    availability: Availability,
    *,
    deltas: list[ConstraintDelta],
    max_seconds: float,
) -> PlaceResult:
    from ortools.sat.python import cp_model

    by_id = {t.id: t for t in tasks}
    rules = _index_deltas(deltas, by_id)

    days_for: dict[str, list[str]] = {}
    for t in tasks:
        days = [d for d in iter_dates(t.window_start, t.window_end) if _day_allowed(d, t, rules)]
        days_for[t.id] = days

    cap: dict[str, int] = {}
    for t in tasks:
        for d in days_for[t.id]:
            cap.setdefault(d, _scaled(availability.cap_for(d)))

    need: dict[str, int] = {t.id: max(1, _scaled(t.est_hours)) for t in tasks}
    # per-sitting ceiling: session_max caps ONE sitting, not the whole task
    sitting_cap: dict[str, int] = {
        t.id: max(1, _scaled(t.session_max_hours)) if t.session_max_hours else need[t.id]
        for t in tasks
    }

    model = cp_model.CpModel()

    # h[t][d] = tenths of an hour of task t placed on day d
    h: dict[tuple[str, str], cp_model.IntVar] = {}
    used: dict[tuple[str, str], cp_model.IntVar] = {}
    for t in tasks:
        ceiling = min(need[t.id], sitting_cap[t.id], max(cap.get(d, 0) for d in days_for[t.id]) if days_for[t.id] else 0)
        for d in days_for[t.id]:
            if cap[d] <= 0:
                continue
            top = min(need[t.id], sitting_cap[t.id], cap[d])
            h[(t.id, d)] = model.NewIntVar(0, top, f"h_{_safe(t.id)}_{d}")
            used[(t.id, d)] = model.NewBoolVar(f"u_{_safe(t.id)}_{d}")
            model.Add(h[(t.id, d)] <= top * used[(t.id, d)])
            model.Add(used[(t.id, d)] <= h[(t.id, d)])

    # --- hard constraints --------------------------------------------------
    for t in tasks:
        keys = [k for k in h if k[0] == t.id]
        if keys:
            # place at most the task's full demand — partial is allowed, and the
            # shortfall is reported rather than made infeasible
            model.Add(sum(h[k] for k in keys) <= need[t.id])

    for d, capacity in cap.items():
        on_day = [(tid, d) for (tid, dd) in h if dd == d]
        if on_day:
            model.Add(sum(h[(tid, d)] for tid, _ in on_day) <= capacity)

    # THE shared weekly cap — the constraint v1 never had (HLD §8.3)
    if availability.weekly_budget_hours:
        budget = _scaled(availability.weekly_budget_hours)
        weeks: dict[tuple[int, int], list[tuple[str, str]]] = defaultdict(list)
        for k in h:
            weeks[iso_year_week(k[1])].append(k)
        for _, keys in weeks.items():
            model.Add(sum(h[k] for k in keys) <= budget)

    _apply_deltas(model, h, used, tasks, need, days_for, rules, cap)

    # --- objective: goal priority, then task priority, then front-load -----
    terms = []
    for (tid, d), var in h.items():
        t = by_id[tid]
        gp = rules["priority_bump"].get(tid, t.goal_priority)
        weight = gp * GOAL_PRIO_WEIGHT + t.priority * TASK_PRIO_WEIGHT
        terms.append(weight * var)
        terms.append(-days_between(t.window_start, d) * var)  # tie-break: front-load
    model.Maximize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1  # reproducibility over speed
    solver.parameters.max_time_in_seconds = max_seconds
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return PlaceResult(
            feasible=False,
            unscheduled=[t.id for t in tasks],
            solver="cpsat",
            detail=f"solver status {solver.StatusName(status)}",
        )

    slots: list[Slot] = []
    unscheduled: list[str] = []
    short: list[str] = []
    for t in tasks:
        placed = 0
        for d in days_for[t.id]:
            if (t.id, d) not in h:
                continue
            tenths = solver.Value(h[(t.id, d)])
            if tenths > 0:
                placed += tenths
                slots.append(Slot(task_id=t.id, date=d, hours=round(tenths / 10.0, 1)))
        if placed == 0:
            unscheduled.append(t.id)
        elif placed < need[t.id]:
            short.append(t.id)

    slots.sort(key=lambda s: (s.date, s.task_id))
    detail = f"{solver.StatusName(status)} · {len(slots)} sittings · {len(tasks) - len(unscheduled)}/{len(tasks)} tasks placed"
    if short:
        detail += f" · {len(short)} short of their full estimate"

    return PlaceResult(
        feasible=True,
        slots=slots,
        unscheduled=unscheduled,
        short=short,
        solver="cpsat",
        detail=detail,
    )


# --------------------------------------------------------------------------
# Constraint deltas — how the LLM's judgment becomes solver input
# --------------------------------------------------------------------------


def _index_deltas(deltas: list[ConstraintDelta], by_id: dict[str, HorizonTask]) -> dict[str, dict]:
    """Group deltas by kind. Unknown task ids are ignored, not fatal."""
    out: dict[str, dict] = {
        "precedence": defaultdict(list),
        "allowed_days": {},
        "avoid_week": defaultdict(list),
        "max_per_day": {},
        "session_max": {},
        "pin": {},
        "priority_bump": {},
    }
    for d in deltas:
        if d.task_id not in by_id:
            continue
        if d.kind == "precedence":
            if d.other in by_id:
                out["precedence"][d.task_id].append(d.other)
        elif d.kind == "allowed_days":
            out["allowed_days"][d.task_id] = _as_int_list(d.value)
        elif d.kind == "avoid_week":
            out["avoid_week"][d.task_id].append(_as_int(d.value))
        elif d.kind == "max_per_day":
            out["max_per_day"][d.task_id] = _as_int(d.value)
        elif d.kind == "session_max":
            out["session_max"][d.task_id] = float(d.value)  # type: ignore[arg-type]
        elif d.kind == "pin":
            out["pin"][d.task_id] = str(d.value)
        elif d.kind == "priority_bump":
            out["priority_bump"][d.task_id] = _as_int(d.value)
    return out


def _apply_deltas(model, h, used, tasks, need, days_for, rules, cap) -> None:
    # precedence: every hour of `task_id` lands strictly after every hour of
    # `other` — so no day of the task may share or precede a day of the other.
    for a, others in rules["precedence"].items():
        for other in others:
            for da in days_for.get(a, []):
                for dob in days_for.get(other, []):
                    if days_between(da, dob) >= 0 and (a, da) in used and (other, dob) in used:
                        model.Add(used[(a, da)] + used[(other, dob)] <= 1)

    # pin: all of the task's hours on one day
    for tid, date in rules["pin"].items():
        keys = [(tid, d) for d in days_for.get(tid, []) if (tid, d) in h]
        target = [(tid, date)] if (tid, date) in h else []
        if target:
            model.Add(h[target[0]] == need[tid])
            for k in keys:
                if k != target[0]:
                    model.Add(h[k] == 0)
        else:
            for k in keys:
                model.Add(h[k] == 0)  # pinned day impossible — place nothing

    # max_per_day: at most N sittings on any one day
    if rules["max_per_day"]:
        limit = min(rules["max_per_day"].values())
        for d in {d for tid in rules["max_per_day"] for d in days_for.get(tid, [])}:
            on_day = [used[(tid, d)] for tid in rules["max_per_day"] if (tid, d) in used]
            if on_day:
                model.Add(sum(on_day) <= limit)

    # session_max for a task arrives via its own `session_max_hours`; a delta
    # overrides it by narrowing the per-sitting ceiling.
    for tid, hours in rules["session_max"].items():
        ceiling = max(1, _scaled(hours))
        for d in days_for.get(tid, []):
            if (tid, d) in h:
                model.Add(h[(tid, d)] <= ceiling)


def _day_allowed(date: str, task: HorizonTask, rules: dict) -> bool:
    allowed = rules["allowed_days"].get(task.id)
    if allowed is not None and weekday_index(date) not in allowed:
        return False
    if iso_year_week(date)[1] in rules["avoid_week"].get(task.id, []):
        return False
    return True


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _scaled(hours: float) -> int:
    """Hours → tenths of an hour. Integer arithmetic, no float drift."""
    from app.core.util import round_half_up

    return max(0, round_half_up(hours * 10))


def _safe(s: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in s)


def _as_int(v) -> int:
    return int(v)


def _as_int_list(v) -> list[int]:
    if isinstance(v, list):
        return [int(x) for x in v]
    return [int(v)]
