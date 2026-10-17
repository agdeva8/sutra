"""Supabase Storage with the database as the safety net.

Uploads written before `SUPABASE_URL` existed are rows in `source_blobs`, so the bucket cannot be the
only place a read looks. Every Supabase failure must degrade to the old path rather than fail the
user's upload, and the bucket is created lazily on the first write.

No network and no database: `storage._client` is backed by `httpx.MockTransport`, and the `_db_*`
helpers are replaced with recorders.
"""
import asyncio
import json

import httpx
import pytest

from sutra_api import storage
from sutra_api.config import settings

KEY = "sources/user_1/0123456789ab-resume.pdf"


@pytest.fixture(autouse=True)
def supabase_configured(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://project.supabase.co")
    monkeypatch.setattr(settings, "supabase_service_key", "service-role-key")
    # A serverless host: there is no durable local disk, so an upload fallback goes to the blob table.
    monkeypatch.setattr(settings, "vercel", "1")


def _use_transport(monkeypatch, handler):
    """Point every Supabase call this module makes at a fake transport."""

    def factory(timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(storage, "_client", factory)


# --- reads ---------------------------------------------------------------------------------------------------


def test_get_falls_back_to_the_database_blob_on_404(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(404, json={"error": "Object not found"})

    _use_transport(monkeypatch, handler)

    async def db_get(key):
        assert key == KEY
        return storage.Object(data=b"old bytes", content_type="text/plain")

    monkeypatch.setattr(storage, "_db_get", db_get)

    obj = asyncio.run(storage.get(KEY))

    assert obj is not None
    assert obj.data == b"old bytes"
    assert obj.content_type == "text/plain"
    assert requests and requests[0].method == "GET"


def test_get_falls_back_to_local_disk_when_the_blob_row_is_gone(monkeypatch, tmp_path):
    _use_transport(monkeypatch, lambda request: httpx.Response(404, json={"error": "Object not found"}))
    monkeypatch.setattr(settings, "vercel", "")  # a long-lived host keeps a disk
    monkeypatch.setattr(settings, "local_storage_dir", str(tmp_path))

    async def db_get(key):
        return None

    monkeypatch.setattr(storage, "_db_get", db_get)

    path = tmp_path / KEY
    path.parent.mkdir(parents=True)
    path.write_bytes(b"on disk")

    obj = asyncio.run(storage.get(KEY))

    assert obj is not None
    assert obj.data == b"on disk"


def test_get_reads_the_bucket_first(monkeypatch):
    def handler(request):
        return httpx.Response(200, content=b"from bucket", headers={"content-type": "application/pdf"})

    _use_transport(monkeypatch, handler)

    async def db_get(key):  # pragma: no cover - must not be reached
        raise AssertionError("the database should not be read when the bucket answers")

    monkeypatch.setattr(storage, "_db_get", db_get)

    obj = asyncio.run(storage.get(KEY))

    assert obj.data == b"from bucket"
    assert obj.content_type == "application/pdf"


# --- deletes -------------------------------------------------------------------------------------------------


def test_delete_clears_both_the_bucket_and_the_blob_row(monkeypatch):
    deleted_from_bucket = []
    deleted_from_db = []

    def handler(request):
        assert request.method == "DELETE"
        deleted_from_bucket.append(request.url.path)
        return httpx.Response(200, json={"message": "removed"})

    _use_transport(monkeypatch, handler)

    async def db_delete(key):
        deleted_from_db.append(key)

    monkeypatch.setattr(storage, "_db_delete", db_delete)

    asyncio.run(storage.delete(KEY))

    assert deleted_from_bucket == [f"/storage/v1/object/{settings.supabase_bucket}/{KEY}"]
    assert deleted_from_db == [KEY]


def test_delete_still_clears_the_blob_row_when_the_bucket_errors(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("storage is down", request=request)

    _use_transport(monkeypatch, handler)

    deleted_from_db = []

    async def db_delete(key):
        deleted_from_db.append(key)

    monkeypatch.setattr(storage, "_db_delete", db_delete)

    asyncio.run(storage.delete(KEY))

    assert deleted_from_db == [KEY]


# --- bucket creation -----------------------------------------------------------------------------------------


def _bucket_creating_handler(*, create_status: int = 201, create_body: dict | None = None):
    """Supabase saying "Bucket not found" once, then accepting the retried upload."""
    state = {"objects": 0, "buckets": 0, "bucket_body": None}

    def handler(request):
        if request.url.path == f"/storage/v1/object/{settings.supabase_bucket}/{KEY}":
            state["objects"] += 1
            if state["objects"] == 1:
                return httpx.Response(
                    400, json={"error": "Bucket not found", "message": "Bucket not found"}
                )
            return httpx.Response(200, json={"Key": KEY})
        if request.url.path == "/storage/v1/bucket":
            state["buckets"] += 1
            state["bucket_body"] = json.loads(request.content)
            return httpx.Response(create_status, json=create_body or {"name": settings.supabase_bucket})
        return httpx.Response(500, json={"error": "unexpected"})

    return handler, state


def test_a_missing_bucket_is_created_and_the_upload_retried_once(monkeypatch):
    handler, state = _bucket_creating_handler()
    _use_transport(monkeypatch, handler)

    async def db_put(key, data, content_type):  # pragma: no cover - must not be reached
        raise AssertionError("the upload should have succeeded after creating the bucket")

    monkeypatch.setattr(storage, "_db_put", db_put)

    key = asyncio.run(storage.put(key=KEY, data=b"bytes", content_type="application/pdf"))

    assert key == KEY
    assert state["objects"] == 2
    assert state["buckets"] == 1
    assert state["bucket_body"] == {
        "id": settings.supabase_bucket,
        "name": settings.supabase_bucket,
        "public": False,
    }


def test_an_already_existing_bucket_is_success(monkeypatch):
    handler, state = _bucket_creating_handler(
        create_status=400,
        create_body={"statusCode": "409", "error": "Duplicate", "message": "The resource already exists"},
    )
    _use_transport(monkeypatch, handler)

    key = asyncio.run(storage.put(key=KEY, data=b"bytes", content_type="application/pdf"))

    assert key == KEY
    assert state["objects"] == 2
    assert state["buckets"] == 1


# --- failures fall back --------------------------------------------------------------------------------------


def test_a_supabase_failure_stores_the_bytes_in_source_blobs(monkeypatch):
    _use_transport(monkeypatch, lambda request: httpx.Response(500, json={"error": "boom"}))
    blobs = {}

    async def db_put(key, data, content_type):
        blobs[key] = (data, content_type)

    monkeypatch.setattr(storage, "_db_put", db_put)

    key = asyncio.run(storage.put(key=KEY, data=b"precious", content_type="application/pdf"))

    assert key == KEY
    assert blobs == {KEY: (b"precious", "application/pdf")}


def test_a_sign_failure_falls_back_to_the_api_upload(monkeypatch):
    """`None` means `direct: false`, so the browser posts the bytes through the API instead."""
    _use_transport(monkeypatch, lambda request: httpx.Response(503))

    assert asyncio.run(storage.signed_upload_url(KEY)) is None


def test_auth_headers_suit_both_kinds_of_supabase_key(monkeypatch):
    from sutra_api import storage
    from sutra_api.config import settings

    monkeypatch.setattr(settings, "supabase_service_key", "eyJhbGciOiJIUzI1NiJ9.legacy.sig")
    assert storage._headers() == {"apikey": "eyJhbGciOiJIUzI1NiJ9.legacy.sig", "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.legacy.sig"}
    monkeypatch.setattr(settings, "supabase_service_key", "sb_secret_abc")
    assert storage._headers() == {"apikey": "sb_secret_abc"}
