# backend/models/fish_assistant.py
"""
Fish Assistant model for Voicyfy application.
Fish Audio TTS provider integration — config only, call logic lives in Voximplant.

Тракт звонка (сценарии inbound_fish / outbound_fish на родительском аккаунте):

    Voximplant ⇄ OpenAI Realtime (gpt-realtime-2.1, output_modalities=["text"])
                    │  модель сама транскрибирует речь, отдельный ASR не нужен
                    ▼
                 текст ответа
                    │
                    ▼
    VoxEngine.createWebSocket → /ws/fish/tts/{assistant_id}  (наш прокси)
                    │  прокси говорит с Fish Audio по MessagePack
                    ▼
              wss://api.fish.audio/v1/tts/live → PCM16 обратно в звонок

Почему нужен прокси: у Voximplant нет встроенного модуля Fish (в отличие от
Modules.Cartesia), а медиа-WebSocket VoxEngine принимает только собственный
JSON-протокол. Fish говорит на своём — состыковать их напрямую нельзя.

Ключ Fish — всегда серверный (FISH_API_KEY, см. provider_keys.resolve):
свой ключ Fish пользователь не указывает, минуты списываются с кошелька.
Ключ OpenAI для LLM-части берётся из профиля, если он есть, иначе серверный.
"""

import uuid
from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, JSON, func, Float, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from backend.models.base import Base

# Модель синтеза Fish Audio по умолчанию.
DEFAULT_FISH_MODEL = "s2.1-pro"  # ✅ v6.0: платная модель (free-уровень без гарантий)

# Модель OpenAI Realtime, которая ведёт диалог и транскрибирует речь.
# Настройкой не является: выбор из UI убран, значение одно для всех агентов
# (телефонный конфиг отдаёт сценарию именно эту константу, а не колонку в БД).
DEFAULT_FISH_LLM_MODEL = "gpt-realtime-2.1"

# Частота дискретизации PCM, которую прокси запрашивает у Fish и отдаёт
# в звонок. 8000 — телефонный тракт Voximplant (PCM16_8KHZ по умолчанию).
DEFAULT_FISH_SAMPLE_RATE = 8000

# Режим латентности Fish: balanced — минимальное время до первого аудио
# (то, что нужно голосовому агенту), normal — выше качество, выше задержка,
# low — ещё быстрее старт ценой качества.
DEFAULT_FISH_LATENCY = "balanced"

# Пределы параметров синтеза Fish (из их API).
FISH_SPEED_MIN, FISH_SPEED_MAX = 0.5, 2.0
FISH_TEMPERATURE_MIN, FISH_TEMPERATURE_MAX = 0.0, 1.0

# Модели, которые принимает API. Список шире того, что предлагается в UI:
# у части агентов в базе уже стоит s2.1-pro или s1, и их правки не должны
# отваливаться с 400 при сохранении.
FISH_MODELS = ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free"]

# То, что показываем в селекторе. Вариант ровно один: синтез везде идёт на
# платной s2.1-pro. Free-уровень и старые s1/s2-pro остаются в FISH_MODELS —
# API их принимает, чтобы правки существующих агентов не падали с 400, но
# при первом же пересохранении из UI такой агент переедет на s2.1-pro.
FISH_SELECTABLE_MODELS = ["s2.1-pro"]

# low — быстрее всего начинает говорить, normal — лучшее качество.
FISH_LATENCY_MODES = ["low", "balanced", "normal"]

# Готовые голоса Fish Audio, которые предлагаем в UI, чтобы ассистента можно
# было протестировать сразу, без похода в библиотеку fish.audio. Это публичные
# reference_id из библиотеки; помимо них пользователь может вписать любой
# другой id (в т.ч. клон) — API принимает произвольную строку. Список должен
# совпадать с FISH_VOICES в backend/static/agent/instructions-voice.js.
FISH_VOICES = [
    {"id": "1ac3ce2f7ba24e90ac2a08055c253fe7", "name": "Светлана", "gender": "f"},
    {"id": "5ddd9a81cc554841a53b75e355d52628", "name": "Сергей", "gender": "m"},
]

# Голос по умолчанию — Светлана. Подставляется, когда fish_voice_id пуст
# (и при создании/правке, и в StartEvent для старых записей без голоса).
DEFAULT_FISH_VOICE_ID = FISH_VOICES[0]["id"]


