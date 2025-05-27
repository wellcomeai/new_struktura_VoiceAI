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
    Создаёт таблицы (если их нет) и добавляет недостающие колонки.
    Каждое изменение выполняется в отдельной транзакции для надежности.
    """
    # 1) Создаём все таблицы по описанным моделям
    Base.metadata.create_all(engine)
    logger.info("Database tables created successfully")

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()
    
    # Для таблицы users добавляем колонки, если их нет
    if "users" in existing_tables:
        cols = {c["name"] for c in inspector.get_columns("users")}
        
        # Выполняем миграции для каждого столбца в отдельной транзакции
        for col_data in [
            {"name": "last_login", "type": "TIMESTAMP WITH TIME ZONE NULL"},
            {"name": "is_active", "type": "BOOLEAN NOT NULL DEFAULT TRUE"},
            {"name": "usage_tokens", "type": "INTEGER NOT NULL DEFAULT 0"},
            {"name": "subscription_plan_id", "type": "UUID REFERENCES subscription_plans(id) NULL"},
            {"name": "subscription_start_date", "type": "TIMESTAMP WITH TIME ZONE NULL"},
            {"name": "subscription_end_date", "type": "TIMESTAMP WITH TIME ZONE NULL"},
            {"name": "is_trial", "type": "BOOLEAN NOT NULL DEFAULT TRUE"},
            {"name": "is_admin", "type": "BOOLEAN NOT NULL DEFAULT FALSE"},
            {"name": "payment_status", "type": "VARCHAR(50) NULL"}
        ]:
            if col_data["name"] not in cols:
                try:
                    with engine.begin() as conn:
                        conn.execute(text(
                            f"ALTER TABLE users ADD COLUMN {col_data['name']} {col_data['type']}"
                        ))
                        logger.info(f"Added missing column {col_data['name']} to users")
                except ProgrammingError as e:
                    if "already exists" in str(e):
                        logger.info(f"Column {col_data['name']} already exists in users table")
                    else:
                        logger.error(f"Error adding column {col_data['name']}: {e}")

    # Для таблицы assistant_configs добавляем колонки, если их нет
    if "assistant_configs" in existing_tables:
        cols = {c["name"] for c in inspector.get_columns("assistant_configs")}
        
        if "api_access_token" not in cols:
            try:
                with engine.begin() as conn:
                    conn.execute(text(
                        "ALTER TABLE assistant_configs ADD COLUMN api_access_token TEXT NULL"
                    ))
                    logger.info("Added missing column api_access_token to assistant_configs")
            except ProgrammingError as e:
                if "already exists" in str(e):
                    logger.info("Column api_access_token already exists in assistant_configs table")
                else:
                    logger.error(f"Error adding column api_access_token: {e}")
    
    # Создаем таблицу pinecone_configs, если не существует
    if "pinecone_configs" not in existing_tables:
        try:
            with engine.begin() as conn:
                conn.execute(text("""
                CREATE TABLE IF NOT EXISTS pinecone_configs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
                assistant_id UUID REFERENCES assistant_configs(id) ON DELETE CASCADE,
                namespace VARCHAR NOT NULL,
                char_count INTEGER DEFAULT 0,
                content_preview TEXT,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
             """))
                logger.info("Created pinecone_configs table")
        except ProgrammingError as e:
            if "already exists" in str(e):
                logger.info("Table pinecone_configs already exists")
            else:
                logger.error(f"Error creating pinecone_configs table: {e}")

    logger.info("Database tables updated successfully")
