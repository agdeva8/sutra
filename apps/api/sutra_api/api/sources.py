"""Sources — files, links, and the text pulled out of them.

Three response variants live here, and they are not interchangeable
(`CONTRACT-RECONCILIATION.md` §8):

* **list** — bare array, **no** `text_excerpt` (the list stays small)
* **single** — adds `text_excerpt`
* **upload** — adds `text_pending`

Three request shapes also differ from the spec, all in v1's favour:
`PATCH` takes `{text_excerpt}` and nothing else; `POST /sources/link` also
accepts `title`, `temporary` and `text`; and preview/extract return completely
different bodies from the ones the spec declares.

**A soft delete, and the bytes stay.** `DELETE` sets `is_deleted`; v1 kept the
object too, calling it an audit trail. That is the right call here because
`user_facts.source_id` and the audit ledger both point at the row — a hard delete
would orphan the ledger that exists to be trustworthy.

Uploads over 20 MB are a **413**, not a 400: the request was well-formed and the
body was simply too big, and the client shows the difference.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from ..vision import describe_image
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..core import extract as extract_mod
from ..core.blast_radius import radius_for
from ..core.link_preview import preview_from, resolve_document
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..llm import get_complete, provider_status
from ..models import Source
from ..storage import delete as storage_delete, object_key, put
from ..store import repo, staleness
from ..stream import delta, done, error, frame, sse_response
from ..wire import source_list_row, source_row, source_upload_row

#: What an upload may be for. A memory photo is kept out of the Sources list.
SOURCE_PURPOSES = ("source", "memory")

router = APIRouter(tags=["sources"])

#: A temporary, unlinked upload is reaped after a week by the cleanup job.
TEMPORARY_TTL_DAYS = 7


def _expires_at(*, temporary: bool, goal_id: str | None) -> datetime | None:
    """Only an *unlinked* temporary upload expires.

    A temporary upload the user then attached to a goal has become real work, so
    the clock stops — which is the whole point of uploading it before the goal
    exists.
    """
    if temporary and not goal_id:
        return datetime.now(UTC) + timedelta(days=TEMPORARY_TTL_DAYS)
    return None


async def _goal_or_404(
    session: AsyncSession, *, user_id: str, goal_id: str | None
) -> tuple[str | None, str]:
    """Resolve and *authorise* the goal link. Returns `(goal_id, goal_title)`.

    Ownership is checked, not assumed: v1 used to silently drop the title for an
    unowned goal, which meant a caller could probe for goal ids by watching the
    response. Now an unowned id is a 404.
    """
    if not goal_id:
        return None, ""
    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    return goal.id, goal.title


async def _source_or_404(
    session: AsyncSession, *, user_id: str, source_id: str
) -> Source:
    row = await repo.get_source(session, user_id=user_id, source_id=source_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return row


async def _record_source_change(
    session: AsyncSession, *, user_id: str, goal_id: str | None, kind: str, summary: str
) -> None:
    if not goal_id:
        return
    horizons, milestone_moved = radius_for(kind)
    await staleness.record_change(
        session,
        user_id=user_id,
        goal_id=goal_id,
        kind="source",
        horizons_moved=horizons,
        milestone_moved=milestone_moved,
        summary=summary,
    )


@router.get("/sources")
async def list_sources(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    goal_id: str = "",
    limit: int = 500,
) -> list[dict]:
    """A **bare array**. `limit` is clamped, not rejected — a bad value degrades."""
    rows = await repo.list_sources(
        session, user_id=user.user_id, goal_id=goal_id or None, limit=min(limit, 500)
    )
    return [source_list_row(s) for s in rows]


@router.post("/sources/upload")
async def upload_source(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    file: UploadFile = File(...),
    goal_id: str = Form(default=""),
    temporary: str = Form(default=""),
    purpose: str = Form(default="source"),
) -> dict:
    """Upload a file. **200**, and the row carries `text_pending`."""
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    data = await file.read()
    if len(data) > settings.source_max_bytes:
        raise HTTPException(status_code=413, detail="File too large (max 20MB)")

    if purpose not in SOURCE_PURPOSES:
        raise HTTPException(status_code=400, detail=f"purpose must be one of {', '.join(SOURCE_PURPOSES)}")
    ext = extract_mod.extension_of(file.filename)
    if ext not in extract_mod.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type: .{ext}"
        )

    resolved_goal_id, goal_title = await _goal_or_404(
        session, user_id=user.user_id, goal_id=goal_id or None
    )

    content_type = file.content_type or "application/octet-stream"
    key = object_key(user_id=user.user_id, filename=file.filename)
    try:
        await put(key=key, data=data, content_type=content_type)
    except OSError:
        # Read-only or full disk (a serverless host with no object storage). The extracted text below is
        # what chat and planning use, so the upload still succeeds; only the original bytes are not kept.
        key = ""

    excerpt, pending = extract_mod.extract_text(
        filename=file.filename, content_type=content_type, data=data
    )
    if pending and extract_mod.is_image(file.filename, content_type):
        # Read the image now, while the bytes are in hand; the text is what chat and planning use.
        excerpt = await describe_image(data, content_type)
        pending = False

    row = Source(
        id=new_id("src"),
        user_id=user.user_id,
        goal_id=resolved_goal_id,
        goal_title=goal_title,
        kind="file",
        purpose=purpose,
        storage_path=key,
        original_filename=file.filename,
        content_type=content_type,
        size=len(data),
        url="",
        text_excerpt=excerpt or None,
        is_deleted=False,
        expires_at=_expires_at(temporary=temporary == "true", goal_id=resolved_goal_id),
    )
    session.add(row)
    await session.flush()
    await session.commit()
    return source_upload_row(row, text_pending=pending)


@router.post("/sources/link")
async def add_source_link(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Attach a URL.

    A non-empty `text` **wins over the fetch** — that is how a gated page (a
    paywalled article, a login-only doc) becomes attachable. It also means the
    paste path never leaves the process.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    body = body or {}

    url = str(body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL")

    resolved_goal_id, goal_title = await _goal_or_404(
        session, user_id=user.user_id, goal_id=body.get("goal_id") or None
    )

    pasted = str(body.get("text") or "")
    doc = await resolve_document(url=url, text=pasted, max_chars=settings.text_excerpt_max)

    row = Source(
        id=new_id("src"),
        user_id=user.user_id,
        goal_id=resolved_goal_id,
        goal_title=goal_title,
        kind="link",
        storage_path="",
        original_filename=str(body.get("title") or "").strip() or url,
        content_type="text/uri-list",
        size=0,
        url=url,
        text_excerpt=(doc.text or None) if doc.ok else None,
        is_deleted=False,
        expires_at=_expires_at(
            temporary=body.get("temporary") is True, goal_id=resolved_goal_id
        ),
    )
    session.add(row)
    await session.flush()
    await _record_source_change(
        session,
        user_id=user.user_id,
        goal_id=resolved_goal_id,
        kind="source.add",
        summary=f"Attached a link to '{goal_title}'",
    )
    await session.commit()
    return source_row(row)


@router.post("/sources/link/preview")
async def preview_link(
    request: Request,
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Fetch title, description and image **without saving anything**.

    Always 200 unless no URL was sent at all — a failure is `{"ok": false,
    "error": …}` inside a 200, which is what lets the dialog offer "save as a raw
    link" for a page it could not read.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    url = str((body or {}).get("url") or "").strip()
    if not url:
        raise HTTPException(
            status_code=400,
            detail={"ok": False, "error": "No URL provided", "url": "", "host": None},
        )

    doc = await resolve_document(url=url)
    return preview_from(doc)


class _LinkExtract(BaseModel):
    """What the coach can pull out of a document.

    `extra="ignore"` because a model volunteers fields — the same boundary the
    agent's `_Llm` base draws, and for the same reason.
    """

    model_config = {"extra": "ignore"}

    summary: str = Field(default="", max_length=1000)
    key_points: list[str] = Field(default_factory=list)
    extractable_items: list[str] = Field(default_factory=list)
    suggested_questions: list[str] = Field(default_factory=list)


_EXTRACT_SYSTEM = """You read a document and report what it contains.
Return a JSON object with: summary (2-3 sentences), key_points (up to 8 short
strings), extractable_items (concrete commitments, dates or tasks the document
implies, up to 12), suggested_questions (up to 6 questions the reader would
want answered next). Report only what the document says — never invent."""


@router.post("/sources/link/extract")
async def extract_link(
    request: Request,
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Ask the coach to read a document. **Nothing is persisted.**

    The response is `{"ok": bool, "extract": {...}, "error": str|null}`, not the
    `{url, title, text, word_count}` the spec declares — the spec describes raw
    text, and this returns an LLM's reading of it. See
    `CONTRACT-RECONCILIATION.md` #47.

    A model failure is `ok: false` with a message that says the page is still
    attachable, because it is: attachment does not depend on this call.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    body = body or {}

    url = str(body.get("url") or "").strip()
    text = str(body.get("text") or "")
    if not url and not text:
        return {
            "ok": False,
            "url": url,
            "final_url": None,
            "extract": None,
            "error": "Provide a url or pasted text.",
        }

    doc = await resolve_document(url=url, text=text)
    if not doc.ok:
        return {
            "ok": False,
            "url": url,
            "final_url": None,
            "extract": None,
            "error": doc.error,
        }

    # 6000, not 8000: the prompt is the document *plus* the schema, and the
    # smaller budget leaves room for the model's own reasoning.
    goal = str(body.get("goal") or "")[:500]
    context = f"Context — the user's goal: {goal}\n\n" if goal else ""
    prompt = context + f"DOCUMENT:\n{(doc.text or '')[:6000]}"
    try:
        parsed = await get_complete()(_EXTRACT_SYSTEM, prompt, _LinkExtract)
    except Exception:
        return {
            "ok": False,
            "url": url,
            "final_url": doc.final_url or None,
            "extract": None,
            "error": (
                "The coach couldn't read this page just now. "
                "It's still attachable, though."
            ),
        }

    return {
        "ok": True,
        "url": url,
        "final_url": doc.final_url or None,
        "extract": {
            "summary": parsed.summary,
            "key_points": parsed.key_points[:12],
            "extractable_items": parsed.extractable_items[:24],
            "suggested_questions": parsed.suggested_questions[:8],
        },
        "error": None,
    }


@router.get("/sources/{id}")
async def get_source(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = await _source_or_404(session, user_id=user.user_id, source_id=id)
    return source_row(row)


@router.patch("/sources/{id}")
async def update_source(
    id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Commit an edited excerpt. **`text_excerpt` is the only writable field.**

    Not `title` or `goal_id` as the spec claims — the editor exists to let the
    user fix a bad extraction, and letting it also re-parent the row would mean
    the excerpt could be attached to a goal it was not about.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    row = await _source_or_404(session, user_id=user.user_id, source_id=id)

    if "text_excerpt" not in (body or {}):
        raise HTTPException(status_code=400, detail="text_excerpt is required")

    row.text_excerpt = str(body["text_excerpt"]).strip()[: settings.text_excerpt_max]
    await session.commit()
    return source_row(row)


@router.delete("/sources/{id}")
async def delete_source(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """**Soft** delete. The row and the object both survive.

    A hard delete would orphan `user_facts.source_id` and the audit entries that
    reference this source — and an audit trail with holes in it is not one.
    """
    row = await _source_or_404(session, user_id=user.user_id, source_id=id)
    row.is_deleted = True
    await _record_source_change(
        session,
        user_id=user.user_id,
        goal_id=row.goal_id,
        kind="source.remove",
        summary=f"Removed '{row.original_filename}'",
    )
    await session.commit()
    return {"ok": True}


@router.get("/sources/{id}/download")
async def download_source(
    id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """The original bytes — or, for a link, the URL as JSON.

    A link has no bytes to stream, so v1 answers with `{"url": …}` and the client
    opens it. Returning an empty download instead would look like a corrupt file.
    """
    row = await _source_or_404(session, user_id=user.user_id, source_id=id)

    if row.kind == "link":
        return {"url": row.url}

    if not row.storage_path:
        raise HTTPException(status_code=404, detail="File not found")

    from ..storage import get as storage_get

    obj = await storage_get(row.storage_path)
    if obj is None:
        raise HTTPException(status_code=404, detail="File not found")

    return Response(
        content=obj.data,
        media_type=obj.content_type or row.content_type,
        # `inline`, not `attachment` — the client renders images and PDFs in
        # place, and the filename still travels for a save.
        headers={"Content-Disposition": f'inline; filename="{row.original_filename}"'},
    )


#: How much of the document goes into the ask prompt.
ASK_DOC_CHARS = 8000
#: v1's window, and its per-message cap.
ASK_MAX_TURNS = 24
ASK_TURN_CHARS = 4000

_ASK_SYSTEM = """You answer questions about one specific document the user has attached.
Ground every answer in the document. If the document does not say, say so plainly
and say what it would take to find out. Be concise — a few sentences unless asked
to expand. Never invent a quote, a number, or a date."""


@router.post("/sources/link/ask")
async def ask_link(
    request: Request,
    user: CurrentUser = Depends(require_user),
):
    """Ask a question about a linked source. SSE.

    The body is `{url?, text?, messages[], provider?, goal?}` — a multi-turn
    panel, not a one-shot ask (`CONTRACT_RECONCILIATION.md` #48). `text` wins
    over `url`, which is what makes a gated page answerable.

    Frames are `delta` / `done` / `error` only. No `tools`: this panel reads a
    document, it does not propose actions, and a confirm card appearing here
    would be an action the user never asked for.

    **One delta, not a token stream.** The model call is
    non-streaming, so the whole reply arrives at once. The client accumulates
    `content` either way, so this renders correctly — it just is not
    character-by-character. Token streaming needs a streaming client in the
    agent, which is a change to a package this service only imports.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Bad request")
    body = body or {}

    url = str(body.get("url") or "").strip()
    text = str(body.get("text") or "")
    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list):
        raw_messages = []

    turns = [
        {
            "role": str(m.get("role")),
            "content": str(m.get("content"))[:ASK_TURN_CHARS],
        }
        for m in raw_messages
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and str(m.get("content") or "").strip()
    ][-ASK_MAX_TURNS:]

    if not url and not text:
        raise HTTPException(status_code=400, detail="Bad request")
    if not turns:
        raise HTTPException(status_code=400, detail="Bad request")

    goal = str(body.get("goal") or "")[:500]

    async def events():
        doc = await resolve_document(
            url=url, text=text, max_chars=settings.text_excerpt_max
        )
        if not doc.ok:
            # One error frame and close — the same shape a model failure uses,
            # because from the client's side they are the same situation.
            yield frame(error(doc.error))
            return

        system = _ASK_SYSTEM
        if goal:
            system = f"{system}\n\nThe user's goal, for context: {goal}"
        system = f"{system}\n\nDOCUMENT:\n{(doc.text or '')[:ASK_DOC_CHARS]}"

        from pydantic import BaseModel

        class _Answer(BaseModel):
            model_config = {"extra": "ignore"}

            text: str = ""

        try:
            result = await get_complete()(
                system,
                "\n".join(f"{t['role']}: {t['content']}" for t in turns),
                _Answer,
            )
        except Exception as exc:  # noqa: BLE001
            yield frame(error(str(exc)))
            return

        yield frame(delta(result.text or ""))
        yield frame(
            done(
                message_id=f"ask_{int(datetime.now(UTC).timestamp() * 1000)}",
                provider=provider_status()["provider"],
            )
        )

    return sse_response(events())
