"""
Composio service — внешние коннекторы агента (Google Calendar, Gmail).

Две фазы:
  1) Подключение аккаунта (OAuth) — link() отдаёт redirect_url, Composio берёт на
     себя весь OAuth-танец и хранение токенов. Сырые токены к нам не приходят.
  2) Вызов инструментов — get_tools() отдаёт определения tools под user_id,
     execute() исполняет вызов под подключённым аккаунтом этого пользователя.

composio_user_id маппится на Voicyfy user.id (str). И оркестратор (OpenRouter),
и голосовой агент (registry-функции) резолвят этот id из своего контекста, так
что подключение шарится между агентами одного владельца.

SDK Composio синхронный — все вызовы уводим в thread executor, чтобы не блокировать
event loop FastAPI. Клиент создаётся лениво (singleton).
"""

import time
import asyncio
from typing import Optional, Dict, Any, List

from backend.core.logging import get_logger
from backend.core.config import settings

logger = get_logger(__name__)


# Ключ коннектора (как в БД/UI) → slug toolkit в Composio.
TOOLKIT_SLUGS: Dict[str, str] = {
    "google_calendar": "GOOGLECALENDAR",
    "gmail": "GMAIL",
}

# Обратный маппинг slug → ключ коннектора.
SLUG_TO_TOOLKIT: Dict[str, str] = {v: k for k, v in TOOLKIT_SLUGS.items()}

# Функции, которые включаются у ГОЛОСОВОГО ассистента при подключении toolkit'а.
# Имена совпадают с registry-функциями в backend/functions/ (google_calendar.py,
# gmail.py). agent.py инжектит/убирает их из assistant.functions при connect/disconnect.
TOOLKIT_VOICE_FUNCTIONS: Dict[str, list] = {
    "google_calendar": [
        {"name": "google_calendar_create_event", "description": "Создать событие/встречу в Google Календаре владельца."},
        {"name": "google_calendar_find_events", "description": "Найти события в Google Календаре владельца."},
    ],
    "gmail": [
        {"name": "gmail_send_email", "description": "Отправить письмо с Gmail владельца."},
        {"name": "gmail_fetch_emails", "description": "Прочитать последние письма из Gmail владельца."},
    ],
}


def voice_function_names(toolkit: str) -> list:
    """Имена голосовых функций для toolkit'а."""
    return [f["name"] for f in TOOLKIT_VOICE_FUNCTIONS.get(toolkit, [])]


# Кэш определений tools: {(composio_user_id, slug_csv): (expires_at, tools)}.
# Composio.tools.get ходит по сети — не хотим дёргать его на каждый ход чата.
_TOOLS_CACHE: Dict[str, Any] = {}
_TOOLS_CACHE_TTL = 300  # секунд

_client = None  # ленивый singleton Composio


def is_configured() -> bool:
    """True, если задан серверный API-ключ Composio."""
    return bool(settings.COMPOSIO_API_KEY)


def auth_config_for(toolkit: str) -> Optional[str]:
    """Auth Config ID Composio для toolkit (из настроек). None, если не задан."""
    mapping = {
        "google_calendar": settings.COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR,
        "gmail": settings.COMPOSIO_AUTH_CONFIG_GMAIL,
    }
    return mapping.get(toolkit)


def toolkit_available(toolkit: str) -> bool:
    """True, если toolkit поддерживается и у него настроен auth_config."""
    return toolkit in TOOLKIT_SLUGS and bool(auth_config_for(toolkit))


def is_composio_tool(slug: str) -> bool:
    """
    True, если имя тулзы — это slug Composio (например GOOGLECALENDAR_CREATE_EVENT).
    Используется диспетчером оркестратора для маршрутизации исполнения.
    """
    if not slug:
        return False
    return any(slug.startswith(f"{s}_") for s in TOOLKIT_SLUGS.values())


def _get_client():
    """Ленивая инициализация клиента Composio. Бросает, если не настроен."""
    global _client
    if _client is not None:
        return _client
    if not is_configured():
        raise RuntimeError("Composio is not configured (COMPOSIO_API_KEY missing)")
    from composio import Composio  # импорт внутри — пакет опционален
    _client = Composio(api_key=settings.COMPOSIO_API_KEY)
    logger.info("[COMPOSIO] Client initialized")
    return _client


