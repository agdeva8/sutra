"""add reminders; let a proposal exist without a chat message

Two additive changes for the agentv2 gateway:

* `reminders` — the agent's reminder bucket (prescriptions, recurring nudges).
* `proposals.message_id` and `.conversation_id` become nullable, so a proposal
  raised from a Scratch entry has somewhere to live. Relaxing NOT NULL never
  invalidates an existing row.

Revision ID: 20261014_1000_add_reminders
Revises: 20261010_1700_add_plan_threads
Create Date: 2026-10-14 10:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20261014_1000_add_reminders"
down_revision = "20261010_1700_add_plan_threads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("days", postgresql.JSONB(), nullable=False),
        sa.Column("times", postgresql.JSONB(), nullable=False),
        sa.Column("source", sa.String(), nullable=False, server_default="manual"),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="reminders_pkey"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="reminders_user_id_fkey", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], name="reminders_goal_id_fkey", ondelete="SET NULL"),
    )
    op.create_index("reminders_user_idx", "reminders", ["user_id", "created_at"])
    op.alter_column("proposals", "message_id", existing_type=sa.String(), nullable=True)
    op.alter_column("proposals", "conversation_id", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    # Re-tightening fails if any agent-raised proposal exists; that is correct, it
    # would orphan them. Delete those rows first if you really mean to go back.
    op.alter_column("proposals", "conversation_id", existing_type=sa.String(), nullable=False)
    op.alter_column("proposals", "message_id", existing_type=sa.String(), nullable=False)
    op.drop_index("reminders_user_idx", table_name="reminders")
    op.drop_table("reminders")
