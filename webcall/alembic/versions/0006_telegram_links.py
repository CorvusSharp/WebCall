"""telegram links table

Revision ID: 0006_telegram_links
Revises: 0005_add_user_public_key
Create Date: 2025-09-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = '0006_telegram_links'
down_revision = '0005_add_user_public_key'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'telegram_links',
        sa.Column('user_id', sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('token', sa.String(length=64), primary_key=True),
        sa.Column('chat_id', sa.String(length=64), nullable=True, index=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=False), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=False), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=False), nullable=True),
    )
    op.create_unique_constraint('uq_user_chat_once', 'telegram_links', ['user_id', 'chat_id'])


def downgrade():
    op.drop_constraint('uq_user_chat_once', 'telegram_links', type_='unique')
    op.drop_table('telegram_links')
