"""plan_items.item_type / priority / due_time: a to-do is its own kind of row

Revision ID: 20261015_1800_todo_fields
Revises: 20261015_1700_milestone_tree
Create Date: 2026-10-15 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1800_todo_fields"
down_revision = "20261015_1700_milestone_tree"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_items", sa.Column("item_type", sa.String(), nullable=True))
    op.add_column("plan_items", sa.Column("priority", sa.String(), nullable=True))
    op.add_column("plan_items", sa.Column("due_time", sa.Time(), nullable=True))


def downgrade() -> None:
    op.drop_column("plan_items", "due_time")
    op.drop_column("plan_items", "priority")
    op.drop_column("plan_items", "item_type")
