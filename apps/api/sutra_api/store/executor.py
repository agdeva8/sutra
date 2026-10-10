"""Applying a confirmed proposal — the eight actions, and their result strings.

Ported verbatim from v1's `api/lib/proposal-executor.ts`. **The result strings are
the contract**: they are rendered as a chat line, and v1's own comment records
why they must be strings — an object here throws "Objects are not valid as a
React child" in the middle of the user's conversation.

The shape of the module is deliberate. It is a **dispatch table of side effects**
with three properties:

* **Never raises on a business failure.** It returns `{success, result}`. A
  failure is an answer — `No matching goal for 'Goa trip'` is something the user
  needs to read, not a 500.
* **Idempotent under retry.** Callers flip the proposal's status with an
  `UPDATE … WHERE status = 'pending'` guard, so a double-confirm matches zero
  rows and 409s instead of applying twice.
* **One transaction.** The caller owns it, so the domain write and the audit row
  that describes it commit together.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..ids import new_id
from ..models import BLOCKER_KINDS, GOAL_HORIZONS, TimetableBlock, User
from . import goal_drop, repo, staleness

#: v1's cap on how many attached sources a confirmed goal adopts.
MAX_LINKED_SOURCES = 10

#: What a proposal may ask for. `set_availability` is handled but is not in this
#: list in v1 either — a model reaches for it rarely, and it is not a proposal
#: the UI has a card for.
PROPOSAL_ACTIONS = (
    "create_goal",
    "update_goal",
    "drop_goal",
    "pause_goal",
    "set_goal_dates",
    "add_milestone",
    "add_blocker",
    "add_block",
)

_TIME_RE = re.compile(r"^\d{2}:\d{2}(:\d{2})?$")


@dataclass
class ExecResult:
    success: bool
    result: str


def _fail(msg: str) -> ExecResult:
    return ExecResult(False, msg)


def _ok(msg: str) -> ExecResult:
    return ExecResult(True, msg)


def _as_date(v: object) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _as_hours(v: object) -> int | None:
    """`Math.round(args.weekly_hours)` when it is a finite number, else None.

    Rounded, not truncated, and None rather than 0 for a missing estimate — a
    goal with no estimate is excluded from the capacity sum, and 0 would quietly
    count it as free.
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return int(round(v))


async def _resolve_goal_ref(session: AsyncSession, *, user_id: str, args: dict):
    """`resolve_goal_ref` over a proposal's args.

    The model is given goal *titles* — it never sees ids — so `goal_title` is the
    common case and `goal_id` the precise one.
    """
    return await goal_drop.resolve_goal_ref(
        session,
        user_id=user_id,
        goal_id=str(args.get("goal_id") or ""),
        goal_title=str(args.get("goal_title") or ""),
    )


async def _apply_plan_items(
    session: AsyncSession, *, user_id: str, goal_id: str, args: dict
) -> None:
    """Attach the plan rows a confirmed proposal carried.

    Replace-on-write: a second confirm of the same goal replaces rather than
    appends, which is what makes a retry safe. See HLD §9.4.
    """
    rows = args.get("plan_items")
    if not isinstance(rows, list) or not rows:
        return
    clean = [
        r
        for r in rows
        if isinstance(r, dict) and r.get("horizon") and r.get("title")
    ]
    if clean:
        await repo.replace_plan_items_for_goal(
            session, user_id=user_id, goal_id=goal_id, rows=clean
        )


async def _link_sources(
    session: AsyncSession, *, user_id: str, goal_id: str, goal_title: str, args: dict
) -> None:
    """Adopt the sources the conversation had attached.

    Only unlinked, non-deleted, *owned* sources — so a caller cannot name someone
    else's file id and have it adopted. A source adopted this way stops being
    temporary: the goal it was attached to now makes it real work.
    """
    ids = args.get("source_ids")
    if not isinstance(ids, list):
        return
    wanted = [str(i) for i in ids if isinstance(i, str) and i][:MAX_LINKED_SOURCES]
    if not wanted:
        return
    for src in await repo.sources_by_ids(session, user_id=user_id, ids=wanted):
        if src.goal_id:
            continue
        src.goal_id = goal_id
        src.goal_title = goal_title
        src.expires_at = None


