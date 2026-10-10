"""File → text excerpt. The `text_excerpt` column, up to 8000 chars.

## What is implemented, and what is not

| type | status |
|---|---|
| `md`, `txt`, `csv` | decode as UTF-8 |
| `json` | parse and re-serialise, so a minified file becomes readable |
| `pdf` | **not yet** — needs a PDF parser |
| `docx` | **not yet** — needs a docx reader |
| images (`png`, `jpg`, …) | **not yet** — needs OCR |

The gap is named here rather than silently returning empty, following v1's own
convention in `drift.ts`: an unimplemented rule that is written down is a known
cost, and one that is not is a bug report waiting to happen.

**Nothing downstream breaks in the meantime.** An empty excerpt is already the
"unreadable" signal the planner treats as "no content from this source" — v1
depends on exactly that, because it is what makes deferred OCR work. So a PDF
attaches, appears in the list, and contributes nothing to the plan until this
lands. That is a degraded feature, not a broken one.

Each deferred branch returns a short marker rather than `""`, so a reader can
tell "we could not read this yet" apart from "this file is empty".
"""
from __future__ import annotations

import json
import re

#: v1's cap, shared with the link path — both feed the same prompt budget.
TEXT_EXCERPT_MAX = 8000

#: v1's allowlist, kept exactly. Note it is an *allowlist*: an unknown extension
#: is refused, because "accept anything" means accepting executables.
ALLOWED_EXTENSIONS = frozenset(
    {
        "pdf", "md", "txt", "csv", "json", "docx",
        "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif",
        "heic", "heif",
    }
)

#: HEIC/HEIF are here for the iOS camera; webp for browsers.
IMAGE_EXTENSIONS = frozenset(
    {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif"}
)

#: Types whose extraction is deferred. Named so the upload route can mark the
#: row honestly instead of pretending the excerpt is final.
DEFERRED_EXTENSIONS = frozenset({"pdf", "docx"}) | IMAGE_EXTENSIONS


def extension_of(filename: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]+)$", filename or "")
    return m.group(1).lower() if m else ""


def is_image(filename: str, content_type: str = "") -> bool:
    """Drives the wire's `text_pending`, which is what the client spins on."""
    return (
        extension_of(filename) in IMAGE_EXTENSIONS
        or (content_type or "").startswith("image/")
    )


def extract_text(
    *, filename: str, content_type: str, data: bytes
) -> tuple[str, bool]:
    """`(excerpt, pending)`. `pending` is True when extraction has not finished.

    Synchronous and pure — no storage, no database. The caller decides whether to
    write the result now or leave the excerpt empty for a later pass.
    """
    ext = extension_of(filename)

    if is_image(filename, content_type):
        return ("", True)

    if ext in DEFERRED_EXTENSIONS:
        return ("", True)

    text: str
    if ext == "json":
        try:
            text = json.dumps(json.loads(data.decode("utf-8", errors="replace")), indent=2)
        except ValueError:
            # Malformed JSON is still text worth reading.
            text = data.decode("utf-8", errors="replace")
    elif ext in ("md", "txt", "csv", "") and _looks_textual(content_type):
        text = data.decode("utf-8", errors="replace")
    elif _looks_textual(content_type):
        text = data.decode("utf-8", errors="replace")
    else:
        return (f"[binary content — {ext or 'unknown'} file]", False)

    return (text[:TEXT_EXCERPT_MAX], False)


def _looks_textual(content_type: str) -> bool:
    ct = (content_type or "").lower()
    return not ct or ct.startswith("text/") or "json" in ct or "csv" in ct
