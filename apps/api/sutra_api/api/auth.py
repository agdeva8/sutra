"""Auth routes — cookies, guests, and the dev personas.

Shapes are v1's, exactly; see `CONTRACT-RECONCILIATION.md` §1. Two of them are
easy to "fix" and must not be:

* **`/auth/me` returns the user bare**, while `/auth/guest` and `/auth/session`
  wrap it in `{"user": ...}` and use `picture` where `me` uses `image`. The
  client branches on both differences.
* **`dev-login` and `personas` 404, not 403**, outside dev. A 404 is what a
  normal deployment looks like; a 403 advertises that a dev surface exists.

The one thing not carried over: `dev-login` requires `user_id`. v1 defaulted it
to the founder, which meant every page-load probe silently authenticated as the
founder — the comment recording that bug is kept here rather than the bug.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_session
from ..deps import CurrentUser, _dev_login_enabled, load_user, require_user, resolve_user
from ..ids import new_guest_user_id
from ..models import User, UserSession
from ..registry import DEFAULT_PROVIDER
from ..security import (
    clear_guest_cookie,
    clear_session_cookie,
    dev_session_token,
    new_session_token,
    set_guest_cookie,
    set_session_cookie,
    sign_guest_token,
)
from ..wire import persona, user_envelope, user_me

router = APIRouter(prefix="/auth", tags=["auth"])

_SAFE_ID = re.compile(r"[^a-zA-Z0-9_-]")


def _dev_gate() -> None:
    """404 outside dev — deliberately not 403."""
    if not _dev_login_enabled():
        raise HTTPException(status_code=404, detail="Not found")


def _safe_id(raw: str) -> str:
    return _SAFE_ID.sub("_", raw)[:64]


def _safe_name(raw: str) -> str:
    return raw.strip()[:80] or "Dev User"


async def _mint_session(
    session: AsyncSession, *, user_id: str, token: str
) -> None:
    """Store the token so it is revocable by `DELETE`, not by key rotation."""
    session.add(
        UserSession(
            session_token=token,
            user_id=user_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=settings.session_ttl_seconds),
        )
    )
    await session.flush()


# ---------------------------------------------------------------------------
# me
# ---------------------------------------------------------------------------


@router.get("/me")
async def me(
    request: Request, session: AsyncSession = Depends(get_session)
) -> dict:
    """The current user, bare — or 401.

    The dev bearer is tried **first and separately** so it can report
    `Unknown dev user` when the named row does not exist. Collapsing it into the
    shared resolver would turn that into a generic 401, which is the difference
    between "your dev token is wrong" and "you are signed out".
    """
    user = await resolve_user(request, session)
    if user is None:
        header = request.headers.get("authorization", "")
        if _dev_login_enabled() and header.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Unknown dev user")
        raise HTTPException(status_code=401, detail="Not authenticated")
    row = await load_user(session, user.user_id)
    if row is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_me(row)


# ---------------------------------------------------------------------------
# guest
# ---------------------------------------------------------------------------


@router.post("/guest")
async def guest(
    response: Response, session: AsyncSession = Depends(get_session)
) -> dict:
    """Mint a guest session.

    A guest is a **real `users` row** with `is_guest = true` — no shadow table,
    no null-owner rows. That is what lets every downstream query stay scoped by a
    single `user_id` and lets a guest's work be re-parented onto their account
    when they sign in.
    """
    user = User(
        id=new_guest_user_id(),
        email=None,
        name="Guest",
        image=None,
        is_guest=True,
        model_provider=DEFAULT_PROVIDER,
    )
    session.add(user)
    await session.flush()
    await session.commit()

    token, _exp = sign_guest_token(user.id)
    set_guest_cookie(response, token)
    return user_envelope(user)


# ---------------------------------------------------------------------------
# session
# ---------------------------------------------------------------------------


async def _exchange_session_id(session_id: str) -> tuple[dict | None, str, int]:
    """Trade a provider `session_id` for an identity. Returns `(data, error, status)`.

    v1 called Emergent's endpoint with an `X-Session-ID` header. With
    `AUTH_EXCHANGE_URL` unset the exchange is simply not configured, and saying
    so beats minting a session for an unverified string.
    """
    if not settings.auth_exchange_url:
        return None, "Session exchange is not configured", 501
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(settings.auth_exchange_timeout_ms / 1000)
        ) as client:
            resp = await client.get(
                settings.auth_exchange_url, headers={"X-Session-ID": session_id}
            )
    except httpx.HTTPError:
        return None, "Could not reach the auth provider", 502
    if resp.status_code != 200:
        return None, "Invalid or expired session", 401
    try:
        return resp.json(), "", 200
    except ValueError:
        return None, "Auth provider returned a malformed response", 502


@router.post("/session")
async def create_session(
    request: Request, response: Response, session: AsyncSession = Depends(get_session)
) -> dict:
    """Exchange a provider `session_id` for our own session cookie.

    v1 minted nothing: it stored the *provider's* token. This service generates
    its own 256-bit token, because the cookie is a bearer credential and should
    be issued where it is trusted. Same table, same 7-day TTL, same verification.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    session_id = (body or {}).get("session_id")
    if not session_id or not isinstance(session_id, str):
        raise HTTPException(status_code=400, detail="Missing session_id")

    data, error, status = await _exchange_session_id(session_id)
    if data is None:
        raise HTTPException(status_code=status, detail=error)

    email = data.get("email")
    user = (
        await session.execute(select(User).where(User.email == email).limit(1))
    ).scalar_one_or_none() if email else None

    if user is None:
        user = User(
            id=f"user_{__import__('uuid').uuid4().hex[:12]}",
            email=email,
            name=data.get("name"),
            image=data.get("picture"),
            is_guest=False,
            model_provider=DEFAULT_PROVIDER,
        )
        session.add(user)
    else:
        # A returning user's profile may have changed upstream.
        user.name = data.get("name") or user.name
        user.image = data.get("picture") or user.image
    await session.flush()

    token = new_session_token()
    await _mint_session(session, user_id=user.id, token=token)
    await session.commit()

    set_session_cookie(response, token)
    return user_envelope(user)


