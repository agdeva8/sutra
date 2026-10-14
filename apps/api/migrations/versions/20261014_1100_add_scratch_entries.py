"""add scratch_entries

The durable inbox behind Scratch. Additive: one new table.

Revision ID: 20261014_1100_add_scratch
Revises: 20261014_1000_add_reminders
Create Date: 2026-10-14 11:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261014_1100_add_scratch"
down_revision = "20261014_1000_add_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scratch_entries",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("question", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="scratch_entries_pkey"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="scratch_entries_user_id_fkey", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"], name="scratch_entries_source_id_fkey", ondelete="SET NULL"),
    )
    op.create_index("scratch_entries_user_status_idx", "scratch_entries", ["user_id", "status", "created_at"])


def downgrade() -> None:
    op.drop_index("scratch_entries_user_status_idx", table_name="scratch_entries")
    op.drop_table("scratch_entries")
