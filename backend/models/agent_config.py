"""
Agent Config model for Voicyfy Agent — autonomous calling AI agent.
Stores orchestrator config, onboarding documents, and chat history per user.
"""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, Boolean, Integer, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from backend.models.base import Base


class AgentConfig(Base):
    __tablename__ = "agent_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    assistant_id = Column(UUID(as_uuid=True), ForeignKey("gemini_assistant_configs.id",
                          ondelete="CASCADE"), nullable=True)
    name = Column(String(255), default="Мой агент", nullable=False)
    is_active = Column(Boolean, default=False, nullable=False)

    # Оркестратор (планировщик)
    orchestrator_model = Column(String(100), default="gpt-5-2025-08-07", nullable=False)
    orchestrator_prompt = Column(Text, nullable=True)

    # Агенты (выполнение шагов)
    agent_model = Column(String(100), default="gpt-4o-mini", nullable=False)
    agent_functions = Column(JSON, default=list, nullable=False)

    # Лимиты
    max_steps = Column(Integer, default=10, nullable=False)
    step_timeout_sec = Column(Integer, default=60, nullable=False)

    # Онбординг документы (5 шагов)
    doc_who_am_i = Column(Text, nullable=True)
    doc_who_we_call = Column(Text, nullable=True)
    doc_how_we_talk = Column(Text, nullable=True)
    doc_what_we_offer = Column(Text, nullable=True)
    doc_rules_and_goals = Column(Text, nullable=True)

    # Рабочие часы (UTC+3)
    working_hours_start = Column(Integer, default=9, nullable=False)
    working_hours_end = Column(Integer, default=21, nullable=False)

    # Номер для исходящих звонков (caller_id)
    default_caller_id = Column(String(50), nullable=True)

    # Чат с агентом
    chat_history = Column(JSONB, default=list, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    gemini_assistant = relationship('GeminiAssistantConfig', foreign_keys=[assistant_id])
