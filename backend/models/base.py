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
    Создаёт таблицы (если их нет) и добавляет в:
      - users: отсутствующие колонки last_login, is_active, usage_tokens
      - assistant_configs: отсутствующую колонку api_access_token
    """
    # 1) Создаём все таблицы по описанным моделям
    Base.metadata.create_all(engine)
    logger.info("Database tables created successfully")

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    with engine.begin() as conn:
        try:
            # — migrate users —
            if "users" in existing_tables:
                cols = {c["name"] for c in inspector.get_columns("users")}
                if "last_login" not in cols:
                    conn.execute(text(
                        "ALTER TABLE users ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                    ))
                    logger.info("Added missing column last_login to users")
                if "is_active" not in cols:
                    conn.execute(text(
                        "ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                    ))
                    logger.info("Added missing column is_active to users")
                if "usage_tokens" not in cols:
                    conn.execute(text(
                        "ALTER TABLE users ADD COLUMN usage_tokens INTEGER NOT NULL DEFAULT 0"
                    ))
                    logger.info("Added missing column usage_tokens to users")

            # — migrate assistant_configs —
            if "assistant_configs" in existing_tables:
                cols = {c["name"] for c in inspector.get_columns("assistant_configs")}
                if "api_access_token" not in cols:
                    conn.execute(text(
                        "ALTER TABLE assistant_configs ADD COLUMN api_access_token TEXT NULL"
                    ))
                    logger.info("Added missing column api_access_token to assistant_configs")

        except SQLAlchemyError as e:
            logger.error(f"Failed to create/update database tables: {e}")
            raise

    logger.info("Database tables updated successfully")
