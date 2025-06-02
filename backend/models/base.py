"""
backend/models/base.py

Базовый модуль для SQLAlchemy-моделей:
- объявляет движок `engine`
- декларативный базовый класс `Base`
- миксин `BaseModel` с to_dict()
- функцию create_tables() без опасных миграций
"""

import os
import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError, ProgrammingError
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
    ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ: создаёт таблицы только если их нет.
    НЕ ИЗМЕНЯЕТ существующие таблицы - для этого используются Alembic миграции.
    Все изменения схемы должны происходить только через Alembic!
    """
    try:
        # ✅ Создаём все таблицы по описанным моделям (только если их нет)
        Base.metadata.create_all(engine)
        logger.info("✅ Database tables created successfully")
        
        # ❌ УБИРАЕМ всю логику добавления колонок - это делает Alembic!
        # ❌ УБИРАЕМ inspector - он не нужен для простого создания таблиц
        # ❌ УБИРАЕМ все ALTER TABLE команды - они опасны для продакшена
        
        logger.info("✅ Database schema initialization completed")
        
    except Exception as e:
        logger.error(f"❌ Error creating tables: {str(e)}")
        raise
