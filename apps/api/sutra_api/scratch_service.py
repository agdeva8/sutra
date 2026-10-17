"""Processing a Scratch entry in the background.

`POST /scratch` writes the row and returns; this runs after the response, on its
own session, so a slow or failing model never delays or loses the capture. The
`status` column is the queue (docs/prd/scratchpad.md §9): `retry` and a future
poller both just re-run `process` on a row.

An entry can carry several sources — a note with three photos is one entry, not
three — and the photos are uploaded in the background after Send. The attachments
are confirmed onto the entry with `POST /scratch/{id}/sources`, and only then does
the client ask for the entry to be filed. The vision reading happens here, not at
upload time, so an upload never waits on the model.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from agentv2 import local_now, triage_entry
from agentv2.llm import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from . import storage
from .agent_store import SqlStore
from .core import extract as extract_mod
from .db import get_engine
from .models import ScratchEntry, Source
from .vision import IMAGE_UNREADABLE, describe_image, needs_reading

log = logging.getLogger(__name__)

MSG_NO_TRANSCRIPT = "Couldn't hear anything in that. Try again."
MSG_UNEXPECTED = "Something went wrong reading this. Try again."

#: How much of an attached source's text goes into triage. Matches the stored excerpt cap.
SOURCE_TEXT_CHARS = 8000

#: What the user is told while an entry is filed, in order. Plain words.
SAY_READING_PHOTO = "Reading the photo…"
SAY_READING = "Reading what you wrote…"
SAY_DECIDING = "Working out what this is and where it belongs…"
SAY_FILING = "Filing it into your plan…"

#: Sources attached after the entry was created, kept in the entry's existing JSONB `result` so that
#: attaching a confirmed upload needs no new column. `ScratchEntry.source_id` stays the primary (first)
#: source, which is what triage links when the note is filed as a source.
ATTACHED_SOURCES_KEY = "sources"
#: When the current filing started, under the same JSONB. `/process` reads it to reclaim an entry whose
#: filing died with its request instead of leaving the row `processing` for ever.
PROCESSING_SINCE_KEY = "processing_since"


def attached_source_ids(entry: ScratchEntry) -> list[str]:
    """Every source on this entry: the primary one first, then the rest in the order they arrived."""
    ids: list[str] = []
    if entry.source_id:
        ids.append(entry.source_id)
    for source_id in (entry.result or {}).get(ATTACHED_SOURCES_KEY) or []:
        if isinstance(source_id, str) and source_id not in ids:
            ids.append(source_id)
    return ids


def attach_source(entry: ScratchEntry, source_id: str) -> list[str]:
    """Record one confirmed upload on the entry, idempotently, and return the full list."""
    ids = attached_source_ids(entry)
    if source_id not in ids:
        ids.append(source_id)
    entry.result = {
        **(entry.result or {}),
        # `source_id` is not repeated here; `attached_source_ids` already reads it.
        ATTACHED_SOURCES_KEY: [i for i in ids if i != entry.source_id],
    }
    return ids


async def _entry_sources(session, entry: ScratchEntry) -> list[Source]:
    """The entry's source rows, in attachment order, owned by the same user (other rows never enter)."""
    ids = attached_source_ids(entry)
    if not ids:
        return []
    rows = (await session.execute(
        select(Source).where(Source.user_id == entry.user_id, Source.id.in_(ids))
    )).scalars().all()
    by_id = {row.id: row for row in rows}
    return [by_id[i] for i in ids if i in by_id]


async def _read_images(entry: ScratchEntry, sources: list[Source], say) -> list[Image]:
    """Read the images attached to the entry and return their bytes for triage.

    Only an excerpt that is still pending is sent to the model; a source already marked unreadable is
    not retried on every filing. A missing object or a failed reading is stored as
    `IMAGE_UNREADABLE`, so the entry still files with the text it has.
    """
    images: list[Image] = []
    if any(needs_reading(src.text_excerpt) for src in sources
           if extract_mod.is_image(src.original_filename, src.content_type)):
        say(SAY_READING_PHOTO)
    for src in sources:
        if not extract_mod.is_image(src.original_filename, src.content_type):
            continue
        data, mime = b"", src.content_type
        if src.storage_path:
            obj = await storage.get(src.storage_path)
            if obj is not None:
                data = obj.data
                # The row records what the client claimed; the store may only know "octet-stream".
                mime = src.content_type if obj.content_type == "application/octet-stream" else obj.content_type
        if needs_reading(src.text_excerpt):
            src.text_excerpt = await describe_image(data, mime) if data else IMAGE_UNREADABLE
        if data:
            images.append((data, mime))
    return images


async def process(entry_id: str, say=None) -> None:
    """Run triage for one entry and record the outcome on its row. `say(line)` reports progress, if given."""
    say = say or (lambda _line: None)
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as session:
        entry = await session.get(ScratchEntry, entry_id)
        if entry is None:
            return
        entry.status = "processing"
        entry.result = {**(entry.result or {}), PROCESSING_SINCE_KEY: datetime.now(timezone.utc).isoformat()}
        await session.commit()

        try:
            say(SAY_READING)
            sources = await _entry_sources(session, entry)
            source_ids = attached_source_ids(entry)
            images = await _read_images(entry, sources, say)
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
                # Images travel separately, as image parts the model can actually see.
                for src in sources:
                    if extract_mod.is_image(src.original_filename, src.content_type):
                        continue
                    if (src.text_excerpt or "").strip():
                        text = (
                            f"{text}\n\nAttached ({src.url or src.original_filename}):\n"
                            f"{src.text_excerpt[:SOURCE_TEXT_CHARS]}"
                        ).strip()
                say(SAY_DECIDING)
                outcome = await triage_entry(
                    store, text, entry_id=entry.id, images=images,
                    source_id=source_ids[0] if source_ids else None,
                    now=now,
                )
        except Exception:  # noqa: BLE001 - nothing here may lose the entry
            log.exception("scratch entry %s failed", entry_id)
            await session.rollback()
            entry = await session.get(ScratchEntry, entry_id)
            entry.status, entry.error = "failed", MSG_UNEXPECTED
            entry.result = {k: v for k, v in (entry.result or {}).items() if k != PROCESSING_SINCE_KEY}
            await session.commit()
            return

        if outcome is not None:
            say(SAY_FILING)
            entry.status = outcome.status
            entry.question = outcome.question
            entry.error = outcome.error
            # Keep the attached sources; drop the lease so a later retry starts clean.
            entry.result = {
                **{k: v for k, v in (entry.result or {}).items() if k != PROCESSING_SINCE_KEY},
                "bucket": outcome.bucket, "lines": outcome.lines, "proposed": outcome.proposed,
            }
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
