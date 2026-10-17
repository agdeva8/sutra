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
from difflib import SequenceMatcher
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..ids import new_id
from ..models import CalendarBlock, GOAL_HORIZONS, Milestone, User
from . import goal_drop, repo, staleness

from agentv2.contracts.blocks import AwayBlock, BLOCK_ADAPTER, EventBlock, TaskBlock

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
    #: The goal this action changed, when it names one. The confirm route reads it to decide which
    #: goal's sessions need re-planning and which conversation to link the new goal to.
    goal_id: str | None = None


#: Spoken date spellings tried after ISO. Day-first because the default time zone is IST.
DATE_FALLBACK_FORMATS = ("%d %B %Y", "%d %b %Y", "%B %d %Y", "%b %d %Y", "%d/%m/%Y", "%d-%m-%Y")

#: Titles at least this alike (difflib ratio, case and punctuation ignored) are the same goal.
DUPLICATE_TITLE_RATIO = 0.86


def _norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", title.lower()).strip()


async def _find_duplicate_goal(session: AsyncSession, *, user_id: str, title: str):
    """An active goal whose title is (nearly) the one being created, or None."""
    wanted = _norm_title(title)
    for goal in await repo.list_goals(session, user_id=user_id, limit=200):
        if goal.status != "active":
            continue
        if SequenceMatcher(None, wanted, _norm_title(goal.title)).ratio() >= DUPLICATE_TITLE_RATIO:
            return goal
    return None


def _fail(msg: str) -> ExecResult:
    return ExecResult(False, msg)


def _ok(msg: str, *, goal_id: str | None = None) -> ExecResult:
    return ExecResult(True, msg, goal_id)


def _as_date(v: object) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    text = str(v).strip()
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        pass
    # The model sometimes echoes the user's own wording ("14 March 2027") instead of ISO. Dropping
    # that silently left goals undated, so accept the common spoken forms.
    cleaned = re.sub(r"(?<=\d)(st|nd|rd|th)\b", "", text, flags=re.IGNORECASE).replace(",", "")
    for fmt in DATE_FALLBACK_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
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


#: Used when a goal proposal names no deadline or no weekly pace.
DEFAULT_GOAL_WEEKS = 12
DEFAULT_WEEKLY_HOURS = 3
DAYS_PER_WEEK = 7


