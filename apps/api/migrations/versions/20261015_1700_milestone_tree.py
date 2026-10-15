"""milestones.parent_id / hours and plan_items.milestone_id: the goal's facet breakdown

Revision ID: 20261015_1700_milestone_tree
Revises: 20261015_1600_done_hours
Create Date: 2026-10-15 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1700_milestone_tree"
down_revision = "20261015_1600_done_hours"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("milestones", sa.Column("parent_id", sa.String(), sa.ForeignKey("milestones.id", ondelete="SET NULL"), nullable=True))
    op.add_column("milestones", sa.Column("hours", sa.Float(), nullable=True))
    op.add_column("plan_items", sa.Column("milestone_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("plan_items", "milestone_id")
    op.drop_column("milestones", "hours")
    op.drop_column("milestones", "parent_id")
