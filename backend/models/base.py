# backend/models/base.py

"""
Defines:
  - SQLAlchemy Base для всех моделей
  - Pydantic BaseModel с настройкой from_attributes (ранее orm_mode)
  - Экспорт движка engine
  - Утилиту create_tables для автоматического создания/обновления таблиц и добавления недостающих колонок
"""

import logging
from sqlalchemy import inspect
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import declarative_base
from backend.db.session import engine  # общий движок из вашего модуля сессии

from pydantic import BaseModel as PydanticBaseModel

logger = logging.getLogger(__name__)

# SQLAlchemy declarative base
Base = declarative_base()

# Pydantic базовая модель для схем, с поддержкой загрузки из ORM-объектов
class BaseModel(PydanticBaseModel):
    model_config = {
        "from_attributes": True,  # позволяет создавать Pydantic-модели из ORM-объектов
    }


def create_tables(engine):
    """
    Создаёт все таблицы по метаданным SQLAlchemy, затем проверяет и
    добавляет в таблицу users недостающие колонки last_login и is_active.
    """
    inspector = inspect(engine)

    try:
        Base.metadata.create_all(engine)
        logger.info("Database tables created/updated successfully")
    except Exception as e:
        logger.error(f"Failed to create/update database tables: {e}")

    # Получаем список существующих колонок в users
    existing = inspector.get_columns("users")
    cols = {col["name"] for col in existing}

    # Открываем соединение для ALTER TABLE
    with engine.connect() as conn:
        if "last_login" not in cols:
            try:
                logger.info("Adding missing column last_login to users table")
                conn.execute(
                    "ALTER TABLE users "
                    "ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                )
            except ProgrammingError as e:
                logger.error(f"Could not add last_login column: {e}")

        if "is_active" not in cols:
            try:
                logger.info("Adding missing column is_active to users table")
                conn.execute(
                    "ALTER TABLE users "
                    "ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                )
            except ProgrammingError as e:
                logger.error(f"Could not add is_active column: {e}")
