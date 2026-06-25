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

# Версия тулкита для tools.execute. С Composio SDK >=0.9 manual execute требует
# версию: "latest" НЕ принимается. Варианты:
#   - пустое значение (по умолчанию) → dangerously_skip_version_check=True:
#     Composio берёт текущую версию тулза в рантайме (нам подходит — вывод читает
#     LLM, версии не пиним).
#   - конкретная дата-версия в env COMPOSIO_TOOLKIT_VERSION (например 20251027_00)
#     → передаём её как version=... для прод-стабильности.
import os as _os
TOOLKIT_VERSION = _os.getenv("COMPOSIO_TOOLKIT_VERSION", "").strip()

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
        accounts = client.connected_accounts
        # link() — актуальный путь. На старых SDK его может не быть — тогда
        # пробуем legacy initiate() (тот же возврат redirect_url).
        method = getattr(accounts, "link", None) or getattr(accounts, "initiate", None)
        if method is None:
            raise RuntimeError("composio SDK has neither connected_accounts.link nor initiate")
        return method(
            user_id=composio_user_id,
            auth_config_id=auth_config_id,
            callback_url=callback_url,
            allow_multiple=True,
        )

    try:
        req = await _run(_do)
    except Exception as e:
        # Подробный лог с типом исключения — чтобы видеть реальную причину
        # (сеть до Composio, неверный auth_config, версия SDK и т.п.).
        logger.error(
            f"[COMPOSIO] link() failed toolkit={toolkit} user={composio_user_id} "
            f"auth_config={auth_config_id}: {type(e).__name__}: {e}",
            exc_info=True,
        )
        raise
    redirect_url = (
        getattr(req, "redirect_url", None)
        or getattr(req, "redirectUrl", None)
    )
    connection_id = getattr(req, "id", None) or getattr(req, "connection_id", None)
    logger.info(f"[COMPOSIO] link() toolkit={toolkit} user={composio_user_id} conn={connection_id} redirect={'yes' if redirect_url else 'NO'}")
    return {"redirect_url": redirect_url, "connection_id": connection_id}


def _extract_list_items(resp) -> list:
    """Достать список аккаунтов из ответа connected_accounts.list (разные формы)."""
    if resp is None:
        return []
    if isinstance(resp, list):
        return resp
    for attr in ("items", "data", "results"):
        val = getattr(resp, attr, None)
        if val is None and isinstance(resp, dict):
            val = resp.get(attr)
        if isinstance(val, list):
            return val
    return []


async def find_active_connection(composio_user_id: str, toolkit: str) -> Optional[Dict[str, Any]]:
    """
    Найти уже существующее активное подключение пользователя для toolkit.

    composio_user_id общий для всех агентов юзера, поэтому подключение,
    сделанное на одном агенте, переиспользуется на других — без повторного OAuth.
    Best-effort: при любой ошибке/неизвестной форме API возвращает None.
    """
    auth_config_id = auth_config_for(toolkit)
    if not auth_config_id or not is_configured():
        return None
    try:
        client = _get_client()

        def _do():
            accounts = client.connected_accounts
            # Пробуем наиболее вероятную сигнатуру list(); подстраховка ниже.
            try:
                return accounts.list(user_ids=[composio_user_id], auth_config_ids=[auth_config_id])
            except TypeError:
                return accounts.list(user_id=composio_user_id)

        resp = await _run(_do)
    except Exception as e:
        logger.warning(f"[COMPOSIO] find_active_connection list failed: {e}")
        return None

    items = _extract_list_items(resp)
    # Сначала ищем явно активное; затем — любое (фильтруем по auth_config, если поле есть).
    def _ac_id(it):
        return (getattr(it, "auth_config_id", None)
                or (it.get("auth_config_id") if isinstance(it, dict) else None)
                or (getattr(getattr(it, "auth_config", None), "id", None)))

    def _status(it):
        s = getattr(it, "status", None) or (it.get("status") if isinstance(it, dict) else None)
        return str(s or "").upper()

    def _id(it):
        return getattr(it, "id", None) or (it.get("id") if isinstance(it, dict) else None)

    candidates = [it for it in items if _ac_id(it) in (None, auth_config_id)]
    active = [it for it in candidates if _status(it) in ("ACTIVE", "CONNECTED", "ENABLED")]
    pick = (active or candidates or [None])[0]
    if not pick:
        return None
    cid = _id(pick)
    if not cid:
        return None
    return {"connected_account_id": cid, "email": _extract_email(pick), "status": _status(pick)}


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


