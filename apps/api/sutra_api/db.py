"""The async engine, the session factory, and the declarative base.

One engine per process, created in the app lifespan and disposed on shutdown.
Tests override `get_session` rather than the engine, so nothing here needs to be
monkeypatched.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, MetaData, func
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings

#: Explicit naming convention so Alembic autogenerate emits stable constraint
#: names. Without it, an unnamed constraint is dropped and re-added under a
#: different generated name on every migration.
NAMING_CONVENTION = {
    "ix": "%(column_0_N_name)s_idx",
    "uq": "%(table_name)s_%(column_0_N_name)s_key",
    "ck": "%(table_name)s_%(constraint_name)s_check",
    "fk": "%(table_name)s_%(column_0_name)s_fkey",
    "pk": "%(table_name)s_pkey",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Timestamped:
    """`created_at` / `updated_at`, in UTC, set by the application.

    v1 has **no triggers** — `updated_at` is the app's job on every UPDATE
    (Drizzle's `.defaultNow()` fires on INSERT only). `onupdate` reproduces that
    for ORM writes; raw `UPDATE` statements must set it explicitly, which is why
    the repo layer goes through the ORM.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


#: Kept connections older than this are replaced at checkout, below Supabase's idle-connection cut-off.
POOL_RECYCLE_S = 300


def pooler_safe_connect_args() -> dict:
    """asyncpg settings that work through Supabase's transaction pooler as well as a session or direct
    connection: no statement cache on either side, and a unique name for every prepared statement.

    The pooler hands one server connection to many clients in turn. asyncpg's default names
    (`__asyncpg_stmt_1__`, `_2__`, …) restart in every client, so two clients meeting on one server
    connection collide: "prepared statement __asyncpg_stmt_1__ already exists". That is the
    deploy failure of 2026-10-17, when the migration's URL pointed at the transaction pooler.
    This is SQLAlchemy's documented recipe for PgBouncer.
    """
    return {
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
        "prepared_statement_name_func": lambda: f"__asyncpg_{uuid4()}__",
    }


def create_engine(url: str | None = None) -> AsyncEngine:
    """Build the engine.

    `statement_cache_size=0` is carried over from v1 deliberately. Local Docker
    Postgres does not need it, but v1's production target was Supabase's
    transaction-mode pooler, where asyncpg's prepared-statement cache collides
    across multiplexed server sessions. Keeping the setting means pointing this
    at the pooler later is a config change, not a bug hunt.
    """
    return create_async_engine(
        url or settings.database_url,
        echo=False,
        # A pre-ping is an extra round trip on EVERY checkout. On a serverless host the pooler (pgbouncer)
        # already owns connection health and the instance is short-lived, so it is pure latency there.
        # `pool_recycle` bounds the age of a kept connection instead.
        pool_pre_ping=not settings.is_serverless,
        pool_recycle=POOL_RECYCLE_S,
        pool_size=5,
        max_overflow=5,
        connect_args=pooler_safe_connect_args(),
    )


def install_engine(engine: AsyncEngine) -> None:
    """Bind the process-wide engine. Called from the app lifespan."""
    global _engine, _sessionmaker
    _engine = engine
    _sessionmaker = async_sessionmaker(engine, expire_on_commit=False)


def get_engine() -> AsyncEngine:
    if _engine is None:
        # Lazy so scripts and tests reach a session without running lifespan.
        install_engine(create_engine())
    assert _engine is not None
    return _engine


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request, committed by the route."""
    if _sessionmaker is None:
        get_engine()
    assert _sessionmaker is not None
    async with _sessionmaker() as session:
        yield session


def session_scope() -> AsyncSession:
    """A standalone session for code that runs outside a request (e.g. storage). Use as `async with`."""
    if _sessionmaker is None:
        get_engine()
    assert _sessionmaker is not None
    return _sessionmaker()
