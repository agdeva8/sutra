"""The app — one FastAPI service, mounted under `/api`.

## Why `/api`

`apps/web` calls `/api/state`, `/api/auth/me`, and so on: `api.js` sets
`API = ${BACKEND_URL}/api` and every path hangs off it. The OpenAPI spec lists
its paths *relative to that mount* (`/state`, not `/api/state`) and gives `/` as
its server, so the mount point is the one thing the spec leaves implicit. It is
`settings.api_prefix`, defaulting to `/api`, so a deployment that strips the
prefix in a proxy can set it to `""` without touching a route.

`/health` and `/ready` are registered at **both** the root and the prefix.
Probes usually hit the root and do not know about a mount point, while the
frontend's own health widget uses the prefixed path.

## Middleware order

`add_middleware` composes in reverse — the last one added runs first. The CSRF
origin check is added **last** so it runs before CORS: a forged request should be
refused on its own merits, not after CORS has already helped the browser decide
whether to expose the response.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from agentv2 import ModelUnavailable
from fastapi.responses import JSONResponse

from .api import (
    agent_goals,
    audit,
    auth,
    blockers,
    calendar,
    chat,
    cron,
    daily_log,
    goals,
    memories,
    motivation,
    ops,
    plan_items,
    preferences,
    scratch,
    sources,
    state,
    timetable,
    tools,
)
from .api import plan as plan_routes
from .config import settings
from .db import create_engine, dispose_engine, install_engine
from .security import MUTATING_METHODS, origin_is_same_site

TITLE = "GoalCoach API"
VERSION = "2.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the engine, start the Scratch recovery loop, and close both."""
    install_engine(create_engine())
    # Entries stranded by a restart are picked up again by a loop that lives as long as the app.
    from .scratch_service import recovery_loop

    # Serverless hosts freeze between requests, so a loop cannot live there; `/cron/reap` does the same job.
    recovery = None if settings.background_inline else asyncio.create_task(recovery_loop())
    try:
        yield
    finally:
        if recovery is not None:
            recovery.cancel()
        await dispose_engine()


def _origin_guard(request: Request) -> JSONResponse | None:
    """Refuse a cross-site mutating request. Returns a response to send, or None.

    This is the substitute for a CSRF token. The spec's own note
    (`x-contract-notes#no-csrf-token`) records that v1 had none, that the spec
    cannot express an origin check, and that the server must therefore enforce
    one. `SameSite=Lax` is the second layer, not a replacement — Lax still
    permits a top-level cross-site POST in older browsers.
    """
    if request.method not in MUTATING_METHODS:
        return None
    path = request.url.path
    if path.endswith("/health") or path.endswith("/ready"):
        return None
    if origin_is_same_site(request):
        return None
    return JSONResponse(status_code=403, content={"detail": "Cross-site request refused"})


def create_app() -> FastAPI:
    app = FastAPI(
        title=TITLE,
        version=VERSION,
        lifespan=lifespan,
        # The frontend calls exact paths; a redirect would turn a POST into a
        # 307 the client does not follow. See
        # `x-contract-notes#empty-path-registration`.
        redirect_slashes=False,
    )

    prefix = settings.api_prefix

    @app.exception_handler(ModelUnavailable)
    async def _no_model(_request: Request, _exc: ModelUnavailable) -> JSONResponse:
        # No model key is a configuration problem, not a crash: say so, and let the client retry later.
        return JSONResponse(status_code=503, content={"detail": "The assistant isn't available right now."})

    @app.middleware("http")
    async def _csrf(request: Request, call_next):
        blocked = _origin_guard(request)
        return blocked if blocked is not None else await call_next(request)

    if settings.cors_allowed_origins:
        # Added *before* the CSRF middleware so CSRF runs first — see the module
        # docstring on ordering.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type", "Authorization", "Cookie", "X-Requested-With"],
            expose_headers=["Set-Cookie"],
            max_age=86400,
        )

    # Order is cosmetic — these paths do not overlap — but it follows the spec's
    # tag order so this list can be read against `openapi.yaml` line by line.
    for module in (
        ops,
        auth,
        preferences,
        state,
        agent_goals,
        goals,
        plan_items,
        blockers,
        timetable,
        sources,
        memories,
        motivation,
        audit,
        daily_log,
        tools,
        chat,
        plan_routes,
        scratch,
        calendar,
        cron,
    ):
        app.include_router(module.router, prefix=prefix)

    # Bare probes at the root, for infrastructure that does not know the mount.
    if prefix:
        app.include_router(ops.router)

    return app


app = create_app()
