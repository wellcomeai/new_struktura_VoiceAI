# backend/models/__init__.py
"""
Database models module for Voicyfy application.
This module contains SQLAlchemy ORM models that represent database tables.
✅ ОБНОВЛЕНО: Добавлена модель EmailVerification для верификации email
✅ ОБНОВЛЕНО: Добавлены модели Gemini Assistant и Gemini Conversation
✅ ОБНОВЛЕНО: Добавлена модель Contact для CRM функциональности
✅ ОБНОВЛЕНО: Добавлена модель ContactNote для ленты заметок
✅ ОБНОВЛЕНО: Добавлены модели Partner для партнерской программы
✅ ОБНОВЛЕНО v3.0: Добавлены модели Voximplant Partner Integration
✅ ОБНОВЛЕНО v3.1: Добавлены модели Grok Assistant для xAI Voice API
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
from .embed_config import EmbedConfig

# ✅ НОВОЕ: Импортируем Gemini модели
from .gemini_assistant import GeminiAssistantConfig, GeminiConversation

# ✅ НОВОЕ v3.1: Импортируем Grok модели для xAI Voice API
from .grok_assistant import GrokAssistantConfig, GrokConversation, GrokVoice

# ✅ НОВОЕ: Импортируем Contact и ContactNote для CRM
from .contact import Contact, ContactNote

# ✅ НОВОЕ: Импортируем Partner модели для партнерской программы
from .partner import Partner, ReferralRelationship, PartnerCommission
from .task import Task, TaskStatus
from .browser_task import BrowserTask, BrowserTaskStatus

# ✅ НОВОЕ v3.0: Импортируем Voximplant Partner модели
from .voximplant_child import (
    VoximplantChildAccount,
    VoximplantPhoneNumber,
    VoximplantVerificationStatus
)

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
    "EmailVerification",
    "EmbedConfig",
    # ✅ НОВОЕ: Gemini модели
    "GeminiAssistantConfig",
    "GeminiConversation",
    # ✅ НОВОЕ v3.1: Grok модели для xAI Voice API
    "GrokAssistantConfig",
    "GrokConversation",
    "GrokVoice",
    # ✅ НОВОЕ: CRM модели
    "Contact",
    "ContactNote",
    # ✅ НОВОЕ: Partner модели
    "Partner",
    "ReferralRelationship",
    "PartnerCommission",
    "Task",
    "TaskStatus",
    "BrowserTask",
    "BrowserTaskStatus",
    # ✅ НОВОЕ v3.0: Voximplant Partner модели
    "VoximplantChildAccount",
    "VoximplantPhoneNumber",
    "VoximplantVerificationStatus",
]
