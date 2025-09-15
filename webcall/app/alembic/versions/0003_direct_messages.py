"""add direct_messages table

Revision ID: 0003_direct_messages
Revises: 0002_friends_push
Create Date: 2025-09-15
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0003_direct_messages'
down_revision = '0002_friends_push'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        'direct_messages',
        sa.Column('id', sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_a_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column('user_b_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column('sender_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column('ciphertext', sa.Text(), nullable=False),
        sa.Column('sent_at', sa.DateTime(timezone=False), nullable=False, index=True),
    )
    # Индекс для пар (user_a_id, user_b_id, sent_at) для быстрых выборок истории
    op.create_index('ix_direct_pair_sent_at', 'direct_messages', ['user_a_id', 'user_b_id', 'sent_at'])


def downgrade() -> None:
    op.drop_index('ix_direct_pair_sent_at', table_name='direct_messages')
    op.drop_table('direct_messages')
