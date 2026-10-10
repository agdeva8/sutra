"""add plan_threads

The ledger that lets a replan find the thread its goal's plan lives on.

A replan re-solves the **checkpointed** task set rather than re-deriving the
plan's meaning (HLD §9.1), so it has to address the thread the plan was produced
on — and `plan_items` cannot stand in for it, because it holds the dates but not
the solver's inputs. It is also the only table in the schema with a timestamp
beside a thread id, which is what makes checkpoint retention expressible at all:
LangGraph's own `checkpoints` tables carry no time column (HLD §11.1).

Additive: one new table, no existing table or column touched.

Revision ID: 20261010_1700_add_plan_threads
Revises:
Create Date: 2026-10-10 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261010_1700_add_plan_threads"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plan_threads",
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("goal_id", sa.String(), nullable=False),
        #: The LangGraph thread the goal's current plan lives on.
        sa.Column("thread_id", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goal_id"], ["goals.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "goal_id"),
    )
    # Retention and the replan lookup both key on the thread, not the goal.
    op.create_index("plan_threads_thread_idx", "plan_threads", ["thread_id"])


def downgrade() -> None:
    op.drop_index("plan_threads_thread_idx", table_name="plan_threads")
    op.drop_table("plan_threads")
