"""plan_items.done_at: when an item was ticked, so an undated done to-do stays on that day only

Revision ID: 20261015_1900_done_at
Revises: 20261015_1800_todo_fields
Create Date: 2026-10-15 19:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1900_done_at"
down_revision = "20261015_1800_todo_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_items", sa.Column("done_at", sa.DateTime(timezone=True), nullable=True))
    # Items already done have no tick time; their creation time is the best stand-in, and it keeps old
    # undated done to-dos off today.
    op.execute("UPDATE plan_items SET done_at = created_at WHERE status = 'done' AND done_at IS NULL")


def downgrade() -> None:
    op.drop_column("plan_items", "done_at")
