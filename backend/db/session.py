# backend/db/session.py

import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

# Build the database URL
DATABASE_URL = os.getenv("DATABASE_URL", settings.DATABASE_URL)
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set")

# Пул соединений. Раньше стоял NullPool: каждый Depends(get_db) открывал новое
# TCP+TLS соединение к Postgres (20-60 мс на запрос, у части эндпоинтов 2-3 раза).
# pool_size держится постоянно, max_overflow открывается по требованию и закрывается
# при возврате, поэтому долгие голосовые сессии не упираются в лимит.
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "25"))
DB_POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))

try:
    engine = create_engine(
        DATABASE_URL,
        echo=settings.DEBUG,
        pool_pre_ping=True,                          # Проверка соединения перед выдачей из пула
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_timeout=30,
        pool_recycle=DB_POOL_RECYCLE,                # Переоткрывать соединения старше 30 минут
        connect_args={"sslmode": "require"}          # Adjust sslmode as needed (e.g. 'disable' in dev)
    )

    # Mask sensitive parts for logging
    database_url_masked = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else "database"
    logger.info(f"Database engine created for {database_url_masked}")

except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    raise

# Configure a session factory
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency that yields a database session and ensures it's closed.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
