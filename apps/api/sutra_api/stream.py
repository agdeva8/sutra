"""SSE — the frame union, in one place.

OpenAPI cannot describe a stream, so `openapi.yaml` puts the union in an
`x-sse-frames` extension and says outright that consumers should read that rather
than the schema. This module is the executable version of that extension.

## The frame contract, and where it comes from

Every frame the client parses is here, and each was verified against the client
rather than the spec — `CONTRACT-RECONCILIATION.md` §5 found five disagreements:

| frame | fields | note |
|---|---|---|
| `delta` | `content` | the spec's HLD §12 says `text`; the client reads `content` |
| `tools` | `message_id`, `proposals` | the client **replaces the message id** from this frame |
| `needs_clarification` | `message_id`, `prompt`, `questions` | `thread_id` is added for the v2 planner |
| `impact` | `impact` | **missing from the spec entirely** |
| `plan` | `node`, `detail` | v2-only progress; no v1 equivalent |
| `done` | `message_id`, `provider`, `ref_id`, `conversation_id`, `redirected`, `text` | |
| `error` | `content` | the spec says `detail` |

Frames are `data: {json}\\n\\n` with **no** `event:` or `id:` lines and no
heartbeat — v1 sent exactly this and the client's reader assumes it.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

#: `no-cache` and the nginx hint are what stop a proxy buffering the stream into
#: one blob — which turns a live response into a 30-second pause.
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def frame(payload: dict[str, Any]) -> str:
    """One SSE frame. The double newline is the terminator, not decoration."""
    return f"data: {json.dumps(payload, default=str)}\n\n"


# ---------------------------------------------------------------------------
# The frames
# ---------------------------------------------------------------------------


def status(content: str) -> dict:
    """A progress line for the user ("Reading what you wrote…"). Shown in place of the pending reply."""
    return {"type": "status", "content": content}


def delta(content: str, *, ref_id: str | None = None) -> dict:
    """One chunk of prose. The client accumulates `content` — not `text`."""
    out: dict[str, Any] = {"type": "delta", "content": content}
    if ref_id:
        out["ref_id"] = ref_id
    return out


def tools(proposals: list[dict], *, message_id: str) -> dict:
    """Proposals to confirm.

    `message_id` is not optional in practice: the client swaps its optimistic
    stream id for this one, and the confirm card's buttons carry `message_id`
    + `proposal_id` back. Without it the card is attached to an id the server
    has never heard of.
    """
    return {"type": "tools", "message_id": message_id, "proposals": proposals}


def needs_clarification(
    questions: list[dict],
    *,
    message_id: str = "",
    prompt: str = "",
    thread_id: str | None = None,
) -> dict:
    """The HITL clarify interrupt. Terminal for this request.

    `thread_id` is the v2 addition: the client resumes with it and an `answers`
    map. v1 had no equivalent because its clarify was not durable.
    """
    out: dict[str, Any] = {
        "type": "needs_clarification",
        "message_id": message_id,
        "prompt": prompt,
        "questions": questions,
    }
    if thread_id:
        out["thread_id"] = thread_id
    return out


def impact(impact_payload: dict) -> dict:
    """The structured impact block — a preview of a goal drop's cascade.

    The spec omits this frame and the client renders it, which is the sort of
    omission that only shows up as a missing card. See
    `CONTRACT_RECONCILIATION.md` #27.
    """
    return {"type": "impact", "impact": impact_payload}


def plan(node: str, detail: str = "") -> dict:
    """Progress from a `/plan/stream` run. Not terminal."""
    return {"type": "plan", "node": node, "detail": detail}


def done(
    *,
    message_id: str,
    provider: str = "",
    ref_id: str | None = None,
    conversation_id: str = "",
    redirected: bool = False,
    text: str = "",
    thread_id: str | None = None,
) -> dict:
    """Exactly one per stream.

    `redirected` + `ref_id` are how the server moves a client out of a bucket
    that has been sealed: on a `true`, the client swaps its ref and continues.

    `thread_id` is a v2 addition, and it is what makes `/plan/stream` usable: the
    client needs the thread to call `/plan/confirm`, and the stream is the only
    place it can learn it. Additive, so a v1-shaped consumer is unaffected.
    """
    out = {
        "type": "done",
        "message_id": message_id,
        "provider": provider,
        "ref_id": ref_id,
        "conversation_id": conversation_id,
        "redirected": redirected,
        "text": text,
    }
    if thread_id:
        out["thread_id"] = thread_id
    return out


def error(message: str) -> dict:
    """Terminal, and the only way to report a failure after a 200 has gone out.

    v1 always prefixed the text with `Model error: `, and the client shows it
    verbatim — so the prefix is kept, because it is the difference between "the
    model failed" and "the app failed".
    """
    return {"type": "error", "content": f"Model error: {message}"}


# ---------------------------------------------------------------------------
# The response
# ---------------------------------------------------------------------------


async def event_stream(chunks: AsyncIterator[str]) -> AsyncIterator[str]:
    """Pass an async iterator of already-framed strings through.

    Exists so a route hands over a generator it built and this module owns the
    headers — the one place that knows an SSE response's shape.
    """
    async for chunk in chunks:
        yield chunk


def sse_response(chunks: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        event_stream(chunks),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


# ---------------------------------------------------------------------------
# Long jobs, streamed
# ---------------------------------------------------------------------------

#: A comment frame this often keeps proxies from closing a quiet connection while a model works.
HEARTBEAT_S = 8.0
#: What the client asks for to get progress frames instead of one JSON body.
SSE_ACCEPT = "text/event-stream"

Say = Callable[[str], None]


def wants_stream(request) -> bool:
    return SSE_ACCEPT in (request.headers.get("accept") or "")


async def progress_stream(work: Callable[[Say], Awaitable[dict]], *, first: str = "") -> AsyncIterator[str]:
    """Run `work(say)` and stream what it says while it runs.

    `say(line)` may be called from any thread. Frames: `status` per line, `result` once with `work`'s
    dict, or `error` if it raised. The server keeps the request open for the whole job, which is what
    lets a serverless host finish it: work started after the response is not guaranteed to run there.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str] = asyncio.Queue()

    def say(line: str) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, line)

    if first:
        yield frame(status(first))
    task = asyncio.ensure_future(work(say))
    while not task.done() or not queue.empty():
        try:
            line = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_S)
        except asyncio.TimeoutError:
            yield ": keep-alive\n\n"
            continue
        yield frame(status(line))
    # A line said just before the job returned is still on its way into the queue (`say` hands it over
    # with `call_soon_threadsafe`); give those hand-overs one turn of the loop, then flush them.
    await asyncio.sleep(0)
    while not queue.empty():
        yield frame(status(queue.get_nowait()))
    try:
        yield frame({"type": "result", "result": task.result()})
    except HTTPException as exc:
        yield frame({"type": "error", "status": exc.status_code, "content": str(exc.detail)})
    except Exception as exc:  # noqa: BLE001 - after the headers, an error frame is the only way to say so
        yield frame({"type": "error", "status": 500, "content": str(exc) or "Something went wrong."})
