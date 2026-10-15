"""plan_items.why and timetable_blocks.why: the planner's reason, shown when an item is opened

Revision ID: 20261015_1400_plan_why
Revises: 20261015_1300_plan_item_desc
Create Date: 2026-10-15 14:00:00

Nullable on purpose, like `description`: older rows have no reason and nothing backfills one, because
a reason invented here would be words the planner never wrote.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1400_plan_why"
down_revision = "20261015_1300_plan_item_desc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_items", sa.Column("why", sa.String(), nullable=True))
    op.add_column("timetable_blocks", sa.Column("why", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("timetable_blocks", "why")
    op.drop_column("plan_items", "why")