@router.post("/logout")
async def logout(
    request: Request, response: Response, session: AsyncSession = Depends(get_session)
) -> dict:
    """Clear both cookies, and revoke the session row if there is one.

    Revoking is what makes a session cookie a DB handle rather than a claim: a
    stolen cookie stops working at logout instead of at expiry.
    """
    token = request.cookies.get(settings.session_cookie)
    if token:
        row = (
            await session.execute(
                select(UserSession).where(UserSession.session_token == token).limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            await session.delete(row)
            await session.commit()
    clear_session_cookie(response)
    clear_guest_cookie(response)
    return {"ok": True}


# ---------------------------------------------------------------------------
# dev personas
# ---------------------------------------------------------------------------


async def _dev_login(
    *, user_id: str, name: str | None, response: Response, session: AsyncSession
) -> dict:
    safe_id = _safe_id(user_id)
    existing = await load_user(session, safe_id)
    if existing is None:
        existing = User(
            id=safe_id,
            email=f"{safe_id}@dev.local",
            name=_safe_name(name or "Dev User"),
            image=None,
            is_guest=False,
            model_provider=DEFAULT_PROVIDER,
        )
        session.add(existing)
        await session.flush()
    # An existing row is deliberately not renamed: the seeded personas' display
    # names are the point of them.

    token = dev_session_token()
    await _mint_session(session, user_id=existing.id, token=token)
    await session.commit()

    set_session_cookie(response, token)
    return user_envelope(existing)


@router.get("/dev-login")
async def dev_login_get(
    response: Response,
    session: AsyncSession = Depends(get_session),
    user_id: str = Query(default=""),
    name: str = Query(default=""),
    probe: str = Query(default=""),
) -> dict:
    """Dev persona login.

    `?probe=1` answers `{"available": true}` **before** the `user_id` guard, so a
    page can decide whether to render the dev menu without naming a user.
    """
    _dev_gate()
    if probe == "1":
        return {"available": True}
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id query param is required")
    return await _dev_login(user_id=user_id, name=name, response=response, session=session)


@router.post("/dev-login")
async def dev_login_post(
    response: Response,
    session: AsyncSession = Depends(get_session),
    user_id: str = Query(default=""),
    name: str = Query(default=""),
    probe: str = Query(default=""),
) -> dict:
    """The form-post spelling. Behaves identically, including the 404 gate."""
    _dev_gate()
    if probe == "1":
        return {"available": True}
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id query param is required")
    return await _dev_login(user_id=user_id, name=name, response=response, session=session)


@router.get("/personas")
async def personas(
    request: Request,
    session: AsyncSession = Depends(get_session),
    currentUserId: str = Query(default=""),
) -> dict:
    """Seeded personas and guests, minus the caller.

    Excluding the caller is the point: the menu is "switch to someone else", and
    listing yourself is a no-op that reads like a bug.
    """
    _dev_gate()
    caller = await resolve_user(request, session)
    exclude = caller.user_id if caller else currentUserId

    rows = list((await session.execute(select(User))).scalars())
    visible = [
        u for u in rows if (u.persona_key is not None or u.is_guest) and u.id != exclude
    ]
    visible.sort(key=lambda u: (u.persona_weight or 0, _neg_created(u)))
    return {"personas": [persona(u) for u in visible]}


def _neg_created(u: User) -> float:
    """Newest first within a weight tier — `desc(created_at)` as a sort key."""
    return -(u.created_at.timestamp() if u.created_at else 0.0)


@router.delete("/personas/{userId}")
async def delete_persona(
    userId: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Delete a guest. Curated personas are protected.

    The distinction matters: a guest row is disposable test data, and a curated
    persona is a fixture whose absence would break every other developer's
    reproduction.
    """
    _dev_gate()
    caller = await resolve_user(request, session)
    if caller and caller.user_id == userId:
        raise HTTPException(
            status_code=400, detail="Can't delete the persona you're signed in as."
        )

    target = await load_user(session, userId)
    if target is None:
        raise HTTPException(status_code=404, detail="Not found")
    if target.persona_key is not None and not target.is_guest:
        raise HTTPException(status_code=400, detail="Can't delete curated dev personas.")

    await session.delete(target)
    await session.commit()
    return {"ok": True, "deleted": userId}
