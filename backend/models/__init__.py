"""
Database models module for WellcomeAI application.
This module contains SQLAlchemy ORM models that represent database tables.
ОБНОВЛЕННАЯ ВЕРСИЯ с полным отслеживанием подписок.
"""

from .base import Base, engine, create_tables_with_full_tracking
from .user import User
from .assistant import AssistantConfig
from .conversation import Conversation
from .file import File
from .integration import Integration
from .pinecone_config import PineconeConfig

# ✅ КРИТИЧЕСКИ ВАЖНО: Импортируем новые модели для отслеживания
from .subscription import SubscriptionPlan, SubscriptionLog, PaymentTransaction

from .function_log import FunctionLog

# Export specific models
__all__ = [
    "Base", 
    "engine", 
    "create_tables_with_full_tracking",  # Обновленная функция
    "User", 
    "AssistantConfig", 
    "Conversation", 
    "File",
    "Integration",
    "PineconeConfig",
    # ✅ НОВЫЕ МОДЕЛИ для полного отслеживания
    "SubscriptionPlan",
    "SubscriptionLog", 
    "PaymentTransaction",
    "FunctionLog"
]
