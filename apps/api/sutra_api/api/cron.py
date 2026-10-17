"""Routes a platform scheduler calls (Vercel Cron, Supabase Cron), guarded by `CRON_SECRET`.

The scheduler sends `Authorization: Bearer $CRON_SECRET`. With no secret configured the
routes are closed, so a deployment that forgot it cannot be triggered by anyone — the
failure is a 404, the same answer as a path that does not exist.

`/cron/jobs` is the drain: it runs everyone's due background jobs for a few minutes and
returns. `/cron/tick` and `/cron/reap` are quick: the nightly tick now *queues* one job per
user (the drain runs it) rather than doing the work inside the cron request.
"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Header, HTTPException

from ..config import settings
from ..jobs import run_due_jobs
from ..nightly import enqueue_tick_jobs
from ..scratch_service import reap_stuck

router = APIRouter(tags=["cron"])


def authorised(authorization: str | None, secret: str) -> bool:
    """The whole guard, as a pure function: no secret means nobody is authorised."""
    if not secret:
        return False
    return hmac.compare_digest(authorization or "", f"Bearer {secret}")


def _authorised(authorization: str | None) -> None:
    if not authorised(authorization, settings.cron_secret):
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/cron/jobs")
async def cron_jobs(authorization: str | None = Header(default=None)) -> dict:
    """Run due background jobs for every user, within the cron time budget."""
    _authorised(authorization)
    return await run_due_jobs()


@router.get("/cron/tick")
async def cron_tick(authorization: str | None = Header(default=None)) -> dict:
    """Queue one tick job per user with an active goal; `/cron/jobs` does the work."""
    _authorised(authorization)
    return await enqueue_tick_jobs()


@router.get("/cron/reap")
async def cron_reap(authorization: str | None = Header(default=None)) -> dict:
    _authorised(authorization)
    return {"refiled": await reap_stuck()}
