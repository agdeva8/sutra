"""Fetching a user-supplied URL — the SSRF guard, and a meta preview.

Ported from v1's `lib/link-preview.ts` and `lib/sources.ts`.

**This is the one place the server makes an outbound request to a host the user
chose.** That makes it the classic SSRF surface: `http://169.254.169.254/…` is
cloud instance metadata, `http://localhost:5432` is the database, and a public
hostname whose A record points at `10.0.0.5` is either of those with a nicer
name. So the guard is deliberately paranoid, in three independent ways:

1. **Syntactic** — the literal hostname is checked against the reserved ranges.
2. **Resolved** — `getaddrinfo` is called and *every* returned address is
   re-checked, which is what catches a public name pointing somewhere private.
3. **Per hop** — redirects are followed manually, and the guard re-runs on each
   `Location`. Letting the HTTP client follow them would validate only the first
   hop and then happily fetch whatever the second one named.

A DNS failure **refuses** rather than allows. An unreadable name is not a
permitted name.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

#: Kept from v1: short enough to keep a dialog responsive, long enough for a
#: slow page.
FETCH_TIMEOUT_S = 12.0
#: Hard byte cap. A page we stop reading at 256 KB is a page we cannot be made
#: to buffer forever.
MAX_BYTES = 256 * 1024
MAX_REDIRECTS = 5
#: The preview's description is a snippet, not an abstract.
SNIPPET_LEN = 400

USER_AGENT = "Sutra/1.0 (+preview)"

#: Hostnames that never leave the machine, by name.
_BLOCKED_NAMES = {"localhost", "0.0.0.0", "::1"}
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal")


def _bare(host: str) -> str:
    return (host or "").strip().strip("[]").lower()


def _ip_is_private(addr: str) -> bool:
    """True for anything not globally routable.

    `ipaddress` covers the whole reserved range — 10/8, 127/8, 169.254/16,
    172.16/12, 192.168/16, ::1, fe80::/10, fc00::/7 — which is strictly more
    than v1's handwritten list, and correct for IPv6 too.
    """
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True  # unparseable is not a routable address
    return not ip.is_global or ip.is_multicast or ip.is_loopback or ip.is_link_local


async def host_is_blocked(host: str) -> bool:
    """Blocked by name or by resolution. DNS failure counts as blocked."""
    bare = _bare(host)
    if not bare or bare in _BLOCKED_NAMES:
        return True
    if bare.endswith(_BLOCKED_SUFFIXES):
        return True
    # A literal address needs no lookup.
    try:
        ipaddress.ip_address(bare)
    except ValueError:
        pass
    else:
        return _ip_is_private(bare)

    try:
        infos = await asyncio.get_running_loop().getaddrinfo(bare, None)
    except (OSError, UnicodeError):
        return True
    return any(_ip_is_private(info[4][0]) for info in infos)


@dataclass
class Document:
    """A fetched page, or the reason there is none.

    `ok` plus `error` rather than an exception: every failure here is a message
    for the user ("this link is private", "the site seems down"), and an
    exception would lose the distinction.
    """

    ok: bool
    url: str = ""
    final_url: str = ""
    text: str = ""
    html: str = ""
    status: int = 0
    content_type: str = ""
    error: str = ""
    headers: dict = field(default_factory=dict)


async def resolve_document(
    *, url: str = "", text: str = "", max_chars: int = 8000
) -> Document:
    """Pasted text wins; otherwise fetch the URL through the guard.

    `text` first is what makes a gated page attachable at all — the user pastes
    what they can see, and nothing is fetched. It also means the paste path
    cannot be an SSRF vector, because it never leaves the process.
    """
    if text and text.strip():
        stripped = text.strip()
        return Document(ok=True, url=url, final_url=url, text=stripped[:max_chars])

    if not url:
        return Document(ok=False, url=url, error="No URL provided")

    try:
        parsed = urlsplit(url)
    except ValueError:
        return Document(ok=False, url=url, error="That doesn't look like a valid URL.")

    if parsed.scheme not in ("http", "https"):
        return Document(
            ok=False, url=url, error="Only http and https URLs are supported."
        )
    if not parsed.netloc:
        return Document(ok=False, url=url, error="That doesn't look like a valid URL.")

    current = url
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(FETCH_TIMEOUT_S),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*"},
    ) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            parts = urlsplit(current)
            if await host_is_blocked(parts.hostname or ""):
                return Document(
                    ok=False,
                    url=url,
                    error="That URL points at a private or local network address.",
                )
            try:
                resp = await client.get(current)
            except httpx.TimeoutException:
                return Document(ok=False, url=url, error="Took too long to respond.")
            except httpx.HTTPError:
                return Document(ok=False, url=url, error="Could not reach this URL.")

            if resp.is_redirect and resp.headers.get("location"):
                # Re-check on the next pass — this is the whole point of
                # following manually.
                current = urljoin(current, resp.headers["location"])
                continue

            if resp.status_code in (401, 403):
                return Document(
                    ok=False,
                    url=url,
                    error="This link is private or requires sign-in.",
                )
            if resp.status_code >= 400:
                return Document(
                    ok=False,
                    url=url,
                    error=f"Got HTTP {resp.status_code} from the site.",
                )

            content_type = resp.headers.get("content-type", "")
            body = resp.content[:MAX_BYTES]
            try:
                html = body.decode(resp.encoding or "utf-8", errors="replace")
            except (LookupError, UnicodeError):
                html = body.decode("utf-8", errors="replace")

            if "html" not in content_type and "xml" not in content_type:
                # Not a page. Hand the raw text back rather than failing: a
                # `.txt` or `.md` link is a legitimate thing to attach.
                return Document(
                    ok=True,
                    url=url,
                    final_url=current,
                    html="",
                    text=html[:max_chars],
                    status=resp.status_code,
                    content_type=content_type,
                    headers=dict(resp.headers),
                )

            readable = strip_html(html)
            return Document(
                ok=True,
                url=url,
                final_url=current,
                html=html,
                text=readable[:max_chars],
                status=resp.status_code,
                content_type=content_type,
                headers=dict(resp.headers),
            )

    return Document(ok=False, url=url, error="Too many redirects.")


# ---------------------------------------------------------------------------
# HTML → text, and the meta preview
# ---------------------------------------------------------------------------

_SCRIPT_STYLE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.I | re.S)
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")

_ENTITIES = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&#x27;": "'",
    "&#x2F;": "/",
}


def decode_entities(s: str) -> str:
    for entity, char in _ENTITIES.items():
        s = s.replace(entity, char)
    return s


def strip_html(html: str) -> str:
    """Regex-based readability. Not a parser, and that is the v1 call.

    A real parser needs a dependency and a policy for malformed input; this
    needs neither, and the consumer is an LLM prompt that is robust to a stray
    tag. The trade is losing table structure and inline spacing, which nothing
    downstream reads.
    """
    if not html:
        return ""
    out = _SCRIPT_STYLE.sub(" ", html)
    out = _COMMENT.sub(" ", out)
    out = _TAG.sub(" ", out)
    out = decode_entities(out)
    return _WS.sub(" ", out).strip()


def extract_title(html: str) -> str:
    for pattern in (
        r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:title["\']',
        r'<meta[^>]+(?:property|name)=["\']twitter:title["\'][^>]+content=["\']([^"\']+)',
        r"<title[^>]*>(.*?)</title>",
    ):
        m = re.search(pattern, html, re.I | re.S)
        if m:
            return decode_entities(_WS.sub(" ", m.group(1))).strip()
    return ""


def extract_meta(html: str, name: str) -> str:
    """`<meta>` in either attribute order — `property` before `content`, and after.

    Both orders appear in the wild, and a regex that assumes one silently returns
    nothing for half the web.
    """
    for pattern in (
        rf'<meta[^>]+(?:property|name)=["\']{name}["\'][^>]+content=["\']([^"\']*)',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']{name}["\']',
    ):
        m = re.search(pattern, html, re.I | re.S)
        if m:
            return decode_entities(m.group(1)).strip()
    return ""


def extract_icon(html: str, final_url: str) -> str:
    m = re.search(
        r'<link[^>]+rel=["\'](?:shortcut )?icon["\'][^>]+href=["\']([^"\']+)',
        html,
        re.I,
    )
    if m:
        return urljoin(final_url, m.group(1))
    parts = urlsplit(final_url)
    return f"{parts.scheme}://{parts.netloc}/favicon.ico" if parts.netloc else ""


def is_embeddable(headers: dict) -> bool:
    """Whether the page may be shown in an iframe.

    Read from the response, not guessed: a dialog that iframes a page which
    forbids framing renders a blank rectangle with no explanation, and this is
    what lets the client offer a link-out instead.
    """
    xfo = headers.get("x-frame-options", "")
    if re.search(r"deny|sameorigin|allow-from", xfo, re.I):
        return False
    csp = headers.get("content-security-policy", "")
    m = re.search(r"frame-ancestors([^;]*)", csp, re.I)
    if m:
        value = m.group(1).strip()
        if not value or value.lower() == "'none'":
            return False
        if value not in ("*", "'self'"):
            return False
    return True


def preview_from(doc: Document) -> dict:
    """The `/sources/link/preview` body. Always renderable, success or not.

    A failure still returns `ok: false` **with HTTP 200** — v1's convention, and
    the dialog depends on it: it offers "save as a raw link" for a page it could
    not read, which a 4xx would turn into a dead end.
    """
    if not doc.ok:
        return {
            "ok": False,
            "url": doc.url,
            "host": urlsplit(doc.url).netloc or None,
            "error": doc.error,
            "title": None,
            "description": None,
            "image": None,
            "favicon": None,
            "snippet": "",
            "content_type": None,
            "status": None,
            "embeddable": False,
        }

    final = doc.final_url or doc.url
    parts = urlsplit(final)
    if not doc.html:
        # Not HTML — a raw text link. The title is the URL and there is nothing
        # to preview, which is honest rather than an error.
        return {
            "ok": True,
            "url": doc.url,
            "host": parts.netloc,
            "final_url": final,
            "title": final,
            "description": None,
            "image": None,
            "favicon": "",
            "snippet": "",
            "content_type": doc.content_type,
            "status": doc.status,
            "embeddable": False,
            "error": None,
        }

    image = extract_meta(doc.html, "og:image") or extract_meta(doc.html, "twitter:image")
    return {
        "ok": True,
        "url": doc.url,
        "host": parts.netloc,
        "final_url": final,
        "title": extract_title(doc.html) or final,
        "description": (
            extract_meta(doc.html, "og:description")
            or extract_meta(doc.html, "twitter:description")
            or extract_meta(doc.html, "description")
            or None
        ),
        "image": urljoin(final, image) if image else None,
        "favicon": extract_icon(doc.html, final),
        "snippet": doc.text[:SNIPPET_LEN].strip(),
        "content_type": doc.content_type,
        "status": doc.status,
        "embeddable": is_embeddable(doc.headers),
        "error": None,
    }
