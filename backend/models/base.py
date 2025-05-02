"""
Base classes and functions for working with the database.
Contains the base class for all SQLAlchemy models and common database functions.
"""

import logging
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from backend.core.config import settings
from backend.core.logging import get_logger

# Initialize logger
logger = get_logger(__name__)

# Create SQLAlchemy engine with optimized pool settings
try:
    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,   # Check connection before using from pool
        pool_recycle=3600,     # Recycle connections after 1 hour
        pool_size=10,          # Maximum pool size
        max_overflow=20,       # Allow up to 20 overflows
        echo=settings.DEBUG    # Log SQL statements in debug mode
    )
    database_url_masked = settings.DATABASE_URL.split('@')[-1] \
        if '@' in settings.DATABASE_URL else 'database'
    logger.info(f"Database engine created for {database_url_masked}")
except Exception as e:
    logger.error(f"Failed to create database engine: {e!r}")
    raise

# Create sessionmaker
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Create base class for models
Base = declarative_base()


class BaseModel:
    """
    Base class for adding common functionality to all models.
    """

    def to_dict(self):
        """
        Convert model instance to dictionary.
        """
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}

    @classmethod
    def from_dict(cls, data):
        """
        Create model instance from dictionary.
        """
        return cls(**{
            k: v for k, v in data.items()
            if k in {c.name for c in cls.__table__.columns}
        })


def create_tables(engine):
    """
    Create or update database tables for all models.
    - Импортирует все модели, чтобы они попали в Base.metadata.
    - Если таблица users уже есть, но в ней нет last_login, добавляет колонку через IF NOT EXISTS.
    - Вызывает create_all, который создаёт все отсутствующие таблицы/колонки.
    """
    try:
        # Импорт всех моделей, чтобы они зарегистрировались в Base.metadata
        from backend.models.user import User
        from backend.models.assistant import AssistantConfig
        from backend.models.conversation import Conversation
        from backend.models.file import File

        inspector = inspect(engine)

        # Если таблица users существует, проверяем и добавляем колонку
        if 'users' in inspector.get_table_names():
            existing_cols = {col['name'] for col in inspector.get_columns('users')}
            if 'last_login' not in existing_cols:
                logger.info("Adding missing column last_login to users table")
                # Используем IF NOT EXISTS, чтобы убрать гонки между воркерами
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "ALTER TABLE users "
                            "ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE NULL"
                        )
                    )

        # Создаём/обновляем все таблицы (создаст любые недостающие модели)
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables created/updated successfully")
    except SQLAlchemyError as e:
        logger.error(f"Failed to create/update database tables: {e!r}")
        raise
