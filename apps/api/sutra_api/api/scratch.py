"""Scratch — reflex capture with async inference (docs/prd/scratchpad.md §17).

`POST` returns as soon as the row is written; triage runs after the response. The
page reads one `GET` that already splits waiting from handled, so the two panes
cannot drift.
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..rate_limit import llm_rate_limit
from ..background import run_after
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..agent_store import AUDIT_APPLY, SqlStore
from ..models import SCRATCH_KINDS, AuditEntry, ScratchEntry, Source
from ..scratch_service import process
from ..wire import iso_dt

router = APIRouter(tags=["scratch"])

#: Rows returned per pane. Generous (CLAUDE.md principle 6); tighten on evidence.
PANE_LIMIT = 200
BODY_MAX_CHARS = 4000
WAITING = ("pending", "processing", "needs_input", "failed")


def _row(e: ScratchEntry) -> dict:
    return {
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
    await run_after(background, process, entry.id)
    await session.refresh(entry)
    return _row(entry)


@router.get("/scratch")
async def list_entries(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    rows = (await session.execute(
        select(ScratchEntry).where(ScratchEntry.user_id == user.user_id)
        .order_by(ScratchEntry.created_at.desc()).limit(PANE_LIMIT * 2)
    )).scalars().all()
    return {
        "waiting": [_row(e) for e in rows if e.status in WAITING][:PANE_LIMIT],
        "handled": [_row(e) for e in rows if e.status == "handled"][:PANE_LIMIT],
    }


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
    await run_after(background, process, entry.id)
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
        await run_after(background, process, entry.id)
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
    audit = (await session.execute(
        select(AuditEntry).where(
            AuditEntry.user_id == user.user_id, AuditEntry.type == AUDIT_APPLY,
            AuditEntry.payload["origin"]["ref"].astext == entry_id)
        .order_by(AuditEntry.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    if audit is None:
        raise HTTPException(status_code=404, detail="Nothing recorded to undo")
    res = await undo_audit(SqlStore(session, user.user_id), audit.id)
    if res.already_undone:
        raise HTTPException(status_code=409, detail="Already undone")
    entry.status = "undone"
    await session.commit()
    return {"reverted": res.reverted, "not_restored": res.not_restored}


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
