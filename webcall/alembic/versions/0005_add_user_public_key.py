"""add public_key to users

Revision ID: 0005_add_user_public_key
Revises: 0004_direct_reads
Create Date: 2025-09-16 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0005_add_user_public_key'
down_revision = '0004_direct_reads'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('public_key', sa.String(length=2000), nullable=True))


def downgrade():
    op.drop_column('users', 'public_key')
