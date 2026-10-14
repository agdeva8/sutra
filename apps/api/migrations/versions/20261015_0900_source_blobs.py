"""source_blobs: upload bytes kept in the database when no object store is reachable

Revision ID: 20261015_0900_source_blobs
Revises: 20261014_1500_profile_questions
Create Date: 2026-10-15 09:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_0900_source_blobs"
down_revision = "20261014_1500_profile_questions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "source_blobs",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("content_type", sa.String(), nullable=False, server_default="application/octet-stream"),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("source_blobs")
