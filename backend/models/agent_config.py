"""
Agent Config model for JARVIS AI Agent Mode.
Stores orchestrator and agent configuration per user/assistant.
"""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, Boolean, Integer, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
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
    orchestrator_model = Column(String(100), default="gpt-4o", nullable=False)
    orchestrator_prompt = Column(Text, nullable=True)

    # Агенты (выполнение шагов)
    agent_model = Column(String(100), default="gpt-4o-mini", nullable=False)
    agent_functions = Column(JSON, default=list, nullable=False)

    # Лимиты
    max_steps = Column(Integer, default=10, nullable=False)
    step_timeout_sec = Column(Integer, default=60, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
