"""Re-plan suggestions — the deterministic "you should re-plan" signal.

Ported verbatim from v1's `api/lib/replan-suggestions.ts`. Pure: it is a function
over inputs the dashboard read model has already loaded, and does no I/O.

**All five triggers are offers, never actions.** Nothing here auto-runs: the
suggestion carries a `prefill` string that opens the existing `review_progress`
chat, where the user sees proposals and confirms them. That is why a suggestion
can be wrong without being harmful — the worst case is a pre-filled sentence the
user ignores.

One dead branch is carried over for parity: `commitments` is never supplied by
any caller, because the entity was removed app-wide (migration 0013) and folded
into `plan_items`. The `lateCommitments` check below therefore never fires. It is
kept because deleting it would be a silent behaviour change if a caller ever
passes one — and the parameter's absence is visible in the signature.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Literal, TypedDict

ReplanTrigger = Literal[
    "capacity_freed",
    "drift",
    "blocker_collision",
    "timetable_collision",
    "infeasible_edit",
]

#: How far back a drop or pause still counts as "just freed capacity".
CAPACITY_WINDOW_DAYS = 7
#: Cap, so the banner stays readable.
MAX_SUGGESTIONS = 5

#: Every trigger resolves through the same intent — there is one planner door.
REPLAN_INTENT: dict[str, str] = {
    "capacity_freed": "review_progress",
    "drift": "review_progress",
    "blocker_collision": "review_progress",
    "timetable_collision": "review_progress",
    "infeasible_edit": "review_progress",
}

_DROP_AUDIT_TYPES = frozenset(
    {
        "drop:goal",
        "confirm:drop_goal",
        "confirm:pause_goal",
        "confirm:update_goal",
        "update:goal",
    }
)
_GOAL_EDIT_AUDIT_TYPES = frozenset(
    {"confirm:update_goal", "confirm:set_goal_dates", "update:goal"}
)

#: Emitted in this order; the cap slices the tail.
_PRIORITY: dict[str, int] = {
    "drift": 0,
    "infeasible_edit": 1,
    "timetable_collision": 2,
    "blocker_collision": 3,
    "capacity_freed": 4,
}


class ReplanSuggestion(TypedDict):
    id: str
    trigger: ReplanTrigger
    goal_id: str | None
    goal_title: str
    message: str
    freed_weekly_hours: float | None
    reasons: list[str]
    blocker_id: str | None
    blocker_title: str | None
    #: Opens the `review_progress` chat with this prompt pre-filled.
    prefill: str


def _to_iso(v: Any) -> str | None:
    """A date-ish value as `YYYY-MM-DD`, or None.

    v1 took any string of length >= 10 and sliced it. Kept, because a full ISO
    timestamp arrives here from JSONB payloads and its date part is what matters.
    """
    if not isinstance(v, str) or len(v) < 10:
        return None
    return v[:10]


def _days_between(a_iso: str, b_iso: str) -> float:
    """Whole days from `a` to `b`. Infinity if either is unparseable.

    Infinity is the safe direction: `created_at` is compared against the window,
    and an unreadable timestamp should *exclude* the suggestion rather than
    resurrect an old change as if it were recent.
    """
    try:
        a = date.fromisoformat(a_iso)
        b = date.fromisoformat(b_iso)
    except ValueError:
        return float("inf")
    return float((b - a).days)


def _event_fields(payload: dict) -> dict:
    """`payload.args ?? payload.fields` — whichever the writer used.

    Proposal writes nest under `args`, direct route writes under `fields`. The
    two are never both present, so trying in order is enough.
    """
    for key in ("args", "fields"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            return nested
    return {}


def _as_dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def compute_replan_suggestions(inp: dict) -> list[ReplanSuggestion]:
    """`inp` keys: goals, blockers, recentAudit, milestones?, commitments?,
    timetableBlocks?, availableWeeklyHours?, today?."""
    today = inp.get("today") or date.today().isoformat()
    goals: list[dict] = list(inp.get("goals") or [])
    blockers: list[dict] = list(inp.get("blockers") or [])
    recent_audit: list[dict] = list(inp.get("recentAudit") or [])

    active = [g for g in goals if g.get("status") == "active"]
    active_by_id = {g["id"]: g for g in active if g.get("id")}
    out: list[ReplanSuggestion] = []

    # ── 1. capacity_freed — a recent drop/pause that freed weekly hours ──────
    seen_goals: set[str] = set()
    for audit in recent_audit:
        if audit.get("type") not in _DROP_AUDIT_TYPES:
            continue
        created = _to_iso(audit.get("created_at"))
        if created and _days_between(created, today) > CAPACITY_WINDOW_DAYS:
            continue

        payload = _as_dict(audit.get("payload"))
        freed = payload.get("freed_weekly_hours")
        if not isinstance(freed, (int, float)) or freed <= 0:
            continue

        goal_id = payload.get("goal_id") if isinstance(payload.get("goal_id"), str) else None
        goal_title = (
            (payload.get("goal_title") or "")
            if isinstance(payload.get("goal_title"), str)
            else ""
        ) or (audit.get("summary") if isinstance(audit.get("summary"), str) else "") or "a goal"

        key = goal_id or goal_title
        if key in seen_goals:
            continue
        seen_goals.add(key)

        # Only offer a re-plan when something is left to re-plan *for*.
        others = [g for g in active if g.get("id") != goal_id]
        if not others:
            continue

        was_paused = audit.get("type") == "confirm:pause_goal" or _event_fields(
            payload
        ).get("status") == "paused"
        verb = "Pausing" if was_paused else "Dropping"
        verb_past = "I paused" if was_paused else "I dropped"
        plural = "" if len(others) == 1 else "s"

        out.append(
            {
                "id": f"capacity:{key}",
                "trigger": "capacity_freed",
                "goal_id": goal_id,
                "goal_title": goal_title,
                "message": (
                    f'{verb} "{goal_title}" freed {freed:g}h/week. You have room '
                    f"to re-plan your remaining {len(others)} goal{plural}."
                ),
                "freed_weekly_hours": freed,
                "reasons": [],
                "blocker_id": None,
                "blocker_title": None,
                "prefill": (
                    f'{verb_past} "{goal_title}" and freed {freed:g}h/week. Re-plan '
                    "my remaining goals to use that capacity — shift dates or "
                    "scope, then show me what changes."
                ),
            }
        )

    # ── 2. drift — an active goal is at risk ────────────────────────────────
    for g in active:
        if g.get("drift_status") != "at_risk":
            continue
        title = g.get("title", "")
        out.append(
            {
                "id": f"drift:{g.get('id')}",
                "trigger": "drift",
                "goal_id": g.get("id"),
                "goal_title": title,
                "message": (
                    f'"{title}" is at risk — milestones or commitments are '
                    "slipping. Re-plan it now?"
                ),
                "freed_weekly_hours": None,
                "reasons": ["Milestones or commitments are behind schedule."],
                "blocker_id": None,
                "blocker_title": None,
                "prefill": (
                    f'My goal "{title}" is at risk — I\'m slipping behind. Re-plan '
                    "it: shift dates or reduce scope, and tell me exactly what "
                    "changes."
                ),
            }
        )

    # ── 3. blocker_collision — a blocker window overlaps an active goal ─────
    for b in blockers:
        b_start = _to_iso(b.get("start_date"))
        if not b_start:
            continue
        b_end = _to_iso(b.get("end_date")) or b_start

        for g in active:
            g_end = _to_iso(g.get("target_date"))
            if not g_end:
                continue
            g_start = _to_iso(g.get("start_date")) or today
            # Overlap iff the blocker starts on/before the goal ends AND ends
            # on/after the goal starts.
            if not (b_start <= g_end and b_end >= g_start):
                continue
            b_title = b.get("title", "")
            g_title = g.get("title", "")
            window = f"{b_start}-{b_end}" if b_end != b_start else b_start
            out.append(
                {
                    "id": f"blocker:{b.get('id')}:{g.get('id')}",
                    "trigger": "blocker_collision",
                    "goal_id": g.get("id"),
                    "goal_title": g_title,
                    "message": (
                        f'"{b_title}" ({window}) overlaps "{g_title}" (→ {g_end}). '
                        "Re-plan around it?"
                    ),
                    "freed_weekly_hours": None,
                    "reasons": [f'Blocker "{b_title}" collides with the goal window.'],
                    "blocker_id": b.get("id"),
                    "blocker_title": b_title,
                    "prefill": (
                        f'A blocker "{b_title}" ({window}) overlaps my goal '
                        f'"{g_title}" (target {g_end}). Re-plan it — shift dates, '
                        "reduce scope, or tell me to accept the slip."
                    ),
                }
            )

    # ── 3.5 timetable_collision — a goal-linked block breaks the window ─────
    for block in inp.get("timetableBlocks") or []:
        if not block.get("goal_id"):
            continue
        goal = active_by_id.get(block["goal_id"])
        if not goal:
            continue
        block_date = _to_iso(block.get("block_date"))
        if not block_date:
            continue

        goal_start = _to_iso(goal.get("start_date"))
        goal_target = _to_iso(goal.get("target_date"))
        reasons: list[str] = []
        if goal_start and block_date < goal_start:
            reasons.append(f"It is scheduled before the goal starts ({goal_start}).")
        if goal_target and block_date > goal_target:
            reasons.append(
                f"It is scheduled after the goal target date ({goal_target})."
            )

        colliding = None
        for b in blockers:
            start = _to_iso(b.get("start_date"))
            end = _to_iso(b.get("end_date")) or start
            if start and end and start <= block_date <= end:
                colliding = b
                break
        if colliding:
            reasons.append(f'It overlaps blocker "{colliding.get("title")}".')
        if not reasons:
            continue

        details = " ".join(reasons)
        label = block.get("label", "")
        g_title = goal.get("title", "")
        out.append(
            {
                "id": f"timetable:{block.get('id')}:{goal.get('id')}",
                "trigger": "timetable_collision",
                "goal_id": goal.get("id"),
                "goal_title": g_title,
                "message": (
                    f'Scheduled block "{label}" on {block_date} conflicts with '
                    f'"{g_title}". {details} Re-plan the schedule?'
                ),
                "freed_weekly_hours": None,
                "reasons": reasons,
                "blocker_id": colliding.get("id") if colliding else None,
                "blocker_title": colliding.get("title") if colliding else None,
                "prefill": (
                    f'My scheduled block "{label}" ({block_date}, '
                    f'{block.get("start_time")}-{block.get("end_time")}) conflicts '
                    f'with the plan for "{g_title}". {details} Suggest a realistic '
                    "schedule or goal-date adjustment."
                ),
            }
        )

    # ── 4. infeasible_edit — a recent date/hour edit broke the plan ─────────
    emitted_infeasible: set[str] = set()
    milestones: list[dict] = list(inp.get("milestones") or [])
    commitments: list[dict] = list(inp.get("commitments") or [])
    known_load = sum(
        g["weekly_hours"]
        for g in active
        if isinstance(g.get("weekly_hours"), (int, float))
    )
    budget = inp.get("availableWeeklyHours")

    for audit in recent_audit:
        if audit.get("type") not in _GOAL_EDIT_AUDIT_TYPES:
            continue
        created = _to_iso(audit.get("created_at"))
        if created and _days_between(created, today) > CAPACITY_WINDOW_DAYS:
            continue

        payload = _as_dict(audit.get("payload"))
        fields = _event_fields(payload)
        goal_id = (
            payload.get("goal_id")
            if isinstance(payload.get("goal_id"), str)
            else None
        ) or (fields.get("goal_id") if isinstance(fields.get("goal_id"), str) else None)
        if not goal_id:
            continue
        goal = active_by_id.get(goal_id)
        if not goal or goal_id in emitted_infeasible:
            continue

        changed_dates = "target_date" in fields or "start_date" in fields
        changed_hours = "weekly_hours" in fields
        if not changed_dates and not changed_hours:
            continue

        reasons: list[str] = []
        target_date = _to_iso(goal.get("target_date"))
        start_date = _to_iso(goal.get("start_date"))
        if changed_dates:
            if target_date and target_date < today:
                reasons.append(f"Target date {target_date} has already passed.")
            if target_date and start_date and start_date > target_date:
                reasons.append(
                    f"Start date {start_date} is after target date {target_date}."
                )
            late_milestones = [
                m
                for m in milestones
                if m.get("goal_id") == goal_id
                and m.get("status") != "done"
                and target_date
                and _to_iso(m.get("target_date"))
                and (_to_iso(m.get("target_date")) or "") > target_date
            ]
            if late_milestones:
                s = "" if len(late_milestones) == 1 else "s"
                reasons.append(
                    f"{len(late_milestones)} open milestone{s} fall after the "
                    "goal target date."
                )
            # Dead branch, kept for parity — no caller supplies `commitments`.
            late_commitments = [
                c
                for c in commitments
                if c.get("goal_id") == goal_id
                and c.get("status") == "open"
                and target_date
                and _to_iso(c.get("due"))
                and (_to_iso(c.get("due")) or "") > target_date
            ]
            if late_commitments:
                s = "" if len(late_commitments) == 1 else "s"
                reasons.append(
                    f"{len(late_commitments)} open commitment{s} fall after the "
                    "goal target date."
                )

        if (
            changed_hours
            and budget is not None
            and all(isinstance(g.get("weekly_hours"), (int, float)) for g in active)
            and known_load > budget
        ):
            reasons.append(
                f"Active goals now require {known_load:g}h/week against a "
                f"{budget:g}h/week capacity ({round(known_load - budget, 1):g}h over)."
            )

        if not reasons:
            continue
        emitted_infeasible.add(goal_id)
        details = " ".join(reasons)
        g_title = goal.get("title", "")
        out.append(
            {
                "id": f"infeasible_edit:{goal_id}",
                "trigger": "infeasible_edit",
                "goal_id": goal_id,
                "goal_title": g_title,
                "message": (
                    f'The latest change made "{g_title}" infeasible. {details} '
                    "Re-plan it?"
                ),
                "freed_weekly_hours": None,
                "reasons": reasons,
                "blocker_id": None,
                "blocker_title": None,
                "prefill": (
                    f'My recent change made "{g_title}" infeasible. {details} '
                    "Re-plan the goal and propose the date or weekly-hours changes "
                    "needed to make it realistic."
                ),
            }
        )

    # Sorted by priority then capped. `sorted` is stable, so suggestions of the
    # same trigger keep the order they were discovered in.
    out.sort(key=lambda s: _PRIORITY[s["trigger"]])
    return out[:MAX_SUGGESTIONS]
