"""`GET /state` — the whole dashboard, in one call.

A thin route: the assembly lives in `sutra_api/dashboard.py`, because
`POST /tools/confirm` returns the identical body and the two must not drift.

One deviation from v1, deliberate: **no 15-second response cache.** v1 cached
this per process and invalidated it on any mutating request from the same user,
which meant `generated_at` could be up to 15s old and a hit after an external
write could show a board that no longer matched. Serving fresh makes
`generated_at` mean what it says. The cache was an optimization; if this ever
needs one it belongs behind an explicit version token, not a clock.

One thing kept: the path is exactly `/state`, with no trailing slash.
`x-contract-notes#empty-path-registration` records that v1 registered an empty
path string and a router that normalises the slash turns a POST into a 307 the
client will not follow. `redirect_slashes=False` on the app is the other half of
that.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..dashboard import assemble_state
from ..db import get_session
from ..deps import CurrentUser, require_user

router = APIRouter(tags=["state"])


@router.get("/state")
async def get_state(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    return await assemble_state(session, user_id=user.user_id)
