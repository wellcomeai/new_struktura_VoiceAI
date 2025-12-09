# backend/models/task.py
"""
Task model для системы задач и автоматических звонков.
Привязывается к контакту (Contact) и выполняется через Scheduler.
✅ ВЕРСИЯ 2.1: Добавлено поле custom_greeting для персонализированных приветствий
✅ ВЕРСИЯ 2.0: Поддержка OpenAI + Gemini ассистентов
"""

from sqlalchemy import Column, String, DateTime, Text, ForeignKey, Enum, Index, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
import enum

from .base import Base


class TaskStatus(str, enum.Enum):
    """Статусы выполнения задачи"""
    SCHEDULED = "scheduled"   # Запланирована (дефолт)
    PENDING = "pending"       # Ожидает выполнения
    CALLING = "calling"       # Звоним прямо сейчас
    COMPLETED = "completed"   # Выполнена успешно
    FAILED = "failed"         # Ошибка при звонке
    CANCELLED = "cancelled"   # Отменена пользователем


class Task(Base):
    """
    Задача с автоматическим звонком в указанное время.
    ✅ Поддерживает OpenAI и Gemini ассистентов
    ✅ v2.1: Персонализированные приветствия через custom_greeting
    
    Основной флоу:
    1. Создается вручную в UI или агентом во время звонка
    2. Scheduler проверяет каждую минуту
    3. Когда scheduled_time наступает → запускает звонок
    4. Обновляет статус и сохраняет результат
    """
    __tablename__ = "tasks"
    
    # ==================== Основные поля ====================
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    
    # ==================== Связи (Foreign Keys) ====================
    # Контакт - КОМУ звонить (обязательно, с каскадным удалением)
    contact_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("contacts.id", ondelete="CASCADE"), 
        nullable=False, 
        index=True
    )
    
    # ✅ НОВОЕ: Два типа ассистентов (один из них должен быть заполнен)
    # OpenAI ассистент - КТО будет звонить (nullable)
    assistant_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("assistant_configs.id"), 
        nullable=True,  # ✅ Теперь nullable
        index=True
    )
    
    # Gemini ассистент - КТО будет звонить (nullable)
    gemini_assistant_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("gemini_assistant_configs.id"), 
        nullable=True,  # ✅ Новое поле
        index=True
    )
    
    # Пользователь - владелец задачи (обязательно)
    user_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("users.id"), 
        nullable=False, 
        index=True
    )
    
    # ==================== Данные задачи ====================
    # Статус выполнения
    status = Column(
        Enum(TaskStatus, name='taskstatus'), 
        default=TaskStatus.SCHEDULED, 
        nullable=False,
        index=True
    )
    
    # Когда нужно позвонить (UTC)
    scheduled_time = Column(DateTime(timezone=True), nullable=False, index=True)
    
    # Название задачи (видит пользователь в UI)
    title = Column(String(255), nullable=False)
    
    # Дополнительное описание (опционально)
    description = Column(Text, nullable=True)
    
    # ✅ НОВОЕ v2.1: Персонализированное приветствие для задачи
    # Если указано - используется вместо config.hello из настроек ассистента
    custom_greeting = Column(Text, nullable=True)
    
    # ==================== Результат выполнения ====================
    # ID звонка в Voximplant (заполняется после звонка)
    call_session_id = Column(String(255), nullable=True)
    
    # Когда начался звонок
    call_started_at = Column(DateTime(timezone=True), nullable=True)
    
    # Когда закончился звонок
    call_completed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Результат звонка (JSON: success, error, duration и т.д.)
    call_result = Column(Text, nullable=True)
    
    # ==================== Timestamps ====================
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), 
        default=datetime.utcnow, 
        onupdate=datetime.utcnow, 
        nullable=False
    )
    
    # ==================== Relationships ====================
    contact = relationship("Contact", back_populates="tasks")
    assistant = relationship("AssistantConfig", foreign_keys=[assistant_id])  # ✅ Explicit FK
    gemini_assistant = relationship("GeminiAssistantConfig", foreign_keys=[gemini_assistant_id])  # ✅ Новое
    user = relationship("User")
    
    # ==================== Constraints & Indexes ====================
    __table_args__ = (
        # ✅ CHECK: хотя бы один ассистент должен быть указан
        CheckConstraint(
            '(assistant_id IS NOT NULL AND gemini_assistant_id IS NULL) OR '
            '(assistant_id IS NULL AND gemini_assistant_id IS NOT NULL)',
            name='check_assistant_type'
        ),
        # Составной индекс для поиска задач к выполнению
        Index('ix_tasks_scheduled_status', 'scheduled_time', 'status'),
        # Индекс для быстрого поиска по контакту
        Index('ix_tasks_contact_scheduled', 'contact_id', 'scheduled_time'),
        # Индекс для поиска по пользователю
        Index('ix_tasks_user_scheduled', 'user_id', 'scheduled_time'),
    )
    
    def __repr__(self):
        assistant_type = "OpenAI" if self.assistant_id else "Gemini"
        greeting_info = " (custom greeting)" if self.custom_greeting else ""
        return f"<Task {self.title} at {self.scheduled_time} ({assistant_type}, status={self.status.value}){greeting_info}>"
    
    def get_assistant_type(self) -> str:
        """Определить тип ассистента"""
        return "openai" if self.assistant_id else "gemini"
    
    def get_assistant_id(self) -> str:
        """Получить ID ассистента (универсально)"""
        return str(self.assistant_id) if self.assistant_id else str(self.gemini_assistant_id)
    
    def to_dict(self):
        """Сериализация для API"""
        return {
            "id": str(self.id),
            "contact_id": str(self.contact_id),
            "assistant_id": str(self.assistant_id) if self.assistant_id else None,
            "gemini_assistant_id": str(self.gemini_assistant_id) if self.gemini_assistant_id else None,
            "assistant_type": self.get_assistant_type(),  # ✅ Новое поле
            "user_id": str(self.user_id),
            "status": self.status.value,
            "scheduled_time": self.scheduled_time.isoformat() if self.scheduled_time else None,
            "title": self.title,
            "description": self.description,
            "custom_greeting": self.custom_greeting,  # ✅ НОВОЕ v2.1
            "call_session_id": self.call_session_id,
            "call_started_at": self.call_started_at.isoformat() if self.call_started_at else None,
            "call_completed_at": self.call_completed_at.isoformat() if self.call_completed_at else None,
            "call_result": self.call_result,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }
    
    def is_overdue(self) -> bool:
        """Проверка: задача просрочена?"""
        return (
            self.scheduled_time < datetime.utcnow() and 
            self.status in [TaskStatus.SCHEDULED, TaskStatus.PENDING]
        )
    
    def can_be_cancelled(self) -> bool:
        """Можно ли отменить задачу?"""
        return self.status in [TaskStatus.SCHEDULED, TaskStatus.PENDING]
    
    def has_custom_greeting(self) -> bool:
        """Проверка: есть ли персонализированное приветствие?"""
        return bool(self.custom_greeting and self.custom_greeting.strip())
