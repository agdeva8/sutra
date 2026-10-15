"""plan_items.description: the session's own sentence, not the goal's

Revision ID: 20261015_1300_plan_item_desc
Revises: 20261015_1200_user_prefs
Create Date: 2026-10-15 13:00:00

Nullable on purpose: every row written before this column existed has no description, and an older
plan is still a valid plan. Nothing backfills — the text has to come from the model, and inventing one
here would put words in the user's plan that the planner never wrote.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1300_plan_item_desc"
down_revision = "20261015_1200_user_prefs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_items", sa.Column("description", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("plan_items", "description")
