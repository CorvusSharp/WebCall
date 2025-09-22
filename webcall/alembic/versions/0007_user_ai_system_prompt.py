"""user ai_system_prompt

Revision ID: 0007_user_ai_system_prompt
Revises: 0006_telegram_links
Create Date: 2025-09-22 00:00:00.000001
"""
from alembic import op
import sqlalchemy as sa

revision = '0007_user_ai_system_prompt'
down_revision = '0006_telegram_links'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('users', sa.Column('ai_system_prompt', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('users', 'ai_system_prompt')
