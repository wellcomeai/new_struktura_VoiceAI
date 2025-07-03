"""
Модель пользователя для приложения WellcomeAI.
Представляет пользователя с данными аутентификации и профиля.
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
    subscription_plan = Column(String, default="free")
    usage_tokens = Column(Integer, default=0)
    last_login = Column(DateTime(timezone=True), nullable=True)
    google_sheets_token = Column(JSON, nullable=True)
    google_sheets_authorized = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
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
    files = relationship("File", back_populates="user", cascade="all, delete-orphan")
    subscription_plan_rel = relationship("SubscriptionPlan", foreign_keys=[subscription_plan_id])
    # Add this to the User model in backend/models/user.py under relationships
   
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
    
    def has_active_subscription(self):
        """Проверить, активна ли подписка пользователя"""
        if self.is_admin:
            return True
            
        from datetime import datetime
        if self.subscription_end_date and self.subscription_end_date > datetime.now():
            return True
            
        return False
