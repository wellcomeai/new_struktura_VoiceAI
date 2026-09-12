"""
VoiceModelTariff — витрина голосовых моделей и цена минуты разговора.

Цены не зашиты в код: правятся из админки (`/api/wallet/admin/tariffs`) без
релиза. Код тарифа совпадает с `assistant_type` в телефонии
(openai / gemini / fish / yandex / cascade / cartesia), поэтому биллинг
находит тариф по типу ассистента без дополнительных маппингов.

Цена хранится в КОПЕЙКАХ за минуту. Таблица создаётся и сидируется
startup-функцией `ensure_wallet_tables()` в app.py.
"""

import uuid
from sqlalchemy import Column, String, Integer, Boolean, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from .base import Base, BaseModel


class VoiceModelTariff(Base, BaseModel):
    __tablename__ = "voice_model_tariffs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Совпадает с assistant_type: openai | gemini | fish | yandex | cascade | cartesia
    code = Column(String(30), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    # Короткий бейдж на карточке модели: «Бесплатно», «Рекомендуем», «Премиум»
    badge = Column(String(50), nullable=True)
    # Цена минуты разговора в копейках (0 — бесплатно)
    price_kopeks_per_min = Column(Integer, nullable=False, default=0)
    # Где работает модель: "widget,telephony" | "telephony"
    channels = Column(String(50), nullable=False, default="telephony")
    # Показывать ли в витрине создания ассистента (cartesia скрыта)
    is_enabled = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=100)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), nullable=True)

    @property
    def price_rub_per_min(self) -> float:
        return round((self.price_kopeks_per_min or 0) / 100.0, 2)

    @property
    def channel_list(self):
        return [c.strip() for c in (self.channels or "").split(",") if c.strip()]

    def to_dict(self):
        return {
            "code": self.code,
            "name": self.name,
            "description": self.description,
            "badge": self.badge,
            "price_kopeks_per_min": self.price_kopeks_per_min or 0,
            "price_rub_per_min": self.price_rub_per_min,
            "channels": self.channel_list,
            "is_enabled": bool(self.is_enabled),
            "sort_order": self.sort_order,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


# Витрина по умолчанию (сидируется один раз, дальше правится из админки).
DEFAULT_TARIFFS = [
    {
        "code": "cascade", "name": "Каскад", "badge": "Бесплатно",
        "description": "Лучшее русское звучание. Платите только за связь",
        "price_kopeks_per_min": 0, "channels": "telephony", "sort_order": 10,
        "is_enabled": True,
    },
    {
        "code": "gemini", "name": "Gemini", "badge": "Рекомендуем",
        "description": "Быстрая и экономичная модель",
        "price_kopeks_per_min": 200, "channels": "widget,telephony", "sort_order": 20,
        "is_enabled": True,
    },
    {
        "code": "fish", "name": "Fish Audio", "badge": None,
        "description": "Премиальный русский синтез речи",
        "price_kopeks_per_min": 400, "channels": "telephony", "sort_order": 30,
        "is_enabled": True,
    },
    {
        "code": "yandex", "name": "Яндекс", "badge": None,
        "description": "Голоса Yandex SpeechKit",
        "price_kopeks_per_min": 500, "channels": "telephony", "sort_order": 40,
        "is_enabled": True,
    },
    {
        "code": "openai", "name": "OpenAI", "badge": "Премиум",
        "description": "Realtime-модель OpenAI",
        "price_kopeks_per_min": 900, "channels": "widget,telephony", "sort_order": 50,
        "is_enabled": True,
    },
    {
        "code": "cartesia", "name": "Cartesia", "badge": None,
        "description": "Устаревшая модель, скрыта из витрины",
        "price_kopeks_per_min": 600, "channels": "telephony", "sort_order": 90,
        "is_enabled": False,
    },
    {
        # 🧪 GPT-Live (gpt-live-1): $0.05/мин голос + токены бэкенд-модели.
        # Скрыт из витрины, пока идёт тест на /static/live-test.html.
        "code": "openai-live", "name": "OpenAI Live", "badge": "Тест",
        "description": "GPT-Live-1: full-duplex голос, экспериментально",
        "price_kopeks_per_min": 900, "channels": "widget", "sort_order": 55,
        "is_enabled": False,
    },
]
