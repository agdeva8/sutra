"""Cookies, tokens, and the CSRF defence the OpenAPI spec cannot express.

Two cookies, as in v1:

* `session_token` — authenticated. Opaque, opaque means *unsignable*: v1 verified
  it by looking it up in `user_sessions`, not by checking a signature, so
  revocation is a `DELETE` rather than a key rotation. Kept exactly.
* `guest_token` — a **signed** claim `{userId, exp}`, held in a base64url payload
  plus an HMAC over that payload. Stateless: verifying a guest costs no DB read,
  which is what makes an unauthenticated first paint cheap.

## The CSRF problem, and why it is here

The spec's own note (`x-contract-notes#no-csrf-token`) records that v1 had **no
CSRF token** — cookie-only auth with `credentials: "include"` on every call. It
then correctly observes that the spec cannot express an origin check, so the
server must enforce one.

So: cookie sessions, plus an origin check on every mutating request. The check
is `_origin_matches_host`, and it is deliberately strict — a same-origin `apps/web`
sends `Origin: <its own origin>` on every non-GET, so a *missing* origin on a
mutating request is itself suspicious and is rejected. `SameSite=Lax` on both
cookies is the second layer; it does not replace the first, because Lax still
permits a top-level cross-site `POST` form submission in older browsers.

One deliberate divergence from v1: it set the session cookie to
`SameSite=None; Secure` in production because its frontend lived on a different
origin. `apps/web` calls `/api` on the same origin, so `Lax` is both sufficient
and stricter. `None` would *weaken* this deployment, which is why it is not
carried over.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlsplit

from fastapi import Request, Response

from .config import settings

_GUEST_TTL_MS = settings.guest_ttl_seconds * 1000


# ---------------------------------------------------------------------------
# base64url without padding — v1's exact encoding
# ---------------------------------------------------------------------------


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    """Decode, tolerating missing padding.

    `urlsafe_b64decode` demands correct padding; v1 stripped it when encoding, so
    a round-trip through a cookie jar can arrive unpadded.
    """
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _secret() -> bytes:
    if not settings.auth_secret:
        raise RuntimeError(
            "AUTH_SECRET is not set. Generate one with: "
            'python -c "import secrets; print(secrets.token_urlsafe(48))"'
        )
    return settings.auth_secret.encode()


# ---------------------------------------------------------------------------
# Guest tokens
# ---------------------------------------------------------------------------


def sign_guest_token(user_id: str, *, now_ms: int | None = None) -> tuple[str, int]:
    """Mint a guest cookie. Returns `(token, expires_at_ms)`.

    The signature covers the **base64url payload string**, not the raw JSON —
    that is what v1 did, and re-encoding the JSON could reorder keys and
    invalidate every existing cookie.
    """
    exp = (now_ms if now_ms is not None else int(time.time() * 1000)) + _GUEST_TTL_MS
    payload = json.dumps({"userId": user_id, "exp": exp}, separators=(",", ":"))
    payload_b64 = _b64e(payload.encode())
    sig = hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64e(sig)}", exp


def verify_guest_token(token: str | None) -> str | None:
    """The guest's user id, or `None`. Never raises on a malformed cookie.

    A bad cookie is an anonymous visitor, not an error — anything else turns a
    stale browser into a 500.
    """
    if not token or "." not in token:
        return None
    payload_b64, _, sig_b64 = token.partition(".")
    try:
        expected = hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest()
        given = _b64d(sig_b64)
    except (ValueError, TypeError):
        return None
    # `timingSafeEqual` on the v1 side; `compare_digest` is the Python spelling.
    # Length is checked first because `compare_digest` raises on a length
    # mismatch rather than returning False, which would be an unhandled 500.
    if len(given) != len(expected) or not hmac.compare_digest(given, expected):
        return None
    try:
        claims = json.loads(_b64d(payload_b64))
    except (ValueError, TypeError):
        return None
    user_id = claims.get("userId")
    exp = claims.get("exp")
    if not isinstance(user_id, str) or not isinstance(exp, int):
        return None
    if exp <= int(time.time() * 1000):
        return None
    return user_id


# ---------------------------------------------------------------------------
# Session tokens
# ---------------------------------------------------------------------------


def new_session_token() -> str:
    """A fresh opaque session token — 256 bits of urandom, url-safe.

    v1 stored the *provider's* token here, having received it from an OAuth
    exchange. This service mints its own: the token is a bearer credential in a
    HttpOnly cookie, so it should be generated where it is trusted rather than
    relayed from a third party. Same 7-day TTL, same table, same verification.
    """
    return secrets.token_urlsafe(32)


def dev_session_token() -> str:
    """The dev-login token, prefixed so it is obvious in `user_sessions`.

    v1 used `dev_<uuid4hex>`. Kept: a row with this prefix in production means
    dev-login is misconfigured, and it should be findable by eye.
    """
    return f"dev_{secrets.token_hex(16)}"


# ---------------------------------------------------------------------------
# Cookies
# ---------------------------------------------------------------------------


def _base_attrs() -> dict[str, object]:
    return {"path": "/", "httponly": True, "secure": settings.is_prod, "samesite": "lax"}


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=settings.session_ttl_seconds,
        **_base_attrs(),
    )


def set_guest_cookie(response: Response, token: str) -> None:
    """10 minutes. Short on purpose — anti-abuse, a locked v1 decision."""
    response.set_cookie(
        settings.guest_cookie,
        token,
        max_age=settings.guest_ttl_seconds,
        **_base_attrs(),
    )


def clear_session_cookie(response: Response) -> None:
    response.set_cookie(
        settings.session_cookie, "", max_age=0, expires=0, **_base_attrs()
    )


def clear_guest_cookie(response: Response) -> None:
    response.set_cookie(settings.guest_cookie, "", max_age=0, expires=0, **_base_attrs())


# ---------------------------------------------------------------------------
# The origin check (CSRF)
# ---------------------------------------------------------------------------

#: Methods that must not be reachable cross-site. GET and HEAD are excluded
#: because they are already safe *given* that no handler here mutates on a GET —
#: which is an invariant of this codebase, not of HTTP.
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def origin_is_same_site(request: Request) -> bool:
    """Reject a cross-site mutating request.

    Fails **closed**: an absent `Origin` on a mutating request is rejected. A
    same-origin `fetch` from `apps/web` always sends one — the browser does, for
    every non-GET — so absence means the request did not come from our own page
    (a hand-rolled client, or a proxy stripping headers). Either way, the safe
    reading of "I cannot tell where this came from" on a *write* is no.

    A request with no `Origin` but a matching `Referer` is accepted, because some
    older clients send only that.
    """
    if request.method not in MUTATING_METHODS:
        return True

    allowed = set(settings.cors_allowed_origins)
    host = request.headers.get("host", "")

    origin = request.headers.get("origin")
    if origin:
        if origin in allowed:
            return True
        return urlsplit(origin).netloc.lower() == host.lower()

    referer = request.headers.get("referer")
    if referer:
        return urlsplit(referer).netloc.lower() == host.lower()

    # No Origin and no Referer. `TestClient` sends neither unless told to, so in
    # the test environment this is allowed; everywhere else it is refused.
    return settings.env == "test"
