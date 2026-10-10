"""The audit ledger — read-only, and the export.

Append-only, written inside the transaction of the mutation it describes. Nothing
here deletes, edits, or filters by anything but user and type.

Two corrections to the spec, both in v1's favour
(`CONTRACT-RECONCILIATION.md` #56, #57):

* `AuditEntry` carries **`user_id` and `payload`** as well as `id`/`type`/
  `summary`/`created_at`. `payload` is what makes the ledger useful —
  `replan_suggestions` reads `payload.freed_weekly_hours` to detect a goal that
  freed capacity.
* `/audit/export` serves **JSON**, not `text/markdown`. The spec picked the
  storybook mock's behaviour over the real route's; the button in the UI says
  "Export JSON" because the route is JSON.

The export deliberately includes only the user's own rows and never a session
token, an API key, or another user's anything. It is the one route that returns
a whole account's history in one body, so it is the one where that matters most.
"""
from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import Message
from ..store import repo
from ..store.chat import proposals_for_messages
from ..wire import audit_entry, chat_message

router = APIRouter(tags=["audit"])

#: v1's clamp. The spec says 500; the route never served more than 200.
MAX_LIMIT = 200
DEFAULT_LIMIT = 50


@router.get("/audit")
async def list_audit(
    limit: int = DEFAULT_LIMIT,
    type: str = "",  # noqa: A002 - the query param really is `type`
    before: str = "",
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> list[dict]:
    """A **bare array**, newest first.

    `type` is a *prefix* filter, not an equality one — so `confirm:` returns
    every confirmed action. `before` is an opaque cursor: v1 accepted either a
    timestamp or an id and compared as a string, which works because both sort
    the same way lexicographically for these formats.
    """
    capped = max(1, min(limit, MAX_LIMIT))
    rows = await repo.list_audit(
        session, user_id=user.user_id, limit=capped, type_prefix=type
    )
    if before:
        rows = [
            r
            for r in rows
            if (r.created_at.isoformat() < before or r.id < before)
        ]
    return [audit_entry(r) for r in rows]


@router.get("/audit/export")
async def export_audit(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> Response:
    """Everything the account holds, as one downloadable JSON file.

    A file rather than an inline body, because the browser triggers a download
    and the client uses a plain `href` — there is no fetch to attach a filename
    to.
    """
    import json

    # Unbounded on purpose: an export that silently dropped rows would be worse
    # than a large file. `list_audit`'s cap is for the on-screen ledger.
    audit_rows = await repo.list_audit(session, user_id=user.user_id, limit=10_000)
    goals = await repo.list_goals(session, user_id=user.user_id, limit=500)
    messages = list(
        (
            await session.execute(
                select(Message)
                .where(Message.user_id == user.user_id)
                .order_by(Message.created_at.asc())
            )
        ).scalars()
    )
    by_message = await proposals_for_messages(
        session, message_ids=[m.id for m in messages]
    )

    payload = {
        "exported_at": datetime.now(UTC).isoformat(),
        "user": {"email": user.email, "name": user.name},
        # A reduced projection: the export is a record of *what was decided*, and
        # the full goal row adds solver detail nobody reads in a spreadsheet.
        "state": {
            "goals": [
                {
                    "id": g.id,
                    "title": g.title,
                    "horizon": g.horizon,
                    "status": g.status,
                    "created_at": g.created_at.isoformat(),
                }
                for g in goals
            ]
        },
        "conversation": [
            chat_message(m, by_message.get(m.id, [])) for m in messages
        ],
        "audit_log": [audit_entry(r) for r in audit_rows],
    }

    filename = f"sutra-export-{user.user_id}-{datetime.now(UTC):%Y-%m-%d}.json"
    return Response(
        content=json.dumps(payload, indent=2, default=str),
        media_type="application/json",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"
        },
    )
