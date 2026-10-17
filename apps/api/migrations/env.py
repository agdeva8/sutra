"""Alembic environment — async engine, URL from settings, metadata from models.

Three decisions worth stating:

* **The URL comes from `settings.ddl_url`**, which prefers an unpooled
  connection. DDL must not share a session with application traffic, and against
  a transaction-mode pooler it would also collide on prepared statements.
* **`target_metadata` is the real `Base.metadata`**, so autogenerate diffs
  against the models rather than a second declaration of the schema. Importing
  `sutra_api.models` is what registers all 21 tables on the metadata — without
  that import, autogenerate would cheerfully emit a migration dropping
  everything.
* **`compare_type=True`** so a changed column type is a diff rather than a
  silent no-op, which is how a `String` quietly stops being long enough.
"""
from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from sutra_api.config import settings
from sutra_api.db import Base, pooler_safe_connect_args

# Imported for its side effect: registering every table on `Base.metadata`.
# Autogenerate without this produces a migration that drops the whole schema.
import sutra_api.models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# The .ini's `sqlalchemy.url` is intentionally blank — see the file's header.
# configparser treats "%" as interpolation, and a URL-encoded password is full of them.
config.set_main_option("sqlalchemy.url", settings.ddl_url.replace("%", "%%"))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL to stdout, with no connection. Used to review a change as text."""
    context.configure(
        url=settings.ddl_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        # The same pooler-safe settings as the app: a migration URL may point at Supabase's
        # transaction pooler, where asyncpg's default statement names collide between clients.
        connect_args=pooler_safe_connect_args(),
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