async def delete_connection(connected_account_id: str) -> bool:
    """
    Удалить connected account в Composio (при отключении коннектора). Best-effort:
    ошибки не роняют отключение — локальная строка всё равно удаляется.
    """
    if not connected_account_id or not is_configured():
        return False
    try:
        client = _get_client()
        method = getattr(client.connected_accounts, "delete", None)
        if method is None:
            logger.warning("[COMPOSIO] connected_accounts.delete not available in SDK")
            return False
        await _run(method, connected_account_id)
        logger.info(f"[COMPOSIO] deleted connected account {connected_account_id}")
        return True
    except Exception as e:
        logger.warning(f"[COMPOSIO] delete_connection({connected_account_id}) failed: {e}")
        return False


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
            exec_kwargs = {"arguments": arguments or {}, "user_id": composio_user_id}
            if TOOLKIT_VERSION:
                # Зафиксированная дата-версия (прод-стабильность).
                exec_kwargs["version"] = TOOLKIT_VERSION
            else:
                # Без пина — пропускаем проверку версии, Composio возьмёт текущую.
                exec_kwargs["dangerously_skip_version_check"] = True
            return client.tools.execute(slug, **exec_kwargs)

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


# ============================================================================
# ГОЛОСОВОЙ АГЕНТ — динамический резолв коннекторов по голосовому ассистенту
# ============================================================================
# Голос не полагается на разовый снимок функций в конфиге: при старте сессии
# смотрим, какие коннекторы у владеющего агента в статусе connected, и
# домешиваем их голосовые функции в список — аналогично тому, как оркестратор
# берёт инструменты через tools.get на каждый запрос.

def composio_user_id_for_agent(agent_config_id) -> str:
    """
    Идентичность агента в Composio (вариант A). Каждый агент — отдельный
    «пользователь» Composio, поэтому подключения изолированы между агентами
    одного владельца. Единая точка правды для connect/get_tools/execute/voice.
    """
    return f"agent_{agent_config_id}"


def _resolve_owner_agent(db, assistant_config):
    """AgentConfig, владеющий данным голосовым ассистентом (gemini/openai/cartesia), или None."""
    aid = getattr(assistant_config, "id", None)
    if not aid:
        return None
    from sqlalchemy import or_ as _or
    from backend.models.agent_config import AgentConfig
    return db.query(AgentConfig).filter(_or(
        AgentConfig.gemini_assistant_id == aid,
        AgentConfig.openai_assistant_id == aid,
        AgentConfig.cartesia_assistant_id == aid,
    )).first()


def composio_user_id_for_assistant(db, assistant_config) -> Optional[str]:
    """Агентная identity Composio по голосовому ассистенту (или None, если агент не найден)."""
    try:
        agent = _resolve_owner_agent(db, assistant_config)
    except Exception as e:
        logger.warning(f"[COMPOSIO] composio_user_id_for_assistant failed: {e}")
        return None
    return composio_user_id_for_agent(agent.id) if agent else None


def connected_toolkits_for_assistant(db, assistant_config) -> list:
    """
    Ключи toolkit'ов (google_calendar/gmail), подключённых к АГЕНТУ, которому
    принадлежит данный голосовой ассистент (gemini/openai/cartesia).
    Best-effort: при любой ошибке возвращает [].
    """
    if assistant_config is None or not is_configured():
        return []
    try:
        from backend.models.agent_connector import AgentConnector

        agent = _resolve_owner_agent(db, assistant_config)
        if not agent:
            return []
        rows = db.query(AgentConnector).filter(
            AgentConnector.agent_config_id == agent.id,
            AgentConnector.status == "connected",
        ).all()
        return [r.toolkit for r in rows if r.toolkit in TOOLKIT_VOICE_FUNCTIONS]
    except Exception as e:
        logger.warning(f"[COMPOSIO] connected_toolkits_for_assistant failed: {e}")
        return []


