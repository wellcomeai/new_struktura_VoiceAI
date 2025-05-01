"""
Database models module for WellcomeAI application.
This module contains SQLAlchemy ORM models that represent database tables.
"""

from .base import Base, engine
from .user import User
from .assistant import AssistantConfig
from .conversation import Conversation
from .file import File

# Export specific models
__all__ = [
    "Base", 
    "engine", 
    "User", 
    "AssistantConfig", 
    "Conversation", 
    "File"
]

# Create tables in the database
def create_tables():
    """
    Create all model tables in the database if they don't exist.
    This function can be called during application startup.
    """
    Base.metadata.create_all(bind=engine)
