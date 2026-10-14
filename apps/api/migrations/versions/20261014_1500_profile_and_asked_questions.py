"""users.profile and messages.questions

`users.profile` holds the "about you" answers asked once in the first-run flow (work or study hours,
wake and sleep, weekly hours for goals, rest days). `messages.questions` keeps the clarifying
questions an assistant turn asked, so the next turn can refuse to ask them again. Both additive.

Revision ID: 20261014_1500_profile_questions
Revises: 20261014_1400_recurring_hours
Create Date: 2026-10-14 15:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261014_1500_profile_questions"
down_revision = "20261014_1400_recurring_hours"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("profile", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column("messages", sa.Column("questions", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "questions")
    op.drop_column("users", "profile")
