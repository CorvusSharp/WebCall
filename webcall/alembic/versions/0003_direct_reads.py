"""noop stub to linearize revisions

Revision ID: 0005_direct_reads_stub
Revises: 0004_direct_reads
Create Date: 2025-09-15
"""

from __future__ import annotations

from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401

# revision identifiers, used by Alembic.
revision = '0005_direct_reads_stub'
down_revision = '0004_direct_reads'
branch_labels = None
depends_on = None


def upgrade():
	# No-op: this stub exists only to resolve previously duplicated migration filenames.
	pass


def downgrade():
	# No-op stub downgrade.
	pass
