"""Routes a platform scheduler calls (Vercel Cron). Guarded by `CRON_SECRET`, not by a user session.

Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set on the project. With no
secret configured the routes are closed, so a deployment that forgot it cannot be triggered by anyone.
"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Header, HTTPException

from ..config import settings
from ..nightly import tick_all_users
from ..scratch_service import reap_stuck

router = APIRouter(tags=["cron"])


def _authorised(authorization: str | None) -> None:
    expected = f"Bearer {settings.cron_secret}"
    if not settings.cron_secret or not hmac.compare_digest(authorization or "", expected):
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/cron/tick")
async def cron_tick(authorization: str | None = Header(default=None)) -> dict:
    _authorised(authorization)
    return await tick_all_users()


@router.get("/cron/reap")
async def cron_reap(authorization: str | None = Header(default=None)) -> dict:
    _authorised(authorization)
    return {"refiled": await reap_stuck()}