# ---------------------------------------------------------------------------
# The actions
# ---------------------------------------------------------------------------


async def _create_goal(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A goal needs a title.")

    raw_horizon = str(args.get("horizon") or "").strip()
    horizon = raw_horizon if raw_horizon in GOAL_HORIZONS else "medium"

    goal = await repo.create_goal(
        session,
        user_id=user_id,
        title=title,
        horizon=horizon,
        why=str(args.get("why") or ""),
        # `next_action` and `first_action` are two spellings of the same field
        # from different prompt versions.
        next_action=str(args.get("next_action") or args.get("first_action") or ""),
        start_date=_as_date(args.get("start_date")),
        target_date=_as_date(args.get("target_date")),
        weekly_hours=_as_hours(args.get("weekly_hours")),
        phase_objectives=args.get("phase_objectives")
        if isinstance(args.get("phase_objectives"), dict)
        else None,
        life_area=str(args.get("life_area") or ""),
    )

    await _link_sources(
        session,
        user_id=user_id,
        goal_id=goal.id,
        goal_title=goal.title,
        args=args,
    )
    await _apply_plan_items(session, user_id=user_id, goal_id=goal.id, args=args)

    summary = f"Created goal '{goal.title}' ({goal.horizon})"
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:create_goal",
        summary=summary,
        payload={"proposal_id": None, "args": _safe(args)},
    )
    return _ok(summary)


async def _update_goal(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    if args.get("status") == "dropped":
        # One door to abandonment, whichever action name reached it.
        return await _drop_goal(session, user_id=user_id, args=args)

    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    if ref is None:
        return _fail(
            f"No matching goal for '{args.get('goal_id') or args.get('goal_title') or ''}'"
        )

    goal = await repo.get_goal(session, user_id=user_id, goal_id=ref.goal_id)
    if goal is None:
        return _fail(f"No matching goal for '{ref.goal_id}'")

    freed: int | None = None
    if args.get("status") == "paused" and goal.status == "active" and goal.weekly_hours:
        freed = goal.weekly_hours

    # `new_title` wins when both are present: it is the more specific spelling.
    for key, attr in (
        ("title", "title"),
        ("why", "why"),
        ("next_action", "next_action"),
        ("status", "status"),
        ("life_area", "life_area"),
    ):
        if args.get(key) is not None:
            setattr(goal, attr, str(args[key]))
    if args.get("new_title") is not None:
        goal.title = str(args["new_title"])
    if "target_date" in args:
        goal.target_date = _as_date(args["target_date"])
    if "weekly_hours" in args:
        goal.weekly_hours = _as_hours(args["weekly_hours"])
    if isinstance(args.get("phase_objectives"), dict):
        goal.phase_objectives = args["phase_objectives"]
    goal.updated_at = datetime.now(UTC)

    summary = f"Updated goal '{goal.title}'"
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:update_goal",
        summary=summary,
        payload={
            "goal_id": goal.id,
            "goal_title": goal.title,
            # Read by `replan_suggestions` to notice a goal that freed capacity.
            "freed_weekly_hours": freed,
            "args": _safe(args),
        },
    )
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal.id,
        kind="goal_scope",
        horizons_moved=radius_for("goal.edit")[0],
        summary=summary,
        detail={"freed_weekly_hours": freed} if freed else None,
    )
    return _ok(summary)


async def _drop_goal(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    if ref is None:
        return _fail(
            f"No matching goal for '{args.get('goal_id') or args.get('goal_title') or ''}'"
        )
    _, line = await goal_drop.apply_goal_drop_cascade(
        session,
        user_id=user_id,
        ref=ref,
        audit_type="confirm:drop_goal",
        reason=args.get("reason"),
    )
    return _ok(line)


async def _pause_goal(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    if ref is None:
        return _fail(
            f"No matching goal for '{args.get('goal_id') or args.get('goal_title') or ''}'"
        )
    goal = await repo.get_goal(session, user_id=user_id, goal_id=ref.goal_id)
    if goal is None:
        return _fail(f"No matching goal for '{ref.goal_id}'")

    freed = goal.weekly_hours if goal.status == "active" else None
    goal.status = "paused"
    goal.updated_at = datetime.now(UTC)

    reason = args.get("reason")
    summary = f"Paused goal '{goal.title}'" + (f" ({reason})" if reason else "")
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:pause_goal",
        summary=summary,
        payload={
            "goal_id": goal.id,
            "goal_title": goal.title,
            "freed_weekly_hours": freed,
            "args": _safe(args),
        },
    )
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal.id,
        kind="goal_scope",
        horizons_moved=radius_for("goal.pause")[0],
        summary=summary,
        detail={"freed_weekly_hours": freed} if freed else None,
    )
    return _ok(f"Paused goal '{goal.title}'")


