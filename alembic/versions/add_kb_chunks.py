"""kb_chunks: база знаний в собственном Postgres (pgvector)

Revision ID: add_kb_chunks
Revises: add_agent_telegram_owner_ids

То же самое идемпотентно делает kb_store.ensure_table на старте приложения.
"""
from alembic import op

revision = 'add_kb_chunks'
down_revision = 'add_agent_telegram_owner_ids'
branch_labels = None
depends_on = None


def upgrade():
    from backend.services.kb_store import TABLE_SQL
    for sql in TABLE_SQL:
        op.execute(sql)


def downgrade():
    op.execute("DROP TABLE IF EXISTS kb_chunks")
