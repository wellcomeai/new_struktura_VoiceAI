"""Add telegram_owner_ids (JSONB) to agent_configs — владельцы бота агента

Revision ID: add_agent_telegram_owner_ids
Revises: add_agent_call_record_url
Create Date: 2026-11-12 12:00:00.000000

Telegram ID пользователей, чьи команды бот агента выполняет полностью; остальные —
гостевой режим (backend/services/agent_telegram_service.py). Пустой список — все
владельцы (как раньше). Дублируется ensure_agent_telegram_owner_ids_column() в app.py.
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_agent_telegram_owner_ids'
down_revision = 'add_agent_call_record_url'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS "
        "telegram_owner_ids JSONB NOT NULL DEFAULT '[]'::jsonb"
    )


def downgrade() -> None:
    op.drop_column('agent_configs', 'telegram_owner_ids')
