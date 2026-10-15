"""plan_items.done_hours: how much of a session is finished when it was only part done

Revision ID: 20261015_1600_done_hours
Revises: 20261015_1500_goal_progress
Create Date: 2026-10-15 16:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1600_done_hours"
down_revision = "20261015_1500_goal_progress"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_items", sa.Column("done_hours", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("plan_items", "done_hours")
