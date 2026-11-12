"""ручной режим контакта: agent_contacts.handoff_*, sender у сообщений мессенджеров

Revision ID: add_agent_handoff
Revises: add_kb_chunks

То же самое идемпотентно делает ensure_agent_handoff_columns на старте приложения.
"""
from alembic import op

revision = 'add_agent_handoff'
down_revision = 'add_kb_chunks'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE agent_contacts ADD COLUMN IF NOT EXISTS handoff_until TIMESTAMP")
    op.execute("ALTER TABLE agent_contacts ADD COLUMN IF NOT EXISTS handoff_since TIMESTAMP")
    op.execute("ALTER TABLE agent_contacts ADD COLUMN IF NOT EXISTS handoff_source VARCHAR(20)")
    op.execute("ALTER TABLE agent_telegram_messages ADD COLUMN IF NOT EXISTS sender VARCHAR(16)")
    op.execute("ALTER TABLE agent_max_messages ADD COLUMN IF NOT EXISTS sender VARCHAR(16)")


def downgrade():
    op.execute("ALTER TABLE agent_contacts DROP COLUMN IF EXISTS handoff_until")
    op.execute("ALTER TABLE agent_contacts DROP COLUMN IF EXISTS handoff_since")
    op.execute("ALTER TABLE agent_contacts DROP COLUMN IF EXISTS handoff_source")
    op.execute("ALTER TABLE agent_telegram_messages DROP COLUMN IF EXISTS sender")
    op.execute("ALTER TABLE agent_max_messages DROP COLUMN IF EXISTS sender")
