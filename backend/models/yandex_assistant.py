# backend/models/yandex_assistant.py
"""
Yandex Assistant models for Voicyfy application.
Yandex SpeechKit Realtime API integration.

Вся логика звонка живёт в сценариях Voximplant (inbound_yandex / outbound_yandex)
на родительском аккаунте. Бэкенд хранит конфигурацию ассистента и отдаёт её
сценарию через /api/telephony/config и /api/telephony/outbound-config.

Модели: speech-realtime-260528 (default), speech-realtime-250923
Голоса: dasha, marina, alexander, и т.д.
Креды (api_key + folder_id) хранятся на пользователе: User.yandex_api_key,
User.yandex_folder_id — каждый клиент платит за свои токены со своего биллинга.
"""

import uuid
from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, JSON, func, Integer, Float, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from backend.models.base import Base

# Дефолтная модель для всех новых Яндекс-ассистентов.
# Поменять дефолт можно здесь; у существующих ассистентов модель меняется
# через PUT /api/yandex-assistants/{id} (поле model) или в UI страницы агентов.
DEFAULT_YANDEX_MODEL = "speech-realtime-260528"

# Входящие звонки (сценарий inbound_yandex v3.0) идут на Speech Realtime Max
# TTS Live независимо от assistant.model: /api/telephony/config отдаёт эту
# модель. Колонка model остаётся для исходящих (outbound_yandex на старой модели).
YANDEX_LIVE_MODEL = "speech-realtime-max-tts-live/latest"

# Голоса LiveTTS (только ru-RU). С обычными голосами (marina, dasha, ...) модели
# LiveTTS несовместимы, и наоборот. Первое амплуа — умолчание Яндекса.
LIVE_TTS_VOICES = {
    "sofia":  {"name": "Софья",   "gender": "female", "roles": ["support", "casual"]},
    "vera":   {"name": "Вера",    "gender": "female", "roles": ["support", "casual"]},
    "irina":  {"name": "Ирина",   "gender": "female", "roles": ["neutral", "formal", "support", "narrator", "sales"]},
    "sergey": {"name": "Сергей",  "gender": "male",   "roles": ["support", "sales"]},
    "vasily": {"name": "Василий", "gender": "male",   "roles": ["support", "sales"]},
    "denis":  {"name": "Денис",   "gender": "male",   "roles": ["neutral", "casual", "formal", "sales"]},
}
LIVE_TTS_ROLE_NAMES = {
    "support": "Поддержка", "sales": "Продажи", "casual": "Непринуждённо",
    "formal": "Официально", "neutral": "Нейтрально", "narrator": "Диктор",
}
DEFAULT_LIVE_VOICE = "sofia"
DEFAULT_LIVE_MALE_VOICE = "sergey"

# Старые мужские голоса — для подбора голоса LiveTTS того же пола.
LEGACY_MALE_VOICES = {"alexander", "anton", "kirill", "filipp", "ermil", "zahar", "madi_ru"}
# Голос LiveTTS → обычный голос для старой модели (исходящие outbound_yandex).
LIVE_TO_LEGACY_VOICE = {
    "sofia": "marina", "vera": "dasha", "irina": "jane",
    "sergey": "anton", "vasily": "alexander", "denis": "kirill",
}


def live_voice_for(voice) -> str:
    """Голос LiveTTS для входящего звонка: свой — как есть, старый — того же пола."""
    if voice in LIVE_TTS_VOICES:
        return voice
    return DEFAULT_LIVE_MALE_VOICE if voice in LEGACY_MALE_VOICES else DEFAULT_LIVE_VOICE


def live_role_for(voice, role):
    """Амплуа, если оно есть у голоса LiveTTS; иначе None (амплуа голоса по умолчанию)."""
    info = LIVE_TTS_VOICES.get(voice)
    return role if (info and role in info["roles"]) else None


def legacy_voice_for(voice) -> str:
    """Голос для старой модели (исходящие): голос LiveTTS заменяется обычным."""
    return LIVE_TO_LEGACY_VOICE.get(voice, voice or "marina")

# Дефолтные параметры генерации. Меняются здесь (для новых ассистентов)
# или через PUT /api/yandex-assistants/{id} (поля temperature / max_tokens).
DEFAULT_YANDEX_TEMPERATURE = 0.7
DEFAULT_YANDEX_MAX_TOKENS = 4096


