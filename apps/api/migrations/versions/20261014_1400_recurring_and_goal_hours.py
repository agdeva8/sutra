"""recurring_blocks; goals.total_hours

Two additive changes:

* `recurring_blocks`: a commitment that repeats until stopped. Its occurrences are ordinary
  `timetable_blocks` rows, so nothing that reads the calendar changes.
* `goals.total_hours`: the effort a goal needs, so progress (hours done against hours needed) can feed
  back into what is planned. Nullable: existing goals simply have no total.

Revision ID: 20261014_1400_recurring_hours
Revises: 20261014_1200_scratch_tz
Create Date: 2026-10-14 14:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261014_1400_recurring_hours"
down_revision = "20261014_1200_scratch_tz"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recurring_blocks",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("weekdays", postgresql.JSONB(), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=False),
        sa.Column("end_time", sa.Time(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="recurring_blocks_pkey"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="recurring_blocks_user_id_fkey", ondelete="CASCADE"),
    )
    op.create_index("recurring_blocks_user_idx", "recurring_blocks", ["user_id", "end_date"])
    op.add_column("goals", sa.Column("total_hours", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("goals", "total_hours")
    op.drop_index("recurring_blocks_user_idx", table_name="recurring_blocks")
    op.drop_table("recurring_blocks")