async def _run(fn, *args, **kwargs):
    """Выполнить синхронный вызов SDK в thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


# ============================================================================
# ФАЗА 1 — ПОДКЛЮЧЕНИЕ АККАУНТА
# ============================================================================

async def initiate_connection(
    composio_user_id: str,
    toolkit: str,
    callback_url: str,
) -> Dict[str, Any]:
    """
    Старт OAuth-флоу для toolkit. Возвращает {redirect_url, connection_id}.

    link() — актуальный (не устаревающий) путь для Composio-managed и custom
    OAuth. callback_url может нести наши query-параметры — Composio их сохранит и
    допишет свои (status, connected_account_id) при возврате.
    """
    auth_config_id = auth_config_for(toolkit)
    if not auth_config_id:
        raise RuntimeError(f"auth_config not set for toolkit '{toolkit}'")

    client = _get_client()

    def _do():
        return client.connected_accounts.link(
            user_id=composio_user_id,
            auth_config_id=auth_config_id,
            callback_url=callback_url,
        )

    req = await _run(_do)
    redirect_url = (
        getattr(req, "redirect_url", None)
        or getattr(req, "redirectUrl", None)
    )
    connection_id = getattr(req, "id", None) or getattr(req, "connection_id", None)
    logger.info(f"[COMPOSIO] link() toolkit={toolkit} user={composio_user_id} conn={connection_id}")
    return {"redirect_url": redirect_url, "connection_id": connection_id}


async def get_connection(connection_id: str) -> Dict[str, Any]:
    """
    Получить состояние подключённого аккаунта по id. Best-effort: ошибки не
    роняют вызов, возвращаем {status: 'unknown'}.
    """
    try:
        client = _get_client()
        acc = await _run(client.connected_accounts.get, connection_id)
        return {
            "status": getattr(acc, "status", None),
            "connected_account_id": getattr(acc, "id", None) or connection_id,
            "email": _extract_email(acc),
        }
    except Exception as e:
        logger.warning(f"[COMPOSIO] get_connection({connection_id}) failed: {e}")
        return {"status": "unknown", "connected_account_id": connection_id, "email": None}


def _extract_email(acc) -> Optional[str]:
    """Достать email/идентификатор аккаунта из ответа Composio (best-effort)."""
    for attr in ("email", "user_email"):
        val = getattr(acc, attr, None)
        if val:
            return val
    data = getattr(acc, "data", None) or getattr(acc, "metadata", None)
    if isinstance(data, dict):
        for key in ("email", "user_email", "login"):
            if data.get(key):
                return data[key]
    return None


# ============================================================================
# ФАЗА 2 — ИНСТРУМЕНТЫ
# ============================================================================

async def get_tools(composio_user_id: str, toolkit_slugs: List[str]) -> List[Dict[str, Any]]:
    """
    Определения tools для пользователя по списку toolkit-slug'ов.

    Возвращает формат Chat Completions ([{"type":"function","function":{...}}]),
    который совпадает с тем, что ждёт оркестратор на OpenRouter. Кэшируется на
    _TOOLS_CACHE_TTL секунд. При любой ошибке возвращает [] (best-effort — не
    ломаем чат, если Composio недоступен).
    """
    if not toolkit_slugs or not is_configured():
        return []

    cache_key = f"{composio_user_id}|{','.join(sorted(toolkit_slugs))}"
    cached = _TOOLS_CACHE.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    try:
        client = _get_client()
        tools = await _run(
            client.tools.get,
            user_id=composio_user_id,
            toolkits=list(toolkit_slugs),
        )
        tools = _normalize_tools(tools)
        _TOOLS_CACHE[cache_key] = (time.time() + _TOOLS_CACHE_TTL, tools)
        return tools
    except Exception as e:
        logger.error(f"[COMPOSIO] get_tools failed (user={composio_user_id}, {toolkit_slugs}): {e}")
        return []


def _normalize_tools(tools) -> List[Dict[str, Any]]:
    """
    Привести вывод SDK к списку dict в формате Chat Completions.
    Default-провайдер Composio уже отдаёт нужный формат, но подстрахуемся.
    """
    result = []
    for t in (tools or []):
        if isinstance(t, dict):
            result.append(t)
        elif hasattr(t, "model_dump"):
            result.append(t.model_dump())
        elif hasattr(t, "to_dict"):
            result.append(t.to_dict())
    return result


async def execute(slug: str, arguments: Dict[str, Any], composio_user_id: str) -> Dict[str, Any]:
    """
    Исполнить инструмент Composio под аккаунтом пользователя.

    Возвращает плоский dict {ok, data?, error?} — удобный и для оркестратора, и
    для голосового агента.
    """
    if not is_configured():
        return {"ok": False, "error": "composio_not_configured"}
    try:
        client = _get_client()

        def _do():
            return client.tools.execute(
                slug,
                arguments=arguments or {},
                user_id=composio_user_id,
            )

        resp = await _run(_do)
        return _normalize_execution(resp)
    except Exception as e:
        logger.error(f"[COMPOSIO] execute({slug}) failed: {e}", exc_info=True)
        return {"ok": False, "error": str(e)}


def _normalize_execution(resp) -> Dict[str, Any]:
    """Привести ToolExecutionResponse к {ok, data, error}."""
    if isinstance(resp, dict):
        successful = resp.get("successful", resp.get("success"))
        return {
            "ok": bool(successful) if successful is not None else True,
            "data": resp.get("data"),
            "error": resp.get("error"),
        }
    successful = getattr(resp, "successful", None)
    if successful is None:
        successful = getattr(resp, "success", None)
    return {
        "ok": bool(successful) if successful is not None else True,
        "data": getattr(resp, "data", None),
        "error": getattr(resp, "error", None),
    }
