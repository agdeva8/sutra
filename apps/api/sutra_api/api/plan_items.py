"""Plan items — the rows of the schedule of record.

Only two things a caller may do, and both are narrow on purpose: **add a
user-owned daily task**, and **tick it**. Everything else on this table is
written by the solver, where a plan is replaced whole rather than patched.

Three v1 asymmetries are kept; `CONTRACT-RECONCILIATION.md` #37-40:

* `POST` returns **200**, not 201, and wraps the row in `{"plan_item": ...}`.
* `PATCH` — the same resource — also wraps, which is the opposite of what the
  spec says.
* The `POST` row **omits `created_at`**; the `PATCH` row includes it.
"""
from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.blast_radius import radius_for
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import PLAN_ITEM_STATUSES

#: The plan-item status that stamps `done_at`.
STATUS_DONE = "done"
from ..store import repo, staleness
from ..wire import plan_item

router = APIRouter(tags=["plan-items"])


def _as_date(v: object) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {v!r}")


async def _record_plan_item_change(
    session: AsyncSession, *, user_id: str, goal_id: str | None, summary: str
) -> None:
    """Record the staleness change, but only for a goal-owned item.

    A user's own daily task with no goal has no goal to make stale. v1 recorded
    one anyway, passing the action string where the `goal_id` belonged, which is
    how that family of bugs went unnoticed.
    """
    if not goal_id:
        return
    horizons, milestone_moved = radius_for("plan_item.edit")
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal_id,
        kind="plan_item",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=summary,
    )