def merge_voice_connector_functions(db, assistant_config, functions):
    """
    Домешать в `functions` голосового ассистента функции подключённых коннекторов.

    Сохраняет форму входа: dict {"enabled_functions":[...]} → dict; list/None → list.
    Дубли по имени убираются. Если коннекторов нет — возвращает functions как есть.
    """
    toolkits = connected_toolkits_for_assistant(db, assistant_config)
    if not toolkits:
        return functions

    extra = []
    for tk in toolkits:
        extra.extend(TOOLKIT_VOICE_FUNCTIONS.get(tk, []))
    if not extra:
        return functions
    extra_names = {f["name"] for f in extra}

    # dict-форма {"enabled_functions": [...имена...]}
    if isinstance(functions, dict) and "enabled_functions" in functions:
        names = [n for n in functions.get("enabled_functions", []) if n not in extra_names]
        names.extend(sorted(extra_names))
        return {"enabled_functions": names}

    # list-форма [{"name","description"}, ...] (или None)
    items = list(functions) if isinstance(functions, list) else []
    items = [f for f in items if (f.get("name") if isinstance(f, dict) else f) not in extra_names]
    items.extend(extra)
    return items


def connector_voice_prompt_note(db, assistant_config) -> str:
    """
    Короткая подсказка для system-промпта голоса о подключённых сервисах, чтобы
    модель знала, что может ими пользоваться. Пусто, если коннекторов нет.
    """
    toolkits = connected_toolkits_for_assistant(db, assistant_config)
    if not toolkits:
        return ""
    labels = {
        "google_calendar": "Google Календарь — можешь создавать события/встречи и проверять занятость",
        "gmail": "Gmail — можешь отправлять письма клиенту",
    }
    lines = [f"- {labels.get(tk, tk)}" for tk in toolkits]
    return (
        "\n\nПОДКЛЮЧЁННЫЕ СЕРВИСЫ (вызывай соответствующие функции, когда это уместно по ходу разговора):\n"
        + "\n".join(lines)
    )


def ensure_connector_functions_persisted(db, assistant_config) -> bool:
    """
    Гарантирует, что голосовые функции подключённых коннекторов присутствуют в
    assistant_config.functions, и ПЕРСИСТИТ изменение (self-heal).

    Нужно для телефонии: функции голосу отдаёт сценарий Voximplant из
    /api/telephony/config (по индексу function_id), а исполняет другой эндпоинт,
    читающий тот же assistant.functions. Поэтому список должен жить в самом поле —
    иначе индексы config↔execute разъедутся. Порядок добавления детерминирован
    (toolkits отсортированы), существующие функции не трогаем — только дописываем.

    Возвращает True, если поле изменилось (вызывающий должен сделать commit).
    """
    from sqlalchemy.orm.attributes import flag_modified

    toolkits = sorted(connected_toolkits_for_assistant(db, assistant_config))
    extra = []
    for tk in toolkits:
        extra.extend(TOOLKIT_VOICE_FUNCTIONS.get(tk, []))
    if not extra:
        return False

    funcs = getattr(assistant_config, "functions", None)

    # dict-форма {"enabled_functions": [...имена...]}
    if isinstance(funcs, dict) and "enabled_functions" in funcs:
        current = list(funcs.get("enabled_functions", []))
        missing = [f["name"] for f in extra if f["name"] not in current]
        if not missing:
            return False
        funcs = {"enabled_functions": current + missing}
        assistant_config.functions = funcs
        flag_modified(assistant_config, "functions")
        return True

    # list-форма [{"name","description"}, ...] (или None/прочее → список)
    items = list(funcs) if isinstance(funcs, list) else []
    existing_names = {(f.get("name") if isinstance(f, dict) else f) for f in items}
    missing = [f for f in extra if f["name"] not in existing_names]
    if not missing:
        return False
    items = items + missing
    assistant_config.functions = items
    flag_modified(assistant_config, "functions")
    return True


