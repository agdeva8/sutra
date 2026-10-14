"""sources.purpose: keep Memories photos out of the Sources list

Revision ID: 20261015_1000_source_purpose
Revises: 20261015_0900_source_blobs
Create Date: 2026-10-15 10:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20261015_1000_source_purpose"
down_revision = "20261015_0900_source_blobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("purpose", sa.String(), nullable=False, server_default="source"))
    # Photos already pinned as memories were uploaded as plain sources: reclassify them.
    op.execute(
        "UPDATE sources SET purpose = 'memory' WHERE id IN (SELECT source_id FROM memories WHERE source_id IS NOT NULL)"
    )


def downgrade() -> None:
    op.drop_column("sources", "purpose")
