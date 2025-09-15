"""add direct_read_states table

Revision ID: 0004_direct_reads
Revises: 0003_direct_messages
Create Date: 2025-09-15
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0004_direct_reads'
down_revision = '0003_direct_messages'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'direct_read_states',
        sa.Column('owner_id', sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('other_id', sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('last_read_at', sa.DateTime(timezone=False), nullable=False),
        sa.PrimaryKeyConstraint('owner_id', 'other_id', name='pk_direct_read_states')
    )


def downgrade():
    op.drop_table('direct_read_states')
