"""Add memory (JSONB) column to agent_configs — память самого агента

Revision ID: add_agent_memory
Revises: add_agent_knowledge_base
Create Date: 2026-09-19 12:00:00.000000

Формат и операции над памятью — backend/services/agent_memory.py.
Дублируется идемпотентной проверкой ensure_agent_memory_column() в app.py.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_agent_memory'
down_revision = 'add_agent_knowledge_base'
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    exists = connection.execute(sa.text("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'agent_configs' AND column_name = 'memory'
        );
    """)).scalar()
    if not exists:
        op.execute(
            "ALTER TABLE agent_configs ADD COLUMN memory JSONB NOT NULL DEFAULT '{}'::jsonb"
        )


def downgrade() -> None:
    op.drop_column('agent_configs', 'memory')
