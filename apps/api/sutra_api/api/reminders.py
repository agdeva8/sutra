"""Reminders: remove one.

Reminders are created by the agent (Scratch, the coach), which writes the whole schedule at once, so there is
no create or edit route here. A person who no longer wants one removes it, which is all this route does.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import Reminder
from ..store import repo

router = APIRouter(tags=["reminders"])


@router.delete("/reminders/{id}")
async def delete_reminder(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = await session.get(Reminder, id)
    # Ownership is part of the lookup: someone else's id is simply not found.
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Reminder not found")
    title = row.title
    await session.delete(row)
    await repo.write_audit(session, user_id=user.user_id, type="delete:reminder", summary=f"Deleted reminder '{title}'", payload={"reminder_id": id})
    await session.commit()
    return {"ok": True}
