"""
provider_keys — единая точка выбора ключа голосового провайдера.

Правило (soft-режим перехода на серверные ключи):
  * у пользователя прописан свой ключ провайдера → работаем на нём, бесплатно;
  * ключа нет → подставляем СЕРВЕРНЫЙ ключ из окружения и списываем минуты
    с кошелька Voicyfy по тарифу модели.

Ключи НЕ копируются в БД — подмена происходит здесь, в момент выдачи
конфигурации (WS-хендлеры виджета, /config сценариев Voximplant).

Составные модели:
  * fish     — диалог ведёт OpenAI Realtime, озвучивает Fish Audio;
  * cartesia — диалог OpenAI Realtime, озвучивает Cartesia;
  * yandex   — ключ + folder_id;
  * cascade  — всегда серверный ключ OpenAI (модель бесплатна, платит только
               телефония).
Составная модель считается «на своём ключе» только если ВСЕ её части
пользовательские; иначе — серверный режим со списанием.
"""

from dataclasses import dataclass, field
from typing import Optional, List

from backend.core.config import settings


# Провайдеры, для которых у платформы должны быть серверные ключи
BILLABLE_PROVIDERS = ("openai", "gemini", "fish", "yandex", "cartesia", "cascade")


@dataclass
class ResolvedKeys:
    provider: str
    # Ключ LLM/realtime-части (для fish/cartesia/cascade это OpenAI)
    api_key: Optional[str] = None
    # Ключ TTS-части (fish_api_key / cartesia_api_key) — для составных моделей
    tts_api_key: Optional[str] = None
    # Yandex folder id
    folder_id: Optional[str] = None
    # True, если хоть одна часть взята из окружения (=> списание с кошелька)
    is_server: bool = False
    # Какие части подставлены с сервера (для логов)
    server_parts: List[str] = field(default_factory=list)

    @property
    def available(self) -> bool:
        """Есть ли всё необходимое, чтобы стартовать разговор."""
        if self.provider in ("fish", "cartesia"):
            return bool(self.api_key and self.tts_api_key)
        if self.provider == "yandex":
            return bool(self.api_key and self.folder_id)
        return bool(self.api_key)


def _pick(user_value: Optional[str], server_value: Optional[str], part: str,
          server_parts: List[str]) -> Optional[str]:
    if user_value:
        return user_value
    if server_value:
        server_parts.append(part)
        return server_value
    return None


def resolve(user, provider: str) -> ResolvedKeys:
    """
    Выбрать ключи для провайдера. `user` может быть None (тогда только
    серверные ключи).
    """
    provider = (provider or "").lower()
    parts: List[str] = []
    g = lambda attr: getattr(user, attr, None) if user is not None else None

    if provider == "openai":
        key = _pick(g("openai_api_key"), settings.OPENAI_API_KEY, "openai", parts)
        return ResolvedKeys(provider, api_key=key, is_server=bool(parts), server_parts=parts)

    if provider == "gemini":
        key = _pick(g("gemini_api_key"), settings.GEMINI_API_KEY, "gemini", parts)
        return ResolvedKeys(provider, api_key=key, is_server=bool(parts), server_parts=parts)

    if provider == "fish":
        key = _pick(g("openai_api_key"), settings.OPENAI_API_KEY, "openai", parts)
        tts = _pick(g("fish_api_key"), settings.FISH_API_KEY, "fish", parts)
        return ResolvedKeys(provider, api_key=key, tts_api_key=tts,
                            is_server=bool(parts), server_parts=parts)

    if provider == "cartesia":
        key = _pick(g("openai_api_key"), settings.OPENAI_API_KEY, "openai", parts)
        tts = _pick(g("cartesia_api_key"), settings.CARTESIA_API_KEY, "cartesia", parts)
        return ResolvedKeys(provider, api_key=key, tts_api_key=tts,
                            is_server=bool(parts), server_parts=parts)

    if provider == "yandex":
        # Ключ и folder_id — пара: берём обе части от пользователя, иначе обе с сервера
        u_key, u_folder = g("yandex_api_key"), g("yandex_folder_id")
        if u_key and u_folder:
            return ResolvedKeys(provider, api_key=u_key, folder_id=u_folder)
        if settings.YANDEX_API_KEY and settings.YANDEX_FOLDER_ID:
            return ResolvedKeys(provider, api_key=settings.YANDEX_API_KEY,
                                folder_id=settings.YANDEX_FOLDER_ID,
                                is_server=True, server_parts=["yandex"])
        return ResolvedKeys(provider, api_key=u_key, folder_id=u_folder)

    if provider == "cascade":
        # Каскад всегда на серверном ключе OpenAI; тариф 0 ₽ — платит телефония
        return ResolvedKeys(provider, api_key=settings.OPENAI_API_KEY,
                            is_server=True, server_parts=["openai"])

    # Неизвестный/неподдерживаемый провайдер (grok, elevenlabs, translate…)
    return ResolvedKeys(provider)


def is_billable(user, provider: str) -> bool:
    """
    Списывать ли минуты с кошелька: да, если разговор идёт на серверном ключе
    платформы. Свой ключ в профиле — бесплатно.

    Админы не исключение: списание с админского кошелька — способ видеть,
    что биллинг работает, а пополнить его можно из админки.
    """
    return resolve(user, provider).is_server


def has_server_key(provider: str) -> bool:
    """Есть ли у платформы серверные ключи для провайдера."""
    return resolve(None, provider).available


def mask(key: Optional[str]) -> str:
    if not key:
        return "<none>"
    if len(key) <= 12:
        return key[:3] + "…"
    return f"{key[:6]}…{key[-4:]}"