async def _set_goal_dates(
    session: AsyncSession, *, user_id: str, args: dict
) -> ExecResult:
    start = _as_date(args.get("start_date"))
    target = _as_date(args.get("target_date"))
    if start is None and target is None:
        return _fail("set_goal_dates requires start_date or target_date")

    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    if ref is None:
        return _fail(
            f"No matching goal for '{args.get('goal_id') or args.get('goal_title') or ''}'"
        )
    goal = await repo.get_goal(session, user_id=user_id, goal_id=ref.goal_id)
    if goal is None:
        return _fail(f"No matching goal for '{ref.goal_id}'")

    if start is not None:
        goal.start_date = start
    if target is not None:
        goal.target_date = target
    goal.updated_at = datetime.now(UTC)

    summary = (
        f"Timeline set for '{goal.title}': "
        f"{start.isoformat() if start else '?'} -> "
        f"{target.isoformat() if target else '?'}"
    )
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:set_goal_dates",
        summary=summary,
        payload={"goal_id": goal.id, "args": _safe(args)},
    )
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal.id,
        kind="goal_dates",
        horizons_moved=radius_for("goal.dates")[0],
        milestone_moved=True,
        summary=summary,
    )
    return _ok(summary)


async def _add_milestone(
    session: AsyncSession, *, user_id: str, args: dict
) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A milestone needs a title.")

    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    goal_title = ref.goal_title if ref else str(args.get("goal_title") or "")

    ms = await repo.create_milestone(
        session,
        user_id=user_id,
        title=title,
        goal_id=ref.goal_id if ref else None,
        goal_title=goal_title,
        target_date=_as_date(args.get("target_date")),
        phase=str(args.get("phase") or ""),
    )
    if ref:
        await _apply_plan_items(session, user_id=user_id, goal_id=ref.goal_id, args=args)

    summary = f"Milestone '{title}' -> {goal_title}"
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:add_milestone",
        summary=summary,
        payload={"milestone_id": ms.id, "goal_id": ms.goal_id, "args": _safe(args)},
    )
    if ms.goal_id:
        await staleness.record_change(
            session,
            user_id=user_id,
            goal_id=ms.goal_id,
            kind="milestone",
            horizons_moved=radius_for("milestone.create")[0],
            milestone_moved=True,
            summary=summary,
        )
    return _ok(summary)


async def _add_blocker(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A blocker needs a title.")
    start = _as_date(args.get("start_date")) or datetime.now(UTC).date()
    end = _as_date(args.get("end_date")) or start

    row = await repo.create_blocker(
        session,
        user_id=user_id,
        title=title,
        start_date=start,
        end_date=end,
        note=str(args.get("note") or ""),
    )
    summary = f"Blocker '{title}' {start.isoformat()}..{end.isoformat()}"
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:add_blocker",
        summary=summary,
        payload={"blocker_id": row.id, "args": _safe(args)},
    )
    return _ok(summary)


