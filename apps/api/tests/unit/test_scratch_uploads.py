"""Uploads return before the model; the entry's filing reads the photo; a failed reading still files.

No database: the store is a fake here. What is pinned is the ordering that makes capture instant — an
upload never waits on vision, and the reading happens while the entry is filed — plus the attachment
list that lets one note carry several sources without a schema change.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from sutra_api import scratch_service, vision
from sutra_api.api import scratch as scratch_routes
from sutra_api.api import sources as sources_routes


# --- the upload returns without the model ---------------------------------------------------------------


class _UploadSession:
    def __init__(self):
        self.added = []

    def add(self, row):
        self.added.append(row)

    async def flush(self):
        return None

    async def commit(self):
        return None


def test_an_image_upload_returns_text_pending_and_never_calls_vision(monkeypatch):
    calls = []

    async def fake_describe(*_args, **_kwargs):
        calls.append(True)
        return "should not happen"

    monkeypatch.setattr(vision, "describe_image", fake_describe)
    session = _UploadSession()

    row = asyncio.run(sources_routes._record_source_row(
        session,
        user_id="user_1",
        filename="photo.jpg",
        content_type="image/jpeg",
        data=b"jpeg bytes",
        key="sources/user_1/0123456789ab-photo.jpg",
        goal_id=None,
        temporary=True,
        purpose="source",
    ))

    assert row["text_pending"] is True
    assert calls == []
    # Nothing was read, so there is no excerpt to mistake for a finished reading.
    assert session.added[0].text_excerpt is None


# --- the reading happens while the entry is filed -------------------------------------------------------


class _Source:
    def __init__(self, excerpt=None, path="sources/user_1/photo.jpg"):
        self.original_filename = "photo.jpg"
        self.content_type = "image/jpeg"
        self.text_excerpt = excerpt
        self.storage_path = path


def _read(monkeypatch, source, *, obj=True, reading="notes on a whiteboard"):
    async def fake_get(_path):
        if not obj:
            return None
        return SimpleNamespace(data=b"image bytes", content_type="image/jpeg")

    async def fake_describe(_data, _mime):
        return reading

    monkeypatch.setattr(scratch_service.storage, "get", fake_get)
    monkeypatch.setattr(scratch_service, "describe_image", fake_describe)
    said = []
    images = asyncio.run(scratch_service._read_images(SimpleNamespace(), [source], said.append))
    return said, images, source


def test_a_pending_image_is_read_and_its_bytes_go_to_triage(monkeypatch):
    said, images, source = _read(monkeypatch, _Source())

    assert said == [scratch_service.SAY_READING_PHOTO]
    assert source.text_excerpt == "notes on a whiteboard"
    assert images == [(b"image bytes", "image/jpeg")]


def test_an_image_already_read_is_not_sent_to_the_model_again(monkeypatch):
    source = _Source(excerpt="read on an earlier filing")
    said, images, unchanged = _read(monkeypatch, source)

    assert said == []
    assert unchanged.text_excerpt == "read on an earlier filing"
    # The bytes still travel: triage sees the image, not only the excerpt.
    assert images == [(b"image bytes", "image/jpeg")]


def test_a_failed_reading_is_marked_unreadable_and_the_entry_keeps_its_text(monkeypatch):
    said, images, source = _read(monkeypatch, _Source(), reading=vision.IMAGE_UNREADABLE)

    assert source.text_excerpt == vision.IMAGE_UNREADABLE
    assert vision.needs_reading(source.text_excerpt) is False
    # The bytes still reach triage, so the note can be filed on what the person wrote.
    assert images == [(b"image bytes", "image/jpeg")]
    assert said == [scratch_service.SAY_READING_PHOTO]


def test_bytes_missing_from_storage_still_mark_the_source_unreadable(monkeypatch):
    _, images, source = _read(monkeypatch, _Source(), obj=False)

    assert source.text_excerpt == vision.IMAGE_UNREADABLE
    assert images == []


# --- several attachments on one entry -------------------------------------------------------------------


def test_attachments_accumulate_idempotently_after_the_primary_source():
    entry = SimpleNamespace(source_id="src_first", result={})

    assert scratch_service.attach_source(entry, "src_second") == ["src_first", "src_second"]
    assert scratch_service.attach_source(entry, "src_second") == ["src_first", "src_second"]
    assert scratch_service.attached_source_ids(entry) == ["src_first", "src_second"]
    # The primary stays in its column; the JSONB list holds only the rest.
    assert entry.result[scratch_service.ATTACHED_SOURCES_KEY] == ["src_second"]


def test_an_entry_with_no_primary_source_still_orders_its_attachments():
    entry = SimpleNamespace(source_id=None, result={})
    scratch_service.attach_source(entry, "src_a")
    scratch_service.attach_source(entry, "src_b")

    assert scratch_service.attached_source_ids(entry) == ["src_a", "src_b"]


# --- the stale filing lease -----------------------------------------------------------------------------


def _processing(lease):
    return SimpleNamespace(status="processing", result=lease)


def test_a_filing_past_its_lease_is_stale():
    now = datetime.now(timezone.utc)
    old = (now - timedelta(seconds=scratch_service.STUCK_AFTER_S + 1)).isoformat()

    assert scratch_routes.filing_is_stale(_processing({"processing_since": old}), now) is True


def test_a_live_filing_is_not_stale():
    now = datetime.now(timezone.utc)
    fresh = (now - timedelta(seconds=5)).isoformat()

    assert scratch_routes.filing_is_stale(_processing({"processing_since": fresh}), now) is False


def test_a_processing_row_with_no_lease_is_reclaimable():
    now = datetime.now(timezone.utc)

    assert scratch_routes.filing_is_stale(_processing({}), now) is True
    assert scratch_routes.filing_is_stale(_processing({"processing_since": "not a time"}), now) is True


# --- attaching a confirmed upload to its entry ----------------------------------------------------------


class _Request:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class _AttachSession:
    def __init__(self, entry, source):
        self._rows = {entry.id: entry, source.id: source}
        self.commits = 0

    async def get(self, _model, row_id):
        return self._rows.get(row_id)

    async def commit(self):
        self.commits += 1


def _attach(entry, body):
    source = SimpleNamespace(id="src_1", user_id="user_1", is_deleted=False)
    session = _AttachSession(entry, source)
    user = SimpleNamespace(user_id="user_1")
    result = asyncio.run(
        scratch_routes.attach_entry_source(entry.id, _Request(body), session=session, user=user)
    )
    return result, session, entry


def _entry(**overrides):
    values = dict(id="scratch_1", user_id="user_1", status="pending", source_id=None, result={},
                  kind="image", body="", question=None, error=None, created_at=datetime.now(timezone.utc),
                  handled_at=None)
    values.update(overrides)
    return SimpleNamespace(**values)


def test_a_confirmed_upload_is_recorded_on_its_pending_entry():
    entry = _entry()

    row, session, _ = _attach(entry, {"source_id": "src_1"})

    assert row["source_ids"] == ["src_1"]
    assert session.commits == 1


def test_a_finished_entry_rejects_a_late_attachment():
    entry = _entry(status="handled")

    with pytest.raises(HTTPException) as caught:
        _attach(entry, {"source_id": "src_1"})

    assert caught.value.status_code == 409


def test_an_attachment_without_a_source_id_is_a_bad_request():
    with pytest.raises(HTTPException) as caught:
        _attach(_entry(), {})

    assert caught.value.status_code == 400
