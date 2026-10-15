"""users.preferences: theme and text size that follow the account

Revision ID: 20261015_1200_user_prefs
Revises: 20261015_1100_calendar_subscriptions
Create Date: 2026-10-15 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261015_1200_user_prefs"
down_revision = "20261015_1100_calendar_subs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("preferences", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("users", "preferences")