async def _create_goal(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A goal needs a title.")

    raw_horizon = str(args.get("horizon") or "").strip()
    horizon = raw_horizon if raw_horizon in GOAL_HORIZONS else "medium"

    if not args.get("allow_duplicate"):
        existing = await _find_duplicate_goal(session, user_id=user_id, title=title)
        if existing is not None:
            return _fail(f"You already have a goal called '{existing.title}'. Open it instead of adding a second one.")

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

    # agentv2 plans from a total number of hours; the chat proposal only carries a weekly pace and a date.
    weeks = max(1, (goal.target_date - goal.start_date).days // DAYS_PER_WEEK) if goal.target_date else DEFAULT_GOAL_WEEKS
    goal.total_hours = weeks * (goal.weekly_hours or DEFAULT_WEEKLY_HOURS)

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
    return _ok(summary, goal_id=goal.id)


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
    return _ok(summary, goal_id=goal.id)


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
    return _ok(summary, goal_id=goal.id)


async def _add_milestone(
    session: AsyncSession, *, user_id: str, args: dict
) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A milestone needs a title.")

    ref = await _resolve_goal_ref(session, user_id=user_id, args=args)
    goal_title = ref.goal_title if ref else str(args.get("goal_title") or "")

    # A sub-milestone names its facet by title; the facet was proposed earlier in the same block, so
    # it is already a row. An unknown facet title leaves this one a facet itself.
    parent_title = str(args.get("parent") or "").strip()
    parent_id = None
    if parent_title and ref:
        parent_id = (await session.execute(select(Milestone.id).where(
            Milestone.user_id == user_id, Milestone.goal_id == ref.goal_id, Milestone.title == parent_title,
            Milestone.parent_id.is_(None)).limit(1))).scalar_one_or_none()

    ms = await repo.create_milestone(
        session,
        user_id=user_id,
        title=title,
        goal_id=ref.goal_id if ref else None,
        goal_title=goal_title,
        target_date=_as_date(args.get("target_date")),
        phase=str(args.get("phase") or ""),
        parent_id=parent_id,
        hours=_as_hours(args.get("hours")),
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
    return _ok(summary, goal_id=ms.goal_id)


async def _add_blocker(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    title = str(args.get("title") or "").strip()
    if not title:
        return _fail("A blocker needs a title.")
    start = _as_date(args.get("start_date")) or datetime.now(UTC).date()
    end = _as_date(args.get("end_date")) or start

    # §4f: Write AwayBlock to calendar_blocks
    blk = AwayBlock(id=new_id("away"), title=title, start_date=start, end_date=end)
    session.add(CalendarBlock(
        id=blk.id, user_id=user_id, block_kind="away", title=blk.title,
        data=blk.model_dump(mode="json")))
    await session.flush()
    summary = f"Away '{title}' {start.isoformat()}..{end.isoformat()}"
    await repo.write_audit(
        session, user_id=user_id, type="confirm:add_blocker",
        summary=summary, payload={"block_id": blk.id, "args": _safe(args)},
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

    # §4f: Write EventBlock or TaskBlock to calendar_blocks
    s_time = _t.fromisoformat(start)
    e_time = _t.fromisoformat(end)
    blk_id = new_id("evt")
    if goal_id:
        blk = TaskBlock(
            id=blk_id, title=label, day=block_date, start=s_time, end=e_time,
            goal_id=goal_id, placed_by="user"
        )
        block_kind = "task"
    else:
        blk = EventBlock(
            id=blk_id, title=label, day=block_date, start=s_time, end=e_time
        )
        block_kind = "event"
    session.add(CalendarBlock(
        id=blk.id, user_id=user_id, block_kind=block_kind, title=blk.title,
        data=blk.model_dump(mode="json")))
    await session.flush()
    summary = f"Scheduled '{label}' {block_date.isoformat()} {start}-{end}"
    await repo.write_audit(
        session, user_id=user_id, type="confirm:add_block",
        summary=summary, payload={"block_id": blk.id, "args": _safe(args)},
    )
    if goal_id:
        await staleness.record_change(
            session, user_id=user_id, goal_id=goal_id, kind="timetable",
            horizons_moved=radius_for("timetable.add")[0], summary=summary,
        )
    return _ok(summary)


async def _edit_block(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    """Edit an existing calendar block (event, task, away, or milestone)."""
    block_id = str(args.get("block_id") or "").strip()
    if not block_id:
        return _fail("edit_block requires block_id.")

    # §4g: Edit CalendarBlock
    row = await session.get(CalendarBlock, block_id)
    if row is None or row.user_id != user_id:
        return _fail(f"No matching block for '{block_id}'")
    blk_dict = row.data
    blk = BLOCK_ADAPTER.validate_python(blk_dict)
    # Update fields provided in args
    if args.get("title"):
        blk.title = str(args["title"])
    if args.get("block_date"):
        parsed = _as_date(args["block_date"])
        if parsed:
            # Event/Task use 'day', Away uses 'start_date'/'end_date', Milestone uses 'target_date'
            if hasattr(blk, 'day') and blk.day is not None:
                blk.day = parsed
            elif hasattr(blk, 'start_date'):
                blk.start_date = parsed
                if hasattr(blk, 'end_date') and (blk.end_date is None or blk.end_date < parsed):
                    blk.end_date = parsed
            elif hasattr(blk, 'target_date'):
                blk.target_date = parsed
    if args.get("start_time"):
        from datetime import time as _t
        if hasattr(blk, 'start'):
            blk.start = _t.fromisoformat(str(args["start_time"]))
    if args.get("end_time"):
        from datetime import time as _t
        if hasattr(blk, 'end'):
            blk.end = _t.fromisoformat(str(args["end_time"]))
    if args.get("goal_title"):
        ref = await goal_drop.resolve_goal_ref(session, user_id=user_id, goal_title=str(args["goal_title"]))
        if ref is None:
            return _fail(f"No matching goal for '{args['goal_title']}'")
        blk.goal_id = ref.goal_id
    row.data = blk.model_dump(mode="json")
    row.title = blk.title
    await session.flush()
    summary = f"Updated block '{blk.title}'"
    await repo.write_audit(
        session, user_id=user_id, type="confirm:edit_block",
        summary=summary, payload={"block_id": block_id, "args": _safe(args)},
    )
    return _ok(summary)


async def _delete_block(session: AsyncSession, *, user_id: str, args: dict) -> ExecResult:
    """Delete an existing calendar block."""
    block_id = str(args.get("block_id") or "").strip()
    if not block_id:
        return _fail("delete_block requires block_id.")

    # §4g: Delete from CalendarBlock
    row = await session.get(CalendarBlock, block_id)
    if row is None or row.user_id != user_id:
        return _fail(f"No matching block for '{block_id}'")
    title = row.title
    await session.execute(
        delete(CalendarBlock).where(CalendarBlock.id == block_id, CalendarBlock.user_id == user_id))
    await session.flush()
    summary = f"Deleted block '{title}'"
    await repo.write_audit(
        session, user_id=user_id, type="confirm:delete_block",
        summary=summary, payload={"block_id": block_id, "args": _safe(args)},
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
    "edit_block": _edit_block,
    "delete_block": _delete_block,
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
