"""Processing a Scratch entry in the background.

`POST /scratch` writes the row and returns; this runs after the response, on its
own session, so a slow or failing model never delays or loses the capture. The
`status` column is the queue (docs/prd/scratchpad.md §9): `retry` and a future
poller both just re-run `process` on a row.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from agentv2 import local_now, triage_entry
from sqlalchemy.ext.asyncio import async_sessionmaker

from . import storage
from .agent_store import SqlStore
from .db import get_engine
from .models import ScratchEntry, Source

log = logging.getLogger(__name__)

MSG_NO_TRANSCRIPT = "Couldn't hear anything in that. Try again."
MSG_UNEXPECTED = "Something went wrong reading this. Try again."

#: How much of an attached source's text goes into triage. Matches the stored excerpt cap.
SOURCE_TEXT_CHARS = 8000

#: What the user is told while an entry is filed, in order. Plain words.
SAY_OPENING_PHOTO = "Opening your photo…"
SAY_READING = "Reading what you wrote…"
SAY_DECIDING = "Working out what this is and where it belongs…"
SAY_FILING = "Filing it into your plan…"


async def _images(session, entry: ScratchEntry) -> list[tuple[bytes, str]]:
    if entry.kind != "image" or not entry.source_id:
        return []
    src = await session.get(Source, entry.source_id)
    obj = await storage.get(src.storage_path) if src and src.storage_path else None
    if obj is None:
        return []
    # The row records what the client claimed; the store may only know "octet-stream".
    mime = src.content_type if obj.content_type == "application/octet-stream" else obj.content_type
    return [(obj.data, mime)]


async def process(entry_id: str, say=None) -> None:
    """Run triage for one entry and record the outcome on its row. `say(line)` reports progress, if given."""
    say = say or (lambda _line: None)
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as session:
        entry = await session.get(ScratchEntry, entry_id)
        if entry is None:
            return
        entry.status = "processing"
        await session.commit()

        try:
            say(SAY_OPENING_PHOTO if entry.kind == "image" else SAY_READING)
            images = await _images(session, entry)
            # Voice arrives already transcribed by the browser; an empty transcript is a failure to hear.
            if entry.kind == "audio" and not entry.body.strip():
                outcome = None
                entry.status, entry.error = "failed", MSG_NO_TRANSCRIPT
            else:
                now = local_now(entry.tz)
                store = SqlStore(session, entry.user_id, today=now.date())
                # An entry settled in chat is filed from its clarified text; the original words stay on the row.
                clarified = (entry.result or {}).get("clarification")
                text = f"{entry.body}\n\nClarified by the user: {clarified}" if clarified else entry.body
                # A file or link attached to the note: what was read from it is part of what the note means.
                src = await session.get(Source, entry.source_id) if entry.source_id else None
                if src is not None and (src.text_excerpt or "").strip():
                    text = f"{text}\n\nAttached ({src.url or src.original_filename}):\n{src.text_excerpt[:SOURCE_TEXT_CHARS]}".strip()
                say(SAY_DECIDING)
                outcome = await triage_entry(
                    store, text, entry_id=entry.id, images=images, source_id=entry.source_id, now=now
                )
        except Exception:  # noqa: BLE001 - nothing here may lose the entry
            log.exception("scratch entry %s failed", entry_id)
            await session.rollback()
            entry = await session.get(ScratchEntry, entry_id)
            entry.status, entry.error = "failed", MSG_UNEXPECTED
            await session.commit()
            return

        if outcome is not None:
            say(SAY_FILING)
            entry.status = outcome.status
            entry.question = outcome.question
            entry.error = outcome.error
            entry.result = {"bucket": outcome.bucket, "lines": outcome.lines, "proposed": outcome.proposed}
            if outcome.status == "handled":
                entry.handled_at = datetime.now(timezone.utc)
        await session.commit()


# --- Recovery ----------------------------------------------------------------

#: An entry that has sat `pending` or `processing` this long is assumed stranded (the process that
#: was filing it died). Longer than the slowest legitimate filing (a goal plan runs about two minutes).
STUCK_AFTER_S = 300
#: How often the recovery loop looks. Each pass is one indexed query.
RECOVERY_POLL_S = 30
#: Entries picked up per pass, so a backlog after an outage is worked off steadily, not all at once.
RECOVERY_BATCH = 20


async def reap_stuck() -> int:
    """Re-file entries stranded in `pending` / `processing`. Returns how many were picked up."""
    from datetime import timedelta

    from sqlalchemy import select

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=STUCK_AFTER_S)
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as session:
        ids = (await session.execute(
            select(ScratchEntry.id)
            .where(ScratchEntry.status.in_(("pending", "processing")), ScratchEntry.created_at < cutoff)
            .order_by(ScratchEntry.created_at).limit(RECOVERY_BATCH)
        )).scalars().all()
    for entry_id in ids:
        await process(entry_id)
    return len(ids)


async def recovery_loop() -> None:
    """Run `reap_stuck` for the life of the app. Never raises: a failed pass is logged and retried."""
    while True:
        try:
            await reap_stuck()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("scratch recovery pass failed")
        await asyncio.sleep(RECOVERY_POLL_S)
