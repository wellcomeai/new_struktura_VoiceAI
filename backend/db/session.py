# backend/db/session.py

import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

# Build the database URL, falling back to settings if needed
DATABASE_URL = os.getenv("DATABASE_URL", settings.DATABASE_URL)
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set")

try:
    # Create SQLAlchemy engine with SSL mode enabled (adjust sslmode as appropriate)
    engine = create_engine(
        DATABASE_URL,
        echo=settings.DEBUG,
        pool_pre_ping=True,               # Verify connection liveness
        connect_args={"sslmode": "require"}  # or "verify-full", or use sslmode=disable if no SSL
    )

    # Mask sensitive parts of the URL when logging
    database_url_masked = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else "database"
    logger.info(f"Database engine created for {database_url_masked}")
except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    raise

# Create a configured "Session" class
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

def get_db() -> Generator[Session, None, None]:
    """
    Dependency for FastAPI to yield a database session and close it after use.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