@router.post("/plan-items")
async def create_plan_item(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Add a user-owned all-day task.

    `due_date` is required, and `horizon` is forced to `daily`: this endpoint
    creates a task on a day, not a scheduled span. A caller cannot use it to
    invent a monthly row — that is the solver's output, and letting a client
    write one would put an unscheduled row in the lattice.

    The row is a `TaskBlock` in `calendar_blocks`, written through the gateway like every
    other plan change; the response keeps the `plan_item` shape the client reads.
    """
    from agentv2 import local_now
    from agentv2.contracts.blocks import AddItem, TaskBlock
    from agentv2.core.ids import new_id

    from ..models import CalendarBlock

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    due = _as_date(body.get("due_date"))
    if due is None:
        raise HTTPException(status_code=400, detail="due_date is required")

    goal_id = body.get("goal_id") or None
    if goal_id:
        goal = await repo.get_goal(session, user_id=user.user_id, goal_id=goal_id)
        if goal is None:
            raise HTTPException(status_code=404, detail="Goal not found")

    today = local_now(request.headers.get("x-timezone")).date()
    blk = TaskBlock(
        id=new_id("task"), title=title, day=due, goal_id=goal_id,
        description=str(body.get("note") or ""), placed_by="user",
    )
    await _apply_via_gateway(session, request, user.user_id, AddItem(block=blk), today)
    await _record_plan_item_change(
        session,
        user_id=user.user_id,
        goal_id=goal_id,
        summary=f"Added task '{blk.title}'",
    )
    await session.commit()
    row = await session.get(CalendarBlock, blk.id)
    return {"plan_item": _block_plan_item(blk, created_at=row.created_at if row else None, with_created_at=False)}


@router.patch("/plan-items/{id}")
async def update_plan_item(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Tick a task open or done. **Only `status` is editable.**

    Not a general patch: the title, the note and the dates of a solver-written
    row are the plan, and a client editing them would desynchronise the row from
    the placement that produced it.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    unknown = set(body) - {"status"}
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown fields: {', '.join(sorted(unknown))}",
        )

    item = await repo.get_plan_item(session, user_id=user.user_id, item_id=id)
    if item is None:
        raise HTTPException(status_code=404, detail="Plan item not found")

    if "status" in body:
        status = str(body["status"])
        if status not in PLAN_ITEM_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"status must be one of {', '.join(PLAN_ITEM_STATUSES)}",
            )
        item.status = status
        item.done_at = datetime.now(UTC) if status == STATUS_DONE else None
        await _record_plan_item_change(
            session,
            user_id=user.user_id,
            goal_id=item.goal_id,
            summary=(
                "Completed a task" if status == "done" else "Reopened a task"
            ),
        )
    await session.commit()
    return {"plan_item": plan_item(item)}


#: Longest to-do title kept, so a pasted paragraph does not become one row's title.
TODO_TITLE_MAX = 300
#: Longest to-do description kept.
TODO_DESCRIPTION_MAX = 4000
#: Fields a to-do edit may set; anything else in the body is a 400.
TODO_EDITABLE = frozenset({"title", "day", "due_time", "priority", "description", "goal_id", "done"})


async def _todo_body(request: Request) -> dict:
    try:
        return (await request.json()) or {}
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")


def _todo_fields(body: dict, *, today: date) -> tuple[dict, list[str]]:
    """Parse the optional to-do fields of a body. Returns (fields to set, fields to clear): a key sent as
    null or "" clears it. Raises 400 on a bad value, and on a day already gone."""
    from datetime import time as _time

    from agentv2.config import TODO_PRIORITIES

    out: dict = {}
    clear: list[str] = []
    for key in ("day", "due_time", "description", "goal_id"):
        if key in body and body[key] in (None, ""):
            clear.append(key)
    if body.get("title") is not None:
        out["title"] = str(body["title"]).strip()[:TODO_TITLE_MAX]
        if not out["title"]:
            raise HTTPException(status_code=400, detail="title can't be empty")
    if body.get("day"):
        out["day"] = _as_date(body["day"])
        if out["day"] < today:
            raise HTTPException(status_code=400, detail="That day has already passed.")
    if body.get("due_time"):
        try:
            out["due_time"] = _time.fromisoformat(str(body["due_time"])[:5])
        except ValueError:
            raise HTTPException(status_code=400, detail="due_time must be HH:MM")
    if body.get("priority") is not None:
        if body["priority"] not in TODO_PRIORITIES:
            raise HTTPException(status_code=400, detail=f"priority must be one of {', '.join(TODO_PRIORITIES)}")
        out["priority"] = body["priority"]
    if body.get("description"):
        out["description"] = str(body["description"]).strip()[:TODO_DESCRIPTION_MAX]
    if body.get("goal_id"):
        out["goal_id"] = str(body["goal_id"])
    if body.get("done") is not None:
        out["done"] = bool(body["done"])
    return out, clear


def _block_plan_item(blk, *, created_at=None, with_created_at: bool = True) -> dict:
    """A task block in the legacy `plan_item` wire shape.

    The to-do screens (and `TodoForm`) read this shape today; the block itself rides alongside
    under `block` so they can move over without a flag day. `horizon` stays `daily` because a
    block placed by the user is a row of the day, exactly what `POST /plan-items` used to write.
    """
    from agentv2.config import ITEM_TYPE_TODO, TODO_PRIORITY_NORMAL

    done = blk.done or blk.state == "done"
    out = {
        "id": blk.id,
        "goal_id": blk.goal_id,
        "horizon": "daily",
        "phase": None,
        "title": blk.title,
        "note": blk.description or "",
        "description": blk.description or None,
        "why": blk.why or None,
        "done_hours": None,
        "start_date": None,
        "end_date": None,
        "due_date": blk.day.isoformat() if blk.day else None,
        "weekly_hours": None,
        "status": "done" if done else "open",
        "item_type": ITEM_TYPE_TODO if blk.todo else None,
        "priority": (blk.priority or TODO_PRIORITY_NORMAL) if blk.todo else None,
        "due_time": blk.at.strftime("%H:%M") if blk.at else None,
        "done_at": None,
    }
    if with_created_at:
        out["created_at"] = created_at.isoformat() if created_at else None
    return out


def _block_wire(blk) -> dict:
    """The block as `/state` sends it: `id` at the top plus the full JSON state."""
    return {"id": blk.id, **blk.model_dump(mode="json")}


async def _apply_via_gateway(session: AsyncSession, request: Request, user_id: str, change, today: date):
    """Send one change through agentv2's gateway, the one write path: validated, audited, undoable."""
    from agentv2 import ChangeSet, Origin, apply_changes

    from ..agent_store import SqlStore

    res = await apply_changes(SqlStore(session, user_id, today=today), ChangeSet(origin=Origin(source="manual"), changes=[change]))
    if hasattr(res, "violations"):
        await session.commit()  # keep the reject row the gateway logged
        raise HTTPException(status_code=422, detail="; ".join(v.message for v in res.violations) or "That change isn't valid.")
    await session.commit()
    return res


def _todo_fields_to_block(fields: dict, clear: list[str]) -> dict:
    """The `_todo_fields` result mapped onto `TaskBlock` field names."""
    out = dict(fields)
    if "due_time" in out:
        out["at"] = out.pop("due_time")
    for key in clear:
        out["at" if key == "due_time" else key] = None
    return out


@router.post("/todos")
async def create_todo(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Add a to-do: a title, and optionally a day, a due-by time, a priority, a description and a goal.

    The row is a `TaskBlock` with `todo=True` in `calendar_blocks`, written through the gateway, so
    it is audited and undoable like one Scratch files. No day means "on Today until it is done".
    """
    from agentv2 import local_now
    from agentv2.config import TODO_ID_PREFIX, TODO_PRIORITY_NORMAL
    from agentv2.contracts.blocks import AddItem, TaskBlock
    from agentv2.core.ids import new_id

    from ..models import CalendarBlock

    today = local_now(request.headers.get("x-timezone")).date()
    fields, _ = _todo_fields(await _todo_body(request), today=today)
    if not fields.get("title"):
        raise HTTPException(status_code=400, detail="title is required")
    fields.pop("done", None)
    blk = TaskBlock(
        id=new_id(TODO_ID_PREFIX),
        title=fields.pop("title"),
        goal_id=fields.pop("goal_id", None),
        day=fields.pop("day", None),
        at=fields.pop("due_time", None),
        priority=fields.pop("priority", TODO_PRIORITY_NORMAL),
        description=fields.pop("description", ""),
        todo=True, placed_by="user",
    )
    res = await _apply_via_gateway(session, request, user.user_id, AddItem(block=blk), today)
    row = await session.get(CalendarBlock, blk.id)
    return {
        "plan_item": _block_plan_item(blk, created_at=row.created_at if row else None, with_created_at=False),
        "block": _block_wire(blk),
        "audit_id": res.audit_id,
    }


@router.patch("/todos/{id}")
async def edit_todo(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Edit a to-do or tick it done / not done. Only the fields sent change; a field sent as null clears it.
    The previous values ride along in the change, so undo restores them.

    A to-do filed before the move to `calendar_blocks` is still a `plan_items` row; editing it by id
    keeps editing that row (`EditTodo`). Everything newer is a `TaskBlock` (`EditItem`).
    """
    from agentv2 import local_now
    from agentv2.config import ITEM_TYPE_TODO
    from agentv2.contracts import EditTodo
    from agentv2.contracts.blocks import EditItem, TaskBlock

    from ..models import CalendarBlock, PlanItem

    body = await _todo_body(request)
    unknown = set(body) - TODO_EDITABLE
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown fields: {', '.join(sorted(unknown))}")
    today = local_now(request.headers.get("x-timezone")).date()

    row = await session.get(PlanItem, id)
    if row is not None and row.user_id == user.user_id and row.item_type == ITEM_TYPE_TODO:
        # An unchanged day that is already past (an overdue to-do) is not a new past date: drop it.
        if body.get("day") and _as_date(body["day"]) == row.due_date:
            body.pop("day")
        fields, clear = _todo_fields(body, today=today)
        before = {
            "title": row.title, "goal_id": row.goal_id, "priority": row.priority, "description": row.description,
            "day": row.due_date.isoformat() if row.due_date else None,
            "due_time": row.due_time.strftime("%H:%M") if row.due_time else None,
            "done": row.status == "done",
        }
        res = await _apply_via_gateway(session, request, user.user_id, EditTodo(id=id, clear=clear, before=before, **fields), today)
        await session.refresh(row)
        return {"plan_item": plan_item(row), "audit_id": res.audit_id}

    block_row = await session.get(CalendarBlock, id)
    if block_row is None or block_row.user_id != user.user_id or block_row.block_kind != "task":
        raise HTTPException(status_code=404, detail="To-do not found")
    from agentv2.contracts.blocks import BLOCK_ADAPTER
    current = BLOCK_ADAPTER.validate_python(block_row.data)
    if not isinstance(current, TaskBlock) or not current.todo:
        raise HTTPException(status_code=404, detail="To-do not found")
    # An unchanged day that is already past (an overdue to-do) is not a new past date: drop it.
    if body.get("day") and _as_date(body["day"]) == current.day:
        body.pop("day")
    fields, clear = _todo_fields(body, today=today)
    updates = _todo_fields_to_block(fields, clear)
    updated = current.model_copy(update=updates)
    if "done" in updates:
        updated.done = bool(updates["done"])
        updated.state = "done" if updated.done else "open"
    before = current.model_dump(mode="json")
    res = await _apply_via_gateway(session, request, user.user_id, EditItem(id=id, block=updated, before=before), today)
    return {
        "plan_item": _block_plan_item(updated, created_at=block_row.created_at),
        "block": _block_wire(updated),
        "audit_id": res.audit_id,
    }
