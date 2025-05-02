"""
backend/models/base.py

Базовый модуль для SQLAlchemy-моделей:
- объявляет движок `engine`
- декларативный базовый класс `Base`
- миксин `BaseModel` с to_dict()
- функцию create_tables() с простыми миграциями
"""

import os
import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import declarative_base

logger = logging.getLogger(__name__)

# URL базы берётся из окружения
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set")

# создаём движок
engine = create_engine(DATABASE_URL, future=True)
logger.info(f"Database engine created for {DATABASE_URL}")

# декларативный базовый класс
Base = declarative_base()

class BaseModel:
    """
    Миксин для SQLAlchemy-моделей, добавляет метод to_dict().
    Не наследует Pydantic.BaseModel, чтобы избежать конфликтов метаклассов.
    """
    def to_dict(self):
        return {col.name: getattr(self, col.name) for col in self.__table__.columns}

def create_tables(engine):
    """
    Создаёт таблицы (если их нет) и добавляет в users отсутствующие колонки:
      - last_login (TIMESTAMP WITH TIME ZONE)
      - is_active  (BOOLEAN NOT NULL DEFAULT TRUE)
    """
    # 1) Создаём все таблицы по описанным моделям
    Base.metadata.create_all(engine)
    logger.info("Database tables created successfully")

    # 2) Простая «ручная» миграция
    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    if "users" not in existing_tables:
        # если таблицы users ещё нет, мигрировать нечего
        return

    # получаем имена колонок в users
    existing_columns = {col["name"] for col in inspector.get_columns("users")}

    with engine.begin() as conn:
        try:
            if "last_login" not in existing_columns:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                ))
                logger.info("Added missing column last_login to users")

            if "is_active" not in existing_columns:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                ))
                logger.info("Added missing column is_active to users")

        except SQLAlchemyError as e:
            logger.error(f"Failed to create/update database tables: {e}")
            raise  # чтобы приложение не стартовало с неконсистентной схемой

    logger.info("Database tables updated successfully")
