import logging
from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.declarative import declarative_base

logger = logging.getLogger(__name__)

# Base class for all ORM models
Base = declarative_base()

def create_tables(engine):
    """
    Create all tables defined on Base.metadata, and apply any simple
    migrations (e.g. adding missing columns) for existing tables.
    """
    inspector = inspect(engine)
    table_names = inspector.get_table_names()

    with engine.connect() as conn:
        # Migrate `users` table: add `last_login` and `is_active` if missing
        if 'users' in table_names:
            existing_cols = {col['name'] for col in inspector.get_columns('users')}

            if 'last_login' not in existing_cols:
                try:
                    logger.info("Adding missing column last_login to users table")
                    conn.execute(text(
                        "ALTER TABLE users "
                        "ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE"
                    ))
                except SQLAlchemyError as e:
                    logger.error(f"Failed to add last_login column: {e}")

            if 'is_active' not in existing_cols:
                try:
                    logger.info("Adding missing column is_active to users table")
                    conn.execute(text(
                        "ALTER TABLE users "
                        "ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE"
                    ))
                except SQLAlchemyError as e:
                    logger.error(f"Failed to add is_active column: {e}")

    # Create any tables/models that don't yet exist
    try:
        Base.metadata.create_all(engine)
        logger.info("Database tables created/updated successfully")
    except SQLAlchemyError as e:
        logger.error(f"Failed to create/update database tables: {e}")
