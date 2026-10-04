"""Add record_url column to agent_calls — ссылка на аудиозапись звонка агента

Revision ID: add_agent_call_record_url
Revises: add_user_pd_consent
Create Date: 2026-09-25 12:00:00.000000

Заполняется PostCallOrchestrator из conversations.client_info["record_url"].
Дублируется идемпотентной проверкой ensure_agent_call_record_url_column() в app.py.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_agent_call_record_url'
down_revision = 'add_user_pd_consent'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE agent_calls ADD COLUMN IF NOT EXISTS record_url TEXT")


def downgrade() -> None:
    op.drop_column('agent_calls', 'record_url')
