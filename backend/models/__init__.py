"""
Database models module for WellcomeAI application.
This module contains SQLAlchemy ORM models that represent database tables.
✅ ОБНОВЛЕНО: Добавлена модель EmailVerification для верификации email
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

# ✅ ДОБАВЛЕНО: Импортируем ElevenLabs модели
from .elevenlabs import ElevenLabsAgent, ElevenLabsConversation

from .function_log import FunctionLog

# ✅ НОВОЕ: Импортируем модель для верификации email
from .email_verification import EmailVerification

# Export specific models
__all__ = [
    "Base", 
    "engine", 
    "create_tables_with_full_tracking",
    "User", 
    "AssistantConfig", 
    "Conversation", 
    "File",
    "Integration",
    "PineconeConfig",
    # Модели для полного отслеживания подписок
    "SubscriptionPlan",
    "SubscriptionLog", 
    "PaymentTransaction",
    # ElevenLabs модели
    "ElevenLabsAgent",
    "ElevenLabsConversation",
    "FunctionLog",
    # ✅ НОВОЕ: Email верификация
    "EmailVerification"
]
