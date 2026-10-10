"""Memories — photo and Instagram keepsakes.

**This is not the shape the spec declares.** `openapi.yaml` documents
`Memory{id, text, source_id, created_at}`, which is v1's **`user_facts`** table —
a different resource, served at a different route, holding durable facts about
the user. This route serves keepsakes, and `Memories.js` renders them as an image
grid with a lightbox; the spec's shape has no image field at all. See
`CONTRACT-RECONCILIATION.md` #53.

The two are easy to confuse and are kept deliberately distinct: a *fact* is
something the coach learned and uses to plan, and a *memory* is something the
user wants to look at again.

All three v1 quirks are kept:

* `GET` **wraps** (`{"memories": [...]}`) where `/audit`, `/sources` and
  `/timetable` are bare. The client branches on it.
* `POST` returns **200**, not 201, and answers `{ok, memory: {id, kind}}` — a
  receipt, not the row.
* `DELETE` **hard**-deletes, despite the module header claiming a soft detach.
  Nothing references a memory, so the row has no reason to survive.
"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..models import Memory
from ..store import repo
from ..wire import memory

router = APIRouter(tags=["memories"])

#: An Instagram post URL: `/p/`, `/reel/`, `/reels/` or `/tv/` then a slug.
_IG_PATH = re.compile(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]{6,})")

_CAPTION_MAX = 600


def _instagram_shortcode(raw: str) -> str | None:
    """The post slug, or None if this is not an Instagram post URL.

    Validated rather than trusted: an "instagram" memory whose URL is not one
    would render an embed that never loads, and the failure would look like the
    app being broken rather than the link being wrong.
    """
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if not (host == "instagram.com" or host.endswith(".instagram.com")):
        return None
    m = _IG_PATH.search(parts.path)
    return m.group(1) if m else None


async def _goal_title(
    session: AsyncSession, *, user_id: str, goal_id: str | None
) -> tuple[str | None, str]:
    """An unknown or unowned goal is **silently ignored**, unlike sources.

    A memory is a keepsake first; refusing to save the photo because a goal id
    was stale would lose the thing the user actually cared about. The goal link
    is the decoration, so a bad one just does not stick.
    """
    if not goal_id:
        return None, ""
    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    if goal is None:
        return None, ""
    return goal.id, goal.title


@router.get("/memories")
async def list_memories(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    rows = await repo.list_memories(session, user_id=user.user_id)
    return {"memories": [memory(m) for m in rows]}


@router.post("/memories")
async def create_memory(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Add a memory. Two kinds, each with its own requirement.

    A **photo** needs a `source_id` — it is a pointer at an uploaded file, and
    the upload must happen first (`/sources/upload`). An **instagram** post needs
    a valid `external_url`. Neither is inferred.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    body = body or {}

    kind = "instagram" if body.get("kind") == "instagram" else "photo"
    caption = str(body.get("caption") or "").strip()[:_CAPTION_MAX]
    goal_id, goal_title = await _goal_title(
        session, user_id=user.user_id, goal_id=body.get("goal_id") or None
    )

    row = Memory(
        id=new_id("mem"),
        user_id=user.user_id,
        kind=kind,
        caption=caption,
        goal_id=goal_id,
        goal_title=goal_title,
        occurred_on=date.today(),
        extra={},
    )

    if kind == "instagram":
        external_url = str(body.get("external_url") or "").strip()
        if not external_url:
            raise HTTPException(
                status_code=400, detail="external_url required for instagram kind"
            )
        shortcode = _instagram_shortcode(external_url)
        if shortcode is None:
            raise HTTPException(
                status_code=400,
                detail="That doesn't look like an Instagram post URL.",
            )
        row.external_url = external_url
        row.instagram_shortcode = shortcode
    else:
        source_id = str(body.get("source_id") or "").strip()
        if not source_id:
            raise HTTPException(
                status_code=400,
                detail="source_id required for photo kind (run /api/sources/upload first)",
            )
        row.source_id = source_id

    session.add(row)
    await session.flush()
    await session.commit()
    return {"ok": True, "memory": {"id": row.id, "kind": row.kind}}


@router.delete("/memories/{id}")
async def delete_memory(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Hard delete. The underlying `sources` row is left alone.

    Removing a keepsake should not remove the file it points at — the same file
    may be attached to a goal, and the audit ledger knows about it.
    """
    row = await repo.get_memory(session, user_id=user.user_id, memory_id=id)
    if row is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    await session.delete(row)
    await session.commit()
    return {"ok": True, "deleted": id}
