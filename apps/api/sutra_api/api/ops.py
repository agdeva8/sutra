"""Liveness and readiness.

`/health` must never touch a dependency: it answers "is this process up", and a
liveness probe that fails when the database is slow causes a restart loop that
makes the outage worse. `/ready` is the opposite — it is *supposed* to fail when
a dependency is down, because that is what takes the instance out of rotation.
"""
from __future__ import annotations

from fastapi import APIRouter, Response
from sqlalchemy import text

from ..config import settings
from ..db import get_session
from ..llm import provider_status
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["ops"])


@router.get("/health")
async def health() -> dict:
    """Liveness. No I/O, by design."""
    return {"status": "ok"}


@router.get("/ready")
async def ready(response: Response, session: AsyncSession = Depends(get_session)) -> dict:
    """Readiness — DB reachable, and a model reachable when one is required.

    A missing key is a *readiness* failure, not a liveness one: the process is
    fine, but every planner route would degrade to `no_change`, so it should not
    take traffic.

    It is only a failure when `REQUIRE_LLM_PROVIDER` is set. Without it, the
    service is ready with no model key (model-backed routes answer 503), so it stays deployable
    with no keys, which is the intent.
    """
    problems: list[str] = []

    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        problems.append(f"database: {exc.__class__.__name__}")

    status = provider_status()
    if settings.require_llm_provider and not status["real"]:
        problems.append("llm: REQUIRE_LLM_PROVIDER is set and no provider key resolved")

    detail = f"provider={status['provider']} model={status['model'] or '-'}"
    if problems:
        response.status_code = 503
        return {"ready": False, "detail": "; ".join(problems)}
    return {"ready": True, "detail": detail}
