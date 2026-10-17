"""Read an uploaded image with the vision model, while the Scratch entry that owns it is filed.

The reading is stored as the source's `text_excerpt`, so later chat turns need only the text and never
the bytes (which on a serverless host are not guaranteed to still be there).

It deliberately does **not** run at upload time: an upload returns as soon as the bytes are stored
(`text_pending: true`) so capture is instant, and `scratch_service.process` reads the pending images
before triage, where its progress line can be shown.
"""
from __future__ import annotations

import asyncio
import base64

from agentv2 import default_chat
from agentv2.llm import reply_text

from .core.extract import TEXT_EXCERPT_MAX

#: What the model is asked about an attached image.
IMAGE_PROMPT = (
    "The user attached this image while setting a goal. Transcribe any text in it exactly, then describe "
    "what it shows in two or three sentences, focusing on what would matter for planning work toward a goal "
    "(a syllabus, a job description, a schedule, a progress screenshot, a reading list). Plain text only."
)
#: Marker stored when the model could not read the image, so it is distinguishable from an empty file.
IMAGE_UNREADABLE = "[image could not be read]"


def needs_reading(excerpt: str | None) -> bool:
    """Whether an image's excerpt is still an outstanding reading.

    Empty means the upload arrived with `text_pending`; the unreadable marker is a finished attempt and
    is not retried on every filing.
    """
    return not (excerpt or "").strip() and excerpt != IMAGE_UNREADABLE


def _describe(data: bytes, content_type: str) -> str:
    url = f"data:{content_type or 'image/png'};base64,{base64.b64encode(data).decode()}"
    message = [{"type": "text", "text": IMAGE_PROMPT}, {"type": "image_url", "image_url": {"url": url}}]
    return reply_text(default_chat().invoke([("user", message)]).content).strip()


async def describe_image(data: bytes, content_type: str) -> str:
    """The model's reading of the image, capped at the excerpt size; a marker if it fails."""
    try:
        text = await asyncio.to_thread(_describe, data, content_type)
    except Exception:  # noqa: BLE001 — no model, no vision support, or a bad image: the upload still succeeds
        return IMAGE_UNREADABLE
    return text[:TEXT_EXCERPT_MAX] or IMAGE_UNREADABLE
