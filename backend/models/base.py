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

# Проверяем, что URL к БД задан через переменную окружения
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set")

# Создаём SQLAlchemy engine
engine = create_engine(DATABASE_URL, future=True)
logger.info(f"Database engine created for {DATABASE_URL}")

# Декларативный базовый класс для всех моделей
Base = declarative_base()

class BaseModel:
    """
    Миксин для SQLAlchemy-моделей, добавляет метод to_dict().
    Не наследует Pydantic.BaseModel, чтобы избежать конфликтов метаклассов.
    """

    def to_dict(self):
        """
        Конвертирует экземпляр модели в словарь по всем колонкам таблицы.
        """
        return {col.name: getattr(self, col.name) for col in self.__table__.columns}

def create_tables(engine):
    """
    Создаёт таблицы (если их нет) и «мигрирует» недостающие колонки в таблице users:
      - last_login (TIMESTAMP WITH TIME ZONE)
      - is_active  (BOOLEAN DEFAULT TRUE)
    """
    # 1) Создать таблицы по описанным моделям
    Base.metadata.create_all(engine)
    logger.info("Database tables created successfully")

    # 2) Простая миграция: добавить колонки, если их нет
    inspector = inspect(engine)
    with engine.begin() as conn:
        try:
            if inspector.has_table("users"):
                # last_login
                if not inspector.has_column("users", "last_login"):
                    conn.execute(text(
                        "ALTER TABLE users ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                    ))
                    logger.info("Adding missing column last_login to users table")

                # is_active
                if not inspector.has_column("users", "is_active"):
                    conn.execute(text(
                        "ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                    ))
                    logger.info("Adding missing column is_active to users table")

        except SQLAlchemyError as e:
            logger.error(f"Failed to create/update database tables: {e}")
            # Пробрасываем дальше, чтобы приложение не стартовало с неконсистентной схемой
            raise

    logger.info("Database tables updated successfully")
