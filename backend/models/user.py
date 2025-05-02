"""
Модель пользователя для приложения WellcomeAI.
Представляет пользователя с данными аутентификации и профиля.
"""

import uuid
from sqlalchemy import Column, String, Boolean, JSON, DateTime, Integer, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

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
    # Комментируем проблемную колонку, которой нет в БД
    # usage_tokens = Column(Integer, default=0)
    last_login = Column(DateTime(timezone=True), nullable=True)
    google_sheets_token = Column(JSON, nullable=True)
    google_sheets_authorized = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Отношения
    assistants = relationship("AssistantConfig", back_populates="user", cascade="all, delete-orphan")
    files = relationship("File", back_populates="user", cascade="all, delete-orphan")

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
            
        return data
    
    def has_api_key(self):
        """Проверить, настроен ли ключ OpenAI API у пользователя"""
        return bool(self.openai_api_key)
        
    # Добавляем метод для совместимости с кодом, который использует usage_tokens
    @property
    def usage_tokens(self):
        """Заглушка для совместимости с существующим кодом"""
        return 0
