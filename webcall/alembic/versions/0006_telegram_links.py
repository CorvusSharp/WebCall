"""telegram links table

Revision ID: 0006_telegram_links
Revises: 0005_add_user_public_key
Create Date: 2025-09-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = '0006_telegram_links'
# Исправлено: корректный предыдущий revision.
down_revision = '0005_add_user_public_key'
branch_labels = None
depends_on = None


def upgrade():
    # Идемпотентность: если таблица уже существует (например, применяли вручную), просто выходим.
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if 'telegram_links' in inspector.get_table_names():
        # Убедимся что недостающие индексы/констрейнты созданы (проверка по именам)
        existing_indexes = {ix['name'] for ix in inspector.get_indexes('telegram_links')}
        if 'ix_telegram_links_chat_id' not in existing_indexes:
            op.create_index('ix_telegram_links_chat_id', 'telegram_links', ['chat_id'])
        # Для уникального констрейнта проверяем pg catalog через простой запрос
        res = conn.execute(sa.text("""
            SELECT conname FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname = 'telegram_links' AND conname = 'uq_user_chat_once'
        """)).fetchone()
        if not res:
            op.create_unique_constraint('uq_user_chat_once', 'telegram_links', ['user_id', 'chat_id'])
        return

    op.create_table(
        'telegram_links',
        sa.Column('user_id', sa.dialects.postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('token', sa.String(length=64), primary_key=True),
        sa.Column('chat_id', sa.String(length=64), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_telegram_links_chat_id', 'telegram_links', ['chat_id'])
    op.create_unique_constraint('uq_user_chat_once', 'telegram_links', ['user_id', 'chat_id'])

def downgrade():
    op.drop_constraint('uq_user_chat_once', 'telegram_links', type_='unique')
    op.drop_index('ix_telegram_links_chat_id', table_name='telegram_links')
    op.drop_table('telegram_links')
