# backend/models/base.py

"""
Defines the declarative base for ORM models and provides a utility
to create/update tables (including adding missing columns) on startup.
"""

import logging

from sqlalchemy import inspect
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import declarative_base

# Import the shared engine so it can be re-exported from this module
from backend.db.session import engine

logger = logging.getLogger(__name__)

# The base class for all ORM models
Base = declarative_base()


def create_tables(engine):
    """
    Create all tables for the metadata, then ensure that any new
    columns added to the User model are present in the database.

    This will:
      - run Base.metadata.create_all(engine)
      - add `last_login` column to users if missing
      - add `is_active` column to users if missing
    """
    inspector = inspect(engine)

    try:
        Base.metadata.create_all(engine)
        logger.info("Database tables created/updated successfully")
    except Exception as e:
        logger.error(f"Failed to create/update database tables: {e}")

    # Fetch existing column names in "users" table
    existing = inspector.get_columns("users")
    cols = {c["name"] for c in existing}

    # Add missing columns
    with engine.connect() as conn:
        if "last_login" not in cols:
            try:
                logger.info("Adding missing column last_login to users table")
                conn.execute(
                    "ALTER TABLE users "
                    "ADD COLUMN last_login TIMESTAMP WITH TIME ZONE NULL"
                )
            except ProgrammingError as e:
                logger.error(f"Could not add last_login column: {e}")

        if "is_active" not in cols:
            try:
                logger.info("Adding missing column is_active to users table")
                conn.execute(
                    "ALTER TABLE users "
                    "ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"
                )
            except ProgrammingError as e:
                logger.error(f"Could not add is_active column: {e}")
