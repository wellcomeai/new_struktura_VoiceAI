"""
Database session management for WellcomeAI application.
Contains functions and objects for creating and managing SQLAlchemy sessions.
"""

import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

# Create database connection URL
DATABASE_URL = os.getenv("DATABASE_URL", settings.DATABASE_URL)

# Create SQLAlchemy engine
try:
    engine = create_engine(
        DATABASE_URL, 
        echo=settings.DEBUG,
        pool_pre_ping=True  # Check connection before using it
    )
    
    # Log connection with masked sensitive information
    database_url_masked = DATABASE_URL.split('@')[-1] if '@' in DATABASE_URL else 'database'
    logger.info(f"Database engine created for {database_url_masked}")
except Exception as e:
    logger.error(f"Failed to create database engine: {str(e)}")
    raise

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Function for getting database session
def get_db() -> Generator[Session, None, None]:
    """
    Generator function for getting database session.
    Used as FastAPI dependency for injecting session into endpoints.
    
    Yields:
        Session: SQLAlchemy session for working with database
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