class FishAssistantConfig(Base):
    """
    Configuration for a Fish Audio voice assistant.

    Fish Audio is a TTS provider — вся логика звонка живёт в сценариях
    Voximplant. Бэкенд хранит конфиг и отдаёт его сценарию через
    /api/telephony/config и /api/telephony/outbound-config.
    """
    __tablename__ = "fish_assistant_configs"

    # Primary fields
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    description = Column(String(500), nullable=True)
    system_prompt = Column(Text, nullable=True)

    # Fish voice settings
    # fish_voice_id — reference_id голоса из библиотеки fish.audio: один из
    # FISH_VOICES или свой (в т.ч. клон). Пусто — DEFAULT_FISH_VOICE_ID.
    fish_voice_id = Column(String(255), nullable=True)
    fish_model = Column(String(50), default=DEFAULT_FISH_MODEL, nullable=False)
    fish_latency = Column(String(20), default=DEFAULT_FISH_LATENCY, nullable=False)
    sample_rate = Column(Integer, default=DEFAULT_FISH_SAMPLE_RATE, nullable=False)

    # Скорость речи Fish (prosody.speed, 0.5–2.0). 1.0 — обычный темп.
    voice_speed = Column(Float, default=1.0, nullable=True)

    # LLM settings (OpenAI Realtime на ключе пользователя).
    # Колонка историческая: пользователь модель не выбирает, в звонок уходит
    # DEFAULT_FISH_LLM_MODEL. У старых записей здесь может лежать другое
    # значение — оно ни на что не влияет.
    llm_model = Column(String(100), default=DEFAULT_FISH_LLM_MODEL, nullable=False)
    language = Column(String(10), default="ru", nullable=False)

    # Живость интонации Fish (их temperature, 0–1). К модели OpenAI отношения
    # не имеет: диалогом правит system_prompt, а это про манеру речи.
    temperature = Column(Float, default=0.7, nullable=True)

    # Greeting and logging
    greeting_message = Column(
        String(500),
        nullable=True,
        default="Здравствуйте! Чем я могу вам помочь?",
    )
    google_sheet_id = Column(String(255), nullable=True)

    # Functions configuration (JSON)
    functions = Column(JSON, nullable=True)

    # Status
    is_active = Column(Boolean, default=True, nullable=False)

    # Timestamps
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    user = relationship("User", back_populates="fish_assistants")

    def __repr__(self):
        return f"<FishAssistantConfig(id={self.id}, name='{self.name}', voice='{self.fish_voice_id}')>"

    def get_fish_start_request(self):
        """
        Тело StartEvent для wss://api.fish.audio/v1/tts/live.

        Прокси досылает его первым сообщением после подключения; format
        всегда pcm — иначе аудио пришлось бы декодировать в сценарии.
        """
        def clamp(value, low, high, default):
            if value is None:
                return default
            return max(low, min(high, float(value)))

        request = {
            "text": "",
            "format": "pcm",
            "sample_rate": self.sample_rate or DEFAULT_FISH_SAMPLE_RATE,
            "latency": self.fish_latency or DEFAULT_FISH_LATENCY,
            # Живость интонации. Ограничиваем на всякий случай: у старых
            # записей temperature могла быть до 2 (когда поле трактовалось
            # как параметр LLM), а Fish принимает только 0–1.
            "temperature": clamp(
                self.temperature, FISH_TEMPERATURE_MIN, FISH_TEMPERATURE_MAX, 0.7
            ),
            "prosody": {
                "speed": clamp(
                    self.voice_speed, FISH_SPEED_MIN, FISH_SPEED_MAX, 1.0
                ),
            },
        }
        # Пустой голос у старых записей — говорим голосом по умолчанию,
        # а не «каким-нибудь» дефолтом Fish.
        request["reference_id"] = self.fish_voice_id or DEFAULT_FISH_VOICE_ID
        return request

    def to_dict(self):
        """Convert to dictionary for API response."""
        return {
            "id": str(self.id),
            "user_id": str(self.user_id) if self.user_id else None,
            "name": self.name,
            "description": self.description,
            "system_prompt": self.system_prompt,
            "fish_voice_id": self.fish_voice_id,
            "fish_model": self.fish_model,
            "fish_latency": self.fish_latency,
            "sample_rate": self.sample_rate,
            "voice_speed": self.voice_speed,
            "llm_model": self.llm_model,
            "language": self.language,
            "temperature": self.temperature,
            "greeting_message": self.greeting_message,
            "google_sheet_id": self.google_sheet_id,
            "functions": self.functions,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
