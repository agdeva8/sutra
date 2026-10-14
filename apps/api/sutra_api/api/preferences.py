"""Preferences — the model switcher.

`git`-cheap routes with two v1 quirks worth keeping:

* `PUT /preferences` returns **`{"model_provider": ...}`**, not the user. The spec
  says the user; the client reads only this key. See
  `CONTRACT-RECONCILIATION.md` #7.
* The `anthropic` alias is accepted and **echoed back unchanged** while
  `claude` is what gets stored. A client that round-trips its own value sees no
  drift, which is how the switcher stays honest about what the user picked.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_user
from ..models import User
from ..profile import ProfileError, clean_profile
from ..registry import DEFAULT_PROVIDER, MODEL_OPTIONS, echo_provider, resolve_provider_id

router = APIRouter(tags=["preferences"])


@router.get("/preferences/models")
async def list_models() -> dict:
    """The catalog. **No auth** — it is a constant, and the sign-in screen needs it."""
    return {"models": MODEL_OPTIONS}


@router.put("/preferences")
async def update_preferences(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user=Depends(require_user),
) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    raw = (body or {}).get("model_provider")
    resolved = resolve_provider_id(raw)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Invalid provider")

    row = await session.get(User, user.user_id)
    if row is None:
        # v1 created a minimal guest row here rather than 404ing, because a
        # signed-in session whose user row is missing is a recoverable state —
        # and losing the preference would be a silent no-op on the next request.
        row = User(
            id=user.user_id,
            email=user.email,
            name=user.name or "Guest",
            is_guest=True,
            model_provider=resolved,
        )
        session.add(row)
    else:
        row.model_provider = resolved
    await session.commit()

    return {"model_provider": echo_provider(raw if isinstance(raw, str) else "", resolved)}


@router.get("/profile")
async def get_profile(
    session: AsyncSession = Depends(get_session),
    user=Depends(require_user),
) -> dict:
    """The "about you" profile. `{"profile": {}}` until it has been asked; `asked` is true after."""
    row = await session.get(User, user.user_id)
    return {"profile": dict(row.profile or {}) if row else {}}


@router.put("/profile")
async def put_profile(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user=Depends(require_user),
) -> dict:
    """Replace the profile. Skipped fields are simply absent; the stored copy is always marked asked."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    try:
        profile = clean_profile((body or {}).get("profile") if isinstance(body, dict) else None)
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    row = await session.get(User, user.user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    row.profile = profile
    await session.commit()
    return {"profile": profile}
