"""Add board_version and calendar_blocks table.

Revision ID: 20261017_0900_board_blocks (27 chars ≤ 32 ✓)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261017_0900_board_blocks"
down_revision = "20261015_2000_plan_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # board_version on users
    op.add_column("users", sa.Column("board_version", sa.Integer(), nullable=False, server_default="0"))

    # calendar_blocks — the four-kind block table
    op.create_table(
        "calendar_blocks",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("block_kind", sa.String(), nullable=False),  # event | task | away | milestone
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("data", JSONB(), nullable=False),  # full block as JSON
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("cal_blocks_user_idx", "calendar_blocks", ["user_id"])
    op.create_index("cal_blocks_kind_idx", "calendar_blocks", ["user_id", "block_kind"])


def downgrade() -> None:
    op.drop_table("calendar_blocks")
    op.drop_column("users", "board_version")
