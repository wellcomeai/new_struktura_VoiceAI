# backend/models/user.py
"""
Модель пользователя для приложения WellcomeAI.
Представляет пользователя с данными аутентификации и профиля.
✅ ОБНОВЛЕНО: Добавлено поле email_verified для верификации email
✅ ОБНОВЛЕНО: Добавлено поле gemini_api_key для Google Gemini API
✅ ОБНОВЛЕНО v2.8: Добавлены поля Voximplant для автоматических звонков
✅ ОБНОВЛЕНО v2.9: Добавлено поле grok_api_key для xAI Grok Voice API
✅ ОБНОВЛЕНО v3.9: Добавлены поля Telegram для уведомлений о звонках
"""

import uuid
from sqlalchemy import Column, String, Boolean, JSON, DateTime, Integer, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .pinecone_config import PineconeConfig
from .base import Base, BaseModel


class User(Base, BaseModel):
    """
    Модель пользователя, представляющая пользователей приложения.
    """
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    company_name = Column(String, nullable=True)
    openai_api_key = Column(String, nullable=True)
    elevenlabs_api_key = Column(String, nullable=True)
    gemini_api_key = Column(String, nullable=True)  # Google Gemini API key
    grok_api_key = Column(String, nullable=True)    # ✅ v2.9: xAI Grok API key
    
    # ✅ v2.8: Voximplant настройки для автоматических звонков
    voximplant_account_id = Column(String(100), nullable=True)
    voximplant_api_key = Column(String(500), nullable=True)
    voximplant_rule_id = Column(String(100), nullable=True)
    voximplant_caller_id = Column(String(50), nullable=True)
    
    # ✅ НОВОЕ v3.9: Telegram настройки для уведомлений о звонках
    telegram_bot_token = Column(String(100), nullable=True)
    telegram_chat_id = Column(String(50), nullable=True)  # Может быть отрицательным для групп/каналов
    
    subscription_plan = Column(String, default="free")
    usage_tokens = Column(Integer, default=0)
    last_login = Column(DateTime(timezone=True), nullable=True)
    google_sheets_token = Column(JSON, nullable=True)
    google_sheets_authorized = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    email_verified = Column(Boolean, default=False, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Новые поля для системы тарификации
    subscription_plan_id = Column(UUID(as_uuid=True), ForeignKey("subscription_plans.id"), nullable=True)
    subscription_start_date = Column(DateTime(timezone=True), nullable=True)
    subscription_end_date = Column(DateTime(timezone=True), nullable=True)
    is_trial = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    payment_status = Column(String(50), nullable=True)

    # Отношения
    assistants = relationship("AssistantConfig", back_populates="user", cascade="all, delete-orphan")
    gemini_assistants = relationship("GeminiAssistantConfig", back_populates="user", cascade="all, delete-orphan")
    grok_assistants = relationship("GrokAssistantConfig", back_populates="user", cascade="all, delete-orphan")  # ✅ v2.9
    files = relationship("File", back_populates="user", cascade="all, delete-orphan")
    subscription_plan_rel = relationship("SubscriptionPlan", foreign_keys=[subscription_plan_id])
    elevenlabs_agents = relationship("ElevenLabsAgent", back_populates="user", cascade="all, delete-orphan")
   
    def __repr__(self):
        """Строковое представление пользователя"""
        return f"<User {self.email}>"
    
    @property
    def full_name(self):
        """Получить полное имя пользователя"""
        parts = []
        if self.first_name:
            parts.append(self.first_name)
        if self.last_name:
            parts.append(self.last_name)
        return " ".join(parts) if parts else None
    
    def to_dict(self):
        """Преобразовать в словарь, исключая конфиденциальные поля"""
        data = super().to_dict()
        # Удаляем конфиденциальные данные
        data.pop("password_hash", None)
        data.pop("openai_api_key", None)
        data.pop("elevenlabs_api_key", None)
        data.pop("gemini_api_key", None)
        data.pop("grok_api_key", None)           # ✅ v2.9: Скрываем Grok API key
        data.pop("voximplant_api_key", None)
        data.pop("telegram_bot_token", None)     # ✅ v3.9: Скрываем Telegram токен
        data.pop("google_sheets_token", None)
        
        # Преобразуем UUID в строку для сериализации JSON
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
        if isinstance(data.get("subscription_plan_id"), uuid.UUID):
            data["subscription_plan_id"] = str(data["subscription_plan_id"])
            
        return data
    
    def has_api_key(self):
        """Проверить, настроен ли ключ OpenAI API у пользователя"""
        return bool(self.openai_api_key)
    
    def has_elevenlabs_api_key(self):
        """Проверить, настроен ли ключ ElevenLabs API у пользователя"""
        return bool(self.elevenlabs_api_key)
    
    def has_gemini_api_key(self):
        """Проверить, настроен ли ключ Gemini API у пользователя"""
        return bool(self.gemini_api_key)
    
    def has_grok_api_key(self):
        """✅ v2.9: Проверить, настроен ли ключ xAI Grok API у пользователя"""
        return bool(self.grok_api_key)
    
    def has_voximplant_config(self):
        """✅ v2.8: Проверить, настроены ли данные Voximplant"""
        return bool(
            self.voximplant_account_id and 
            self.voximplant_api_key and 
            self.voximplant_rule_id and 
            self.voximplant_caller_id
        )
    
    def get_voximplant_config(self):
        """✅ v2.8: Получить настройки Voximplant"""
        if not self.has_voximplant_config():
            return None
        
        return {
            "account_id": self.voximplant_account_id,
            "api_key": self.voximplant_api_key,
            "rule_id": self.voximplant_rule_id,
            "caller_id": self.voximplant_caller_id
        }
    
    def has_telegram_config(self):
        """✅ НОВОЕ v3.9: Проверить, настроены ли данные Telegram"""
        return bool(self.telegram_bot_token and self.telegram_chat_id)
    
    def get_telegram_config(self):
        """✅ НОВОЕ v3.9: Получить настройки Telegram"""
        if not self.has_telegram_config():
            return None
        
        return {
            "bot_token": self.telegram_bot_token,
            "chat_id": self.telegram_chat_id
        }
    
    def has_active_subscription(self):
        """Проверить, активна ли подписка пользователя"""
        if self.is_admin:
            return True
            
        from datetime import datetime
        if self.subscription_end_date and self.subscription_end_date > datetime.now():
            return True
            
        return False
    
    def is_email_verified(self):
        """Проверить, подтверждён ли email пользователя"""
        return self.email_verified
    
    def needs_email_verification(self):
        """Проверить, требуется ли верификация email"""
        return not self.email_verified
    
    def get_available_providers(self):
        """✅ v2.9: Получить список доступных AI провайдеров"""
        providers = []
        
        if self.openai_api_key:
            providers.append("openai")
        if self.gemini_api_key:
            providers.append("gemini")
        if self.grok_api_key:
            providers.append("grok")
        if self.elevenlabs_api_key:
            providers.append("elevenlabs")
            
        return providers
