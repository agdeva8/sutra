"""Run work that should not delay the response.

On a long-lived server that is a FastAPI background task. On a serverless host the process is frozen
as soon as the response goes out, so the same work runs inside the request (`BACKGROUND_INLINE=true`).
Callers use `run_after` and do not care which.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import BackgroundTasks

from .config import settings


async def run_after(background: BackgroundTasks, fn: Callable[..., Awaitable[None]], *args) -> None:
    if settings.background_inline:
        await fn(*args)
    else:
        background.add_task(fn, *args)
