"""calendar_subscriptions: one feed per subscribed calendar, each delinked on its own

Revision ID: 20261015_1100_calendar_subs
Revises: 20261015_1000_source_purpose
Create Date: 2026-10-15 11:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1100_calendar_subs"
down_revision = "20261015_1000_source_purpose"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calendar_subscriptions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(), nullable=False, server_default="My calendar"),
        sa.Column("provider", sa.String(), nullable=False, server_default="other"),
        sa.Column("token", sa.String(), nullable=False, unique=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True)),
        sa.Column("removed_at", sa.DateTime(timezone=True)),
        sa.Column("purge_after", sa.DateTime(timezone=True)),
    )
    op.create_index("calendar_subscriptions_user_idx", "calendar_subscriptions", ["user_id", "created_at"])
    # Existing subscriptions keep working: the same token, now one row among possibly several.
    op.execute(
        """
        INSERT INTO calendar_subscriptions (id, user_id, name, provider, token, status, created_at, last_fetched_at)
        SELECT 'cal_' || substr(md5(random()::text || user_id), 1, 12), user_id, 'Sutra plan', 'other', token,
               'active', created_at, last_fetched_at
        FROM calendar_feeds WHERE token IS NOT NULL
        """
    )
    op.execute("UPDATE calendar_feeds SET token = NULL")


def downgrade() -> None:
    op.drop_index("calendar_subscriptions_user_idx", table_name="calendar_subscriptions")
    op.drop_table("calendar_subscriptions")
