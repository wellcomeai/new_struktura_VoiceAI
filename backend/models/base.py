import logging
from sqlalchemy import create_engine, text
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
        pool_recycle=3600,    # Recycle connections after 1 hour
        pool_size=10,         # Maximum pool size
        max_overflow=20,      # Allow up to 20 overflows
        echo=settings.DEBUG   # Log SQL statements in debug mode
    )
    database_url_masked = settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else 'database'
    logger.info(f"Database engine created for {database_url_masked}")
except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    raise

# Create sessionmaker
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Create base class for models
Base = declarative_base()

# Add common functionality to all models
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
            if k in [c.name for c in cls.__table__.columns]
        })

# Function to create or update tables
def create_tables(engine):
    """
    Ensure database schema is up-to-date:
    - добавляет колонку last_login в users, если её нет
    - создаёт недостающие таблицы
    """
    try:
        # Импорт моделей для регистрации в metadata
        from backend.models.user import User
        from backend.models.assistant import AssistantConfig
        from backend.models.conversation import Conversation
        from backend.models.file import File

        # Добавляем missing column без сброса всех таблиц
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ NULL"
            ))

        # Создаём отсутствующие таблицы, не трогая уже существующие
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables created/updated successfully")
    except Exception as e:
        logger.error(f"Failed to create/update database tables: {e}")
        raise
