"""add calendar_feeds

The subscribable .ics feed per user. Additive: one new table.

Revision ID: 20261014_1200_add_calendar_feeds
Revises: 20261014_1100_add_scratch
Create Date: 2026-10-14 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261014_1200_add_calendar_feeds"
down_revision = "20261014_1100_add_scratch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calendar_feeds",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("token", sa.String(), nullable=True),
        sa.Column("prompted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("user_id", name="calendar_feeds_pkey"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="calendar_feeds_user_id_fkey", ondelete="CASCADE"),
        sa.UniqueConstraint("token", name="calendar_feeds_token_key"),
    )


def downgrade() -> None:
    op.drop_table("calendar_feeds")
