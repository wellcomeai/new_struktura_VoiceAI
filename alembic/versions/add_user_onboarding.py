"""Обязательный онбординг: users.onboarding_completed_at, test_number_leases.is_onboarding

Revision ID: add_user_onboarding
Revises: add_agent_memory
Create Date: 2026-09-19 18:00:00.000000

Существующим пользователям onboarding_completed_at проставляется сразу:
сценарий «создай ассистента → позвони ему» обязателен только для новых.
Дублируется идемпотентной проверкой ensure_onboarding_columns() в app.py.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_user_onboarding'
down_revision = 'add_agent_memory'
branch_labels = None
depends_on = None


def _has_column(connection, table, column) -> bool:
    return bool(connection.execute(sa.text("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = :t AND column_name = :c
        );
    """), {"t": table, "c": column}).scalar())


def upgrade() -> None:
    connection = op.get_bind()
    if not _has_column(connection, 'users', 'onboarding_completed_at'):
        op.execute("ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMPTZ NULL")
        op.execute("UPDATE users SET onboarding_completed_at = NOW() WHERE onboarding_completed_at IS NULL")
    if not _has_column(connection, 'test_number_leases', 'is_onboarding'):
        op.execute("ALTER TABLE test_number_leases ADD COLUMN is_onboarding BOOLEAN NOT NULL DEFAULT FALSE")


def downgrade() -> None:
    op.drop_column('test_number_leases', 'is_onboarding')
    op.drop_column('users', 'onboarding_completed_at')