async def _add_block(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    """Schedule a fixed commitment.

    Validated hard, because a block is the part of the week the solver must not
    move — an invalid one would either be dropped silently or, worse, occupy a
    slot the plan wanted.
    """
    block_date = _as_date(args.get("block_date"))
    start = str(args.get("start_time") or "")
    end = str(args.get("end_time") or "")
    label = str(args.get("label") or "").strip()
    kind = str(args.get("kind") or "commitment")

    if (
        block_date is None
        or not label
        or not _TIME_RE.match(start)
        or not _TIME_RE.match(end)
        or end <= start
        or kind not in BLOCKER_KINDS
    ):
        return _fail("Invalid timetable block details.")

    goal_id: str | None = None
    goal_title = str(args.get("goal_title") or "")
    if goal_title:
        ref = await goal_drop.resolve_goal_ref(
            session, user_id=user_id, goal_title=goal_title
        )
        if ref is None:
            return _fail(f"No matching goal for '{goal_title}'")
        goal_id, goal_title = ref.goal_id, ref.goal_title

    from datetime import time as _t

    row = TimetableBlock(
        id=new_id("blk"),
        user_id=user_id,
        block_date=block_date,
        start_time=_t.fromisoformat(start),
        end_time=_t.fromisoformat(end),
        label=label,
        kind=kind,
        # `plan`, not `manual`: a confirmed proposal wrote this, and the
        # difference tells a later replan which blocks it may move.
        source="plan",
        source_id=None,
        goal_id=goal_id,
        goal_title=goal_title,
        note=str(args.get("note") or ""),
    )
    session.add(row)
    await session.flush()

    summary = f"Scheduled '{label}' {block_date.isoformat()} {start}-{end}"
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:add_block",
        summary=summary,
        payload={"block_id": row.id, "args": _safe(args)},
    )
    if goal_id:
        await staleness.record_change(
            session,
            user_id=user_id,
            goal_id=goal_id,
            kind="timetable",
            horizons_moved=radius_for("timetable.add")[0],
            summary=summary,
        )
    return _ok(summary)


async def _set_availability(
    session: AsyncSession, *, user_id: str, args: dict
) -> ExecResult:
    """Save the weekly availability grid. Finiteness and a 24h cap, per day."""
    raw = args.get("availability")
    if not isinstance(raw, dict):
        return _fail("Availability needs a per-day object.")

    hours: dict[str, float] = {}
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        value = raw.get(day)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            hours[day] = max(0.0, min(float(value), 24.0))

    row = await session.get(User, user_id)
    if row is None:
        return _fail("No user row to save availability against.")
    row.availability = hours
    await session.flush()

    summary = "Availability saved: " + ", ".join(
        f"{day} {hours.get(day, 0):g}h" for day in ("mon", "tue", "wed", "thu", "fri")
    )
    await repo.write_audit(
        session,
        user_id=user_id,
        type="confirm:set_availability",
        summary=summary,
        payload={"availability": hours},
    )
    return _ok("Saved your weekly availability.")


_DISPATCH = {
    "create_goal": _create_goal,
    "update_goal": _update_goal,
    "drop_goal": _drop_goal,
    "pause_goal": _pause_goal,
    "set_goal_dates": _set_goal_dates,
    "add_milestone": _add_milestone,
    "add_blocker": _add_blocker,
    "add_block": _add_block,
    "set_availability": _set_availability,
}


async def apply_proposal(
    session: AsyncSession, *, user_id: str, action: str, args: dict
) -> ExecResult:
    """Run one action. Never raises for a business failure — see the docstring."""
    handler = _DISPATCH.get(action)
    if handler is None:
        return _fail(f"Unknown action '{action}'")
    try:
        return await handler(session, user_id=user_id, args=args or {})
    except Exception as exc:  # noqa: BLE001
        # A handler that throws was malformed input, not a server fault: the
        # route turns this into a 422 so the user can retry rather than seeing a
        # 500 on a proposal they can still act on.
        return _fail(f"Could not apply '{action}': {exc}")


def ledger_args(args: dict) -> dict:
    """The args as stored in the ledger, minus anything un-renderable.

    Public because `api/tools.py` stores the same projection in the audit row it
    writes for a confirm — two spellings of "what the proposal actually said"
    would be two things to keep in sync.
    """
    out: dict = {}
    for key, value in (args or {}).items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value
        elif isinstance(value, list):
            out[key] = [v for v in value if isinstance(v, (str, int, float, bool))]
        elif isinstance(value, dict):
            out[key] = {
                k: v for k, v in value.items() if isinstance(v, (str, int, float, bool))
            }
    return out


#: The internal spelling, kept so the action handlers above read unchanged.
_safe = ledger_args
