"""goals.plan_status / plan_started_at: whether a goal's schedule is being built, built, or failed

Revision ID: 20261015_2000_plan_status
Revises: 20261015_1900_done_at
Create Date: 2026-10-15 20:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_2000_plan_status"
down_revision = "20261015_1900_done_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("goals", sa.Column("plan_status", sa.String(), nullable=True))
    op.add_column("goals", sa.Column("plan_started_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("goals", "plan_started_at")
    op.drop_column("goals", "plan_status")
