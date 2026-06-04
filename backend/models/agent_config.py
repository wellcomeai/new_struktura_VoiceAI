"""
Agent Config model for Voicyfy Agent — autonomous calling AI agent.
Stores orchestrator config, onboarding documents, and chat history per user.

✅ v3.0: multi-provider voice assistant (gemini / openai / cartesia),
         hardcoded orchestrator prompts (uses_hardcoded_prompt), OpenRouter model.
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
    name = Column(String(255), default="Мой агент", nullable=False)
    is_active = Column(Boolean, default=False, nullable=False)

    # ── Тип голосового ассистента — выбирается при создании, можно менять ──
    assistant_type = Column(String(20), nullable=True)  # gemini | openai | cartesia

    # ── FK на голосового ассистента (заполняется ровно один из трёх) ──
    gemini_assistant_id = Column(
        UUID(as_uuid=True),
        ForeignKey("gemini_assistant_configs.id", ondelete="SET NULL"),
        nullable=True
    )
    openai_assistant_id = Column(
        UUID(as_uuid=True),
        ForeignKey("assistant_configs.id", ondelete="SET NULL"),
        nullable=True
    )
    cartesia_assistant_id = Column(
        UUID(as_uuid=True),
        ForeignKey("cartesia_assistant_configs.id", ondelete="SET NULL"),
        nullable=True
    )

    # ── Оркестратор (планировщик) ──
    # Формат OpenRouter (provider/model-name) для новых агентов v3.0+
    orchestrator_model = Column(String(100), default="deepseek/deepseek-v4-pro", nullable=False)
    orchestrator_prompt = Column(Text, nullable=True)  # для старых агентов (gpt-4o-mini)

    # Агенты (выполнение шагов) — legacy поля, не используются (оставлены до миграции)
    agent_model = Column(String(100), default="gpt-4o-mini", nullable=False)
    agent_functions = Column(JSON, default=list, nullable=False)

    # Лимиты — legacy поля
    max_steps = Column(Integer, default=10, nullable=False)
    step_timeout_sec = Column(Integer, default=60, nullable=False)

    # Онбординг документы (5 шагов)
    doc_who_am_i = Column(Text, nullable=True)
    doc_who_we_call = Column(Text, nullable=True)
    doc_how_we_talk = Column(Text, nullable=True)
    doc_what_we_offer = Column(Text, nullable=True)
    doc_rules_and_goals = Column(Text, nullable=True)

    # Шаг 6 wizard — произвольный текст
    additional_instructions = Column(Text, nullable=True)

    # Флаг — TRUE для агентов созданных после v3.0
    uses_hardcoded_prompt = Column(Boolean, default=False, nullable=False)

    # Рабочие часы (UTC+3)
    working_hours_start = Column(Integer, default=9, nullable=False)
    working_hours_end = Column(Integer, default=21, nullable=False)

    # Номер для исходящих звонков (caller_id)
    default_caller_id = Column(String(50), nullable=True)

    # Чат с агентом
    chat_history = Column(JSONB, default=list, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # ── Relationships ──
    gemini_assistant = relationship(
        "GeminiAssistantConfig", foreign_keys=[gemini_assistant_id]
    )
    openai_assistant = relationship(
        "AssistantConfig", foreign_keys=[openai_assistant_id]
    )
    cartesia_assistant = relationship(
        "CartesiaAssistantConfig", foreign_keys=[cartesia_assistant_id]
    )

    def get_voice_assistant(self):
        """Универсальный геттер — вернёт активного голосового ассистента."""
        if self.assistant_type == "gemini":
            return self.gemini_assistant
        if self.assistant_type == "openai":
            return self.openai_assistant
        if self.assistant_type == "cartesia":
            return self.cartesia_assistant
        return None

    def get_voice_assistant_id(self):
        if self.assistant_type == "gemini":
            return self.gemini_assistant_id
        if self.assistant_type == "openai":
            return self.openai_assistant_id
        if self.assistant_type == "cartesia":
            return self.cartesia_assistant_id
        return None
