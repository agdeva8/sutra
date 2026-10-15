"""Auth — one resolver, three ladders collapsed into one.

v1 had **three** resolvers (`authenticateRoute`, `resolveRequestUser`, and a
`getAuthenticatedUser`), each with a different order, plus four routes that
inlined a fourth. That is how the bearer bug happened.

**The bearer bug, not reproduced.** v1's shared resolvers gated
`Authorization: Bearer` behind `ALLOW_DEV_LOGIN === "true"`, but `/auth/me`,
`/sources`, `/sources/{id}`, `/sources/{id}/download` and `/audit/export` had
their own inline resolvers that accepted a bearer **without that gate** and used
it as the `user_id`. So `Bearer user_founder01` — or any other id — read that
user's data with no credential at all. Here the gate is in one function and
there is no second path.

**Ladder:** session cookie → guest cookie → dev bearer. v1's `resolveRequestUser`
order; kept because the session cookie is the strongest claim and the guest the
weakest, so checking strongest-first means a user with both is never *downgraded*
to their guest identity.

A dev bearer must name an **existing** user row. v1 used the raw string as the
`user_id` without checking, which meant a typo produced FK violations deep inside
a write instead of a 401 at the door.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import get_session
from .models import User, UserSession
from .security import verify_guest_token

#: v1 rejected this exact string defensively; kept so a placeholder in a script
#: cannot become a working credential.
_BOGUS_TOKEN = "bogus_xxx"


@dataclass(frozen=True)
class CurrentUser:
    """The authenticated caller. `user_id` is the only scoping key anywhere.

    Never read from a request body — v1 called that out explicitly, and it is
    the difference between "scoped to me" and "scoped to whoever I name".
    """

    user_id: str
    is_guest: bool
    source: Literal["session", "guest", "bearer"]
    email: str | None = None
    name: str | None = None
    model_provider: str = "gemini"
    persona_key: str | None = None

    @property
    def label(self) -> str:
        """What the audit ledger and the toaster call this user."""
        return self.name or self.email or ("Guest" if self.is_guest else self.user_id)


#: How long a resolved identity is reused before the database is asked again. Every API call used to
#: cost two round trips (session row, then user row) before doing any work; on a serverless host with a
#: remote database that was most of the ~1.4s floor. Short, because a revoked session or a changed
#: profile should show up quickly, and `forget_identity` drops an entry the moment we know it changed.
IDENTITY_CACHE_TTL_S = 30.0
#: A hard bound so the dict cannot grow without limit in a long-lived process.
IDENTITY_CACHE_MAX = 2000

_identity_cache: dict[str, tuple[float, "CurrentUser"]] = {}


def _cache_get(key: str) -> "CurrentUser | None":
    hit = _identity_cache.get(key)
    if hit is None:
        return None
    if hit[0] <= time.monotonic():
        _identity_cache.pop(key, None)
        return None
    return hit[1]


def _cache_put(key: str, user: "CurrentUser") -> None:
    if len(_identity_cache) >= IDENTITY_CACHE_MAX:
        _identity_cache.clear()
    _identity_cache[key] = (time.monotonic() + IDENTITY_CACHE_TTL_S, user)


def forget_identity(*, user_id: str | None = None, session_token: str | None = None) -> None:
    """Drop cached identities after a logout or a change to the user row."""
    if session_token:
        _identity_cache.pop(f"s:{session_token}", None)
    if user_id:
        for key in [k for k, (_, u) in _identity_cache.items() if u.user_id == user_id]:
            _identity_cache.pop(key, None)


def _dev_login_enabled() -> bool:
    return settings.allow_dev_login or settings.env == "test"


async def load_user(session: AsyncSession, user_id: str) -> User | None:
    return await session.get(User, user_id)


async def _from_session_cookie(
    request: Request, session: AsyncSession
) -> CurrentUser | None:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        return None
    cached = _cache_get(f"s:{token}")
    if cached is not None:
        return cached
    # One round trip: the session row and its user together.
    found = (
        await session.execute(
            select(UserSession, User)
            .join(User, User.id == UserSession.user_id)
            .where(UserSession.session_token == token)
            .limit(1)
        )
    ).first()
    # No row, or an expired one: the cookie is stale. Fall *through* rather than
    # 401 — v1's rule, and it is what lets an expired session degrade into the
    # guest they already are instead of a dead page.
    if found is None:
        return None
    row, user = found
    if row.expires_at <= datetime.now(UTC):
        return None
    resolved = _of(user, "session")
    _cache_put(f"s:{token}", resolved)
    return resolved


async def _from_guest_cookie(
    request: Request, session: AsyncSession
) -> CurrentUser | None:
    user_id = verify_guest_token(request.cookies.get(settings.guest_cookie))
    if not user_id:
        return None
    cached = _cache_get(f"g:{user_id}")
    if cached is not None:
        return cached
    user = await load_user(session, user_id)
    # A signed claim for a row that no longer exists is not a user. v1 would
    # return the bare id and let a write fail on the FK; refusing here is the
    # same outcome with a better error.
    if user is None:
        return None
    resolved = _of(user, "guest")
    _cache_put(f"g:{user_id}", resolved)
    return resolved


async def _from_dev_bearer(
    request: Request, session: AsyncSession
) -> CurrentUser | None:
    if not _dev_login_enabled():
        return None
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token or token == _BOGUS_TOKEN:
        return None
    user = await load_user(session, token)
    if user is None:
        return None
    return _of(user, "bearer")


def _of(user: User, source: Literal["session", "guest", "bearer"]) -> CurrentUser:
    return CurrentUser(
        user_id=user.id,
        is_guest=user.is_guest,
        source=source,
        email=user.email,
        name=user.name,
        model_provider=user.model_provider or "gemini",
        persona_key=user.persona_key,
    )


async def resolve_user(
    request: Request, session: AsyncSession
) -> CurrentUser | None:
    """The whole auth surface, in one place. `None` means anonymous."""
    for resolve in (_from_session_cookie, _from_guest_cookie, _from_dev_bearer):
        user = await resolve(request, session)
        if user is not None:
            return user
    return None


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------


async def current_user(
    request: Request, session: AsyncSession = Depends(get_session)
) -> CurrentUser | None:
    """Optional auth — for routes that behave differently when signed in."""
    return await resolve_user(request, session)


async def require_user(
    request: Request, session: AsyncSession = Depends(get_session)
) -> CurrentUser:
    """Required auth. 401 with v1's exact body: `{"detail": "Not authenticated"}`.

    `detail` is not decoration — v1's client does `throw new Error(err.detail)`
    and shows it verbatim, so the string is user-visible copy.
    """
    user = await resolve_user(request, session)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    return user


def planner_enabled_for(user: CurrentUser) -> bool:
    """The dark-launch switch (HLD §14).

    Returning `{"status": "disabled"}` rather than erroring is what makes the
    planner safe to ship dark: the client falls back to the SSE chat path.
    """
    return settings.planner_allowed_for(user.user_id)
