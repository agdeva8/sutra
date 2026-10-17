"""Scratch — reflex capture with async inference (docs/prd/scratchpad.md §17).

`POST` returns as soon as the row is written; triage runs after the response. The
page reads one `GET` that already splits waiting from handled, so the two panes
cannot drift.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agentv2.config import ITEM_TYPE_TODO
from agentv2.contracts import Change, ChangeSet, EditTodo, LinkSource, Origin
from agentv2.contracts.blocks import BLOCK_ADAPTER, Block, EditItem

from ..db import get_session
from ..rate_limit import llm_rate_limit
from ..background import run_after
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..agent_store import AUDIT_APPLY, SqlStore
from ..models import SCRATCH_KINDS, AuditEntry, CalendarBlock, Goal, PlanItem, ScratchEntry, Source
from ..scratch_service import process
from ..stream import progress_stream, sse_response, wants_stream
from ..wire import iso_dt

router = APIRouter(tags=["scratch"])

#: Rows returned per pane. Generous (CLAUDE.md principle 6); tighten on evidence.
PANE_LIMIT = 200
BODY_MAX_CHARS = 4000
WAITING = ("pending", "processing", "needs_input", "failed")

#: The goal state a Scratch entry can move: only an active goal is a valid target.
GOAL_ACTIVE = "active"
#: The one status whose entries can be re-linked (a filed entry is part of the history).
STATUS_HANDLED = "handled"

#: What a re-linkable row lives in. The audit names the change; this names the table.
ITEM_BLOCK = "block"
ITEM_TODO = "todo"
ITEM_SOURCE = "source"

#: Audit change kind -> the kind of row it created.
CREATED_ITEM_KINDS = {"add_item": ITEM_BLOCK, "add_todo": ITEM_TODO, "link_source": ITEM_SOURCE}


@dataclass(frozen=True)
class CreatedItem:
    """One row a filing wrote, named by the table it lives in."""

    kind: str
    id: str


@dataclass(frozen=True)
class TodoState:
    """The fields a re-link needs from a `plan_items` to-do: the new goal and the undo snapshot."""

    title: str
    goal_id: str | None
    priority: str | None
    description: str | None
    day: date | None
    due_time: str | None
    done: bool


@dataclass(frozen=True)
class SourceState:
    """What `LinkSource` needs to re-point a source without inventing text for it."""

    title: str
    summary: str
    goal_id: str | None


def _row(e: ScratchEntry, *, undoable: bool | None = None, linkable: int | None = None,
         goal: dict | None = None) -> dict:
    row = {
        "id": e.id,
        "kind": e.kind,
        "body": e.body,
        "source_id": e.source_id,
        "status": e.status,
        "question": e.question,
        "error": e.error,
        "result": e.result,
        "created_at": iso_dt(e.created_at),
        "handled_at": iso_dt(e.handled_at),
    }
    if undoable is not None:
        # Only handled entries the agent actually wrote something for (an audit row exists) can be undone;
        # a NOISE entry changed nothing, so the client must not offer Undo on it.
        row["undoable"] = undoable
    if linkable is not None:
        # How many rows the entry created that a goal link can move, and the goal they all currently
        # share (None also means "they disagree", which the next link resolves). The card draws its
        # label from this, so it never has to fetch every item to know what it is linked to.
        row["linkable"] = linkable
        row["goal"] = goal
    return row


# ---------------------------------------------------------------------------
# The pure part: what a filing created, and what re-linking it looks like
# ---------------------------------------------------------------------------


def created_items(payload: dict | None) -> list[CreatedItem]:
    """The rows a filing actually wrote, read back from its audit row.

    `applied` holds the indices of the changes that landed; a proposal wrote nothing, so it is skipped.
    This is the same ledger read `undo` does, which is why an entry needs no extra column to remember
    what it created.
    """
    changes = (payload or {}).get("changes") or []
    applied = set((payload or {}).get("applied") or [])
    out: list[CreatedItem] = []
    for i, change in enumerate(changes):
        kind = CREATED_ITEM_KINDS.get(change.get("kind"))
        if kind is None or i not in applied:
            continue
        if kind == ITEM_BLOCK:
            item_id = (change.get("block") or {}).get("id")
        elif kind == ITEM_TODO:
            item_id = change.get("id")
        else:
            item_id = change.get("source_id")
        if item_id:
            out.append(CreatedItem(kind=kind, id=item_id))
    return out


def can_relink(block: Block) -> bool:
    """An away span has no goal at all. Every other kind can carry one."""
    return block.block_kind != "away"


def _item_goal(item: CreatedItem, *, blocks: dict[str, Block], todos: dict[str, TodoState],
               sources: dict[str, SourceState]) -> str | None:
    """The goal a created row points at now, or None when it is gone or carries none."""
    if item.kind == ITEM_BLOCK:
        block = blocks.get(item.id)
        return block.goal_id if block is not None and can_relink(block) else None
    if item.kind == ITEM_TODO:
        state = todos.get(item.id)
        return state.goal_id if state is not None else None
    state = sources.get(item.id)
    return state.goal_id if state is not None else None


def link_state(items: list[CreatedItem], *, blocks: dict[str, Block], todos: dict[str, TodoState],
               sources: dict[str, SourceState]) -> tuple[int, str | None]:
    """(rows a link would move, the single goal they share).

    A mixed link answers None: the card then offers "Link to a goal", and the next tap is what makes
    the rows agree — which is the action the user is being offered.
    """
    linkable = 0
    goals: set[str | None] = set()
    for item in items:
        exists = (
            item.id in blocks if item.kind == ITEM_BLOCK
            else item.id in todos if item.kind == ITEM_TODO
            else item.id in sources
        )
        if not exists:
            continue
        linkable += 1
        goals.add(_item_goal(item, blocks=blocks, todos=todos, sources=sources))
    return linkable, (next(iter(goals)) if len(goals) == 1 else None)


def relink_changes(items: list[CreatedItem], goal_id: str | None, *, blocks: dict[str, Block],
                   todos: dict[str, TodoState], sources: dict[str, SourceState]) -> list[Change]:
    """The changes that point every created row at `goal_id`, or at no goal when it is None.

    Each kind of row has its own edit: a 4-kind block is replaced whole (`EditItem`), a to-do edits
    only its goal (`EditTodo`, clearing it for "No goal"), and a source re-points with `LinkSource`.
    """
    out: list[Change] = []
    for item in items:
        if item.kind == ITEM_BLOCK:
            block = blocks.get(item.id)
            if block is None or not can_relink(block):
                continue
            # A milestone always belongs to a goal, so "No goal" leaves it where it is.
            if block.block_kind == "milestone" and goal_id is None:
                continue
            out.append(EditItem(
                id=item.id,
                block=block.model_copy(update={"goal_id": goal_id}),
                before=block.model_dump(mode="json"),
            ))
        elif item.kind == ITEM_TODO:
            state = todos.get(item.id)
            if state is None:
                continue
            before = {
                "title": state.title, "goal_id": state.goal_id, "priority": state.priority,
                "description": state.description,
                "day": state.day.isoformat() if state.day else None,
                "due_time": state.due_time, "done": state.done,
            }
            if goal_id is None:
                out.append(EditTodo(id=item.id, clear=["goal_id"], before=before))
            else:
                out.append(EditTodo(id=item.id, goal_id=goal_id, before=before))
        else:
            state = sources.get(item.id)
            if state is None:
                continue
            out.append(LinkSource(source_id=item.id, goal_id=goal_id, title=state.title,
                                  summary=state.summary))
    return out


def link_summary(count: int, goal_title: str | None) -> str:
    """The audit row's one sentence, in the user's terms."""
    items = f"{count} item" + ("" if count == 1 else "s")
    if goal_title is None:
        return f"Unlinked {items} from Scratch"
    return f"Linked {items} from Scratch to '{goal_title}'"


async def _item_states(session: AsyncSession, user_id: str, items: list[CreatedItem]):
    """Current rows behind a filing's created items, keyed by id. Other users' rows never enter."""
    blocks: dict[str, Block] = {}
    todos: dict[str, TodoState] = {}
    sources: dict[str, SourceState] = {}

    block_ids = [i.id for i in items if i.kind == ITEM_BLOCK]
    if block_ids:
        rows = (await session.execute(
            select(CalendarBlock).where(
                CalendarBlock.user_id == user_id, CalendarBlock.id.in_(block_ids))
        )).scalars().all()
        for row in rows:
            try:
                blocks[row.id] = BLOCK_ADAPTER.validate_python(row.data)
            except Exception:
                pass  # An unparsable row cannot be re-linked; leave it out rather than fail the card.

    todo_ids = [i.id for i in items if i.kind == ITEM_TODO]
    if todo_ids:
        rows = (await session.execute(
            select(PlanItem).where(
                PlanItem.user_id == user_id, PlanItem.id.in_(todo_ids),
                PlanItem.item_type == ITEM_TYPE_TODO)
        )).scalars().all()
        for row in rows:
            todos[row.id] = TodoState(
                title=row.title, goal_id=row.goal_id, priority=row.priority,
                description=row.description,
                day=row.due_date,
                due_time=row.due_time.strftime("%H:%M") if row.due_time else None,
                done=row.status == "done",
            )

    source_ids = [i.id for i in items if i.kind == ITEM_SOURCE]
    if source_ids:
        rows = (await session.execute(
            select(Source).where(
                Source.user_id == user_id, Source.id.in_(source_ids), Source.is_deleted.is_(False))
        )).scalars().all()
        for row in rows:
            sources[row.id] = SourceState(
                title=row.original_filename, summary="", goal_id=row.goal_id)
    return blocks, todos, sources


@router.post("/scratch", status_code=201, dependencies=[Depends(llm_rate_limit)])
async def create_entry(
    request: Request,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    kind = str(body.get("kind") or "text")
    if kind not in SCRATCH_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {', '.join(SCRATCH_KINDS)}")
    text = str(body.get("body") or "").strip()[:BODY_MAX_CHARS]
    source_id = body.get("source_id") or None
    if kind == "text" and not text:
        raise HTTPException(status_code=400, detail="body is required")
    if kind in ("image", "file") and not source_id:
        raise HTTPException(status_code=400, detail="source_id is required")
    if source_id:
        src = await session.get(Source, source_id)
        if src is None or src.user_id != user.user_id:
            raise HTTPException(status_code=404, detail="Source not found")

    entry = ScratchEntry(id=new_id("scratch"), user_id=user.user_id, kind=kind, body=text, source_id=source_id,
                         tz=request.headers.get("x-timezone"))
    session.add(entry)
    await session.commit()
    # `defer`: the client will start the work itself with `POST /scratch/{id}/process`, which streams
    # progress. That is how a serverless host gets it done, and how the user sees what is happening.
    if body.get("defer") is not True:
        await run_after(background, process, entry.id)
        await session.refresh(entry)
    return _row(entry)


#: First progress line of a streamed filing, sent before the work reports its own.
PROCESS_FIRST = "Got it."


@router.post("/scratch/{entry_id}/process", dependencies=[Depends(llm_rate_limit)])
async def process_entry(
    entry_id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> object:
    """File one pending entry now, streaming what is happening. A no-op for an entry already past `pending`."""
    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    runnable = entry.status == "pending"

    async def job(say) -> dict:
        if runnable:
            await process(entry_id, say)
        fresh = await session.get(ScratchEntry, entry_id, populate_existing=True)
        return _row(fresh)

    if wants_stream(request):
        return sse_response(progress_stream(job, first=PROCESS_FIRST))
    return await job(lambda _line: None)


@router.get("/scratch")
async def list_entries(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    rows = (await session.execute(
        select(ScratchEntry).where(ScratchEntry.user_id == user.user_id)
        .order_by(ScratchEntry.created_at.desc()).limit(PANE_LIMIT * 2)
    )).scalars().all()
    handled = sorted((e for e in rows if e.status == STATUS_HANDLED),
                     key=lambda e: e.handled_at or e.created_at, reverse=True)[:PANE_LIMIT]

    # The filing's audit row is the oldest apply row for the entry: a later link writes its own row
    # under the same ref, and that one must not be mistaken for the one that created the items.
    filing: dict[str, dict] = {}
    if handled:
        payloads = (await session.execute(
            select(AuditEntry.payload).where(
                AuditEntry.user_id == user.user_id, AuditEntry.type == AUDIT_APPLY,
                AuditEntry.payload["origin"]["ref"].astext.in_([e.id for e in handled]))
            .order_by(AuditEntry.created_at.asc())
        )).scalars().all()
        for payload in payloads:
            ref = ((payload or {}).get("origin") or {}).get("ref")
            if ref:
                filing.setdefault(ref, payload)

    items_by_entry = {entry_id: created_items(payload) for entry_id, payload in filing.items()}
    blocks, todos, sources = await _item_states(
        session, user.user_id, [item for items in items_by_entry.values() for item in items])
    goal_ids = {
        goal for items in items_by_entry.values() for item in items
        if (goal := _item_goal(item, blocks=blocks, todos=todos, sources=sources))
    }
    goal_titles: dict[str, str] = {}
    if goal_ids:
        goal_titles = dict((await session.execute(
            select(Goal.id, Goal.title).where(
                Goal.user_id == user.user_id, Goal.id.in_(goal_ids))
        )).all())

    handled_rows = []
    for entry in handled:
        linkable, goal_id = link_state(
            items_by_entry.get(entry.id, []), blocks=blocks, todos=todos, sources=sources)
        goal = {"id": goal_id, "title": goal_titles.get(goal_id, "")} if goal_id else None
        handled_rows.append(_row(entry, undoable=entry.id in filing, linkable=linkable, goal=goal))

    # The picker names the user's active goals; a paused or dropped one is not a valid target.
    goals = (await session.execute(
        select(Goal.id, Goal.title).where(
            Goal.user_id == user.user_id, Goal.status == GOAL_ACTIVE)
        .order_by(Goal.created_at)
    )).all()
    return {
        "waiting": [_row(e) for e in rows if e.status in WAITING][:PANE_LIMIT],
        "handled": handled_rows,
        "goals": [{"id": gid, "title": title} for gid, title in goals],
    }


@router.post("/scratch/{entry_id}/link-goal")
async def link_entry_goal(
    entry_id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Point everything one entry filed at a goal — or at none.

    One gateway change set, so the edit and its audit row land together; the route only decides what
    to edit. An entry's rows are found from the audit row of its filing, never from the entry itself.
    """
    from agentv2.contracts.results import Applied, Rejected
    from agentv2.gateway import apply

    try:
        body = (await request.json()) or {}
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if "goal_id" not in body:
        raise HTTPException(status_code=400, detail="goal_id is required (use null for no goal)")
    goal_id = body.get("goal_id") or None
    if goal_id is not None and not isinstance(goal_id, str):
        raise HTTPException(status_code=400, detail="goal_id must be a string or null")

    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status != STATUS_HANDLED:
        raise HTTPException(status_code=409, detail="Only a handled entry can be linked")

    goal = None
    if goal_id is not None:
        goal = await session.get(Goal, goal_id)
        if goal is None or goal.user_id != user.user_id:
            raise HTTPException(status_code=404, detail="Goal not found")
        if goal.status != GOAL_ACTIVE:
            raise HTTPException(status_code=409, detail="Only an active goal can be linked")

    audit = (await session.execute(
        select(AuditEntry).where(
            AuditEntry.user_id == user.user_id, AuditEntry.type == AUDIT_APPLY,
            AuditEntry.payload["origin"]["ref"].astext == entry_id)
        .order_by(AuditEntry.created_at.asc()).limit(1)
    )).scalar_one_or_none()
    if audit is None:
        raise HTTPException(status_code=404, detail="Nothing recorded to re-link")

    items = created_items(audit.payload)
    blocks, todos, sources = await _item_states(session, user.user_id, items)
    changes = relink_changes(items, goal_id, blocks=blocks, todos=todos, sources=sources)
    if not changes:
        return {"items": [], "audit_id": None}

    store = SqlStore(session, user.user_id)
    res = await apply(ChangeSet(origin=Origin(source="scratch", ref=entry_id), changes=changes), store)
    if isinstance(res, Rejected):
        await session.commit()  # Keep the reject row: a link that broke a rule is worth seeing.
        raise HTTPException(status_code=422, detail={
            "violations": [v.model_dump() for v in res.violations]})
    assert isinstance(res, Applied)

    # The gateway's summary counts changes; this row is read by a person, so it says what happened.
    row = await session.get(AuditEntry, res.audit_id)
    if row is not None:
        row.summary = link_summary(len(res.applied), goal.title if goal else None)
    await session.commit()

    updated = []
    for i in res.applied:
        change = changes[i]
        if isinstance(change, EditItem):
            updated.append({"kind": ITEM_BLOCK, "id": change.id, "title": change.block.title,
                            "goal_id": change.block.goal_id})
        elif isinstance(change, EditTodo):
            updated.append({"kind": ITEM_TODO, "id": change.id, "title": todos[change.id].title,
                            "goal_id": goal_id})
        elif isinstance(change, LinkSource):
            updated.append({"kind": ITEM_SOURCE, "id": change.source_id,
                            "title": sources[change.source_id].title, "goal_id": change.goal_id})
    return {"items": updated, "audit_id": res.audit_id}


