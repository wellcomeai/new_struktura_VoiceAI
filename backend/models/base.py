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
    Создаёт таблицы (если их нет) и добавляет недостающие колонки
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
                
                # Добавляем колонки, только если их нет, каждую в отдельном try-except блоке
                if "last_login" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                        ))
                        logger.info("Added missing column last_login to users")
                    except ProgrammingError as e:
                        # Если колонка уже существует, просто логируем и продолжаем
                        if "already exists" in str(e):
                            logger.info("Column last_login already exists in users table")
                        else:
                            raise
                
                if "is_active" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                        ))
                        logger.info("Added missing column is_active to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column is_active already exists in users table")
                        else:
                            raise
                
                # Для usage_tokens, который вызывает ошибку
                if "usage_tokens" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN usage_tokens INTEGER NOT NULL DEFAULT 0"
                        ))
                        logger.info("Added missing column usage_tokens to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column usage_tokens already exists in users table")
                        else:
                            raise
                
                # Добавляем новые колонки для системы тарификации
                if "subscription_plan_id" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN subscription_plan_id UUID REFERENCES subscription_plans(id) NULL"
                        ))
                        logger.info("Added missing column subscription_plan_id to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column subscription_plan_id already exists in users table")
                        else:
                            raise
                
                if "subscription_start_date" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN subscription_start_date TIMESTAMP WITH TIME ZONE NULL"
                        ))
                        logger.info("Added missing column subscription_start_date to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column subscription_start_date already exists in users table")
                        else:
                            raise
                
                if "subscription_end_date" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN subscription_end_date TIMESTAMP WITH TIME ZONE NULL"
                        ))
                        logger.info("Added missing column subscription_end_date to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column subscription_end_date already exists in users table")
                        else:
                            raise
                
                if "is_trial" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN is_trial BOOLEAN NOT NULL DEFAULT TRUE"
                        ))
                        logger.info("Added missing column is_trial to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column is_trial already exists in users table")
                        else:
                            raise
                
                if "is_admin" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE"
                        ))
                        logger.info("Added missing column is_admin to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column is_admin already exists in users table")
                        else:
                            raise
                
                if "payment_status" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE users ADD COLUMN payment_status VARCHAR(50) NULL"
                        ))
                        logger.info("Added missing column payment_status to users")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column payment_status already exists in users table")
                        else:
                            raise

            # — migrate assistant_configs —
            if "assistant_configs" in existing_tables:
                cols = {c["name"] for c in inspector.get_columns("assistant_configs")}
                if "api_access_token" not in cols:
                    try:
                        conn.execute(text(
                            "ALTER TABLE assistant_configs ADD COLUMN api_access_token TEXT NULL"
                        ))
                        logger.info("Added missing column api_access_token to assistant_configs")
                    except ProgrammingError as e:
                        if "already exists" in str(e):
                            logger.info("Column api_access_token already exists in assistant_configs table")
                        else:
                            raise

        except SQLAlchemyError as e:
            logger.error(f"Failed to create/update database tables: {e}")
            # Не выбрасываем исключение, чтобы приложение могло запуститься
            # даже если не удалось добавить некоторые колонки
            logger.warning("Continuing despite database migration errors")

    logger.info("Database tables updated successfully")
