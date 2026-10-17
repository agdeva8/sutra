"""Add the agent_jobs queue.

Revision ID: 20261017_1400_agent_jobs (24 chars ≤ 32 ✓)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261017_1400_agent_jobs"
down_revision = "20261017_0900_board_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),  # queued | running | done | failed
        # SET NULL, not CASCADE: a dropped goal should not erase the audit trail of jobs that
        # already ran against it.
        sa.Column("goal_id", sa.String(), sa.ForeignKey("goals.id", ondelete="SET NULL")),
        sa.Column("dedupe_key", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("run_after", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("progress", sa.Text(), nullable=False, server_default=""),
        sa.Column("result", JSONB()),
        sa.Column("error", sa.Text()),
        sa.Column("audit_id", sa.String()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # One queued job per (user, work item): a double tap queues one job, while a job that has
    # started no longer blocks a genuinely new request.
    op.create_index(
        "agent_jobs_queued_dedupe_idx",
        "agent_jobs",
        ["user_id", "dedupe_key"],
        unique=True,
        postgresql_where=sa.text("status = 'queued'"),
    )
    # At most one running job per user, enforced by the database: two claims racing for the same user
    # (the app's /jobs/run and the cron drain) cannot both start, so two re-plans never undo each other.
    op.create_index(
        "agent_jobs_one_running_idx",
        "agent_jobs",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
    )
    op.create_index("agent_jobs_claim_idx", "agent_jobs", ["status", "run_after"])
    op.create_index("agent_jobs_user_status_idx", "agent_jobs", ["user_id", "status"])


def downgrade() -> None:
    op.drop_table("agent_jobs")