@router.post("/scratch/{entry_id}/retry")
async def retry_entry(
    entry_id: str,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status not in ("failed", "needs_input"):
        raise HTTPException(status_code=409, detail="Only a failed or waiting entry can be retried")
    entry.status, entry.error, entry.question = "pending", None, None
    await session.commit()
    # Filed by the client via `/process` (streamed), not inline: see `chat_entry`.
    await session.refresh(entry)
    return _row(entry)


@router.post("/scratch/{entry_id}/chat", dependencies=[Depends(llm_rate_limit)])
async def chat_entry(
    entry_id: str,
    request: Request,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """One turn of the chat about an entry that is waiting on the user.

    The agent either asks its next question (shown on the entry) or settles what the note means,
    in which case the entry is filed from the clarified text in the background."""
    from agentv2 import entry_chat

    try:
        body = (await request.json()) or {}
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    message = str(body.get("message") or "").strip()[:BODY_MAX_CHARS]
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status != "needs_input":
        raise HTTPException(status_code=409, detail="This entry is not waiting on you")

    turns = [tuple(t) for t in (entry.result or {}).get("chat", [])]
    step = await entry_chat(SqlStore(session, user.user_id), entry.body, turns, message)
    if step.error:
        raise HTTPException(status_code=503, detail=step.error)
    result = {"chat": [list(t) for t in step.turns]}
    if step.resolved:
        entry.result = {**result, "clarification": step.resolved}
        entry.status, entry.question = "pending", None
        await session.commit()
        # Not filed here: filing runs the whole triage (often 10-20s), which used to hold this reply
        # (and the user's spinner) hostage. The client files it next with `POST /scratch/{id}/process`,
        # which streams progress; an entry nobody files is picked up by the recovery job.
        await session.refresh(entry)
    else:
        entry.result = result
        entry.question = step.reply
        await session.commit()
    return {"reply": step.reply, "resolved": bool(step.resolved), "entry": _row(entry)}


@router.post("/scratch/{entry_id}/undo")
async def undo_entry(
    entry_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Undo what the agent did with a handled entry: remove what it added, reopen what it closed."""
    from agentv2 import undo_audit

    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status != "handled":
        raise HTTPException(status_code=409, detail="Only a handled entry can be undone")
    # The filing's audit row is the oldest one under this ref. A later re-link writes its own row,
    # and "Undo" on the card means the filing, not the last link the user made.
    audit = (await session.execute(
        select(AuditEntry).where(
            AuditEntry.user_id == user.user_id, AuditEntry.type == AUDIT_APPLY,
            AuditEntry.payload["origin"]["ref"].astext == entry_id)
        .order_by(AuditEntry.created_at.asc()).limit(1)
    )).scalar_one_or_none()
    if audit is None:
        raise HTTPException(status_code=404, detail="Nothing recorded to undo")
    res = await undo_audit(SqlStore(session, user.user_id), audit.id)
    if res.already_undone:
        raise HTTPException(status_code=409, detail="Already undone")
    entry.status = "undone"
    await session.commit()
    return {"reverted": res.reverted, "not_restored": res.not_restored}


#: Terminal status for a handled entry whose proposal the user turned down. Neither pane lists it.
STATUS_DISMISSED = "dismissed"


@router.post("/scratch/{entry_id}/dismiss")
async def dismiss_entry(
    entry_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Turn down what the agent only proposed for a handled entry. It changed nothing, so there is nothing to undo."""
    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status != "handled" or not (entry.result or {}).get("proposed"):
        raise HTTPException(status_code=409, detail="Only a handled entry with a proposal can be dismissed")
    entry.status = STATUS_DISMISSED
    await session.commit()
    return {"ok": True}


@router.delete("/scratch/{entry_id}")
async def discard_entry(
    entry_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Discard a waiting entry (used when the user answers it with a fuller note)."""
    entry = await session.get(ScratchEntry, entry_id)
    if entry is None or entry.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.status == "handled":
        raise HTTPException(status_code=409, detail="A handled entry is part of the history")
    await session.delete(entry)
    await session.commit()
    return {"ok": True}
