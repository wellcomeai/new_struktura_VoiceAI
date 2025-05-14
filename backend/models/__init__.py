"""
Database models module for WellcomeAI application.
This module contains SQLAlchemy ORM models that represent database tables.
"""

from .base import Base, engine, create_tables  # Обновленный импорт
from .user import User
from .assistant import AssistantConfig
from .conversation import Conversation
from .file import File
from .integration import Integration

# Export specific models
__all__ = [
    "Base", 
    "engine", 
    "create_tables",  # Добавлен в экспорт
    "User", 
    "AssistantConfig", 
    "Conversation", 
    "File"
    "Integration"
]
