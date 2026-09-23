"""Add personal data consent columns to users (152-ФЗ, отдельное согласие)

Revision ID: add_user_pd_consent
Revises: add_user_onboarding
Create Date: 2026-09-23 12:00:00.000000

Отметка ставится при регистрации (/static/consent.html), пишется в
backend/api/auth.py. Дублируется ensure_user_pd_consent_columns() в app.py.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_user_pd_consent'
down_revision = 'add_user_onboarding'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_at TIMESTAMPTZ")
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_version VARCHAR(20)")
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS pd_consent_ip VARCHAR(64)")


def downgrade() -> None:
    op.drop_column('users', 'pd_consent_ip')
    op.drop_column('users', 'pd_consent_version')
    op.drop_column('users', 'pd_consent_at')
