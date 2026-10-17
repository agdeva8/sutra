"""Object storage — Supabase Storage, with a local-disk fallback.

v1 used a proprietary object-store proxy. This is a plain Supabase Storage
client: the bucket is reached over its REST API with a service key, and the path
convention is `sources/<user_id>/<unique>-<filename>` — one object per upload,
never one object per name.

**The fallback is not a stub.** With `SUPABASE_URL` unset, objects land in
`LOCAL_STORAGE_DIR` and are served from there. That keeps the whole service
runnable with no credentials — which matters because every other subsystem has
an offline mode, and a service that cannot boot without cloud storage is one
nobody can test.

Filenames are sanitised on the way in. An uploaded name is attacker-controlled
(`../../etc/passwd`, a NUL byte, a 4 KB unicode name), and it is used to build a
path — so the sanitised form is what is stored, and the original is kept in the
`original_filename` column where it is only ever displayed.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import settings

logger = logging.getLogger(__name__)

#: Everything outside this set becomes `_`. Deliberately conservative: the set
#: of characters that are safe in a URL path segment *and* on every filesystem
#: we might fall back to is small.
_UNSAFE = re.compile(r"[^a-zA-Z0-9._-]")

#: v1's cap. A 200-char name is already absurd; truncation keeps the path well
#: inside every filesystem's limit while preserving the extension.
_MAX_NAME = 200

#: The prefix every key shares, so a bucket can hold other things later.
PREFIX = "sources"

#: Random hex characters that make one upload's key distinct from another's. 12 hex is 48 bits —
#: the same budget `ids.new_id` spends, and far more than enough for a single user's uploads.
UNIQUE_KEY_HEX = 12

#: Separates the unique part from the readable filename in a minted key.
KEY_SEPARATOR = "-"

#: What a minted key's filename component looks like, as opposed to a filename-derived key written
#: before uploads were unique. The confirm step checks this *shape* rather than re-deriving the key,
#: so a key the sign step minted is still accepted when a client sends it back.
_MINTED_NAME = re.compile(rf"[0-9a-f]{{{UNIQUE_KEY_HEX}}}-[A-Za-z0-9._-]+")

#: What a store answers when it has no type of its own — local disk cannot record what it received, so
#: it says this for everything. Callers that need to *render* an object must treat it as "unknown" and
#: fall back to the type recorded on the row; serving it verbatim makes a browser download a photo.
GENERIC_CONTENT_TYPE = "application/octet-stream"


def sanitize_filename(name: str) -> str:
    """`../../etc/passwd` → `.._.._etc_passwd`. Never returns an empty string."""
    cleaned = _UNSAFE.sub("_", name or "")
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return (cleaned[:_MAX_NAME] or "file")


def object_key(*, user_id: str, filename: str) -> str:
    """A fresh storage path for one upload.

    Namespaced by user, so one user's name cannot collide with another's — and so a bucket listing is
    readable by owner. The unique part matters: iPhone galleries are full of `image.jpg`, and two
    attachments of the same `resume.pdf` used to overwrite each other's bytes and share one object.

    The unique part counts against `_MAX_NAME`, so the filename component keeps its guaranteed cap
    while the original name stays readable in the key.
    """
    unique = uuid.uuid4().hex[:UNIQUE_KEY_HEX]
    room = _MAX_NAME - len(unique) - len(KEY_SEPARATOR)
    readable = sanitize_filename(filename)[:room] or "file"
    return f"{PREFIX}/{sanitize_filename(user_id)}/{unique}{KEY_SEPARATOR}{readable}"


def is_minted_key(*, user_id: str, key: str) -> bool:
    """Whether `key` has the shape `object_key` mints *for this user*.

    Used by the direct-upload confirm step: the sign step minted the key once, so the check is
    ownership plus shape, never a recomputation from the filename (which would no longer match).
    """
    prefix = f"{PREFIX}/{sanitize_filename(user_id)}/"
    if not key.startswith(prefix):
        return False
    return _MINTED_NAME.fullmatch(key[len(prefix):]) is not None


@dataclass
class Object:
    """Bytes plus the content type the *store* reports for them.

    The content type comes from storage, not from the `sources` row — v1 did
    this, and it is the right call: the row records what the client claimed, the
    store records what it actually got.
    """

    data: bytes
    content_type: str


def _supabase_configured() -> bool:
    return bool(settings.supabase_url and settings.supabase_service_key)


def _use_local_disk() -> bool:
    """Local disk is only durable on a long-lived host.

    On a serverless host (Vercel sets `VERCEL`) a write to `/tmp` succeeds but lives on one function
    instance, so the same download 404s, then 200s, then 500s depending on which instance answers. There
    the bytes go to the database blob table instead, unless Supabase Storage is configured.
    """
    return not settings.is_serverless


#: The Storage API's two areas, relative to the project URL. Named because both are used to build paths,
#: and because a bucket is not an object: the bucket endpoint creates, the object endpoint stores.
_STORAGE_V1 = "storage/v1"
_BUCKET_ENDPOINT = f"{_STORAGE_V1}/bucket"
_OBJECT_ENDPOINT = f"{_STORAGE_V1}/object"


def _client(timeout: float) -> httpx.AsyncClient:
    """The HTTP client every Supabase call uses. A seam for tests, and one place a timeout is set."""
    return httpx.AsyncClient(timeout=timeout)


def _storage_url(path: str) -> str:
    return f"{settings.supabase_url.rstrip('/')}/{path}"


def _object_url(key: str) -> str:
    return _storage_url(f"{_OBJECT_ENDPOINT}/{settings.supabase_bucket}/{key}")


#: How a JWT starts (base64 of `{"`). A legacy service_role key is a JWT; a new `sb_secret_…` key is not.
JWT_PREFIX = "eyJ"


def _headers() -> dict[str, str]:
    """Auth headers for Supabase Storage, for either kind of key.

    A legacy service_role key is a JWT and goes as both `apikey` and the bearer token. A new secret key
    (`sb_secret_…`) is not a JWT: Supabase's gateway accepts it in `apikey` and rejects it as a bearer
    token, so it is sent there only.
    """
    key = settings.supabase_service_key
    headers = {"apikey": key}
    if key.startswith(JWT_PREFIX):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _bucket_missing(resp: httpx.Response) -> bool:
    """Whether this response is Supabase saying the bucket was never created.

    Supabase reports it as `{"error": "Bucket not found"}` with a 400 or 404, and the status alone is not
    enough: a 404 is also how a missing *object* answers. The message is the only reliable discriminator.
    """
    if resp.status_code not in (400, 404):
        return False
    return "bucket not found" in resp.text.lower()


async def _ensure_bucket(client: httpx.AsyncClient) -> None:
    """Create the configured bucket, private, once. Idempotent: "already exists" is success.

    Called lazily from the first write instead of at boot — a deployment that boots before anyone has
    created the bucket should still work, and a bucket is not worth failing `/ready` over.
    """
    name = settings.supabase_bucket
    resp = await client.post(
        _storage_url(_BUCKET_ENDPOINT),
        headers=_headers(),
        json={"id": name, "name": name, "public": False},
    )
    if resp.status_code in (200, 201):
        logger.info("storage: created the '%s' bucket", name)
        return
    text = resp.text.lower()
    if resp.status_code in (400, 409) and ("already exists" in text or "duplicate" in text):
        # Another instance won the race, or it was created out of band. Either way it is there.
        return
    resp.raise_for_status()


def direct_upload_available() -> bool:
    """Whether the browser can write to the store itself instead of posting bytes here.

    Only Supabase can do this: local disk and the blob table are reachable from this process alone, so
    those keep the proxy path.
    """
    return _supabase_configured()


async def signed_upload_url(key: str) -> str | None:
    """A URL the browser `PUT`s the bytes to, or `None` when there is no object store to sign for.

    Uploading through this function caps a file at the host's request-body limit (Vercel: ~4.5 MB),
    which is far below `source_max_bytes` — so a 20 MB photo could never arrive. Signing a path moves
    the bytes browser-to-store and leaves the API to record the row.

    A signing failure returns `None` rather than raising: the caller then answers `direct: false` and
    the browser posts the bytes through the API instead. Losing direct upload is a slower upload, not a
    failed one, so it must never take the attachment down with it.
    """
    if not _supabase_configured():
        return None
    try:
        async with _client(timeout=30) as client:
            sign_path = f"{_OBJECT_ENDPOINT}/upload/sign/{settings.supabase_bucket}/{key}"
            resp = await client.post(_storage_url(sign_path), headers=_headers())
            if _bucket_missing(resp):
                await _ensure_bucket(client)
                resp = await client.post(_storage_url(sign_path), headers=_headers())
            resp.raise_for_status()
            signed = (resp.json() or {}).get("url") or ""
    except httpx.HTTPError as exc:
        logger.warning("storage: could not sign an upload URL (%s); falling back to the API upload", exc)
        return None
    if not signed:
        return None
    # Supabase answers with a path (`/object/upload/sign/...?token=…`); the client needs it absolute.
    base = settings.supabase_url.rstrip("/")
    return signed if signed.startswith("http") else f"{base}/storage/v1{signed}"


def _local_path(key: str) -> Path:
    """Resolve under `LOCAL_STORAGE_DIR`, refusing anything that escapes it.

    The second half of the traversal defence: `sanitize_filename` already
    removed the separators, and this asserts the result is where it should be.
    Two independent checks, because this is the one place a bad name becomes a
    filesystem write.
    """
    root = Path(settings.local_storage_dir).resolve()
    target = (root / key).resolve()
    if not str(target).startswith(str(root)):
        raise ValueError("storage key escapes the storage root")
    return target


async def put(*, key: str, data: bytes, content_type: str) -> str:
    """Store the bytes. Returns the key, which is what the row records.

    A Supabase failure is never the user's problem: the bytes go to the database blob table instead,
    which `get` already reads, so the attachment still works and the outage is a log line.
    """
    if _supabase_configured():
        try:
            async with _client(timeout=120) as client:
                await _supabase_put(client, key=key, data=data, content_type=content_type)
            return key
        except httpx.HTTPError as exc:
            logger.warning(
                "storage: Supabase write failed for %s (%s); keeping the bytes in source_blobs", key, exc
            )
            await _db_put(key, data, content_type)
            return key

    if _use_local_disk():
        try:
            path = _local_path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return key
        except OSError:
            pass
    # No durable disk (a serverless host): keep the bytes in the database instead.
    await _db_put(key, data, content_type)
    return key


async def _supabase_put(
    client: httpx.AsyncClient, *, key: str, data: bytes, content_type: str
) -> None:
    """One object write, creating the bucket first if this is the deployment's first upload.

    The retry is deliberately one: the only failure it recovers from is a bucket that did not exist
    yet. Anything else is a real error and belongs to the caller's fallback.
    """
    headers = {
        **_headers(),
        "Content-Type": content_type or "application/octet-stream",
        # Overwrite rather than 409 — the key is unique per upload, so a repeat PUT is a retry.
        "x-upsert": "true",
    }
    resp = await client.post(_object_url(key), content=data, headers=headers)
    if _bucket_missing(resp):
        await _ensure_bucket(client)
        resp = await client.post(_object_url(key), content=data, headers=headers)
    resp.raise_for_status()


async def get(key: str) -> Object | None:
    """Read the bytes back, or `None` when the object is gone.

    With Supabase configured the bucket is asked first, then `source_blobs`, then local disk: uploads
    written before `SUPABASE_URL` was set live in the database, and they must stay downloadable. A read
    error other than "not found" is re-raised, because the caller turns it into a retryable 503 — an
    unreachable store is not the same thing as a deleted file.
    """
    if _supabase_configured():
        async with _client(timeout=60) as client:
            resp = await client.get(_object_url(key), headers=_headers())
        if resp.status_code != 404:
            resp.raise_for_status()
            return Object(
                data=resp.content,
                content_type=resp.headers.get("content-type", GENERIC_CONTENT_TYPE),
            )
        # 404 — either the object predates the bucket or it is genuinely gone. Look where old files live.
        return await _db_get(key) or _local_get(key)

    if _use_local_disk():
        local = _local_get(key)
        if local is not None:
            return local
    return await _db_get(key)


def _local_get(key: str) -> Object | None:
    """The local-disk copy, if a long-lived host has one. Never raises for an unusable key."""
    if not _use_local_disk():
        return None
    try:
        path = _local_path(key)
        if path.is_file():
            return Object(data=path.read_bytes(), content_type=GENERIC_CONTENT_TYPE)
    except (ValueError, OSError):
        pass
    return None


async def delete(key: str) -> None:
    """Best-effort, and clears every place the bytes could be. A missing object is a success.

    Both stores are attempted regardless of the other: an upload made during a Supabase outage sits in
    `source_blobs` *and* may later have been copied to the bucket, so deleting one is not enough.
    Storage is never the source of truth: the `sources` row is, and a soft delete keeps even that. So a
    failed object delete must not fail the request.
    """
    if not key:
        return
    if _supabase_configured():
        try:
            async with _client(timeout=30) as client:
                await client.delete(_object_url(key), headers=_headers())
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("storage: Supabase delete failed for %s (%s); continuing", key, exc)
    if _use_local_disk():
        try:
            _local_path(key).unlink(missing_ok=True)
        except (ValueError, OSError):
            pass
    await _db_delete(key)


# ---------------------------------------------------------------------------
# Database fallback
# ---------------------------------------------------------------------------


async def _db_put(key: str, data: bytes, content_type: str) -> None:
    from sqlalchemy.dialects.postgresql import insert

    from .db import session_scope
    from .models import SourceBlob

    values = {"key": key, "content_type": content_type or "application/octet-stream", "data": data}
    stmt = insert(SourceBlob).values(**values)
    stmt = stmt.on_conflict_do_update(index_elements=[SourceBlob.key], set_={"data": data, "content_type": values["content_type"]})
    async with session_scope() as session:
        await session.execute(stmt)
        await session.commit()


async def _db_get(key: str) -> Object | None:
    from .db import session_scope
    from .models import SourceBlob

    async with session_scope() as session:
        row = await session.get(SourceBlob, key)
    return Object(data=row.data, content_type=row.content_type) if row else None


async def _db_delete(key: str) -> None:
    from sqlalchemy import delete as sql_delete

    from .db import session_scope
    from .models import SourceBlob

    async with session_scope() as session:
        await session.execute(sql_delete(SourceBlob).where(SourceBlob.key == key))
        await session.commit()


# ---------------------------------------------------------------------------
# Diagnostics, for /ready
# ---------------------------------------------------------------------------

#: How long the readiness probe waits on Supabase. Short: /ready must answer quickly, and a slow bucket
#: is reported, not waited out.
PROBE_TIMEOUT_S = 5.0

MODE_SUPABASE = "supabase"
MODE_DISK = "disk"
MODE_DATABASE = "database"


def storage_mode() -> str:
    """Where new uploads go: Supabase Storage when configured, else local disk on a long-lived host, else
    the `source_blobs` table. Names only, never a secret, so it is safe to report."""
    if _supabase_configured():
        return MODE_SUPABASE
    return MODE_DISK if _use_local_disk() else MODE_DATABASE


async def storage_probe() -> str:
    """One cheap look at the bucket, as a short word for /ready. Never raises.

    "ok" — the key works and the bucket exists; "no bucket yet" — the key works, and the bucket will be
    created on the first upload; "HTTP 401" and the like — Supabase refused (a wrong key or URL);
    an exception name — Supabase could not be reached.
    """
    if not _supabase_configured():
        return "not configured"
    try:
        async with _client(PROBE_TIMEOUT_S) as client:
            resp = await client.get(_storage_url(f"{_BUCKET_ENDPOINT}/{settings.supabase_bucket}"), headers=_headers())
    except Exception as exc:  # noqa: BLE001 — a probe reports, it does not fail
        return exc.__class__.__name__
    if resp.status_code == 200:
        return "ok"
    if _bucket_missing(resp):
        return "no bucket yet"
    return f"HTTP {resp.status_code}"
