"""The nudge card — one recommendation set, matched to the user's current state.

## `cache` is a polling switch, not telemetry

This is the single most important thing about this route and the place the spec
is most wrong. `openapi.yaml` declares the enum `hit | miss | warming`;
**`warming` does not exist anywhere in v1**, and the real enum is
`hit | miss | stale`. See `CONTRACT-RECONCILIATION.md` #58.

The client polls every **5s** while `cache` is anything but `hit`, and gives up
after **60s**. So the field is a control signal: a value that never becomes
`hit` is a request storm, and the spec's own note says as much — it just names
the wrong enum.

That is why the deferred pipeline below answers a **warm empty set** rather than
a permanent `miss`. `miss` would be the more literal answer ("we have nothing
cached that matches"), and it would make every open dashboard poll for a minute
and then silently stop, forever. An empty set with `hit` is truthful — the cache
*is* warm, and it *is* empty — and it stops the polling.

`hit` / `stale` / `miss` otherwise mean what v1 meant:

| value | condition | items | side effect |
|---|---|---|---|
| `hit` | cached, unexpired | cached | none |
| `stale` | cached, expired, but under 24h old | cached, served as-is | refresh starts |
| `miss` | no row, or a row over 24h old | `[]` computed now | refresh starts |
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..core.motivation import compute_state_hash, detect_bucket
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import MotivationCache
from ..store import repo
from ..wire import motivation

router = APIRouter(tags=["motivation"])

#: The client asks for at most three; v1 clamped rather than rejected.
MAX_ITEMS = 3


async def _generate(*, bucket: str, user_id: str, n: int) -> list[dict]:
    """The recommendation pipeline — **not built yet**.

    v1's is search → fetch → critique (up to 25 LLM calls) → frame, with a hard
    `COST_CAP_USD = 0.25` and a 20s pipeline timeout. It needs a search key
    (Tavily) and a model, and it is the largest single subsystem in v1's
    product surface.

    Returning `[]` from here is a real implementation of a real answer: "there is
    nothing to show this user right now". The route above then writes that empty
    set to the cache, so the next poll is a genuine `hit` and the client stops
    polling. When the pipeline lands, only this function changes — the cache
    contract, the bucket logic and the wire shape all stay.
    """
    return []


@router.get("/motivation/recommend")
async def recommend(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    n: int = MAX_ITEMS,
) -> dict:
    wanted = max(1, min(int(n or MAX_ITEMS), MAX_ITEMS))
    now = datetime.now(UTC)

    if not settings.motivation_enabled:
        return motivation("stuck", [], "hit", now.isoformat())

    goals = await repo.list_goals(session, user_id=user.user_id, limit=500)
    milestones = await repo.list_milestones(session, user_id=user.user_id, limit=1000)

    goal_dicts = [
        {
            "id": g.id,
            "status": g.status,
            "updated_at": g.updated_at.isoformat() if g.updated_at else None,
        }
        for g in goals
    ]
    milestone_dicts = [
        {
            "status": m.status,
            "target_date": m.target_date.isoformat() if m.target_date else None,
        }
        for m in milestones
    ]

    bucket = detect_bucket(
        today=now.date(), milestones=milestone_dicts, goals=goal_dicts, now=now
    )
    state_hash = compute_state_hash(
        overdue_ids=[
            m["target_date"]
            for m in milestone_dicts
            if m["status"] != "done" and m["target_date"]
        ]
        or [],
        goals=goal_dicts,
    )

    row = (
        await session.execute(
            select(MotivationCache).where(
                MotivationCache.user_id == user.user_id,
                MotivationCache.bucket == bucket,
                MotivationCache.state_hash == state_hash,
            )
        )
    ).scalar_one_or_none()

    if row is not None and row.expires_at > now:
        return motivation(
            bucket, list(row.items or [])[:wanted], "hit", row.generated_at.isoformat()
        )

    stale = row is not None and (
        (now - row.generated_at).total_seconds() < settings.motivation_stale_ttl_seconds
    )
    if stale:
        # Serve what we have while refreshing. Returning `[]` here would blank a
        # card the user is looking at.
        return motivation(
            bucket, list(row.items or [])[:wanted], "stale", row.generated_at.isoformat()
        )

    # A genuine miss: compute, store, then answer `hit`.
    items = (
        await _generate(bucket=bucket, user_id=user.user_id, n=wanted)
        if settings.motivation_pipeline_enabled
        else []
    )

    if row is None:
        row = MotivationCache(
            user_id=user.user_id,
            bucket=bucket,
            state_hash=state_hash,
            items=items,
            generated_at=now,
            expires_at=now,
        )
        session.add(row)
    else:
        row.items = items
        row.generated_at = now

    from datetime import timedelta

    row.expires_at = now + timedelta(seconds=settings.motivation_cache_ttl_seconds)
    await session.commit()

    return motivation(bucket, items[:wanted], "hit", row.generated_at.isoformat())
