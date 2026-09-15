"""Knowledge base belongs to the user, not to an assistant (v6.0)

С v6.0 база знаний принадлежит пользователю: бэкенд вставляет строку с
assistant_id=NULL и user_id=<владелец> (api/knowledge_base.py), а к ассистентам
она подключается строкой «Pinecone namespace: <ns>» в системном промпте.

Таблица же создавалась, когда БЗ жёстко висела на OpenAI-ассистенте:
 * assistant_id был NOT NULL — создать пользовательскую БЗ не получалось,
   INSERT падал с NotNullViolation;
 * FK стоял с ON DELETE CASCADE — удаление старого OpenAI-ассистента уносило
   с собой базу знаний, которая уже принадлежит пользователю.

Ту же правку идемпотентно делает ensure_pinecone_user_owned() при старте
приложения (app.py) — на проде схему двигает именно она, эта миграция нужна,
чтобы состояние схемы было зафиксировано и в репозитории.

Revision ID: pinecone_user_owned_kb
Revises: None
Create Date: 2026-09-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = 'pinecone_user_owned_kb'
down_revision = None
branch_labels = None
depends_on = None

TABLE = "pinecone_configs"
COLUMN = "assistant_id"


def _column(bind, table: str, column: str):
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return None
    return next((c for c in inspector.get_columns(table) if c["name"] == column), None)


def _assistant_fk(bind):
    """FK на assistant_configs: имя читаем из БД, а не угадываем."""
    inspector = sa.inspect(bind)
    if TABLE not in inspector.get_table_names():
        return None
    for fk in inspector.get_foreign_keys(TABLE):
        if (fk.get("constrained_columns") or []) == [COLUMN] and fk.get("name"):
            return fk
    return None


def _recreate_fk(bind, ondelete: str) -> None:
    fk = _assistant_fk(bind)
    if not fk or not fk.get("referred_table"):
        return
    if (fk.get("options") or {}).get("ondelete", "").upper() == ondelete:
        return
    op.drop_constraint(fk["name"], TABLE, type_="foreignkey")
    op.create_foreign_key(
        fk["name"], TABLE, fk["referred_table"], [COLUMN], ["id"], ondelete=ondelete
    )


def upgrade():
    bind = op.get_bind()
    column = _column(bind, TABLE, COLUMN)
    if column is None:
        return
    if not column.get("nullable", True):
        op.alter_column(TABLE, COLUMN, existing_type=postgresql.UUID(), nullable=True)
    _recreate_fk(bind, "SET NULL")


def downgrade():
    # NOT NULL обратно не возвращаем: в таблице уже могут лежать
    # пользовательские базы знаний с assistant_id=NULL, и ALTER просто упадёт.
    bind = op.get_bind()
    if _column(bind, TABLE, COLUMN) is None:
        return
    _recreate_fk(bind, "CASCADE")
