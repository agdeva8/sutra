"""The LangGraph checkpointer — durable interrupts across HTTP requests.

This is what makes the clarify interrupt survive a reload, a deploy, and a
different server process: `thread_id` is the conversation id, so the graph state
for a paused plan lives in Postgres, not in the process that happened to serve
the first request.

Two v1 lessons are kept **verbatim**, because both cost real debugging time:

1. **Call `.setup()` where the saver is built, not only in the app lifespan.**
   Tests and scripts reach a saver without running lifespan, and an un-setup
   saver fails on the first read with `relation "checkpoints" does not exist`.
2. **Rebuild the pool when the event loop changes.** psycopg's async pool binds
   asyncio primitives to one loop; reusing it from a second loop (a test, or a
   second `asyncio.run`) hangs rather than erroring, which is a far worse
   failure to diagnose.

`prepare_threshold=None` is also carried over: with the default, psycopg
auto-prepares statements after five executions, which breaks against Supabase's
transaction-mode pooler because a prepared statement is bound to one server
session and the pooler multiplexes them.

Without `DATABASE_URL` this degrades to `InMemorySaver`, so the graph runs for
tests and for the offline stub with no database at all.
"""
from __future__ import annotations

import asyncio
from typing import Any

from ..config import settings

#: The event loop the cached saver was built on. A mismatch means rebuild.
_bound_loop: asyncio.AbstractEventLoop | None = None
_saver: Any = None
_pool: Any = None


async def get_checkpointer() -> Any:
    """The process-wide saver, rebuilt if the running loop has changed."""
    global _bound_loop, _saver, _pool

    loop = asyncio.get_running_loop()
    if _saver is not None and _bound_loop is loop:
        return _saver

    await _close()

    if not settings.ddl_url:
        from langgraph.checkpoint.memory import InMemorySaver

        _saver = InMemorySaver()
    else:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        from psycopg_pool import AsyncConnectionPool

        # psycopg speaks `postgresql://`; the `+asyncpg` suffix is SQLAlchemy's
        # dialect marker and psycopg rejects it.
        url = settings.ddl_url.replace("postgresql+asyncpg://", "postgresql://")
        _pool = AsyncConnectionPool(
            conninfo=url,
            open=False,
            kwargs={"autocommit": True, "prepare_threshold": None},
        )
        await _pool.open()
        _saver = AsyncPostgresSaver(_pool)
        # Idempotent, and called here rather than only in lifespan — see the
        # module docstring.
        await _saver.setup()

    _bound_loop = loop
    return _saver


async def _close() -> None:
    global _saver, _pool, _bound_loop
    if _pool is not None:
        try:
            await _pool.close()
        except Exception:  # pragma: no cover - closing a pool must never raise
            pass
    _pool = None
    _saver = None
    _bound_loop = None


async def close_checkpointer() -> None:
    """Called from the app lifespan on shutdown."""
    await _close()
