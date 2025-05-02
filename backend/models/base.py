# backend/models/base.py

"""
Здесь определяются:
  - SQLAlchemy Declarative Base для всех ORM-моделей
  - Импорт движка подключения (engine) из backend/db/session.py
  - Функция create_tables для автоматического создания/обновления таблиц
    и добавления недостающих колонок в таблицу users (last_login, is_active)
"""

import logging

from sqlalchemy import inspect, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import declarative_base

from backend.db.session import engine  # движок создаётся в backend/db/session.py

logger = logging.getLogger(__name__)

# декларативная база для всех моделей
Base = declarative_base()


def create_tables(bind_engine=None):
    """
    Создаёт все таблицы, описанные в метаданных Base.metadata,
    затем проверяет в таблице users наличие колонок last_login и is_active
    и добавляет их, если их нет.
    """
    bind_engine = bind_engine or engine
    inspector = inspect(bind_engine)

    try:
        Base.metadata.create_all(bind_engine)
        logger.info("Database tables created/updated successfully")
    except Exception as e:
        logger.error(f"Failed to create/update database tables: {e}")

    try:
        existing_cols = {col["name"] for col in inspector.get_columns("users")}
    except Exception:
        existing_cols = set()

    # Работаем в текстовом режиме, т.к. на уровне ORM ALTER TABLE не делают
    with bind_engine.connect() as conn:
        # Добавляем last_login, если нет
        if "last_login" not in existing_cols:
            try:
                logger.info("Adding missing column last_login to users table")
                conn.execute(
                    text(
                        "ALTER TABLE users "
                        "ADD COLUMN last_login TIMESTAMPTZ NULL"
                    )
                )
            except ProgrammingError as e:
                logger.error(f"Could not add last_login column: {e}")

        # Добавляем is_active, если нет
        if "is_active" not in existing_cols:
            try:
                logger.info("Adding missing column is_active to users table")
                conn.execute(
                    text(
                        "ALTER TABLE users "
                        "ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                    )
                )
            except ProgrammingError as e:
                logger.error(f"Could not add is_active column: {e}")
