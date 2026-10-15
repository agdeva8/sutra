"""goal_progress: the progress judge's latest verdict per goal

Revision ID: 20261015_1500_goal_progress
Revises: 20261015_1400_plan_why
Create Date: 2026-10-15 15:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261015_1500_goal_progress"
down_revision = "20261015_1400_plan_why"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "goal_progress",
        sa.Column("goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("digest", sa.String(), nullable=False),
        sa.Column("verdict", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("goal_progress_user_idx", "goal_progress", ["user_id"])


def downgrade() -> None:
    op.drop_index("goal_progress_user_idx", table_name="goal_progress")
    op.drop_table("goal_progress")
