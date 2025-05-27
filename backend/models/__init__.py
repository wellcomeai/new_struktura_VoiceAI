"""
Database models module for WellcomeAI application.
This module contains SQLAlchemy ORM models that represent database tables.
"""

from .base import Base, engine, create_tables
from .user import User
from .assistant import AssistantConfig
from .conversation import Conversation
from .file import File
from .integration import Integration
from .pinecone_config import PineconeConfig  # Add this line
from .function_log import FunctionLog
# Export specific models
__all__ = [
    "Base", 
    "engine", 
    "create_tables", 
    "User", 
    "AssistantConfig", 
    "Conversation", 
    "File",
    "Integration",
    "PineconeConfig"  # Add this line
    "FunctionLog"
]
