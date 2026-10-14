"""scratch_entries.tz

The user's timezone when they wrote the entry, so a note that is filed a moment
later (in the background) still resolves "today" and "thursday" where they are.
Additive and nullable.

Revision ID: 20261014_1200_scratch_tz
Revises: 20261014_1200_add_calendar_feeds
Create Date: 2026-10-14 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261014_1200_scratch_tz"
down_revision = "20261014_1200_add_calendar_feeds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("scratch_entries", sa.Column("tz", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("scratch_entries", "tz")
