"""The async engine, the session factory, and the declarative base.

One engine per process, created in the app lifespan and disposed on shutdown.
Tests override `get_session` rather than the engine, so nothing here needs to be
monkeypatched.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime

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
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        connect_args={"statement_cache_size": 0},
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