class YandexAssistantConfig(Base):
    """
    Configuration for a Yandex voice assistant.
    Uses Yandex SpeechKit Realtime API.
    """
    __tablename__ = "yandex_assistant_configs"

    # Primary fields
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    description = Column(String(500), nullable=True)
    system_prompt = Column(Text, nullable=True)

    # Model settings
    # speech-realtime-260528 (default) / speech-realtime-250923
    model = Column(String(100), default=DEFAULT_YANDEX_MODEL, nullable=False)

    # Voice settings (Yandex voices: dasha, marina, alexander, ...)
    voice = Column(String(50), default="marina", nullable=False)
    # Амплуа голоса (role): например friendly, neutral, strict — опционально
    voice_role = Column(String(50), nullable=True)
    language = Column(String(10), default="ru", nullable=False)

    # Greeting and logging
    greeting_message = Column(String(500), nullable=True, default="Здравствуйте! Чем я могу вам помочь?")
    google_sheet_id = Column(String(255), nullable=True)

    # Status flags
    is_active = Column(Boolean, default=True, nullable=False)
    is_public = Column(Boolean, default=False, nullable=False)

    # Timestamps
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Stats
    total_conversations = Column(Integer, default=0, nullable=False)

    # Model parameters
    temperature = Column(Float, default=DEFAULT_YANDEX_TEMPERATURE, nullable=False)
    max_tokens = Column(Integer, default=DEFAULT_YANDEX_MAX_TOKENS, nullable=False)

    # Functions configuration (JSON)
    # Format: {"enabled_functions": ["query_llm", "send_webhook", ...]}
    # Сценарий строит functionNameToIdMap из деклараций, которые бэкенд
    # собирает через build_functions_for_openai() — формат общий для всех типов.
    functions = Column(JSON, nullable=True)

    # Relationships
    user = relationship("User", back_populates="yandex_assistants")
    conversations = relationship(
        "YandexConversation",
        back_populates="assistant",
        cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<YandexAssistantConfig(id={self.id}, name='{self.name}', voice='{self.voice}')>"

    def to_dict(self):
        """Convert to dictionary for API response."""
        return {
            "id": str(self.id),
            "user_id": str(self.user_id) if self.user_id else None,
            "name": self.name,
            "description": self.description,
            "system_prompt": self.system_prompt,
            "model": self.model,
            "voice": self.voice,
            "voice_role": self.voice_role,
            "language": self.language,
            "greeting_message": self.greeting_message,
            "google_sheet_id": self.google_sheet_id,
            "is_active": self.is_active,
            "is_public": self.is_public,
            "total_conversations": self.total_conversations,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "functions": self.functions,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class YandexConversation(Base):
    """
    Conversation log for Yandex assistants.
    Stores dialog history for analytics and interface display.
    """
    __tablename__ = "yandex_conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistant_id = Column(
        UUID(as_uuid=True),
        ForeignKey("yandex_assistant_configs.id", ondelete="CASCADE"),
        nullable=False
    )
    session_id = Column(String(100), nullable=False, index=True)
    user_message = Column(Text, nullable=True)
    assistant_message = Column(Text, nullable=True)

    # Function call tracking
    function_name = Column(String(100), nullable=True)
    function_result = Column(JSON, nullable=True)

    # Telephony info
    caller_number = Column(String(50), nullable=True)
    call_direction = Column(String(20), nullable=True)  # inbound, outbound

    # Metrics
    tokens_used = Column(Integer, default=0, nullable=False)
    audio_duration_ms = Column(Integer, default=0, nullable=True)
    latency_ms = Column(Integer, nullable=True)

    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationship
    assistant = relationship("YandexAssistantConfig", back_populates="conversations")

    def __repr__(self):
        return f"<YandexConversation(id={self.id}, assistant_id={self.assistant_id}, session_id='{self.session_id}')>"

    def to_dict(self):
        """Convert to dictionary for API response."""
        return {
            "id": str(self.id),
            "assistant_id": str(self.assistant_id),
            "session_id": self.session_id,
            "user_message": self.user_message,
            "assistant_message": self.assistant_message,
            "function_name": self.function_name,
            "function_result": self.function_result,
            "caller_number": self.caller_number,
            "call_direction": self.call_direction,
            "tokens_used": self.tokens_used,
            "audio_duration_ms": self.audio_duration_ms,
            "latency_ms": self.latency_ms,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
