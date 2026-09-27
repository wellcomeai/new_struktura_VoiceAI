"""
Agent Tools — tool definitions and implementations for GPT-5 Responses API.
Two tool sets: AGENT_CHAT_TOOLS (user chat) and AGENT_POSTCALL_TOOLS (post-call analysis).
"""

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from backend.db.session import safe_rollback
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import func, or_, and_, exists

from backend.core.logging import get_logger
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.models.agent_config import AgentConfig
from backend.models.task import Task, TaskStatus
from backend.models.user import User
from backend.models.agent_connector import AgentConnector
from backend.services import composio_service
from backend.services import agent_memory
from backend.services import agent_files
from backend.services.agent_reply_check import REPLY_CHECK_CHANNEL
from backend.services import telegram_user_service
from backend.services import max_user_service
from backend.services.telegram_notification import TelegramNotificationService
from backend.core.timezone_utils import adjust_to_working_hours
from backend.core.pipeline_stages import AGENT_CONTACT_STAGE_KEYS, is_valid_stage

logger = get_logger(__name__)


# Тулза доступна и в чате, и в post-call анализе — определяем один раз.
MOVE_CONTACT_STAGE_TOOL = {
    "type": "function",
    "name": "move_contact_stage",
    "description": (
        "Перевести контакт на стадию воронки продаж. Доступные стадии: "
        "new (новый), active (в работе), success (успех — цель достигнута), "
        "rejected (явный отказ), do_not_call (просил больше не звонить). "
        "Вызывай только когда есть реальное основание сменить стадию. Если "
        "ничего по сути не изменилось (не дозвонились, клиент ещё думает) — "
        "НЕ вызывай, контакт останется в текущей стадии."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта"},
            "stage": {
                "type": "string",
                "enum": AGENT_CONTACT_STAGE_KEYS,
                "description": "Ключ стадии воронки",
            },
            "reason": {"type": "string", "description": "Краткая причина перевода (опционально)"},
        },
        "required": ["agent_contact_id", "stage"],
    },
}


# Тулза доступна и в чате, и в post-call анализе — определяем один раз.
UPDATE_CONTACT_INFO_TOOL = {
    "type": "function",
    "name": "update_contact_info",
    "description": (
        "Обновить базовую информацию о контакте (имя, компанию, должность, заметки). "
        "Используй когда пользователь говорит 'запиши что...', 'обнови данные...', "
        "'у Иванова новая должность' и т.п. После звонка — когда узнал новый факт "
        "о клиенте (например должность), который стоит сохранить как заметку."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта"},
            "name": {"type": "string"},
            "company": {"type": "string"},
            "position": {"type": "string"},
            "notes": {"type": "string", "description": "Свободный текст с информацией о клиенте"},
        },
        "required": ["agent_contact_id"],
    },
}


# Поиск по векторной базе знаний агента. Доступен и в чате, и в post-call.
SEARCH_KNOWLEDGE_BASE_TOOL = {
    "type": "function",
    "name": "search_knowledge_base",
    "description": (
        "Найти информацию в базе знаний компании (векторный поиск). Используй, "
        "когда нужен фактический ответ по продукту, услугам, ценам, условиям или "
        "другим деталям из материалов владельца. Не выдумывай факты — бери их из "
        "результатов поиска. Если база пуста или ничего не найдено — скажи прямо."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Поисковый запрос на русском языке"},
            "top_k": {"type": "integer", "description": "Сколько фрагментов вернуть (по умолчанию 3)"},
        },
        "required": ["query"],
    },
}


# Отправка SMS клиенту с номера агента (Voximplant). Доступна в чате и в post-call.
SEND_SMS_TOOL = {
    "type": "function",
    "name": "send_sms",
    "description": (
        "Отправить SMS клиенту с номера агента (Voximplant). Используй, когда "
        "владелец просит отправить контакту SMS, либо когда после звонка нужно "
        "продублировать клиенту важную информацию (адрес, ссылку, реквизиты, "
        "код, напоминание о встрече). Получателя укажи через agent_contact_id — "
        "номер возьмётся из карточки контакта; либо задай phone напрямую. "
        "Номер отправителя выбирается автоматически (номер агента). Текст до 500 символов."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Текст SMS (до 500 символов)"},
            "agent_contact_id": {
                "type": "string",
                "description": "UUID контакта-получателя (его телефон будет номером назначения). Либо укажи phone.",
            },
            "phone": {
                "type": "string",
                "description": "Номер получателя напрямую, если не задан agent_contact_id",
            },
        },
        "required": ["text"],
    },
}


# Отправка события на внешний вебхук (n8n/Make/Zapier/любой HTTP endpoint).
# Доступна и в чате, и в post-call. URL берётся сервером из AgentConfig.webhook_url —
# модель его НЕ передаёт (нельзя отправить на произвольный адрес).
SEND_WEBHOOK_TOOL = {
    "type": "function",
    "name": "send_webhook",
    "description": (
        "Отправить событие на внешний вебхук владельца (n8n, Make.com, Zapier "
        "или любой HTTP endpoint). URL настроен в конфигурации агента и "
        "подставляется автоматически — передавать его не нужно. Используй, когда "
        "по итогу разговора/сообщения нужно передать данные во внешнюю систему: "
        "оформить заявку, бронирование, лид, зафиксировать событие или результат "
        "звонка. Если вебхук не настроен — инструмент вернёт ошибку."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "event": {
                "type": "string",
                "description": "Код события: 'booking', 'request', 'lead', 'notification' и т.п.",
            },
            "payload": {
                "type": "object",
                "description": "Произвольные данные для отправки (имя, телефон, детали заявки и т.д.)",
            },
        },
        "required": ["event"],
    },
}


# Уведомление владельцу в Telegram-бота агента. Доступно и в чате/входящих
# сообщениях, и в post-call — чтобы оркестратор мог сигналить о важных событиях
# (горячий лид, жалоба, вопрос без ответа) сразу, а не только после звонка.
SEND_TELEGRAM_NOTIFICATION_TOOL = {
    "type": "function",
    "name": "send_telegram_notification",
    "description": (
        "Отправить уведомление владельцу бизнеса в Telegram (бот уведомлений агента). "
        "Используй при важных событиях: клиент готов купить / просит счёт, жалуется, "
        "просит живого человека, задал вопрос без ответа в материалах. "
        "Укажи в тексте: контакт (имя, телефон), суть события, что уже сделано. "
        "Не отправляй повторно одно и то же событие."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "Текст уведомления"},
            "file_id": {"type": "string", "description": "Приложить файл (file_id из create_pdf_document / create_spreadsheet / export_contacts_table)"},
        },
        "required": ["message"],
    },
}


# ============================================================================
# HELPERS
# ============================================================================

UPDATE_AGENT_MEMORY_TOOL = {
    "type": "function",
    "name": "update_agent_memory",
    "description": (
        "Точечно изменить ТВОЮ память (блокнот агента, блок «ПАМЯТЬ АГЕНТА» в запросе): "
        "добавить заметки (add), исправить заметки по id (update), удалить заметки по id (delete). "
        "Можно передать несколько операций сразу. Не переписывай всю память — правь только нужные заметки. "
        "Секции: instructions (правила владельца на будущее), observations (наблюдения о работе), "
        "plans (намерения, не привязанные к контакту). Факты о конкретном клиенте сюда НЕ пиши — "
        "для них update_contact_memory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "add": {
                "type": "array",
                "description": "Новые заметки",
                "items": {
                    "type": "object",
                    "properties": {
                        "section": {
                            "type": "string",
                            "enum": agent_memory.SECTION_KEYS,
                            "description": "Секция памяти",
                        },
                        "text": {"type": "string", "description": "Текст заметки: одна мысль, коротко"},
                    },
                    "required": ["section", "text"],
                },
            },
            "update": {
                "type": "array",
                "description": "Исправить существующие заметки (id из блока «ПАМЯТЬ АГЕНТА», например m3)",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "id заметки"},
                        "text": {"type": "string", "description": "Новый текст заметки целиком"},
                        "section": {
                            "type": "string",
                            "enum": agent_memory.SECTION_KEYS,
                            "description": "Перенести в другую секцию (опционально)",
                        },
                    },
                    "required": ["id", "text"],
                },
            },
            "delete": {
                "type": "array",
                "description": "id заметок, которые нужно удалить (устарели, выполнены, противоречат новым)",
                "items": {"type": "string"},
            },
        },
    },
}


def _parse_iso_utc(value) -> Optional[datetime]:
    """
    Распарсить ISO 8601 строку времени в aware-datetime (UTC).
    Принимает суффикс 'Z' и смещения; naive-время трактуется как UTC.
    Возвращает None, если строку не удалось разобрать.
    """
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def assistant_task_kwargs(agent_config) -> dict:
    """
    Возвращает kwargs для Task с правильным FK голосового ассистента
    в зависимости от assistant_type агента (gemini / openai / cartesia / yandex /
    cascade / fish).
    Для старых агентов без assistant_type — fallback на gemini_assistant_id.
    """
    if not agent_config:
        return {}
    a_type = getattr(agent_config, "assistant_type", None)
    vid = agent_config.get_voice_assistant_id() if a_type else agent_config.gemini_assistant_id
    if a_type == "openai":
        return {"assistant_id": vid}
    if a_type == "cartesia":
        return {"cartesia_assistant_id": vid}
    if a_type == "yandex":
        return {"yandex_assistant_id": vid}
    if a_type == "cascade":
        return {"cascade_assistant_id": vid}
    if a_type == "fish":
        return {"fish_assistant_id": vid}
    # gemini (and legacy default)
    return {"gemini_assistant_id": vid}


def to_chat_completions_tools(tools: list) -> list:
    """
    Конвертирует tools из формата OpenAI Responses API (flat:
    {"type":"function","name":...,"parameters":...}) в формат Chat Completions /
    OpenRouter (nested: {"type":"function","function":{...}}).
    """
    converted = []
    for t in tools:
        if t.get("type") == "function" and "name" in t:
            converted.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                },
            })
        else:
            converted.append(t)
    return converted


# ============================================================================
# CONNECTOR TOOLS (Composio) — динамическая надстройка над базовыми tools
# ============================================================================

def _connected_toolkits(agent_config, db: Session) -> list:
    """
    Ключи toolkit'ов (google_calendar/gmail), подключённых к агенту (status='connected').
    Пустой список, если Composio не настроен, агента нет или нет подключений.
    """
    if agent_config is None or not composio_service.is_configured():
        return []
    try:
        rows = db.query(AgentConnector).filter(
            AgentConnector.agent_config_id == agent_config.id,
            AgentConnector.status == "connected",
        ).all()
    except Exception as e:
        logger.warning(f"[AGENT-TOOLS] connector lookup failed: {e}")
        return []
    return [r.toolkit for r in rows if r.toolkit in composio_service.TOOLKIT_SLUGS]


async def _augment_with_connectors(base_tools: list, agent_config, db: Session) -> list:
    """Дописать к base_tools определения подключённых коннекторов (если есть)."""
    toolkits = _connected_toolkits(agent_config, db)
    if not toolkits:
        return base_tools
    tool_slugs = []
    for tk in toolkits:
        tool_slugs.extend(composio_service.chat_tool_slugs(tk))
    if not tool_slugs:
        return base_tools
    composio_user_id = composio_service.composio_user_id_for_agent(agent_config.id)
    connector_tools = await composio_service.get_tools(composio_user_id, tool_slugs)
    if not connector_tools:
        return base_tools
    logger.info(f"[AGENT-TOOLS] +{len(connector_tools)} connector tools for agent {agent_config.id}")
    return base_tools + connector_tools


async def build_chat_tools(agent_config, db: Session) -> list:
    """
    Tools для чата/Telegram оркестратора (Chat Completions формат): базовый
    AGENT_CHAT_TOOLS + коннекторы Composio + личный Telegram/MAX (если подключены)
    + проверка ответа (schedule_reply_check, только v3).
    """
    tools = await _augment_with_connectors(
        to_chat_completions_tools(AGENT_CHAT_TOOLS), agent_config, db
    )
    tools = _augment_with_telegram_account(tools, agent_config, db)
    tools = _augment_with_max_account(tools, agent_config, db)
    tools = _augment_with_bulk_messages(tools, agent_config, db)
    return tools + to_chat_completions_tools([SCHEDULE_REPLY_CHECK_TOOL, *FILE_CHAT_TOOLS])


async def build_postcall_tools(agent_config, db: Session) -> list:
    """Tools для PostCall-анализа: AGENT_POSTCALL_TOOLS + коннекторы + личный Telegram + личный MAX + проверка ответа."""
    tools = await _augment_with_connectors(
        to_chat_completions_tools(AGENT_POSTCALL_TOOLS), agent_config, db
    )
    tools = _augment_with_telegram_account(tools, agent_config, db)
    tools = _augment_with_max_account(tools, agent_config, db)
    return tools + to_chat_completions_tools([SCHEDULE_REPLY_CHECK_TOOL, *FILE_POSTCALL_TOOLS])


async def fn_execute_connector(tool_name: str, args: dict, agent_config_id: str, db: Session) -> dict:
    """
    Исполнить инструмент коннектора (Composio) для оркестратора.
    Identity Composio — по агенту (вариант A): то же подключение, что у голосового
    агента этого же агента, изолированное от других агентов владельца.
    """
    composio_user_id = composio_service.composio_user_id_for_agent(agent_config_id)
    return await composio_service.execute(tool_name, args, composio_user_id)


# ============================================================================
# TELEGRAM USER TOOLS — личный Telegram-аккаунт агента (MTProto, Telethon).
# Домешиваются в чат и PostCall, ТОЛЬКО когда аккаунт подключён. Голосовому
# ассистенту эти функции намеренно НЕ отдаются.
# ============================================================================

TELEGRAM_SEND_MESSAGE_TOOL = {
    "type": "function",
    "name": "telegram_send_message",
    "description": (
        "Отправить клиенту сообщение в Telegram С ЛИЧНОГО аккаунта владельца. "
        "Указывай agent_contact_id (предпочтительно) и/или username. Получатель "
        "резолвится: по уже существующему диалогу → по @username → по номеру "
        "телефона контакта (только если первых двух нет; лимитировано — Telegram "
        "банит за спам незнакомым). Пиши как живой человек, без markdown."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "username": {"type": "string", "description": "Telegram @username получателя (если известен)"},
            "text": {"type": "string", "description": "Текст сообщения (с файлом — подпись к нему)"},
            "file_id": {"type": "string", "description": "Приложить файл (file_id из create_pdf_document / create_spreadsheet / get_agent_files)"},
        },
        "required": ["text"],
    },
}

TELEGRAM_GET_THREAD_TOOL = {
    "type": "function",
    "name": "telegram_get_thread",
    "description": (
        "Получить последние сообщения Telegram-переписки с контактом "
        "(личный аккаунт владельца) — для контекста перед ответом."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "limit": {"type": "integer", "description": "Сколько сообщений (по умолчанию 20)"},
        },
        "required": ["agent_contact_id"],
    },
}

SCHEDULE_TELEGRAM_MESSAGE_TOOL = {
    "type": "function",
    "name": "schedule_telegram_message",
    "description": (
        "Запланировать ОТЛОЖЕННОЕ сообщение клиенту в Telegram с личного аккаунта "
        "владельца (для немедленной отправки используй telegram_send_message). "
        "Передавай ИНСТРУКЦИЮ — что и зачем написать (цель, ключевые тезисы), а НЕ "
        "готовый текст: текст составится в момент отправки с учётом свежей "
        "переписки и памяти контакта. Время задай ОДНИМ из способов: delay_minutes "
        "— для относительного («через N минут/часов»), scheduled_at — для "
        "абсолютного («завтра в 14:00»). Рабочие часы не применяются — сообщение "
        "уйдёт ровно в назначенное время."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "scheduled_at": {
                "type": "string",
                "description": (
                    "Абсолютные дата и время отправки ISO 8601 UTC (например 2026-07-09T12:00:00Z). "
                    "Не используй для «через N минут» — для этого есть delay_minutes"
                ),
            },
            "delay_minutes": {
                "type": "integer",
                "description": (
                    "Через сколько минут отправить. Сервер сам вычислит точное время от "
                    "текущего момента — ВСЕГДА используй этот параметр, когда просят "
                    "написать «через N минут/часов», не вычисляй scheduled_at сам."
                ),
            },
            "title": {"type": "string", "description": "Короткое название задачи (видно владельцу в календаре)"},
            "instruction": {
                "type": "string",
                "description": (
                    "Инструкция для составления сообщения: цель, что сказать/спросить, "
                    "о чём договорились. НЕ готовый текст."
                ),
            },
        },
        "required": ["agent_contact_id", "instruction"],
    },
}

TELEGRAM_USER_TOOLS = [
    TELEGRAM_SEND_MESSAGE_TOOL,
    TELEGRAM_GET_THREAD_TOOL,
    SCHEDULE_TELEGRAM_MESSAGE_TOOL,
]


def _augment_with_telegram_account(base_tools: list, agent_config, db: Session) -> list:
    """Дописать тулзы личного Telegram, если аккаунт агента подключён."""
    if agent_config is None:
        return base_tools
    try:
        if not telegram_user_service.account_connected(db, agent_config.id):
            return base_tools
    except Exception as e:
        logger.warning(f"[AGENT-TOOLS] telegram account lookup failed: {e}")
        return base_tools
    return base_tools + to_chat_completions_tools(TELEGRAM_USER_TOOLS)


def _augment_with_bulk_messages(tools: list, agent_config, db: Session) -> list:
    """bulk_schedule_messages — только в чат и только если подключён Telegram или MAX."""
    try:
        connected = agent_config is not None and (
            telegram_user_service.account_connected(db, agent_config.id)
            or max_user_service.account_connected(db, agent_config.id)
        )
    except Exception as e:
        logger.warning(f"[AGENT-TOOLS] messenger account lookup failed: {e}")
        connected = False
    if not connected:
        return tools
    return tools + to_chat_completions_tools([BULK_SCHEDULE_MESSAGES_TOOL])


async def fn_telegram_send_message(args: dict, user_id: str, agent_config, db: Session) -> dict:
    """
    Отправка сообщения с личного Telegram владельца. Анти-бан меры:
    - почасовой лимит исходящих (TG_SEND_HOURLY_LIMIT);
    - резолв по номеру телефона (ImportContacts) — только когда нет диалога и
      username, и не чаще TG_PHONE_RESOLVE_HOURLY_LIMIT новых диалогов в час.
    """
    from backend.models.agent_telegram_account import (
        AgentTelegramDialog, AgentTelegramMessage,
    )

    if not telegram_user_service.is_configured():
        return {"ok": False, "error": telegram_user_service.error_human("not_configured")}
    if agent_config is None:
        return {"ok": False, "error": telegram_user_service.error_human("not_connected")}

    account = telegram_user_service.get_account_for_agent(db, agent_config.id)
    if account is None:
        return {"ok": False, "error": telegram_user_service.error_human("not_connected")}

    text = (args.get("text") or "").strip()
    attach, attach_err = _attachment(args, db, agent_config.id)
    if attach_err:
        return {"ok": False, "error": attach_err}
    if not text and attach is None:
        return {"ok": False, "error": telegram_user_service.error_human("empty_text")}

    hour_ago = datetime.utcnow() - timedelta(hours=1)
    sent_last_hour = db.query(AgentTelegramMessage).filter(
        AgentTelegramMessage.account_id == account.id,
        AgentTelegramMessage.direction == "outbound",
        AgentTelegramMessage.created_at >= hour_ago,
    ).count()
    if sent_last_hour >= telegram_user_service.TG_SEND_HOURLY_LIMIT:
        return {"ok": False, "error": telegram_user_service.error_human("send_limit_reached")}

    # Резолв контакта и его диалога
    contact = None
    dialog = None
    if args.get("agent_contact_id"):
        contact = db.query(AgentContact).filter(
            AgentContact.id == args["agent_contact_id"],
            AgentContact.user_id == user_id,
            AgentContact.agent_config_id == agent_config.id,
        ).first()
        if not contact:
            return {"ok": False, "error": "Контакт не найден"}
        dialog = db.query(AgentTelegramDialog).filter(
            AgentTelegramDialog.account_id == account.id,
            AgentTelegramDialog.agent_contact_id == contact.id,
        ).first()

    peer_id = dialog.tg_peer_id if dialog else None
    username = (args.get("username") or "").strip() or (dialog.tg_username if dialog else None)
    phone = None
    if contact and contact.phone and not contact.phone.startswith("tg:"):
        phone = contact.phone

    # Телефонный резолв — только как последний фолбэк и в пределах лимита
    allow_phone = phone is not None and peer_id is None and not username
    if allow_phone:
        phone_resolves = db.query(AgentTelegramDialog).filter(
            AgentTelegramDialog.account_id == account.id,
            AgentTelegramDialog.created_via == "send_phone",
            AgentTelegramDialog.created_at >= hour_ago,
        ).count()
        if phone_resolves >= telegram_user_service.TG_PHONE_RESOLVE_HOURLY_LIMIT:
            return {"ok": False, "error": telegram_user_service.error_human("phone_resolve_limit_reached")}

    session_str = telegram_user_service.decrypt_session(account.session_encrypted)
    result = await telegram_user_service.send_message(
        session_str,
        text,
        peer_id=peer_id,
        username=username,
        phone=phone if allow_phone else None,
        contact_name=(contact.name if contact else None),
        file_bytes=(bytes(attach.content) if attach else None),
        file_name=(attach.filename if attach else None),
    )
    if not result.get("ok"):
        err = result.get("error") or "telegram_error"
        if err == "session_revoked":
            account.status = "error"
            account.last_error = "session_revoked"
            db.commit()
        return {"ok": False, "error": telegram_user_service.error_human(err)}

    # Upsert диалога (peer теперь известен) и сохранение сообщения в тред
    res_peer = result.get("peer_id")
    if res_peer:
        if dialog is None:
            dialog = db.query(AgentTelegramDialog).filter(
                AgentTelegramDialog.account_id == account.id,
                AgentTelegramDialog.tg_peer_id == res_peer,
            ).first()
        if dialog is None:
            dialog = AgentTelegramDialog(
                account_id=account.id,
                agent_contact_id=(contact.id if contact else None),
                tg_peer_id=res_peer,
                created_via=("send_phone" if result.get("resolved_via") == "phone" else "send_username"),
                last_processed_msg_id=result.get("tg_message_id") or 0,
            )
            db.add(dialog)
        if contact and dialog.agent_contact_id is None:
            dialog.agent_contact_id = contact.id
        if result.get("username"):
            dialog.tg_username = result["username"]
        if result.get("name"):
            dialog.tg_name = result["name"]

    telegram_user_service.store_message(
        db, account, "outbound", _body_with_attachment(text, attach),
        agent_contact_id=(contact.id if contact else (dialog.agent_contact_id if dialog else None)),
        tg_peer_id=res_peer,
        tg_message_id=result.get("tg_message_id"),
    )
    db.commit()

    to_label = result.get("name") or (f"@{result['username']}" if result.get("username") else str(res_peer))
    logger.info(f"[AGENT-TOOLS] telegram_send_message → {to_label} via {result.get('resolved_via')}")
    return {"ok": True, "to": to_label, "resolved_via": result.get("resolved_via")}


async def fn_telegram_get_thread(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Последние сообщения личной Telegram-переписки с контактом."""
    contact = db.query(AgentContact).filter(
        AgentContact.id == args.get("agent_contact_id"),
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Контакт не найден"}
    limit = min(int(args.get("limit") or 20), 50)
    rows = telegram_user_service.get_thread(db, contact.id, limit=limit)
    return {"ok": True, "messages": [m.to_dict() for m in rows]}


async def fn_schedule_telegram_message(args: dict, user_id: str, agent_config, db: Session) -> dict:
    """
    Запланировать отложенное Telegram-сообщение: создаёт Task(channel="telegram").
    Текст НЕ фиксируется — в description хранится инструкция, а сообщение
    составит оркестратор в момент срабатывания задачи (см. execute_agent_task →
    PostCallOrchestrator.run_for_scheduled_telegram).
    """
    if not telegram_user_service.is_configured():
        return {"ok": False, "error": telegram_user_service.error_human("not_configured")}
    if agent_config is None or not telegram_user_service.account_connected(db, agent_config.id):
        return {"ok": False, "error": telegram_user_service.error_human("not_connected")}

    instruction = (args.get("instruction") or "").strip()
    if not instruction:
        return {"ok": False, "error": "Пустая инструкция — опиши, что нужно написать клиенту"}

    task_args = {
        "agent_contact_id": args.get("agent_contact_id"),
        "scheduled_at": args.get("scheduled_at"),
        "delay_minutes": args.get("delay_minutes"),
        "title": args.get("title"),
        "notes": instruction,
    }
    return await fn_create_agent_task(
        task_args, user_id, str(agent_config.id), db, channel="telegram"
    )


# ============================================================================
# MAX USER TOOLS — личный аккаунт мессенджера MAX агента (PyMax).
# Зеркалит Telegram-тулзы. Домешиваются в чат и PostCall, ТОЛЬКО когда аккаунт
# подключён. Голосовому ассистенту эти функции намеренно НЕ отдаются.
# ============================================================================

MAX_SEND_MESSAGE_TOOL = {
    "type": "function",
    "name": "max_send_message",
    "description": (
        "Отправить клиенту сообщение в мессенджере MAX С ЛИЧНОГО аккаунта "
        "владельца. Указывай agent_contact_id. Получатель резолвится: по уже "
        "существующему диалогу MAX → по номеру телефона контакта (только если "
        "диалога нет; лимитировано — антифрод MAX). Пиши как живой человек, "
        "без markdown."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "text": {"type": "string", "description": "Текст сообщения (с файлом — подпись к нему)"},
            "file_id": {"type": "string", "description": "Приложить файл (file_id из create_pdf_document / create_spreadsheet / get_agent_files)"},
        },
        "required": ["agent_contact_id", "text"],
    },
}

MAX_GET_THREAD_TOOL = {
    "type": "function",
    "name": "max_get_thread",
    "description": (
        "Получить последние сообщения MAX-переписки с контактом "
        "(личный аккаунт владельца) — для контекста перед ответом."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "limit": {"type": "integer", "description": "Сколько сообщений (по умолчанию 20)"},
        },
        "required": ["agent_contact_id"],
    },
}

SCHEDULE_MAX_MESSAGE_TOOL = {
    "type": "function",
    "name": "schedule_max_message",
    "description": (
        "Запланировать ОТЛОЖЕННОЕ сообщение клиенту в MAX с личного аккаунта "
        "владельца (для немедленной отправки используй max_send_message). "
        "Передавай ИНСТРУКЦИЮ — что и зачем написать (цель, ключевые тезисы), а НЕ "
        "готовый текст: текст составится в момент отправки с учётом свежей "
        "переписки и памяти контакта. Время задай ОДНИМ из способов: delay_minutes "
        "— для относительного («через N минут/часов»), scheduled_at — для "
        "абсолютного («завтра в 14:00»). Рабочие часы не применяются."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "scheduled_at": {
                "type": "string",
                "description": (
                    "Абсолютные дата и время отправки ISO 8601 UTC (например 2026-07-09T12:00:00Z). "
                    "Не используй для «через N минут» — для этого есть delay_minutes"
                ),
            },
            "delay_minutes": {
                "type": "integer",
                "description": (
                    "Через сколько минут отправить. Сервер сам вычислит точное время от "
                    "текущего момента — ВСЕГДА используй этот параметр, когда просят "
                    "написать «через N минут/часов», не вычисляй scheduled_at сам."
                ),
            },
            "title": {"type": "string", "description": "Короткое название задачи (видно владельцу в календаре)"},
            "instruction": {
                "type": "string",
                "description": (
                    "Инструкция для составления сообщения: цель, что сказать/спросить, "
                    "о чём договорились. НЕ готовый текст."
                ),
            },
        },
        "required": ["agent_contact_id", "instruction"],
    },
}

MAX_USER_TOOLS = [
    MAX_SEND_MESSAGE_TOOL,
    MAX_GET_THREAD_TOOL,
    SCHEDULE_MAX_MESSAGE_TOOL,
]


# ============================================================================
# REPLY CHECK — «проверь, ответил ли клиент» (Task.channel="reply_check").
# Только v3 (OpenRouter): домешивается в build_chat_tools / build_postcall_tools.
# Исполняет TaskScheduler.execute_agent_reply_check (см. services/agent_reply_check.py).
# ============================================================================

SCHEDULE_REPLY_CHECK_TOOL = {
    "type": "function",
    "name": "schedule_reply_check",
    "description": (
        "Поставить ПРОВЕРКУ ОТВЕТА клиента: в назначенное время система посмотрит, "
        "выходил ли клиент на связь после постановки задачи (написал в Telegram/MAX, "
        "прислал SMS, позвонил или взял трубку). Ответил — проверка закроется сама, "
        "ничего делать не нужно. Промолчал — тебя разбудят, и ты сам решишь по своим "
        "правилам, что делать дальше (позвонить, написать в другой канал, напомнить, "
        "сменить стадию, сообщить владельцу или ничего). Ставь после того, как написал "
        "или отправил что-то клиенту и ждёшь реакции. Время — delay_minutes (через "
        "N минут/часов) или scheduled_at (абсолютное). Рабочие часы не применяются."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            "delay_minutes": {
                "type": "integer",
                "description": (
                    "Через сколько минут проверить. Сервер сам вычислит точное время — "
                    "ВСЕГДА используй этот параметр для «через N минут/часов/дней»."
                ),
            },
            "scheduled_at": {
                "type": "string",
                "description": "Абсолютное время проверки ISO 8601 UTC (например 2026-07-09T12:00:00Z)",
            },
            "title": {"type": "string", "description": "Короткое название (видно владельцу в календаре)"},
            "instruction": {
                "type": "string",
                "description": (
                    "Какого ответа ждём и что планировали сделать, если клиент промолчит — "
                    "подсказка тебе на момент проверки (например: «ждём ответ на КП, если "
                    "молчит — позвонить»)."
                ),
            },
        },
        "required": ["agent_contact_id", "instruction"],
    },
}


async def fn_schedule_reply_check(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """
    Поставить проверку ответа: создаёт Task(channel="reply_check"). Момент
    «после которого ждём ответ» — created_at задачи; инструкция хранится в
    description и попадёт в прогон оркестратора, если клиент промолчит.
    """
    instruction = (args.get("instruction") or "").strip()
    if not instruction:
        return {"ok": False, "error": "Пустая инструкция — опиши, какого ответа ждём и что делать при молчании"}
    if args.get("delay_minutes") is None and not args.get("scheduled_at"):
        return {"ok": False, "error": "Укажи время проверки: delay_minutes или scheduled_at"}

    # У контакта держим одну ожидающую проверку: новая (ждём реакцию на
    # последнее касание) заменяет прежние, иначе агент проснётся несколько раз
    # по одному и тому же молчанию.
    replaced = 0
    agent_contact_id = args.get("agent_contact_id")
    if agent_contact_id:
        try:
            replaced = db.query(Task).filter(
                Task.agent_contact_id == agent_contact_id,
                Task.user_id == user_id,
                Task.is_agent_task == True,
                Task.channel == REPLY_CHECK_CHANNEL,
                Task.status == TaskStatus.SCHEDULED,
            ).update({"status": TaskStatus.CANCELLED}, synchronize_session=False)
        except Exception as e:
            logger.warning(f"[AGENT-TOOLS] replace reply checks failed: {e}")
            safe_rollback(db)
            replaced = 0

    task_args = {
        "agent_contact_id": agent_contact_id,
        "scheduled_at": args.get("scheduled_at"),
        "delay_minutes": args.get("delay_minutes"),
        "title": args.get("title"),
        "notes": instruction,
    }
    result = await fn_create_agent_task(
        task_args, user_id, agent_config_id, db, channel=REPLY_CHECK_CHANNEL
    )
    if not result.get("ok"):
        safe_rollback(db)  # контакт не найден — прежние проверки не трогаем
        return result
    if replaced:
        result["replaced_previous_checks"] = replaced
    if result.get("ok"):
        result["note"] = (
            "Проверка поставлена. Если клиент ответит раньше — она закроется сама; "
            "если промолчит — тебя разбудят в назначенное время."
        )
    return result


def _augment_with_max_account(base_tools: list, agent_config, db: Session) -> list:
    """Дописать тулзы личного MAX, если аккаунт агента подключён."""
    if agent_config is None:
        return base_tools
    try:
        if not max_user_service.account_connected(db, agent_config.id):
            return base_tools
    except Exception as e:
        logger.warning(f"[AGENT-TOOLS] max account lookup failed: {e}")
        return base_tools
    return base_tools + to_chat_completions_tools(MAX_USER_TOOLS)


async def fn_max_send_message(args: dict, user_id: str, agent_config, db: Session) -> dict:
    """
    Отправка сообщения с личного MAX владельца. Анти-бан меры:
    - почасовой лимит исходящих (MAX_SEND_HOURLY_LIMIT);
    - резолв по номеру телефона (search_by_phone) — только когда нет диалога, и
      не чаще MAX_PHONE_RESOLVE_HOURLY_LIMIT новых диалогов в час.
    """
    from backend.models.agent_max_account import AgentMaxDialog, AgentMaxMessage

    if not max_user_service.is_configured():
        return {"ok": False, "error": max_user_service.error_human("not_configured")}
    if agent_config is None:
        return {"ok": False, "error": max_user_service.error_human("not_connected")}

    account = max_user_service.get_account_for_agent(db, agent_config.id)
    if account is None:
        return {"ok": False, "error": max_user_service.error_human("not_connected")}

    text = (args.get("text") or "").strip()
    attach, attach_err = _attachment(args, db, agent_config.id)
    if attach_err:
        return {"ok": False, "error": attach_err}
    if not text and attach is None:
        return {"ok": False, "error": max_user_service.error_human("empty_text")}

    hour_ago = datetime.utcnow() - timedelta(hours=1)
    sent_last_hour = db.query(AgentMaxMessage).filter(
        AgentMaxMessage.account_id == account.id,
        AgentMaxMessage.direction == "outbound",
        AgentMaxMessage.created_at >= hour_ago,
    ).count()
    if sent_last_hour >= max_user_service.MAX_SEND_HOURLY_LIMIT:
        return {"ok": False, "error": max_user_service.error_human("send_limit_reached")}

    # Резолв контакта и его диалога
    contact = None
    dialog = None
    if args.get("agent_contact_id"):
        contact = db.query(AgentContact).filter(
            AgentContact.id == args["agent_contact_id"],
            AgentContact.user_id == user_id,
            AgentContact.agent_config_id == agent_config.id,
        ).first()
        if not contact:
            return {"ok": False, "error": "Контакт не найден"}
        dialog = db.query(AgentMaxDialog).filter(
            AgentMaxDialog.account_id == account.id,
            AgentMaxDialog.agent_contact_id == contact.id,
        ).first()

    chat_id = dialog.max_chat_id if dialog else None
    peer_id = dialog.max_peer_id if dialog else None
    phone = None
    if contact and contact.phone and not contact.phone.startswith("max:"):
        phone = contact.phone

    # Телефонный резолв — только как последний фолбэк и в пределах лимита
    allow_phone = phone is not None and chat_id is None and peer_id is None
    if allow_phone:
        phone_resolves = db.query(AgentMaxDialog).filter(
            AgentMaxDialog.account_id == account.id,
            AgentMaxDialog.created_via == "send_phone",
            AgentMaxDialog.created_at >= hour_ago,
        ).count()
        if phone_resolves >= max_user_service.MAX_PHONE_RESOLVE_HOURLY_LIMIT:
            return {"ok": False, "error": max_user_service.error_human("phone_resolve_limit_reached")}

    result = await max_user_service.send_message(
        str(account.id),
        account.phone or "",
        text,
        chat_id=chat_id,
        peer_id=peer_id,
        phone=phone if allow_phone else None,
        file_bytes=(bytes(attach.content) if attach else None),
        file_name=(attach.filename if attach else None),
    )
    if not result.get("ok"):
        err = result.get("error") or "max_error"
        if err in ("session_revoked", "session_missing"):
            account.status = "error"
            account.last_error = err
            db.commit()
        return {"ok": False, "error": max_user_service.error_human(err)}

    # Upsert диалога (chat_id теперь известен) и сохранение сообщения в тред
    res_chat = result.get("chat_id")
    if res_chat:
        if dialog is None:
            dialog = db.query(AgentMaxDialog).filter(
                AgentMaxDialog.account_id == account.id,
                AgentMaxDialog.max_chat_id == res_chat,
            ).first()
        if dialog is None:
            dialog = AgentMaxDialog(
                account_id=account.id,
                agent_contact_id=(contact.id if contact else None),
                max_chat_id=res_chat,
                max_peer_id=result.get("peer_id"),
                created_via=("send_phone" if result.get("resolved_via") == "phone" else "send_dialog"),
                last_processed_msg_time=result.get("msg_time") or 0,
            )
            db.add(dialog)
        if contact and dialog.agent_contact_id is None:
            dialog.agent_contact_id = contact.id
        if result.get("peer_id") and dialog.max_peer_id is None:
            dialog.max_peer_id = result.get("peer_id")
        if result.get("name"):
            dialog.max_name = result["name"]

    max_user_service.store_message(
        db, account, "outbound", _body_with_attachment(text, attach),
        agent_contact_id=(contact.id if contact else (dialog.agent_contact_id if dialog else None)),
        max_chat_id=res_chat,
        max_message_id=result.get("max_message_id"),
    )
    db.commit()

    to_label = result.get("name") or (contact.name if contact else None) or str(res_chat)
    logger.info(f"[AGENT-TOOLS] max_send_message → {to_label} via {result.get('resolved_via')}")
    return {"ok": True, "to": to_label, "resolved_via": result.get("resolved_via")}


async def fn_max_get_thread(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Последние сообщения личной MAX-переписки с контактом."""
    contact = db.query(AgentContact).filter(
        AgentContact.id == args.get("agent_contact_id"),
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Контакт не найден"}
    limit = min(int(args.get("limit") or 20), 50)
    rows = max_user_service.get_thread(db, contact.id, limit=limit)
    return {"ok": True, "messages": [m.to_dict() for m in rows]}


async def fn_schedule_max_message(args: dict, user_id: str, agent_config, db: Session) -> dict:
    """
    Запланировать отложенное MAX-сообщение: создаёт Task(channel="max").
    Текст НЕ фиксируется — в description хранится инструкция, а сообщение
    составит оркестратор в момент срабатывания задачи (см. execute_agent_task →
    PostCallOrchestrator.run_for_scheduled_max).
    """
    if not max_user_service.is_configured():
        return {"ok": False, "error": max_user_service.error_human("not_configured")}
    if agent_config is None or not max_user_service.account_connected(db, agent_config.id):
        return {"ok": False, "error": max_user_service.error_human("not_connected")}

    instruction = (args.get("instruction") or "").strip()
    if not instruction:
        return {"ok": False, "error": "Пустая инструкция — опиши, что нужно написать клиенту"}

    task_args = {
        "agent_contact_id": args.get("agent_contact_id"),
        "scheduled_at": args.get("scheduled_at"),
        "delay_minutes": args.get("delay_minutes"),
        "title": args.get("title"),
        "notes": instruction,
    }
    return await fn_create_agent_task(
        task_args, user_id, str(agent_config.id), db, channel="max"
    )


# ============================================================================
# ФИЛЬТР КОНТАКТОВ — общий для search_contacts и массовых действий (bulk_*)
# ============================================================================

# Строк контактов за один вызов search_contacts: больше — дорого по токенам
# (строка ~60 токенов) и хуже для точности модели. Для работы со всей базой
# агент листает offset'ом или действует по фильтру через bulk_*.
CONTACT_LIST_DEFAULT = 30
CONTACT_LIST_MAX = 200
# Контактов за один вызов массового действия.
BULK_ACTION_MAX = 1000

CONTACT_SORT_KEYS = [
    "newest", "oldest", "last_called_oldest", "last_called_newest", "attempts_most", "name",
]

CONTACT_FILTER_PROPERTIES = {
    "query": {"type": "string", "description": "Подстрока имени, телефона или компании"},
    "stage": {"type": "string", "enum": AGENT_CONTACT_STAGE_KEYS, "description": "Одна стадия воронки"},
    "stages": {
        "type": "array", "items": {"type": "string", "enum": AGENT_CONTACT_STAGE_KEYS},
        "description": "Несколько стадий воронки (любая из)",
    },
    "company": {"type": "string", "description": "Подстрока названия компании"},
    "attempts_min": {"type": "integer", "description": "Попыток звонка не меньше N (N ≥ 1)"},
    "attempts_max": {"type": "integer", "description": "Попыток звонка не больше N (N ≥ 1; ни одной попытки — never_called=true)"},
    "never_called": {"type": "boolean", "description": "true — только те, кому ни разу не звонили"},
    "called_at_least_once": {"type": "boolean", "description": "true — только те, кому звонили хотя бы раз"},
    "not_called_days": {
        "type": "integer",
        "description": "Последний звонок был N и более дней назад, N ≥ 1 (тех, кому не звонили ни разу, НЕ включает — для них never_called)",
    },
    "called_within_days": {"type": "integer", "description": "Звонили за последние N дней, N ≥ 1"},
    "created_after": {"type": "string", "description": "Добавлен в базу не раньше (ISO 8601, UTC)"},
    "created_before": {"type": "string", "description": "Добавлен в базу раньше (ISO 8601, UTC)"},
    "has_scheduled_call": {"type": "boolean", "description": "true — только те, у кого уже есть запланированный звонок"},
    "no_scheduled_call": {"type": "boolean", "description": "true — только те, у кого запланированного звонка нет"},
    "no_reply_days": {
        "type": "integer",
        "description": (
            "Клиент молчит N+ дней, N ≥ 1: агент выходил на связь (звонок или сообщение) N и более "
            "дней назад, а клиент за последние N дней ни разу не ответил — не писал в Telegram/MAX/SMS, "
            "не звонил и не брал трубку"
        ),
    },
}

# Значения query, которые модели передают в смысле «все» — это не поиск.
_QUERY_WILDCARDS = {"*", "%", "all", "any", "все", "всё", "всех", "любой", "любые"}


def _normalize_contact_filter(f: dict) -> dict:
    """
    Убирает из фильтра «пустые» значения, которые модели подставляют по умолчанию
    для необязательных полей: 0 в днях/попытках, false в флагах, "*" в query.
    Иначе called_within_days=0 или never_called=false молча превращали запрос
    в «0 контактов». Флаги работают только со значением true.
    """
    out = {}
    for key, value in (f or {}).items():
        if value is None or value == "" or value == []:
            continue
        if key == "query":
            value = str(value).strip()
            if not value or value.lower() in _QUERY_WILDCARDS:
                continue
        elif key in ("attempts_min", "attempts_max", "not_called_days", "called_within_days", "no_reply_days"):
            n = _as_int(value)
            if n is None or n <= 0:
                continue
            value = n
        elif key in ("never_called", "called_at_least_once", "has_scheduled_call", "no_scheduled_call", "all_contacts"):
            if value is not True and str(value).lower() != "true":
                # Легаси-смысл has_scheduled_call=false → no_scheduled_call сюда не
                # переносим: модели ставят false «по умолчанию», а не по просьбе.
                continue
            value = True
        out[key] = value
    return out

# Фильтр для массовых действий: те же поля + явные id или «вся база».
# Описания полей не дублируем (они у search_contacts) — схема уходит в каждый запрос.
BULK_FILTER_SCHEMA = {
    "type": "object",
    "description": (
        "Каких контактов касается действие. Поля и их смысл — как у search_contacts. "
        "Пустой фильтр не допускается; вся база — all_contacts=true (только по явной просьбе)."
    ),
    "properties": {
        **{k: {kk: vv for kk, vv in v.items() if kk != "description"} for k, v in CONTACT_FILTER_PROPERTIES.items()},
        "agent_contact_ids": {"type": "array", "items": {"type": "string"}},
        "all_contacts": {"type": "boolean"},
    },
}

BULK_COMMON_PROPERTIES = {
    "dry_run": {
        "type": "boolean",
        "description": "true — ничего не менять, только посчитать, сколько контактов попадёт, и показать примеры",
    },
    "max_contacts": {
        "type": "integer",
        "description": f"Обработать не больше N контактов за вызов (по умолчанию и максимум {BULK_ACTION_MAX})",
    },
}


def _naive_utc(value) -> Optional[datetime]:
    """ISO-строка → naive UTC (даты в agent_contacts хранятся без таймзоны, в UTC)."""
    dt = _parse_iso_utc(value)
    return dt.replace(tzinfo=None) if dt else None


def _as_int(value, default=None):
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def _stage_condition(stage: str):
    """Условие по стадии. «active» включает и легаси-статусы вне воронки (напр. calling)."""
    if stage == "active":
        return or_(AgentContact.status == "active", AgentContact.status.notin_(AGENT_CONTACT_STAGE_KEYS))
    return AgentContact.status == stage


def _scheduled_call_exists():
    return exists().where(and_(
        Task.agent_contact_id == AgentContact.id,
        Task.is_agent_task == True,
        Task.status == TaskStatus.SCHEDULED,
        Task.channel == "call",
    ))


def _call_direction_sql():
    """postcall_log->>'call_direction' (канал события AgentCall), '' если нет."""
    return func.coalesce(AgentCall.postcall_log["call_direction"].astext, "")


def _touched_before(cutoff):
    """Агент выходил на связь с контактом не позже cutoff (звонок или сообщение)."""
    from backend.models.agent_telegram_account import AgentTelegramMessage
    from backend.models.agent_max_account import AgentMaxMessage
    return or_(
        exists().where(and_(
            AgentCall.agent_contact_id == AgentContact.id,
            AgentCall.direction == "outbound",
            AgentCall.created_at <= cutoff,
            _call_direction_sql() != "reply_check",
        )),
        exists().where(and_(
            AgentTelegramMessage.agent_contact_id == AgentContact.id,
            AgentTelegramMessage.direction == "outbound",
            AgentTelegramMessage.created_at <= cutoff,
        )),
        exists().where(and_(
            AgentMaxMessage.agent_contact_id == AgentContact.id,
            AgentMaxMessage.direction == "outbound",
            AgentMaxMessage.created_at <= cutoff,
        )),
    )


def _replied_since(cutoff):
    """
    Клиент выходил на связь после cutoff: любое входящее событие агента
    (звонок, SMS, Telegram, MAX — у всех AgentCall.direction="inbound"),
    состоявшийся исходящий звонок или входящее сообщение в тредах мессенджеров
    (на случай, если агент был выключен и событие не создалось).
    """
    from backend.models.agent_telegram_account import AgentTelegramMessage
    from backend.models.agent_max_account import AgentMaxMessage
    return or_(
        exists().where(and_(
            AgentCall.agent_contact_id == AgentContact.id,
            AgentCall.created_at >= cutoff,
            or_(
                AgentCall.direction == "inbound",
                and_(
                    AgentCall.status == "answered",
                    _call_direction_sql().in_(["", "outbound"]),
                ),
            ),
        )),
        exists().where(and_(
            AgentTelegramMessage.agent_contact_id == AgentContact.id,
            AgentTelegramMessage.direction == "inbound",
            AgentTelegramMessage.created_at >= cutoff,
        )),
        exists().where(and_(
            AgentMaxMessage.agent_contact_id == AgentContact.id,
            AgentMaxMessage.direction == "inbound",
            AgentMaxMessage.created_at >= cutoff,
        )),
    )


def _contact_filter_query(db: Session, user_id: str, agent_config_id: str, f: dict):
    """
    Строит запрос AgentContact по фильтру f (поля CONTACT_FILTER_PROPERTIES +
    agent_contact_ids). Всегда скоупится по user_id + agent_config_id.
    Возвращает (query, error): error — строка для ответа модели, если фильтр неверный.
    """
    f = f or {}
    q = db.query(AgentContact).filter(
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    )

    ids = f.get("agent_contact_ids")
    if ids:
        if not isinstance(ids, list):
            ids = [ids]
        valid = []
        for raw in ids:
            try:
                valid.append(uuid.UUID(str(raw)))
            except (ValueError, TypeError):
                continue
        if not valid:
            return None, "invalid_agent_contact_ids"
        q = q.filter(AgentContact.id.in_(valid))

    stages = []
    if f.get("stage"):
        stages.append(f["stage"])
    if f.get("stages"):
        stages.extend(f["stages"] if isinstance(f["stages"], list) else [f["stages"]])
    if stages:
        bad = [s for s in stages if not is_valid_stage(s)]
        if bad:
            return None, f"invalid_stage: {', '.join(map(str, bad))}"
        q = q.filter(or_(*[_stage_condition(s) for s in stages]))

    if f.get("company"):
        q = q.filter(AgentContact.company.ilike(f"%{f['company']}%"))

    if f.get("query"):
        like = f"%{f['query']}%"
        q = q.filter(or_(
            AgentContact.name.ilike(like),
            AgentContact.phone.ilike(like),
            AgentContact.company.ilike(like),
        ))

    attempts_min = _as_int(f.get("attempts_min"))
    if attempts_min is not None:
        q = q.filter(AgentContact.attempts_count >= attempts_min)
    attempts_max = _as_int(f.get("attempts_max"))
    if attempts_max is not None:
        q = q.filter(AgentContact.attempts_count <= attempts_max)

    if f.get("never_called") is True:
        q = q.filter(AgentContact.last_called_at.is_(None))
    if f.get("called_at_least_once") is True:
        q = q.filter(AgentContact.last_called_at.isnot(None))

    now = datetime.utcnow()
    not_called_days = _as_int(f.get("not_called_days"))
    if not_called_days is not None and not_called_days > 0:
        q = q.filter(AgentContact.last_called_at < now - timedelta(days=not_called_days))
    called_within_days = _as_int(f.get("called_within_days"))
    if called_within_days is not None and called_within_days > 0:
        q = q.filter(AgentContact.last_called_at >= now - timedelta(days=called_within_days))

    for key, op in (("created_after", "ge"), ("created_before", "lt")):
        if f.get(key):
            dt = _naive_utc(f[key])
            if not dt:
                return None, f"invalid_{key}"
            q = q.filter(AgentContact.created_at >= dt if op == "ge" else AgentContact.created_at < dt)

    no_reply_days = _as_int(f.get("no_reply_days"))
    if no_reply_days is not None and no_reply_days > 0:
        cutoff = now - timedelta(days=no_reply_days)
        q = q.filter(_touched_before(cutoff), ~_replied_since(cutoff))

    if f.get("has_scheduled_call") is True:
        q = q.filter(_scheduled_call_exists())
    if f.get("no_scheduled_call") is True:
        q = q.filter(~_scheduled_call_exists())

    return q, None


def _sort_contacts(q, sort: Optional[str]):
    """Сортировка + id как тай-брейкер, чтобы постраничный вывод был стабильным."""
    col = AgentContact
    order = {
        "oldest": [col.created_at.asc()],
        "last_called_oldest": [col.last_called_at.asc().nullsfirst()],
        "last_called_newest": [col.last_called_at.desc().nullslast()],
        "attempts_most": [col.attempts_count.desc()],
        "name": [col.name.asc().nullslast()],
    }.get(sort or "newest", [col.created_at.desc()])
    return q.order_by(*order, col.id.asc())


def _compact_contact(c: AgentContact) -> dict:
    """Короткая строка контакта для модели: пустые поля не передаём (экономия токенов)."""
    row = {
        "id": str(c.id),
        "name": c.name,
        "phone": c.phone,
        "company": c.company,
        "position": c.position,
        "stage": c.status,
        "attempts": c.attempts_count or None,
        "last_called": c.last_called_at.isoformat(timespec="minutes") if c.last_called_at else None,
    }
    return {k: v for k, v in row.items() if v not in (None, "")}


def _bulk_targets(args: dict, db: Session, user_id: str, agent_config_id: str, legacy_stage: bool = False):
    """
    Разбирает цель массового действия: filter / agent_contact_ids / stage.
    stage верхнего уровня — легаси-фильтр только у bulk_schedule_calls (legacy_stage=True);
    у bulk_move_contacts_stage это целевая стадия, а не фильтр.
    Пустой фильтр запрещён — вся база только через all_contacts=true.
    Возвращает (query, filter_dict, error).
    """
    f = dict(args.get("filter") or {})
    if args.get("agent_contact_ids") and not f.get("agent_contact_ids"):
        f["agent_contact_ids"] = args["agent_contact_ids"]
    if legacy_stage and args.get("stage") and not (f.get("stage") or f.get("stages")):
        f["stage"] = args["stage"]

    f = _normalize_contact_filter(f)
    criteria = {k: v for k, v in f.items() if k != "all_contacts"}
    if not criteria and f.get("all_contacts") is not True:
        return None, f, "empty_filter: передай filter (или agent_contact_ids), либо filter.all_contacts=true для всей базы"

    q, err = _contact_filter_query(db, user_id, agent_config_id, criteria)
    return q, criteria, err


def _bulk_limit(args: dict) -> int:
    return max(1, min(_as_int(args.get("max_contacts"), BULK_ACTION_MAX), BULK_ACTION_MAX))


# ============================================================================
# TOOL DEFINITIONS FOR GPT-5 RESPONSES API
# ============================================================================

# ============================================================================
# FILES — PDF и таблицы xlsx (services/agent_files.py). Только v3: домешиваются
# в build_chat_tools / build_postcall_tools. Файл хранится в agent_files, в ответе
# file_id (для отправки вложением) и публичная ссылка url.
# ============================================================================

EXPORT_CONTACTS_MAX = 10000

CREATE_PDF_DOCUMENT_TOOL = {
    "type": "function",
    "name": "create_pdf_document",
    "description": (
        "Создать PDF-документ: коммерческое предложение, счёт-памятку, итоги разговора, "
        "инструкцию, отчёт. Текст пиши сам в content простой разметкой: «# », «## », «### » — "
        "заголовки; «- » — список; «1. » — нумерованный список; строки «| a | b |» — таблица "
        "(первая строка — шапка); **жирный**; «---» — разделитель; пустая строка — новый "
        "абзац. В ответе file_id и url. Отправить клиенту — telegram_send_message / "
        "max_send_message с file_id или ссылкой url в send_sms; владельцу — "
        "send_telegram_notification с file_id. Не выдумывай цены и условия — бери из базы "
        "знаний и инструкций владельца."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Заголовок документа (крупно вверху первой страницы)"},
            "content": {"type": "string", "description": "Текст документа в простой разметке (см. описание)"},
            "filename": {"type": "string", "description": "Имя файла без расширения, например «КП Ромашка»"},
            "agent_contact_id": {"type": "string", "description": "UUID контакта, если документ для конкретного клиента"},
        },
        "required": ["title", "content"],
    },
}

CREATE_SPREADSHEET_TOOL = {
    "type": "function",
    "name": "create_spreadsheet",
    "description": (
        "Создать таблицу Excel (.xlsx) из своих данных: прайс, сравнение, отчёт, список. "
        "sheets — листы: name, columns (шапка) и rows (строки: массивы значений в порядке "
        "columns). Числа передавай числами, чтобы в Excel их можно было считать. Для выгрузки "
        "базы контактов есть export_contacts_table. В ответе file_id и url."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "filename": {"type": "string", "description": "Имя файла без расширения"},
            "sheets": {
                "type": "array",
                "description": "Листы таблицы (до 10)",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Название листа (до 31 символа)"},
                        "columns": {"type": "array", "items": {"type": "string"}, "description": "Заголовки колонок"},
                        "rows": {
                            "type": "array",
                            "description": "Строки данных (до 5000 на лист)",
                            "items": {"type": "array", "items": {}},
                        },
                    },
                    "required": ["columns", "rows"],
                },
            },
            "agent_contact_id": {"type": "string", "description": "UUID контакта, если таблица для конкретного клиента"},
        },
        "required": ["sheets"],
    },
}

EXPORT_CONTACTS_TABLE_TOOL = {
    "type": "function",
    "name": "export_contacts_table",
    "description": (
        "Выгрузить контакты агента в Excel по фильтру (те же поля, что у search_contacts, "
        "внутри filter): «скинь таблицу тех, кто не отвечает неделю», «выгрузи отказников». "
        "Лист «Контакты»: данные, стадия, итог последнего звонка, память, следующий шаг; "
        "при include_calls=true — ещё лист «Звонки» с транскриптами. Вся база — "
        "filter={all_contacts:true}. В ответе число строк, file_id и url."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "filter": BULK_FILTER_SCHEMA,
            "include_calls": {"type": "boolean", "description": "Добавить лист «Звонки» с историей и транскриптами (по умолчанию false)"},
            "filename": {"type": "string", "description": "Имя файла без расширения"},
        },
        "required": ["filter"],
    },
}

GET_AGENT_FILES_TOOL = {
    "type": "function",
    "name": "get_agent_files",
    "description": (
        "Список файлов, которые ты уже создал (PDF, таблицы), новые сверху: file_id, имя, "
        "контакт, дата, url. Нужен, чтобы повторно отправить готовый документ, а не делать заново."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_contact_id": {"type": "string", "description": "Только файлы этого контакта"},
            "limit": {"type": "integer", "description": "Сколько файлов (по умолчанию 20, максимум 50)"},
        },
    },
}

FILE_CHAT_TOOLS = [CREATE_PDF_DOCUMENT_TOOL, CREATE_SPREADSHEET_TOOL, EXPORT_CONTACTS_TABLE_TOOL, GET_AGENT_FILES_TOOL]
FILE_POSTCALL_TOOLS = [CREATE_PDF_DOCUMENT_TOOL, CREATE_SPREADSHEET_TOOL, GET_AGENT_FILES_TOOL]


def _attachment(args: dict, db: Session, agent_config_id) -> tuple:
    """
    Файл-вложение по args.file_id (только файлы этого агента).
    Возвращает (AgentFile | None, error | None).
    """
    fid = (args.get("file_id") or "").strip() if isinstance(args.get("file_id"), str) else args.get("file_id")
    if not fid:
        return None, None
    f = agent_files.get_agent_file(db, fid, agent_config_id)
    if f is None:
        safe_rollback(db)
        return None, "Файл не найден — возьми file_id из create_pdf_document / get_agent_files"
    return f, None


def _body_with_attachment(text: str, f) -> str:
    """Текст для треда/хронологии: сообщение + пометка о вложении."""
    if f is None:
        return text
    mark = f"[📎 {f.filename}]"
    return f"{text}\n{mark}" if text else mark


def _file_contact_id(args: dict, db: Session, user_id: str, agent_config_id: str):
    """agent_contact_id из аргументов, если это контакт этого агента. (id, error)."""
    cid = args.get("agent_contact_id")
    if not cid:
        return None, None
    try:
        row = db.query(AgentContact.id).filter(
            AgentContact.id == cid,
            AgentContact.user_id == user_id,
            AgentContact.agent_config_id == agent_config_id,
        ).first()
    except Exception:
        safe_rollback(db)
        row = None
    if not row:
        return None, "Контакт не найден"
    return row[0], None


async def fn_create_pdf_document(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    title = (args.get("title") or "").strip()
    content = args.get("content") or ""
    contact_id, err = _file_contact_id(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}
    try:
        pdf = await asyncio.to_thread(agent_files.build_pdf, title, content)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    f = agent_files.save_file(
        db, user_id=user_id, agent_config_id=agent_config_id, kind="pdf",
        filename=agent_files.safe_filename(args.get("filename") or title, "pdf"),
        content=pdf, title=title, agent_contact_id=contact_id,
    )
    return agent_files.file_result(f)


async def fn_create_spreadsheet(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    contact_id, err = _file_contact_id(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}
    try:
        data, rows = await asyncio.to_thread(agent_files.build_xlsx, args.get("sheets") or [])
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    name = args.get("filename") or agent_files.default_filename("Таблица")
    f = agent_files.save_file(
        db, user_id=user_id, agent_config_id=agent_config_id, kind="xlsx",
        filename=agent_files.safe_filename(name, "xlsx", "table"),
        content=data, title=name, agent_contact_id=contact_id,
    )
    result = agent_files.file_result(f)
    result["rows"] = rows
    return result


async def fn_export_contacts_table(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    from backend.services.contact_export_service import generate_contacts_export_xlsx

    q, applied, err = _bulk_targets(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}
    total = q.count()
    if total == 0:
        return {"ok": True, "rows": 0, "note": "По фильтру нет контактов — файл не создан"}
    if total > EXPORT_CONTACTS_MAX:
        return {"ok": False, "error": f"Слишком много контактов ({total}); максимум {EXPORT_CONTACTS_MAX} — сузь фильтр"}
    ids = [r[0] for r in q.with_entities(AgentContact.id).all()]

    def _build():
        # Сборка до 10k строк с транскриптами — в потоке и на своей сессии,
        # чтобы не держать event loop.
        from backend.db.session import SessionLocal
        tdb = SessionLocal()
        try:
            return generate_contacts_export_xlsx(
                tdb, agent_config_id, contact_ids=ids, include_calls=bool(args.get("include_calls")),
            )
        finally:
            tdb.close()

    data = await asyncio.to_thread(_build)
    name = args.get("filename") or agent_files.default_filename("Контакты")
    try:
        f = agent_files.save_file(
            db, user_id=user_id, agent_config_id=agent_config_id, kind="xlsx",
            filename=agent_files.safe_filename(name, "xlsx", "contacts"),
            content=data, title=name,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    result = agent_files.file_result(f)
    result["rows"] = total
    result["filter"] = applied
    return result


async def fn_get_agent_files(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    from backend.models.agent_file import AgentFile
    q = db.query(AgentFile).filter(
        AgentFile.agent_config_id == agent_config_id,
        AgentFile.user_id == user_id,
    )
    if args.get("agent_contact_id"):
        q = q.filter(AgentFile.agent_contact_id == args["agent_contact_id"])
    limit = max(1, min(_as_int(args.get("limit"), 20) or 20, 50))
    rows = q.order_by(AgentFile.created_at.desc()).limit(limit).all()
    return {
        "ok": True,
        "files": [{**f.to_dict(), "url": agent_files.public_url(f)} for f in rows],
    }


# ============================================================================
# BULK MESSAGES — массовая рассылка в Telegram/MAX с личного аккаунта владельца.
# Создаёт по Task(channel=telegram|max) на контакт: каждое сообщение составит
# оркестратор в момент отправки по инструкции (как schedule_*_message).
# ============================================================================

MESSENGER_BULK_MAX = 200
# Новые диалоги по номеру: не больше 5 в час на аккаунт (TG/MAX_PHONE_RESOLVE_HOURLY_LIMIT),
# поэтому контактам без переписки пишем не чаще раза в 12 минут.
MESSENGER_COLD_INTERVAL_MIN = 12
MESSENGER_WARM_INTERVAL_MIN = 2

BULK_SCHEDULE_MESSAGES_TOOL = {
    "type": "function",
    "name": "bulk_schedule_messages",
    "description": (
        "Запланировать сообщения группе контактов в Telegram или MAX (личный аккаунт владельца) "
        "по фильтру filter, как у search_contacts: «напиши всем, кто молчит неделю» → "
        "filter={no_reply_days:7}. Передавай ИНСТРУКЦИЮ (цель и тезисы), а не готовый текст: "
        "каждому клиенту сообщение составится отдельно в момент отправки с учётом его памяти "
        "и переписки (это отдельный прогон модели на каждого — стоит кредитов). «Не звонить» "
        "пропускаются всегда. Контактам без переписки пишем не чаще раза в 12 минут "
        "(антиспам мессенджеров). Выполняй только по явной просьбе владельца; сначала "
        "dry_run=true и назови число."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "filter": BULK_FILTER_SCHEMA,
            "channel": {"type": "string", "enum": ["telegram", "max"], "description": "Мессенджер"},
            "instruction": {"type": "string", "description": "Что и зачем написать (не готовый текст)"},
            "start_at": {"type": "string", "description": "Время первого сообщения ISO 8601 UTC (по умолчанию через 3 минуты)"},
            "interval_minutes": {"type": "integer", "description": "Интервал между сообщениями, минут (по умолчанию 15)"},
            "title": {"type": "string", "description": "Название задач (видно в календаре)"},
            "skip_if_scheduled": {
                "type": "boolean",
                "description": "Пропускать контакты, которым в этот мессенджер уже запланировано сообщение (по умолчанию true)",
            },
            "sort": {"type": "string", "enum": CONTACT_SORT_KEYS, "description": "Очерёдность (по умолчанию oldest)"},
            "dry_run": BULK_COMMON_PROPERTIES["dry_run"],
            "max_contacts": {
                "type": "integer",
                "description": f"Не больше N контактов за вызов (по умолчанию и максимум {MESSENGER_BULK_MAX})",
            },
        },
        "required": ["filter", "channel", "instruction"],
    },
}


async def fn_bulk_schedule_messages(args: dict, user_id: str, agent_config, db: Session) -> dict:
    from backend.models.agent_telegram_account import AgentTelegramDialog, AgentTelegramAccount
    from backend.models.agent_max_account import AgentMaxDialog, AgentMaxAccount

    channel = args.get("channel")
    if channel not in ("telegram", "max"):
        return {"ok": False, "error": "channel должен быть telegram или max"}
    svc = max_user_service if channel == "max" else telegram_user_service
    if not svc.is_configured():
        return {"ok": False, "error": svc.error_human("not_configured")}
    if agent_config is None or not svc.account_connected(db, agent_config.id):
        return {"ok": False, "error": svc.error_human("not_connected")}
    agent_config_id = str(agent_config.id)

    instruction = (args.get("instruction") or "").strip()
    if not instruction:
        return {"ok": False, "error": "Пустая инструкция — опиши, что и зачем написать"}

    now_utc = datetime.now(timezone.utc)
    start_dt = _parse_iso_utc(args.get("start_at")) if args.get("start_at") else None
    if start_dt is None or start_dt < now_utc + timedelta(minutes=2):
        start_dt = now_utc + timedelta(minutes=3)

    q, applied, err = _bulk_targets(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}

    excluded_dnc = q.filter(AgentContact.status == "do_not_call").count()
    q = q.filter(AgentContact.status != "do_not_call")

    skipped_scheduled = 0
    if args.get("skip_if_scheduled", True) is not False:
        pending = exists().where(and_(
            Task.agent_contact_id == AgentContact.id,
            Task.is_agent_task == True,
            Task.status == TaskStatus.SCHEDULED,
            Task.channel == channel,
        ))
        skipped_scheduled = q.filter(pending).count()
        q = q.filter(~pending)

    # Есть ли уже переписка в этом мессенджере (тогда номер резолвить не нужно).
    if channel == "max":
        dialog_exists = exists().where(and_(
            AgentMaxDialog.agent_contact_id == AgentContact.id,
            AgentMaxDialog.account_id == AgentMaxAccount.id,
            AgentMaxAccount.agent_config_id == agent_config.id,
        ))
    else:
        dialog_exists = exists().where(and_(
            AgentTelegramDialog.agent_contact_id == AgentContact.id,
            AgentTelegramDialog.account_id == AgentTelegramAccount.id,
            AgentTelegramAccount.agent_config_id == agent_config.id,
        ))

    total = q.count()
    without_dialog = q.filter(~dialog_exists).count()
    limit = max(1, min(_as_int(args.get("max_contacts"), MESSENGER_BULK_MAX) or MESSENGER_BULK_MAX, MESSENGER_BULK_MAX))
    interval = max(1, min(_as_int(args.get("interval_minutes"), 15) or 15, 1440))
    min_interval = MESSENGER_COLD_INTERVAL_MIN if without_dialog else MESSENGER_WARM_INTERVAL_MIN
    interval_raised = interval < min_interval
    interval = max(interval, min_interval)
    sort = args.get("sort") or "oldest"

    if args.get("dry_run"):
        preview = _bulk_preview(q, total, limit, sort)
        preview.update({
            "channel": channel,
            "excluded_do_not_call": excluded_dnc,
            "skipped_already_scheduled": skipped_scheduled,
            "without_dialog": without_dialog,
            "interval_minutes": interval,
            "estimated_duration_minutes": interval * max(0, min(total, limit) - 1),
        })
        return preview
    if total == 0:
        return {
            "ok": False, "error": "no_contacts_matched",
            "excluded_do_not_call": excluded_dnc, "skipped_already_scheduled": skipped_scheduled,
        }

    contacts = _sort_contacts(q, sort).limit(limit).all()
    title = args.get("title") or ("Сообщение в MAX" if channel == "max" else "Сообщение в Telegram")
    task_kwargs = assistant_task_kwargs(agent_config)

    scheduled = []
    for i, contact in enumerate(contacts):
        slot = start_dt + timedelta(minutes=interval * i)
        if isinstance(contact.memory, dict):
            snooze_until = _parse_iso_utc(contact.memory.get("snooze_until"))
            if snooze_until and slot < snooze_until:
                slot = snooze_until
        task = Task(
            is_agent_task=True,
            channel=channel,
            agent_contact_id=contact.id,
            user_id=user_id,
            contact_id=None,
            status=TaskStatus.SCHEDULED,
            scheduled_time=slot,
            title=title,
            description=instruction,
            **task_kwargs,
        )
        db.add(task)
        scheduled.append((task, contact, slot))
    db.commit()
    logger.info(
        f"[AGENT-TOOLS] Bulk scheduled {len(scheduled)} {channel} messages for user {user_id} (filter={applied})"
    )

    slots = [slot for _, _, slot in scheduled]
    result = {
        "ok": True,
        "channel": channel,
        "scheduled_count": len(scheduled),
        "remaining_not_scheduled": max(0, total - len(scheduled)),
        "excluded_do_not_call": excluded_dnc,
        "skipped_already_scheduled": skipped_scheduled,
        "without_dialog": without_dialog,
        "interval_minutes": interval,
        "first_message_at": min(slots).isoformat(),
        "last_message_at": max(slots).isoformat(),
        "tasks": [
            {"task_id": str(t.id), "agent_contact_id": str(c.id), "contact_name": c.name or c.phone,
             "scheduled_at": sl.isoformat()}
            for t, c, sl in scheduled[:20]
        ],
        "tasks_truncated": len(scheduled) > 20,
    }
    if interval_raised:
        result["note"] = (
            f"Интервал поднят до {interval} мин: контактов без переписки — {without_dialog}, "
            "а новые диалоги мессенджер разрешает открывать не чаще 5 в час."
        )
    return result


AGENT_CHAT_TOOLS = [
    {
        "type": "function",
        "name": "create_agent_contact",
        "description": "Создать новый контакт в базе агента для обзвона.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя контакта"},
                "phone": {"type": "string", "description": "Номер телефона (обязательно)"},
                "company": {"type": "string", "description": "Компания"},
                "position": {"type": "string", "description": "Должность"},
                "notes": {"type": "string", "description": "Заметки о контакте"},
            },
            "required": ["phone"],
        },
    },
    {
        "type": "function",
        "name": "create_agent_task",
        "description": (
            "Создать задачу на звонок контакту агента в указанное время. "
            "Время задай ОДНИМ из способов: delay_minutes — для относительного "
            "(«через N минут/часов»), scheduled_at — для абсолютного («завтра в 14:00»)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "scheduled_at": {
                    "type": "string",
                    "description": (
                        "Абсолютные дата и время звонка ISO 8601 UTC (например 2026-07-09T12:00:00Z). "
                        "Не используй для «через N минут» — для этого есть delay_minutes"
                    ),
                },
                "delay_minutes": {
                    "type": "integer",
                    "description": (
                        "Через сколько минут позвонить. Сервер сам вычислит точное время от "
                        "текущего момента — ВСЕГДА используй этот параметр, когда просят "
                        "перезвонить «через N минут/часов», не вычисляй scheduled_at сам."
                    ),
                },
                "title": {"type": "string", "description": "Название задачи"},
                "notes": {"type": "string", "description": "Описание / заметки"},
            },
            "required": ["agent_contact_id", "title"],
        },
    },
    {
        "type": "function",
        "name": "get_agent_contacts",
        "description": (
            "Свежий общий список контактов агента (новые сверху), постранично. То же, что "
            "search_contacts без фильтров; для поиска, отбора и подсчёта используй search_contacts."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": f"Сколько контактов вернуть (по умолчанию 50, максимум {CONTACT_LIST_MAX})"},
                "offset": {"type": "integer", "description": "Сколько пропустить — для следующей страницы бери next_offset из ответа"},
            },
        },
    },
    {
        "type": "function",
        "name": "get_contact_call_history",
        "description": "Получить историю звонков конкретного контакта агента.",
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            },
            "required": ["agent_contact_id"],
        },
    },
    {
        "type": "function",
        "name": "get_contact_timeline",
        "description": (
            "Получить ЕДИНУЮ хронологию всего общения с контактом по ВСЕМ каналам "
            "(звонки + SMS + Telegram) в одном списке с метками времени, старые → "
            "новые. Используй, когда владелец просит показать всю переписку/историю "
            "общения с человеком, восстановить контекст или понять, о чём "
            "договаривались — вместо раздельных get_contact_call_history / "
            "telegram_get_thread."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "days": {"type": "integer", "description": "Окно в днях (по умолчанию 90; 0 — без ограничения)"},
                "limit": {"type": "integer", "description": "Максимум событий (по умолчанию 100)"},
            },
            "required": ["agent_contact_id"],
        },
    },
    {
        "type": "function",
        "name": "get_agent_tasks",
        "description": "Получить список задач на звонки. Использовать когда пользователь спрашивает о запланированных звонках, расписании, следующих задачах. Также вызывать ПЕРЕД созданием новой задачи чтобы проверить дубли. Для количества задач по статусам опирайся на поля status_counts и scheduled_count из ответа (точные счётчики по всей выборке), а не пересчитывай массив tasks — он ограничен лимитом.",
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {
                    "type": "string",
                    "description": "UUID контакта агента — фильтр по конкретному контакту (опционально)",
                },
                "status_filter": {
                    "type": "string",
                    "description": "Фильтр по статусу: scheduled, completed, failed, cancelled (опционально)",
                },
            },
        },
    },
    {
        "type": "function",
        "name": "get_agent_stats",
        "description": "Получить сводную статистику агента: контакты, звонки, задачи.",
        "parameters": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "type": "function",
        "name": "delete_agent_task",
        "description": "Удалить задачу на звонок по её ID. Используй когда пользователь просит удалить, убрать или отменить запланированный звонок/задачу. Сначала вызови get_agent_tasks, чтобы найти нужный task_id. Удаление необратимо — задача исчезает из календаря и не будет выполнена планировщиком.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "UUID задачи, которую нужно удалить",
                },
            },
            "required": ["task_id"],
        },
    },
    {
        "type": "function",
        "name": "search_contacts",
        "description": (
            "Найти, отобрать и посчитать контакты в базе агента. Фильтры: подстрока имени/телефона/"
            "компании, стадии, число попыток, давность звонка, дата добавления, наличие запланированного "
            "звонка. Ответ всегда содержит total — точное число подходящих контактов во всей базе. "
            "Нужно только число («сколько…») → count_only=true, строки не придут. Нужен список → "
            f"limit (по умолчанию {CONTACT_LIST_DEFAULT}, максимум {CONTACT_LIST_MAX}); если has_more=true, "
            "следующая страница — offset=next_offset. Не листай всю базу ради действия: чтобы "
            "обзвонить, сменить стадию или отменить звонки группе, передай тот же фильтр в "
            "bulk_schedule_calls / bulk_move_contacts_stage / bulk_cancel_calls."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                **CONTACT_FILTER_PROPERTIES,
                "sort": {
                    "type": "string", "enum": CONTACT_SORT_KEYS,
                    "description": (
                        "Порядок: newest (новые, по умолчанию), oldest, last_called_oldest (давно не звонили "
                        "и никогда не звонили — первыми), last_called_newest, attempts_most, name"
                    ),
                },
                "limit": {"type": "integer", "description": f"Сколько строк вернуть (по умолчанию {CONTACT_LIST_DEFAULT}, максимум {CONTACT_LIST_MAX})"},
                "offset": {"type": "integer", "description": "Сколько пропустить — для следующей страницы бери next_offset"},
                "count_only": {"type": "boolean", "description": "true — вернуть только total без списка"},
            },
        },
    },
    {
        "type": "function",
        "name": "get_contact_details",
        "description": (
            "Получить полную карточку одного контакта: базовые поля, стадию воронки, заметки, "
            "память агента (summary, ключевые факты, лучшее время, история тона), число попыток, "
            "дату последнего звонка и краткую сводку по последним звонкам. Используй для запросов "
            "вида 'расскажи всё про Иванова', 'что мы знаем о контакте'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            },
            "required": ["agent_contact_id"],
        },
    },
    {
        "type": "function",
        "name": "get_contacts_by_stage",
        "description": (
            "Получить разбивку контактов по стадиям воронки: счётчик по каждой стадии "
            "(new/active/success/rejected/do_not_call) и небольшой пример контактов в каждой. "
            "Используй для вопросов 'как распределены контакты', 'сколько в работе/успехов/отказов', "
            "'покажи воронку'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "bulk_create_contacts",
        "description": (
            "Создать сразу несколько контактов одним вызовом. Используй когда пользователь "
            "присылает список людей для обзвона. У каждого контакта обязателен phone. "
            "Дубли по номеру телефона (уже есть в базе) пропускаются."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "contacts": {
                    "type": "array",
                    "description": "Список контактов для создания",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "phone": {"type": "string", "description": "Номер телефона (обязательно)"},
                            "company": {"type": "string"},
                            "position": {"type": "string"},
                            "notes": {"type": "string"},
                        },
                        "required": ["phone"],
                    },
                },
            },
            "required": ["contacts"],
        },
    },
    {
        "type": "function",
        "name": "delete_agent_contact",
        "description": (
            "Удалить контакт из базы агента по его UUID. Вместе с контактом удаляется его история "
            "звонков, а запланированные задачи отвязываются. Удаление необратимо — используй только "
            "по явной просьбе пользователя ('удали контакт', 'убери из базы'). Если нужно просто "
            "перестать звонить — лучше move_contact_stage в do_not_call."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
            },
            "required": ["agent_contact_id"],
        },
    },
    {
        "type": "function",
        "name": "append_contact_note",
        "description": (
            "Дописать заметку к контакту, НЕ стирая существующие заметки (в отличие от update_contact_info, "
            "который перезаписывает поле notes целиком). Каждая заметка добавляется новой строкой с датой. "
            "Используй когда узнал новый факт о клиенте и хочешь его сохранить, не теряя прежние записи."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "note": {"type": "string", "description": "Текст заметки для добавления"},
            },
            "required": ["agent_contact_id", "note"],
        },
    },
    {
        "type": "function",
        "name": "update_agent_task",
        "description": (
            "Изменить существующую запланированную задачу на звонок: перенести время и/или поменять "
            "название/описание. Используй для 'перенеси звонок Иванову на завтра 15:00', 'переименуй задачу'. "
            "Сначала найди task_id через get_agent_tasks или get_upcoming_schedule. Время передавай в UTC. "
            "Менять можно только задачи в статусе scheduled."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "UUID задачи"},
                "scheduled_at": {"type": "string", "description": "Новое время звонка ISO 8601 (UTC), опционально"},
                "title": {"type": "string", "description": "Новое название задачи (опционально)"},
                "notes": {"type": "string", "description": "Новое описание (опционально)"},
            },
            "required": ["task_id"],
        },
    },
    {
        "type": "function",
        "name": "get_upcoming_schedule",
        "description": (
            "Получить календарь ближайших запланированных звонков по ВСЕМ контактам (а не по одному). "
            "Используй для 'что у меня на сегодня/завтра', 'какие звонки впереди', 'покажи расписание'. "
            "Возвращает задачи в статусе scheduled, отсортированные по времени."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "За сколько ближайших дней показывать (по умолчанию 7)"},
                "limit": {"type": "integer", "description": "Максимум задач (по умолчанию 50)"},
            },
        },
    },
    {
        "type": "function",
        "name": "bulk_schedule_calls",
        "description": (
            "Запланировать обзвон группы контактов с интервалом, начиная с start_at. Группу задаёшь "
            "фильтром filter (те же поля, что у search_contacts) — сервер сам выберет контакты, "
            "выгружать их список не нужно. Примеры: «обзвони всех новых завтра с 10:00» → "
            "filter={stage:'new'}; «перезвони тем, кому не звонили неделю и было меньше 3 попыток» → "
            "filter={not_called_days:7, attempts_max:2}. Контакты «Не звонить» (do_not_call) "
            "не планируются никогда; тем, у кого уже есть запланированный звонок, новый не ставится "
            "(skip_if_scheduled). Для большой группы сначала вызови с dry_run=true и назови владельцу "
            "число. Время start_at в UTC; звонки сдвигаются в рабочие часы агента."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filter": BULK_FILTER_SCHEMA,
                "agent_contact_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Устаревший способ: список UUID контактов (лучше filter.agent_contact_ids)",
                },
                "stage": {"type": "string", "enum": AGENT_CONTACT_STAGE_KEYS, "description": "Устаревший способ: стадия (лучше filter.stage)"},
                "start_at": {"type": "string", "description": "Время первого звонка ISO 8601 (UTC)"},
                "interval_minutes": {"type": "integer", "description": "Интервал между звонками в минутах (по умолчанию 15)"},
                "title": {"type": "string", "description": "Название задач (по умолчанию 'Звонок агента')"},
                "sort": {"type": "string", "enum": CONTACT_SORT_KEYS, "description": "Очерёдность звонков (по умолчанию oldest — в порядке добавления)"},
                "skip_if_scheduled": {"type": "boolean", "description": "Пропускать контакты с уже запланированным звонком (по умолчанию true)"},
                **BULK_COMMON_PROPERTIES,
            },
            "required": ["start_at"],
        },
    },
    {
        "type": "function",
        "name": "bulk_move_contacts_stage",
        "description": (
            "Перевести группу контактов на стадию воронки одним вызовом, по фильтру filter (поля как у "
            "search_contacts) или по списку filter.agent_contact_ids. Например: «всех, кому звонили 5+ раз "
            "без результата, в отказ» → filter={stages:['new','active'], attempts_min:5}, stage='rejected'. "
            "Контакты «Не звонить» затрагиваются, только если фильтр явно указывает стадию do_not_call. "
            "При переводе в do_not_call их запланированные звонки отменяются. Перед изменением большой "
            "группы вызови с dry_run=true и подтверди число с владельцем."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filter": BULK_FILTER_SCHEMA,
                "stage": {"type": "string", "enum": AGENT_CONTACT_STAGE_KEYS, "description": "Новая стадия"},
                "reason": {"type": "string", "description": "Краткая причина (для журнала)"},
                **BULK_COMMON_PROPERTIES,
            },
            "required": ["filter", "stage"],
        },
    },
    {
        "type": "function",
        "name": "bulk_cancel_calls",
        "description": (
            "Отменить запланированные задачи (звонки и отложенные сообщения) у группы контактов по "
            "фильтру filter. Например: «отмени все звонки отказникам» → filter={stage:'rejected'}; "
            "«сними всё, что запланировано компании Ромашка» → filter={company:'Ромашка'}. "
            "Задачи получают статус cancelled. Для одной задачи используй delete_agent_task. "
            "Выполняй только по явной просьбе; для большой группы сначала dry_run=true."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filter": BULK_FILTER_SCHEMA,
                "channel": {
                    "type": "string", "enum": ["call", "telegram", "max", "reply_check", "all"],
                    "description": (
                        "Какие задачи отменить: call — звонки (по умолчанию), telegram/max — сообщения, "
                        "reply_check — проверки ответа, all — все"
                    ),
                },
                **BULK_COMMON_PROPERTIES,
            },
            "required": ["filter"],
        },
    },
    {
        "type": "function",
        "name": "trigger_immediate_call",
        "description": (
            "Позвонить контакту прямо сейчас — создаёт задачу на ближайшее выполнение (планировщик подхватит "
            "её в течение ~30 секунд). В отличие от create_agent_task, НЕ сдвигает время в рабочие часы — "
            "звонок уйдёт немедленно. Используй только по явной просьбе 'позвони ему сейчас', 'набери немедленно'. "
            "Перед звонком убедись, что агент активен."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "title": {"type": "string", "description": "Название задачи (опционально)"},
            },
            "required": ["agent_contact_id"],
        },
    },
    {
        "type": "function",
        "name": "snooze_contact",
        "description": (
            "Приостановить звонки контакту до указанной даты: отменяет все его запланированные задачи и "
            "запрещает планировать новые звонки раньше этой даты (последующие create_agent_task автоматически "
            "сдвинутся на дату окончания паузы). Используй для 'не звони Иванову до понедельника', "
            "'поставь на паузу до 15 числа'. Дату окончания паузы передавай в UTC."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "until": {"type": "string", "description": "Дата окончания паузы ISO 8601 (UTC)"},
            },
            "required": ["agent_contact_id", "until"],
        },
    },
    {
        "type": "function",
        "name": "get_call_transcript",
        "description": (
            "Получить ПОЛНЫЙ транскрипт конкретного звонка по его UUID (get_contact_call_history отдаёт только "
            "первые 500 символов). Используй когда пользователь просит 'покажи весь разговор', 'что именно сказал клиент'. "
            "Сначала найди agent_call_id через get_contact_call_history."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_call_id": {"type": "string", "description": "UUID звонка (AgentCall)"},
            },
            "required": ["agent_call_id"],
        },
    },
    {
        "type": "function",
        "name": "get_period_report",
        "description": (
            "Сводный отчёт по звонкам за период: всего звонков, дозвонов, успехов, перезвонов, недозвонов, "
            "суммарная и средняя длительность, конверсия. Используй для 'как прошла неделя', 'отчёт за месяц', "
            "'статистика с 1 по 7 число'. Даты передавай в UTC; если не указаны — берётся последние 7 дней."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "date_from": {"type": "string", "description": "Начало периода ISO 8601 (UTC), опционально"},
                "date_to": {"type": "string", "description": "Конец периода ISO 8601 (UTC), опционально"},
            },
        },
    },
    {
        "type": "function",
        "name": "get_failed_calls",
        "description": (
            "Получить список недозвонов и неудачных звонков как очередь на перезвон — по одному (последнему) "
            "звонку на контакт, с данными контакта. Используй для 'кому не дозвонились', 'покажи недозвоны', "
            "'кого надо перезвонить'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Максимум контактов (по умолчанию 30)"},
            },
        },
    },
    UPDATE_CONTACT_INFO_TOOL,
    MOVE_CONTACT_STAGE_TOOL,
    SEARCH_KNOWLEDGE_BASE_TOOL,
    SEND_SMS_TOOL,
    SEND_WEBHOOK_TOOL,
    SEND_TELEGRAM_NOTIFICATION_TOOL,
    UPDATE_AGENT_MEMORY_TOOL,
]


AGENT_POSTCALL_TOOLS = [
    {
        "type": "function",
        "name": "update_contact_memory",
        "description": "Обновить память агента о контакте после звонка.",
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "summary": {"type": "string", "description": "Краткий итог звонка"},
                "key_facts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Новые факты о контакте",
                },
                "best_time": {"type": "string", "description": "Лучшее время для звонка или null"},
                "tone": {"type": "string", "description": "Тон разговора (дружелюбный/деловой/холодный)"},
            },
            "required": ["agent_contact_id", "summary"],
        },
    },
    {
        "type": "function",
        "name": "create_agent_task",
        "description": (
            "Создать задачу на перезвон. После исходящего звонка следующее касание "
            "планируется ВСЕГДА, кроме случая когда цель звонка уже достигнута: "
            "перезвон — этим tool, отложенное сообщение — schedule_telegram_message "
            "(если доступен). "
            "Время задай ОДНИМ из способов: delay_minutes — для относительного "
            "(«через N минут/часов»), scheduled_at — для абсолютного («завтра в 14:00»)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "scheduled_at": {
                    "type": "string",
                    "description": (
                        "Абсолютные дата и время звонка ISO 8601 UTC (например 2026-07-09T12:00:00Z). "
                        "Не используй для «через N минут» — для этого есть delay_minutes"
                    ),
                },
                "delay_minutes": {
                    "type": "integer",
                    "description": (
                        "Через сколько минут позвонить. Сервер сам вычислит точное время от "
                        "текущего момента — ВСЕГДА используй этот параметр, когда просят "
                        "перезвонить «через N минут/часов», не вычисляй scheduled_at сам."
                    ),
                },
                "title": {"type": "string", "description": "Название задачи"},
                "notes": {"type": "string", "description": "Описание / заметки"},
            },
            "required": ["agent_contact_id", "title"],
        },
    },
    SEND_TELEGRAM_NOTIFICATION_TOOL,
    UPDATE_CONTACT_INFO_TOOL,
    MOVE_CONTACT_STAGE_TOOL,
    SEARCH_KNOWLEDGE_BASE_TOOL,
    SEND_SMS_TOOL,
    SEND_WEBHOOK_TOOL,
    UPDATE_AGENT_MEMORY_TOOL,
]


# ============================================================================
# TOOL IMPLEMENTATIONS
# ============================================================================

async def fn_create_agent_contact(args: dict, agent_config_id: str, user_id: str, db: Session) -> dict:
    contact = AgentContact(
        agent_config_id=agent_config_id,
        user_id=user_id,
        name=args.get("name"),
        phone=args["phone"],
        company=args.get("company"),
        position=args.get("position"),
        notes=args.get("notes"),
        status="new",
        memory={},
    )
    db.add(contact)
    db.commit()
    db.refresh(contact)
    logger.info(f"[AGENT-TOOLS] Created contact {contact.id} ({contact.phone})")
    return {"ok": True, "contact_id": str(contact.id), "phone": contact.phone, "name": contact.name}


async def fn_create_agent_task(args: dict, user_id: str, agent_config_id: str, db: Session, channel: str = "call") -> dict:
    """
    Создать агентскую задачу. channel="call" (дефолт) — задача на звонок,
    channel="telegram" — отложенное сообщение с личного Telegram-аккаунта
    (для него не применяются рабочие часы: писать можно в любое время).
    """
    is_telegram = channel == "telegram"
    is_max = channel == "max"
    is_messenger = is_telegram or is_max  # отложенное сообщение, не звонок
    is_reply_check = channel == REPLY_CHECK_CHANNEL  # проверка ответа, не звонок
    agent_contact_id = args["agent_contact_id"]

    # Изоляция агентов: задачу можно ставить только своему контакту.
    owner = db.query(AgentContact.id).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not owner:
        return {"ok": False, "error": "Contact not found"}

    # Время задачи: delay_minutes (относительное, сервер считает сам) имеет
    # приоритет над scheduled_at (абсолютное, посчитанное моделью).
    now_utc = datetime.now(timezone.utc)
    clamped_to_future = False
    scheduled_at = None
    if args.get("delay_minutes") is not None:
        try:
            scheduled_at = now_utc + timedelta(minutes=max(1, int(args["delay_minutes"])))
        except (ValueError, TypeError):
            scheduled_at = None  # битое значение → падаем в ветку scheduled_at
    if scheduled_at is None:
        try:
            scheduled_at = datetime.fromisoformat(str(args["scheduled_at"]).replace("Z", "+00:00"))
        except (KeyError, ValueError, TypeError):
            scheduled_at = datetime.utcnow() + timedelta(hours=1)
        # Клэмп: модель могла посчитать время от устаревшего значения в промпте.
        sched_aware = scheduled_at if scheduled_at.tzinfo else scheduled_at.replace(tzinfo=timezone.utc)
        if sched_aware < now_utc + timedelta(minutes=2):
            scheduled_at = now_utc + timedelta(minutes=3)
            clamped_to_future = True
            logger.info(f"[AGENT-TOOLS] scheduled_at in the past, clamped to {scheduled_at.isoformat()}")

    # Get assistant from agent_config (type-aware — gemini/openai/cartesia/yandex)
    agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()

    # Учитываем паузу контакта (snooze): если контакт на паузе до даты в будущем —
    # сдвигаем звонок на момент окончания паузы (раньше звонить нельзя).
    snooze_contact = db.query(AgentContact).filter(AgentContact.id == agent_contact_id).first()
    if snooze_contact and isinstance(snooze_contact.memory, dict):
        snooze_until_raw = snooze_contact.memory.get("snooze_until")
        snooze_until = _parse_iso_utc(snooze_until_raw) if snooze_until_raw else None
        if snooze_until:
            sched_aware = scheduled_at if scheduled_at.tzinfo else scheduled_at.replace(tzinfo=timezone.utc)
            if sched_aware < snooze_until:
                scheduled_at = snooze_until
                logger.info(f"[AGENT-TOOLS] Contact {agent_contact_id} snoozed until {snooze_until}, shifting task to it")

    # Унифицированная проверка рабочих часов агента (МСК) — переносим звонок
    # на ближайший рабочий день, если время выпадает на нерабочие часы.
    # Сообщения мессенджеров (Telegram/MAX) и проверка ответа рабочими часами
    # не ограничены (звонок по итогам проверки сам сдвинется в рабочие часы).
    if agent_config is not None and not is_messenger and not is_reply_check:
        adjusted, _shifted = adjust_to_working_hours(
            scheduled_at,
            agent_config.working_hours_start,
            agent_config.working_hours_end,
        )
        scheduled_at = adjusted

    # Cancel only exact-time duplicates for this contact (same contact + same
    # scheduled_time + same channel). Tasks scheduled for other dates/times are
    # preserved, so a contact can have several upcoming calls planned at
    # different moments; звонок и telegram-сообщение на одно время — не дубли.
    existing_tasks = db.query(Task).filter(
        Task.agent_contact_id == agent_contact_id,
        Task.status == TaskStatus.SCHEDULED,
        Task.is_agent_task == True,
        Task.scheduled_time == scheduled_at,
        Task.channel == channel,
    ).all()

    cancelled_count = 0
    for existing_task in existing_tasks:
        existing_task.status = TaskStatus.CANCELLED
        cancelled_count += 1

    if cancelled_count > 0:
        logger.info(f"[AGENT-TOOLS] Cancelled {cancelled_count} duplicate SCHEDULED tasks for contact {agent_contact_id} at {scheduled_at}")

    # Create new task — route assistant to the correct Task FK by type.
    # Для telegram-задач ассистент не нужен (исполняет оркестратор, не звонилка),
    # но FK заполняем как обычно — это безвредно и упрощает конверсию в звонок.
    task = Task(
        is_agent_task=True,
        channel=channel,
        agent_contact_id=agent_contact_id,
        user_id=user_id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=scheduled_at,
        title=args.get("title") or (
            "Проверка ответа" if is_reply_check else
            "Сообщение в MAX" if is_max else
            "Сообщение в Telegram" if is_telegram else
            "Звонок агента"
        ),
        description=args.get("notes", ""),
        **assistant_task_kwargs(agent_config),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    logger.info(f"[AGENT-TOOLS] Created agent task {task.id} (channel={channel}) for contact {agent_contact_id} at {scheduled_at}")
    result = {
        "ok": True,
        "task_id": str(task.id),
        "channel": channel,
        "scheduled_at": scheduled_at.isoformat(),
        "cancelled_duplicates": cancelled_count,
    }
    if clamped_to_future:
        result["note"] = "scheduled_at был в прошлом — время поднято до ближайшего будущего"
    return result


async def fn_update_contact_memory(args: dict, agent_config_id: str, db: Session) -> dict:
    agent_contact_id = args["agent_contact_id"]
    # Изоляция агентов: память можно обновлять только своему контакту.
    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    memory = contact.memory or {}

    if "summary" in args:
        memory["summary"] = args["summary"]
    if "best_time" in args and args["best_time"]:
        memory["best_time"] = args["best_time"]
    if "tone" in args:
        tone_list = memory.get("tone_history", [])
        tone_list.append(args["tone"])
        memory["tone_history"] = tone_list[-10:]
    if "key_facts" in args:
        facts = set(memory.get("key_facts", []))
        facts.update(args["key_facts"])
        memory["key_facts"] = list(facts)

    memory["attempts"] = (memory.get("attempts", 0)) + 1
    memory["last_call"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M")

    contact.memory = memory
    flag_modified(contact, 'memory')
    db.commit()
    logger.info(f"[AGENT-TOOLS] Updated memory for contact {agent_contact_id}")
    return {"ok": True, "contact_id": agent_contact_id}


async def fn_update_agent_memory(args: dict, agent_config_id: str, db: Session) -> dict:
    """
    Точечные операции над памятью агента (add / update / delete). Атомарно под
    FOR UPDATE строки агента — см. agent_memory.lock_and_apply. Возвращает
    отчёт: что применилось, что нет и почему (модель видит ошибки и лимиты).
    """
    if not agent_config_id:
        return {"ok": False, "error": "agent_config_id_required"}
    add = args.get("add") or []
    update = args.get("update") or []
    delete = args.get("delete") or []
    if not isinstance(add, list) or not isinstance(update, list) or not isinstance(delete, list):
        return {"ok": False, "error": "add/update/delete must be arrays"}
    if not (add or update or delete):
        return {"ok": False, "error": "nothing_to_do: pass add, update or delete"}
    return agent_memory.lock_and_apply(
        db, agent_config_id, add=add, update=update, delete=delete, source="agent"
    )


async def fn_update_contact_info(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """
    Обновить базовую информацию о контакте (name/company/position/notes).
    notes — то, что пользователь/агент ЯВНО записали как факт (не путать с memory).
    """
    agent_contact_id = args.get("agent_contact_id")
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    updated_fields = []
    for field in ("name", "company", "position", "notes"):
        if field in args and args[field] is not None:
            setattr(contact, field, args[field])
            updated_fields.append(field)

    if not updated_fields:
        return {"ok": False, "error": "no_fields_to_update"}

    db.commit()
    logger.info(f"[AGENT-TOOLS] Updated contact {agent_contact_id} fields: {updated_fields}")
    return {"ok": True, "contact_id": str(agent_contact_id), "updated_fields": updated_fields}


async def fn_move_contact_stage(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """
    Перевести контакт на стадию воронки (status). Скоупится по user_id +
    agent_config_id, чтобы агент/чат не мог тронуть чужой контакт или контакт
    другого агента. Валидирует стадию по единому справочнику pipeline_stages.
    """
    agent_contact_id = args.get("agent_contact_id")
    stage = args.get("stage")
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}
    if not is_valid_stage(stage):
        return {"ok": False, "error": f"invalid_stage: {stage}"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    old_stage = contact.status
    contact.status = stage
    db.commit()
    logger.info(
        f"[AGENT-TOOLS] Moved contact {agent_contact_id} stage {old_stage} -> {stage} "
        f"(reason: {args.get('reason', '')})"
    )
    return {"ok": True, "contact_id": str(agent_contact_id), "old_stage": old_stage, "stage": stage}


async def fn_get_agent_contacts(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Свежий список контактов постранично — search_contacts без фильтров."""
    return await fn_search_contacts(
        {"limit": args.get("limit") or 50, "offset": args.get("offset"), "sort": "newest"},
        user_id, agent_config_id, db,
    )


async def fn_get_contact_call_history(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    agent_contact_id = args["agent_contact_id"]

    # Изоляция агентов: историю звонков отдаём только по своему контакту.
    owner = db.query(AgentContact.id).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not owner:
        return {"ok": False, "error": "Contact not found"}

    calls = (
        db.query(AgentCall)
        .filter(AgentCall.agent_contact_id == agent_contact_id)
        .order_by(AgentCall.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "ok": True,
        "count": len(calls),
        "calls": [
            {
                "id": str(c.id),
                "status": c.status,
                "post_call_decision": c.post_call_decision,
                "duration_seconds": c.duration_seconds,
                "transcript": (c.transcript[:500] if c.transcript else None),
                "started_at": c.started_at.isoformat() if c.started_at else None,
                "completed_at": c.completed_at.isoformat() if c.completed_at else None,
            }
            for c in calls
        ],
    }


async def fn_get_contact_timeline(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """
    Единая хронология общения с контактом по всем каналам (звонки + SMS +
    Telegram) для чат-оркестратора. Переиспользует build_conversation_timeline
    (ленивый импорт — agent_orchestrator импортирует этот модуль).
    """
    contact = db.query(AgentContact).filter(
        AgentContact.id == args.get("agent_contact_id"),
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    try:
        days = int(args.get("days")) if args.get("days") is not None else 90
    except (TypeError, ValueError):
        days = 90
    try:
        limit = min(int(args.get("limit")) if args.get("limit") is not None else 100, 200)
    except (TypeError, ValueError):
        limit = 100

    from backend.services.agent_orchestrator import build_conversation_timeline
    timeline = build_conversation_timeline(
        db, contact, max_events=limit, days_window=(days or 0)
    )
    if not timeline:
        return {"ok": True, "timeline": "", "note": "Истории общения по этому контакту пока нет."}
    return {"ok": True, "timeline": timeline.strip()}


async def fn_get_agent_tasks(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Получить задачи агента с опциональными фильтрами.

    Согласовано с эндпоинтом календаря (GET /api/agent/tasks): INNER JOIN с
    AgentContact, чтобы не считать «осиротевшие» задачи (agent_contact_id=NULL
    после ON DELETE SET NULL), которых нет в UI.

    Помимо списка задач возвращает status_counts — агрегированные счётчики по
    статусам по ВСЕЙ выборке. Это надёжный источник правды о количестве
    scheduled-задач, который не зависит от лимита выдачи строк (раньше при
    LIMIT 20 + ORDER BY scheduled_time ASC будущие scheduled-задачи отсекались
    старыми завершёнными, и агент видел «0 запланированных»).
    """
    # Базовый фильтр — общий для счётчиков и для списка строк.
    # Изоляция агентов: задачи скоупим через INNER JOIN с AgentContact по
    # agent_config_id (у Task своего agent_config_id нет — как в /api/agent/tasks).
    base_filters = [
        Task.user_id == user_id,
        Task.is_agent_task == True,
        AgentContact.agent_config_id == agent_config_id,
    ]
    if args.get("agent_contact_id"):
        base_filters.append(Task.agent_contact_id == args["agent_contact_id"])

    # Приводим строковый статус к enum (как в /api/agent/tasks). Невалидный
    # статус не роняем — просто игнорируем фильтр.
    status_filter = None
    if args.get("status_filter"):
        try:
            status_filter = TaskStatus(args["status_filter"])
        except ValueError:
            logger.warning(f"[AGENT-TOOLS] Invalid status_filter: {args['status_filter']!r}, ignoring")

    # Агрегированные счётчики по статусам по всей выборке (без лимита).
    count_q = db.query(Task.status, func.count(Task.id)).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(*base_filters)
    if status_filter is not None:
        count_q = count_q.filter(Task.status == status_filter)
    status_counts = {
        (st.value if hasattr(st, "value") else st): cnt
        for st, cnt in count_q.group_by(Task.status).all()
    }
    total = sum(status_counts.values())

    # Список строк: scheduled-задачи первыми, затем по времени — чтобы будущие
    # запланированные звонки не отсекались лимитом.
    q = db.query(Task).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(*base_filters)
    if status_filter is not None:
        q = q.filter(Task.status == status_filter)

    tasks = q.order_by(
        (Task.status == TaskStatus.SCHEDULED).desc(),
        Task.scheduled_time.asc(),
    ).limit(50).all()

    return {
        "ok": True,
        "count": len(tasks),
        "total": total,
        "status_counts": status_counts,
        "scheduled_count": status_counts.get(TaskStatus.SCHEDULED.value, 0),
        "tasks": [
            {
                "id": str(t.id),
                "title": t.title,
                "status": t.status.value if hasattr(t.status, "value") else t.status,
                "channel": t.channel or "call",
                "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
                "description": t.description,
                "agent_contact_id": str(t.agent_contact_id) if t.agent_contact_id else None,
            }
            for t in tasks
        ],
    }


async def fn_delete_agent_task(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Удалить задачу агента по ID.

    Hard-delete (как delete_agent_contact). Скоупится по user_id + is_agent_task
    + agent_config_id (через JOIN с AgentContact), чтобы агент не мог удалить
    чужую, не-агентскую или принадлежащую другому агенту задачу.
    """
    task_id = args.get("task_id")
    if not task_id:
        return {"ok": False, "error": "task_id is required"}

    task = db.query(Task).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(
        Task.id == task_id,
        Task.user_id == user_id,
        Task.is_agent_task == True,
        AgentContact.agent_config_id == agent_config_id,
    ).first()

    if not task:
        logger.warning(f"[AGENT-TOOLS] delete_agent_task: task {task_id} not found for user {user_id}")
        return {"ok": False, "error": "Task not found"}

    title = task.title
    db.delete(task)
    db.commit()

    logger.info(f"[AGENT-TOOLS] Deleted agent task {task_id} ('{title}') for user {user_id}")
    return {"ok": True, "deleted": True, "task_id": str(task_id), "title": title}


async def fn_get_agent_stats(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    # Изоляция агентов: вся статистика считается строго по agent_config_id.
    total_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.agent_config_id == agent_config_id
    ).scalar() or 0

    active_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.agent_config_id == agent_config_id,
        AgentContact.status.notin_(["rejected", "do_not_call"]),
    ).scalar() or 0

    total_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent_config_id
    ).scalar() or 0

    success_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent_config_id,
        AgentCall.post_call_decision == "SUCCESS",
    ).scalar() or 0

    followup_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent_config_id,
        AgentCall.post_call_decision == "FOLLOWUP",
    ).scalar() or 0

    no_answer_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent_config_id,
        AgentCall.post_call_decision == "NO_ANSWER",
    ).scalar() or 0

    scheduled_tasks = db.query(func.count(Task.id)).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(
        Task.user_id == user_id,
        Task.is_agent_task == True,
        Task.status == TaskStatus.SCHEDULED,
        AgentContact.agent_config_id == agent_config_id,
    ).scalar() or 0

    return {
        "ok": True,
        "total_contacts": total_contacts,
        "active_contacts": active_contacts,
        "total_calls": total_calls,
        "success_calls": success_calls,
        "followup_calls": followup_calls,
        "no_answer_calls": no_answer_calls,
        "scheduled_tasks": scheduled_tasks,
    }


async def fn_send_telegram_notification(args: dict, agent_config: AgentConfig, db: Session) -> dict:
    """
    v2.2: Шлёт во все chat_id из agent_config.telegram_chat_ids.
    Использует бота агента (agent_configs.telegram_bot_token), а не юзера.
    """
    from backend.services.agent_telegram_service import (
        AgentTelegramService,
        markdown_to_telegram_html,
    )

    message = args["message"]

    if not agent_config or not agent_config.has_telegram_bot():
        return {"ok": False, "error": "telegram_bot_not_configured"}

    if not agent_config.telegram_enabled:
        return {"ok": False, "error": "telegram_disabled"}

    if not agent_config.get_telegram_chat_ids_list():
        return {"ok": False, "error": "no_chat_ids_configured"}

    # Тело уведомления может быть в Markdown → конвертируем в безопасный Telegram-HTML
    attach, attach_err = _attachment(args, db, agent_config.id)
    if attach_err:
        return {"ok": False, "error": attach_err}

    body_html = markdown_to_telegram_html(message)
    text = f"🤖 <b>Voicyfy Agent</b>\n\n{body_html}"
    result = await AgentTelegramService.send_to_all_chats(
        agent_config, text,
        file_bytes=(bytes(attach.content) if attach else None),
        file_name=(attach.filename if attach else None),
    )

    logger.info(
        f"[AGENT-TOOLS] Telegram notification: sent={result['sent']} "
        f"failed={result['failed']} total={result['total']} (agent {agent_config.id})"
    )
    return {
        "ok": result["sent"] > 0,
        "sent": result["sent"],
        "failed": result["failed"],
        "total": result["total"],
    }


async def fn_send_sms(args: dict, user_id: str, agent_config: AgentConfig, db: Session) -> dict:
    """
    Отправить SMS клиенту с номера агента через Voximplant Management API.

    Источник — agent_config.default_caller_id (номер, с которого агент звонит).
    Получатель — телефон контакта (agent_contact_id) или явно переданный phone.
    Credentials берутся из VoximplantChildAccount по user_id.
    """
    import httpx
    from backend.models.voximplant_child import VoximplantChildAccount

    text = (args.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Текст SMS не может быть пустым"}

    # Получатель: явный phone имеет приоритет, иначе берём телефон контакта.
    to_number = (args.get("phone") or "").strip()
    if not to_number and args.get("agent_contact_id"):
        contact = db.query(AgentContact).filter(
            AgentContact.id == args["agent_contact_id"],
            AgentContact.user_id == user_id,
            AgentContact.agent_config_id == (agent_config.id if agent_config else None),
        ).first()
        if not contact:
            return {"ok": False, "error": "Contact not found"}
        to_number = (contact.phone or "").strip()
    if not to_number:
        return {"ok": False, "error": "Не указан номер получателя (phone или agent_contact_id)"}

    child = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == user_id
    ).first()
    if not child or not child.vox_account_id or not child.vox_api_key:
        return {"ok": False, "error": "Voximplant credentials не настроены"}

    # Источник — номер агента. Та же логика, что и у исходящих звонков
    # (task_scheduler): сначала default_caller_id, иначе первый активный номер
    # аккаунта. Поэтому SMS работает в тех же случаях, что и звонки — даже если
    # default_caller_id у агента не задан.
    active_numbers = [p.phone_number for p in (child.phone_numbers or []) if getattr(p, "is_active", False)]
    from_number = (getattr(agent_config, "default_caller_id", None) or "").strip()
    if not from_number or (active_numbers and from_number not in active_numbers):
        if active_numbers:
            from_number = active_numbers[0]
    if not from_number:
        return {"ok": False, "error": "no_source_number: у агента нет активного номера-отправителя"}

    to_clean = to_number.replace("+", "")
    from_clean = from_number.replace("+", "")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.voximplant.com/platform_api/SendSmsMessage/",
                params={
                    "account_id": child.vox_account_id,
                    "api_key": child.vox_api_key,
                    "source": from_clean,
                    "destination": to_clean,
                    "sms_body": text,
                },
            )
        data = resp.json()
    except Exception as e:
        logger.error(f"[AGENT-TOOLS] send_sms error: {e}", exc_info=True)
        return {"ok": False, "error": str(e)}

    if isinstance(data, dict) and data.get("result") == 1:
        tx = data.get("transaction_id")
        logger.info(f'[AGENT-TOOLS] SMS {from_clean} → {to_clean}: "{text[:50]}" (tx: {tx})')
        # Сохраняем исходящее SMS в общий тред (sms_messages), чтобы переписка
        # была полной для контекста агента и карточки контакта.
        from backend.services.sms_history import store_outbound_sms
        store_outbound_sms(db, child.id, child.vox_account_id, from_clean, to_clean, text)
        return {"ok": True, "transaction_id": tx, "to": to_clean}

    error_msg = data.get("error", {}).get("msg", str(data)) if isinstance(data, dict) else str(data)
    logger.error(f"[AGENT-TOOLS] SMS failed {from_clean} → {to_clean}: {error_msg}")
    return {"ok": False, "error": f"Ошибка Voximplant: {error_msg}"}


async def fn_search_contacts(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """
    Поиск и отбор контактов по фильтру с постраничным выводом.
    total — точное число по всей базе, строки — не больше CONTACT_LIST_MAX за вызов.
    """
    filter_args = _normalize_contact_filter({k: args[k] for k in CONTACT_FILTER_PROPERTIES if k in args})
    q, err = _contact_filter_query(db, user_id, agent_config_id, filter_args)
    if err:
        return {"ok": False, "error": err}

    total = q.count()

    # Фильтр ничего не нашёл — даём модели понять, что дело в фильтре, а не в пустой базе.
    diagnostics = {}
    if total == 0 and filter_args:
        base_q, _ = _contact_filter_query(db, user_id, agent_config_id, {})
        total_in_base = base_q.count()
        if total_in_base:
            diagnostics = {
                "total_in_base": total_in_base,
                "hint": (
                    f"По фильтру {json.dumps(filter_args, ensure_ascii=False)} никого нет, но всего в "
                    f"базе {total_in_base} контактов. Не говори, что база пуста; если фильтр "
                    "владелец не просил — повтори вызов без него."
                ),
            }

    if args.get("count_only"):
        return {"ok": True, "total": total, "filter": filter_args, **diagnostics}

    limit = max(1, min(_as_int(args.get("limit"), CONTACT_LIST_DEFAULT), CONTACT_LIST_MAX))
    offset = max(0, _as_int(args.get("offset"), 0))
    contacts = _sort_contacts(q, args.get("sort")).offset(offset).limit(limit).all()

    result = {
        "ok": True,
        "total": total,
        "offset": offset,
        "count": len(contacts),
        "has_more": offset + len(contacts) < total,
        "contacts": [_compact_contact(c) for c in contacts],
        **({"filter": filter_args} if filter_args else {}),
        **diagnostics,
    }
    if result["has_more"]:
        result["next_offset"] = offset + len(contacts)
        result["hint"] = (
            f"Показаны {offset + 1}–{offset + len(contacts)} из {total}. Для действия над всеми "
            "подходящими контактами передай этот же фильтр в bulk_*, а не листай список."
        )
    return result


async def fn_get_contact_details(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Полная карточка контакта: поля + память + краткая сводка последних звонков."""
    agent_contact_id = args.get("agent_contact_id")
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    recent_calls = (
        db.query(AgentCall)
        .filter(AgentCall.agent_contact_id == contact.id)
        .order_by(AgentCall.created_at.desc())
        .limit(5)
        .all()
    )

    return {
        "ok": True,
        "contact": {
            "id": str(contact.id),
            "name": contact.name,
            "phone": contact.phone,
            "company": contact.company,
            "position": contact.position,
            "notes": contact.notes,
            "stage": contact.status,
            "memory": contact.memory or {},
            "attempts_count": contact.attempts_count or 0,
            "last_called_at": contact.last_called_at.isoformat() if contact.last_called_at else None,
            "created_at": contact.created_at.isoformat() if contact.created_at else None,
        },
        "recent_calls": [
            {
                "id": str(c.id),
                "status": c.status,
                "post_call_decision": c.post_call_decision,
                "duration_seconds": c.duration_seconds,
                "created_at": c.created_at.isoformat() if c.created_at else None,
            }
            for c in recent_calls
        ],
    }


async def fn_get_contacts_by_stage(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Разбивка контактов по стадиям воронки: счётчики + примеры контактов."""
    rows = db.query(AgentContact.status, func.count(AgentContact.id)).filter(
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).group_by(AgentContact.status).all()
    counts = {(st or "new"): cnt for st, cnt in rows}

    stages = []
    for key in AGENT_CONTACT_STAGE_KEYS:
        sample = (
            db.query(AgentContact)
            .filter(
                AgentContact.user_id == user_id,
                AgentContact.agent_config_id == agent_config_id,
                AgentContact.status == key,
            )
            .order_by(AgentContact.created_at.desc())
            .limit(5)
            .all()
        )
        stages.append({
            "stage": key,
            "count": counts.get(key, 0),
            "sample": [
                {"id": str(c.id), "name": c.name, "phone": c.phone, "company": c.company}
                for c in sample
            ],
        })

    return {
        "ok": True,
        "total": sum(counts.values()),
        "stages": stages,
    }


async def fn_bulk_create_contacts(args: dict, agent_config_id: str, user_id: str, db: Session) -> dict:
    """Массовое создание контактов. Дубли по номеру (уже в базе) пропускаются."""
    items = args.get("contacts") or []
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "contacts_required"}

    created = []
    skipped = []
    for item in items:
        if not isinstance(item, dict):
            continue
        phone = item.get("phone")
        if not phone:
            skipped.append({"phone": None, "reason": "no_phone"})
            continue

        # Дубль проверяем в пределах ТЕКУЩЕГО агента (а не всего аккаунта) —
        # один номер может вестись разными агентами одного пользователя.
        exists = db.query(AgentContact.id).filter(
            AgentContact.agent_config_id == agent_config_id,
            AgentContact.phone == phone,
        ).first()
        if exists:
            skipped.append({"phone": phone, "reason": "duplicate"})
            continue

        contact = AgentContact(
            agent_config_id=agent_config_id,
            user_id=user_id,
            name=item.get("name"),
            phone=phone,
            company=item.get("company"),
            position=item.get("position"),
            notes=item.get("notes"),
            status="new",
            memory={},
        )
        db.add(contact)
        db.flush()
        created.append({"id": str(contact.id), "phone": contact.phone, "name": contact.name})

    db.commit()
    logger.info(f"[AGENT-TOOLS] Bulk created {len(created)} contacts, skipped {len(skipped)}")
    return {
        "ok": True,
        "created_count": len(created),
        "skipped_count": len(skipped),
        "created": created,
        "skipped": skipped,
    }


async def fn_delete_agent_contact(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Удалить контакт агента (hard-delete). История звонков удаляется каскадом."""
    agent_contact_id = args.get("agent_contact_id")
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    # Отменяем запланированные задачи контакта, чтобы планировщик их не выполнил
    # после удаления (FK Task.agent_contact_id = ON DELETE SET NULL).
    db.query(Task).filter(
        Task.agent_contact_id == agent_contact_id,
        Task.status == TaskStatus.SCHEDULED,
        Task.is_agent_task == True,
    ).update({"status": TaskStatus.CANCELLED}, synchronize_session=False)

    name = contact.name or contact.phone
    db.delete(contact)
    db.commit()
    logger.info(f"[AGENT-TOOLS] Deleted agent contact {agent_contact_id} ('{name}') for user {user_id}")
    return {"ok": True, "deleted": True, "contact_id": str(agent_contact_id), "name": name}


async def fn_append_contact_note(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Дописать заметку к контакту, не стирая существующие (новая строка с датой)."""
    agent_contact_id = args.get("agent_contact_id")
    note = (args.get("note") or "").strip()
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}
    if not note:
        return {"ok": False, "error": "note_required"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    stamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    line = f"[{stamp}] {note}"
    contact.notes = f"{contact.notes}\n{line}" if contact.notes else line
    db.commit()
    logger.info(f"[AGENT-TOOLS] Appended note to contact {agent_contact_id}")
    return {"ok": True, "contact_id": str(agent_contact_id), "notes": contact.notes}


async def fn_update_agent_task(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Изменить запланированную задачу агента: время и/или название/описание."""
    task_id = args.get("task_id")
    if not task_id:
        return {"ok": False, "error": "task_id_required"}

    # Изоляция агентов: правим только задачи своих контактов (JOIN с AgentContact).
    task = db.query(Task).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(
        Task.id == task_id,
        Task.user_id == user_id,
        Task.is_agent_task == True,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not task:
        return {"ok": False, "error": "Task not found"}
    if task.status != TaskStatus.SCHEDULED:
        return {"ok": False, "error": f"task_not_scheduled (status={task.status.value if hasattr(task.status, 'value') else task.status})"}

    updated = []
    if args.get("scheduled_at"):
        new_dt = _parse_iso_utc(args["scheduled_at"])
        if not new_dt:
            return {"ok": False, "error": "invalid_scheduled_at"}
        # Привести к рабочим часам агента (как при создании задачи).
        # Сообщения и проверки ответа рабочими часами не ограничены.
        agent_config = None
        if task.agent_contact_id:
            contact = db.query(AgentContact).filter(AgentContact.id == task.agent_contact_id).first()
            if contact and contact.agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == contact.agent_config_id).first()
        if agent_config is not None and (task.channel or "call") == "call":
            new_dt, _shifted = adjust_to_working_hours(
                new_dt, agent_config.working_hours_start, agent_config.working_hours_end
            )
        task.scheduled_time = new_dt
        updated.append("scheduled_at")

    if args.get("title") is not None:
        task.title = args["title"]
        updated.append("title")
    if args.get("notes") is not None:
        task.description = args["notes"]
        updated.append("notes")

    if not updated:
        return {"ok": False, "error": "no_fields_to_update"}

    db.commit()
    logger.info(f"[AGENT-TOOLS] Updated agent task {task_id} fields: {updated}")
    return {
        "ok": True,
        "task_id": str(task_id),
        "updated_fields": updated,
        "scheduled_at": task.scheduled_time.isoformat() if task.scheduled_time else None,
        "title": task.title,
    }


async def fn_get_upcoming_schedule(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Календарь ближайших запланированных звонков по всем контактам."""
    try:
        days = max(1, min(int(args.get("days") or 7), 90))
    except (ValueError, TypeError):
        days = 7
    try:
        limit = max(1, min(int(args.get("limit") or 50), 100))
    except (ValueError, TypeError):
        limit = 50

    now = datetime.utcnow()
    horizon = now + timedelta(days=days)

    rows = (
        db.query(Task, AgentContact)
        .join(AgentContact, Task.agent_contact_id == AgentContact.id)
        .filter(
            Task.user_id == user_id,
            Task.is_agent_task == True,
            Task.status == TaskStatus.SCHEDULED,
            Task.scheduled_time >= now,
            Task.scheduled_time <= horizon,
            AgentContact.agent_config_id == agent_config_id,
        )
        .order_by(Task.scheduled_time.asc())
        .limit(limit)
        .all()
    )

    return {
        "ok": True,
        "count": len(rows),
        "days": days,
        "tasks": [
            {
                "task_id": str(t.id),
                "title": t.title,
                "channel": t.channel or "call",
                "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
                "agent_contact_id": str(c.id),
                "contact_name": c.name,
                "contact_phone": c.phone,
            }
            for t, c in rows
        ],
    }


def _bulk_preview(q, total: int, limit: int, sort: Optional[str]) -> dict:
    """Ответ dry_run: сколько попадёт и несколько примеров."""
    sample = _sort_contacts(q, sort).limit(5).all()
    return {
        "ok": True,
        "dry_run": True,
        "matched": total,
        "will_process": min(total, limit),
        "sample": [_compact_contact(c) for c in sample],
    }


async def fn_bulk_schedule_calls(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Запланировать звонки группе контактов (по фильтру) с интервалом, начиная со start_at."""
    start_dt = _parse_iso_utc(args.get("start_at"))
    if not start_dt:
        return {"ok": False, "error": "invalid_or_missing_start_at"}

    interval = max(1, min(_as_int(args.get("interval_minutes"), 15) or 15, 1440))
    title = args.get("title") or "Звонок агента"

    q, applied, err = _bulk_targets(args, db, user_id, agent_config_id, legacy_stage=True)
    if err:
        return {"ok": False, "error": err}

    # «Не звонить» не планируем никогда, даже если попали в фильтр явно.
    excluded_dnc = q.filter(AgentContact.status == "do_not_call").count()
    q = q.filter(AgentContact.status != "do_not_call")

    skipped_scheduled = 0
    if args.get("skip_if_scheduled", True) is not False:
        skipped_scheduled = q.filter(_scheduled_call_exists()).count()
        q = q.filter(~_scheduled_call_exists())

    total = q.count()
    limit = _bulk_limit(args)
    sort = args.get("sort") or "oldest"
    if args.get("dry_run"):
        preview = _bulk_preview(q, total, limit, sort)
        preview.update({"excluded_do_not_call": excluded_dnc, "skipped_already_scheduled": skipped_scheduled})
        return preview
    if total == 0:
        return {
            "ok": False, "error": "no_contacts_matched",
            "excluded_do_not_call": excluded_dnc, "skipped_already_scheduled": skipped_scheduled,
        }

    contacts = _sort_contacts(q, sort).limit(limit).all()

    agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
    task_kwargs = assistant_task_kwargs(agent_config)

    scheduled = []
    for i, contact in enumerate(contacts):
        slot = start_dt + timedelta(minutes=interval * i)

        # Уважаем паузу контакта (snooze).
        if isinstance(contact.memory, dict):
            snooze_until = _parse_iso_utc(contact.memory.get("snooze_until"))
            if snooze_until and slot < snooze_until:
                slot = snooze_until

        # Рабочие часы агента.
        if agent_config is not None:
            slot, _shifted = adjust_to_working_hours(
                slot, agent_config.working_hours_start, agent_config.working_hours_end
            )

        task = Task(
            is_agent_task=True,
            agent_contact_id=contact.id,
            user_id=user_id,
            contact_id=None,
            status=TaskStatus.SCHEDULED,
            scheduled_time=slot,
            title=title,
            description=args.get("notes", ""),
            **task_kwargs,
        )
        db.add(task)
        scheduled.append((task, contact, slot))

    db.commit()
    logger.info(f"[AGENT-TOOLS] Bulk scheduled {len(scheduled)} calls for user {user_id} (filter={applied})")

    # В ответе — только начало списка: на сотнях задач полный список раздувает контекст модели.
    preview = [
        {
            "task_id": str(task.id),
            "agent_contact_id": str(contact.id),
            "contact_name": contact.name or contact.phone,
            "scheduled_at": slot.isoformat(),
        }
        for task, contact, slot in scheduled[:20]
    ]
    slots = [slot for _, _, slot in scheduled]
    return {
        "ok": True,
        "scheduled_count": len(scheduled),
        "remaining_not_scheduled": max(0, total - len(scheduled)),
        "excluded_do_not_call": excluded_dnc,
        "skipped_already_scheduled": skipped_scheduled,
        "first_call_at": min(slots).isoformat(),
        "last_call_at": max(slots).isoformat(),
        "tasks": preview,
        "tasks_truncated": len(scheduled) > len(preview),
    }


async def fn_bulk_move_contacts_stage(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Перевести группу контактов (по фильтру) на стадию воронки."""
    stage = args.get("stage")
    if not is_valid_stage(stage):
        return {"ok": False, "error": f"invalid_stage: {stage}"}

    q, applied, err = _bulk_targets(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}

    # «Не звонить» трогаем только при явном указании этой стадии в фильтре.
    filter_stages = set(applied.get("stages") or []) | ({applied["stage"]} if applied.get("stage") else set())
    if "do_not_call" not in filter_stages:
        q = q.filter(AgentContact.status != "do_not_call")
    q = q.filter(AgentContact.status != stage)

    total = q.count()
    limit = _bulk_limit(args)
    if args.get("dry_run"):
        return _bulk_preview(q, total, limit, "oldest")
    if total == 0:
        return {"ok": True, "moved": 0, "note": "Нет контактов для перевода (возможно, уже на этой стадии)"}

    ids = [row.id for row in _sort_contacts(q.with_entities(AgentContact.id, AgentContact.created_at), "oldest").limit(limit).all()]
    from_rows = (
        db.query(AgentContact.status, func.count(AgentContact.id))
        .filter(AgentContact.id.in_(ids))
        .group_by(AgentContact.status)
        .all()
    )
    moved = db.query(AgentContact).filter(AgentContact.id.in_(ids)).update(
        {"status": stage, "updated_at": datetime.utcnow()}, synchronize_session=False
    )

    cancelled = 0
    if stage == "do_not_call":
        cancelled = db.query(Task).filter(
            Task.agent_contact_id.in_(ids),
            Task.is_agent_task == True,
            Task.status == TaskStatus.SCHEDULED,
        ).update({"status": TaskStatus.CANCELLED}, synchronize_session=False)

    db.commit()
    logger.info(
        f"[AGENT-TOOLS] Bulk moved {moved} contacts -> {stage} for user {user_id} "
        f"(filter={applied}, reason: {args.get('reason', '')})"
    )
    return {
        "ok": True,
        "moved": moved,
        "stage": stage,
        "from_stages": {(st or "new"): cnt for st, cnt in from_rows},
        "remaining_not_moved": max(0, total - moved),
        "cancelled_tasks": cancelled,
    }


async def fn_bulk_cancel_calls(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Отменить запланированные задачи у группы контактов (по фильтру)."""
    q, applied, err = _bulk_targets(args, db, user_id, agent_config_id)
    if err:
        return {"ok": False, "error": err}

    channel = args.get("channel") or "call"
    tq = db.query(Task).filter(
        Task.agent_contact_id.in_(q.with_entities(AgentContact.id)),
        Task.is_agent_task == True,
        Task.status == TaskStatus.SCHEDULED,
    )
    if channel != "all":
        tq = tq.filter(Task.channel == channel)

    limit = _bulk_limit(args)
    contacts_total = q.filter(_scheduled_call_exists()).count() if channel == "call" else None
    tasks_total = tq.count()
    if args.get("dry_run"):
        return {
            "ok": True, "dry_run": True, "tasks_matched": tasks_total,
            "contacts_with_scheduled_calls": contacts_total, "channel": channel,
        }
    if tasks_total == 0:
        return {"ok": True, "cancelled_tasks": 0, "note": "Запланированных задач по фильтру нет"}

    task_ids = [row.id for row in tq.with_entities(Task.id).order_by(Task.scheduled_time.asc()).limit(limit).all()]
    cancelled = db.query(Task).filter(Task.id.in_(task_ids)).update(
        {"status": TaskStatus.CANCELLED}, synchronize_session=False
    )
    db.commit()
    logger.info(f"[AGENT-TOOLS] Bulk cancelled {cancelled} tasks ({channel}) for user {user_id} (filter={applied})")
    return {
        "ok": True,
        "cancelled_tasks": cancelled,
        "remaining_not_cancelled": max(0, tasks_total - cancelled),
        "channel": channel,
    }


async def fn_trigger_immediate_call(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Создать задачу на немедленный звонок (без сдвига в рабочие часы)."""
    agent_contact_id = args.get("agent_contact_id")
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
    if agent_config is not None and not agent_config.is_active:
        return {"ok": False, "error": "agent_inactive", "hint": "Активируйте агента, иначе планировщик не выполнит звонок."}

    # Немедленно: ставим задачу на текущий момент, рабочие часы НЕ применяем —
    # пользователь явно просит позвонить сейчас. Планировщик подхватит её за ~30с.
    task = Task(
        is_agent_task=True,
        agent_contact_id=contact.id,
        user_id=user_id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=datetime.now(timezone.utc),
        title=args.get("title") or "Немедленный звонок",
        description="",
        **assistant_task_kwargs(agent_config),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    logger.info(f"[AGENT-TOOLS] Triggered immediate call task {task.id} for contact {agent_contact_id}")
    return {
        "ok": True,
        "task_id": str(task.id),
        "agent_contact_id": str(contact.id),
        "contact_name": contact.name or contact.phone,
        "note": "Звонок поставлен в очередь, планировщик выполнит его в течение ~30 секунд.",
    }


async def fn_snooze_contact(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Поставить контакт на паузу до даты: отменить задачи + запретить ранние звонки."""
    agent_contact_id = args.get("agent_contact_id")
    until = _parse_iso_utc(args.get("until"))
    if not agent_contact_id:
        return {"ok": False, "error": "agent_contact_id_required"}
    if not until:
        return {"ok": False, "error": "invalid_or_missing_until"}

    contact = db.query(AgentContact).filter(
        AgentContact.id == agent_contact_id,
        AgentContact.user_id == user_id,
        AgentContact.agent_config_id == agent_config_id,
    ).first()
    if not contact:
        return {"ok": False, "error": "Contact not found"}

    # Отменяем все запланированные задачи контакта.
    cancelled = db.query(Task).filter(
        Task.agent_contact_id == agent_contact_id,
        Task.status == TaskStatus.SCHEDULED,
        Task.is_agent_task == True,
    ).update({"status": TaskStatus.CANCELLED}, synchronize_session=False)

    # Запоминаем паузу в памяти контакта — её уважает create_agent_task / bulk_schedule_calls.
    memory = dict(contact.memory or {})
    memory["snooze_until"] = until.isoformat()
    contact.memory = memory
    flag_modified(contact, "memory")
    db.commit()
    logger.info(f"[AGENT-TOOLS] Snoozed contact {agent_contact_id} until {until}, cancelled {cancelled} tasks")
    return {
        "ok": True,
        "contact_id": str(agent_contact_id),
        "snooze_until": until.isoformat(),
        "cancelled_tasks": cancelled,
    }


async def fn_get_call_transcript(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Полный транскрипт конкретного звонка."""
    agent_call_id = args.get("agent_call_id")
    if not agent_call_id:
        return {"ok": False, "error": "agent_call_id_required"}

    call = db.query(AgentCall).filter(
        AgentCall.id == agent_call_id,
        AgentCall.user_id == user_id,
        AgentCall.agent_config_id == agent_config_id,
    ).first()
    if not call:
        return {"ok": False, "error": "Call not found"}

    return {
        "ok": True,
        "call": {
            "id": str(call.id),
            "agent_contact_id": str(call.agent_contact_id) if call.agent_contact_id else None,
            "status": call.status,
            "post_call_decision": call.post_call_decision,
            "duration_seconds": call.duration_seconds,
            "started_at": call.started_at.isoformat() if call.started_at else None,
            "completed_at": call.completed_at.isoformat() if call.completed_at else None,
            "transcript": call.transcript or "(транскрипт недоступен)",
        },
    }


async def fn_get_period_report(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Сводный отчёт по звонкам за период (по умолчанию последние 7 дней)."""
    date_to = _parse_iso_utc(args.get("date_to")) or datetime.now(timezone.utc)
    date_from = _parse_iso_utc(args.get("date_from")) or (date_to - timedelta(days=7))
    if date_from > date_to:
        date_from, date_to = date_to, date_from

    # Колонка created_at — naive UTC, сравниваем с naive границами.
    df = date_from.replace(tzinfo=None)
    dt = date_to.replace(tzinfo=None)

    calls = (
        db.query(AgentCall)
        .filter(
            AgentCall.user_id == user_id,
            AgentCall.agent_config_id == agent_config_id,
            AgentCall.created_at >= df,
            AgentCall.created_at <= dt,
        )
        .all()
    )

    total = len(calls)
    answered = sum(1 for c in calls if c.status == "answered")
    success = sum(1 for c in calls if c.post_call_decision == "SUCCESS")
    followup = sum(1 for c in calls if c.post_call_decision == "FOLLOWUP")
    no_answer = sum(1 for c in calls if c.post_call_decision == "NO_ANSWER" or c.status in ("no_answer", "failed"))
    total_duration = sum(int(c.duration_seconds or 0) for c in calls)
    avg_duration = round(total_duration / answered) if answered else 0
    conversion = round(success / answered * 100, 1) if answered else 0.0

    return {
        "ok": True,
        "period": {"from": date_from.isoformat(), "to": date_to.isoformat()},
        "total_calls": total,
        "answered": answered,
        "success": success,
        "followup": followup,
        "no_answer": no_answer,
        "total_duration_seconds": total_duration,
        "avg_duration_seconds": avg_duration,
        "conversion_percent": conversion,
    }


async def fn_get_failed_calls(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    """Очередь на перезвон: последний неудачный/недозвон по каждому контакту."""
    try:
        limit = max(1, min(int(args.get("limit") or 30), 100))
    except (ValueError, TypeError):
        limit = 30

    calls = (
        db.query(AgentCall)
        .filter(
            AgentCall.user_id == user_id,
            AgentCall.agent_config_id == agent_config_id,
            or_(
                AgentCall.status.in_(["no_answer", "failed"]),
                AgentCall.post_call_decision == "NO_ANSWER",
            ),
        )
        .order_by(AgentCall.created_at.desc())
        .limit(300)
        .all()
    )

    seen = set()
    result = []
    for c in calls:
        cid = c.agent_contact_id
        if cid in seen:
            continue
        seen.add(cid)
        contact = db.query(AgentContact).filter(AgentContact.id == cid).first() if cid else None
        result.append({
            "agent_call_id": str(c.id),
            "agent_contact_id": str(cid) if cid else None,
            "contact_name": (contact.name if contact else None),
            "contact_phone": (contact.phone if contact else None),
            "status": c.status,
            "post_call_decision": c.post_call_decision,
            "last_attempt_at": c.created_at.isoformat() if c.created_at else None,
            "attempts_count": (contact.attempts_count if contact else None),
        })
        if len(result) >= limit:
            break

    return {"ok": True, "count": len(result), "contacts": result}


async def fn_search_knowledge_base(args: dict, agent_config, db: Session) -> dict:
    """
    Векторный поиск по базе знаний агента.

    Namespace берётся из agent_config.kb_namespace. Эмбеддинги считаются на
    системном ключе OPENAI_API_KEY (оркестратор v3 работает на кредитах, а не на
    личном ключе юзера).
    """
    import os
    from backend.services.pinecone_service import PineconeService

    query = (args.get("query") or "").strip()
    top_k = int(args.get("top_k") or 3)

    if not query:
        return {"ok": False, "error": "Пустой поисковый запрос"}

    namespace = getattr(agent_config, "kb_namespace", None) if agent_config else None
    if not namespace:
        return {"ok": False, "error": "База знаний не создана для этого агента"}

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        return {"ok": False, "error": "OPENAI_API_KEY не настроен на сервере"}

    try:
        matches = await PineconeService.search(
            query=query, namespace=namespace, api_key=openai_api_key, top_k=top_k,
        )
    except Exception as e:
        logger.error(f"[AGENT-TOOLS] knowledge base search failed: {e}", exc_info=True)
        return {"ok": False, "error": f"Ошибка поиска: {e}"}

    results = [{"text": m.get("text", ""), "score": m.get("score")} for m in matches]
    return {"ok": True, "query": query, "total": len(results), "results": results}


async def fn_send_webhook(args: dict, agent_config, db: Session) -> dict:
    """
    Отправить событие на внешний вебхук агента (n8n/Make/Zapier/любой HTTP endpoint).

    URL берётся ТОЛЬКО из agent_config.webhook_url — модель его не передаёт.
    Тело запроса: {event, data, agent_id, agent_name}. Best-effort: ошибки сети
    не роняют оркестратор, а возвращаются как {"ok": false, ...}.
    """
    import asyncio
    import aiohttp

    url = (getattr(agent_config, "webhook_url", None) or "").strip() if agent_config else ""
    if not url:
        return {"ok": False, "error": "webhook_url_not_configured"}

    event = (args.get("event") or "").strip() or "default_event"
    payload = args.get("payload")
    if not isinstance(payload, dict):
        payload = {} if payload is None else {"value": payload}

    data = {
        "event": event,
        "data": payload,
        "agent_id": str(agent_config.id),
        "agent_name": agent_config.name,
    }

    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=data) as response:
                response_text = await response.text()
                logger.info(f"[AGENT-TOOLS] Webhook sent: event={event} status={response.status} (agent {agent_config.id})")
                return {
                    "ok": 200 <= response.status < 300,
                    "status": response.status,
                    "event": event,
                    "response": response_text[:200],
                }
    except asyncio.TimeoutError:
        logger.error(f"[AGENT-TOOLS] Webhook timeout: {url}")
        return {"ok": False, "error": "webhook_timeout"}
    except Exception as e:
        logger.error(f"[AGENT-TOOLS] send_webhook error: {e}", exc_info=True)
        return {"ok": False, "error": str(e)}


# ============================================================================
# DISPATCHER
# ============================================================================

_TOOL_MAP = {
    "search_knowledge_base": "fn_search_knowledge_base",
    "create_agent_contact": "fn_create_agent_contact",
    "create_agent_task": "fn_create_agent_task",
    "update_contact_memory": "fn_update_contact_memory",
    "update_agent_memory": "fn_update_agent_memory",
    "update_contact_info": "fn_update_contact_info",
    "move_contact_stage": "fn_move_contact_stage",
    "get_agent_contacts": "fn_get_agent_contacts",
    "get_contact_call_history": "fn_get_contact_call_history",
    "get_agent_tasks": "fn_get_agent_tasks",
    "delete_agent_task": "fn_delete_agent_task",
    "get_agent_stats": "fn_get_agent_stats",
    "send_telegram_notification": "fn_send_telegram_notification",
    "send_sms": "fn_send_sms",
    "send_webhook": "fn_send_webhook",
    "search_contacts": "fn_search_contacts",
    "get_contact_details": "fn_get_contact_details",
    "get_contacts_by_stage": "fn_get_contacts_by_stage",
    "bulk_create_contacts": "fn_bulk_create_contacts",
    "delete_agent_contact": "fn_delete_agent_contact",
    "append_contact_note": "fn_append_contact_note",
    "update_agent_task": "fn_update_agent_task",
    "get_upcoming_schedule": "fn_get_upcoming_schedule",
    "bulk_schedule_calls": "fn_bulk_schedule_calls",
    "bulk_move_contacts_stage": "fn_bulk_move_contacts_stage",
    "bulk_cancel_calls": "fn_bulk_cancel_calls",
    "trigger_immediate_call": "fn_trigger_immediate_call",
    "snooze_contact": "fn_snooze_contact",
    "get_call_transcript": "fn_get_call_transcript",
    "get_period_report": "fn_get_period_report",
    "get_failed_calls": "fn_get_failed_calls",
    "telegram_send_message": "fn_telegram_send_message",
    "telegram_get_thread": "fn_telegram_get_thread",
    "schedule_telegram_message": "fn_schedule_telegram_message",
    "max_send_message": "fn_max_send_message",
    "max_get_thread": "fn_max_get_thread",
    "schedule_max_message": "fn_schedule_max_message",
    "schedule_reply_check": "fn_schedule_reply_check",
    "create_pdf_document": "fn_create_pdf_document",
    "create_spreadsheet": "fn_create_spreadsheet",
    "export_contacts_table": "fn_export_contacts_table",
    "get_agent_files": "fn_get_agent_files",
    "bulk_schedule_messages": "fn_bulk_schedule_messages",
}


async def execute_tool(tool_name: str, tool_args: dict, context: dict, db: Session) -> str:
    """
    Execute an agent tool by name.

    context must contain: agent_config_id, user_id, user (User object)
    Returns JSON string with result.
    """
    agent_config_id = context.get("agent_config_id")
    user_id = context.get("user_id")
    user = context.get("user")

    try:
        if tool_name == "create_agent_contact":
            result = await fn_create_agent_contact(tool_args, agent_config_id, user_id, db)
        elif tool_name == "create_agent_task":
            result = await fn_create_agent_task(tool_args, user_id, agent_config_id, db)
        elif tool_name == "update_contact_memory":
            result = await fn_update_contact_memory(tool_args, agent_config_id, db)
        elif tool_name == "update_agent_memory":
            result = await fn_update_agent_memory(tool_args, agent_config_id, db)
        elif tool_name == "update_contact_info":
            result = await fn_update_contact_info(tool_args, user_id, agent_config_id, db)
        elif tool_name == "move_contact_stage":
            result = await fn_move_contact_stage(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_agent_contacts":
            result = await fn_get_agent_contacts(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_contact_call_history":
            result = await fn_get_contact_call_history(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_contact_timeline":
            result = await fn_get_contact_timeline(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_agent_tasks":
            result = await fn_get_agent_tasks(tool_args, user_id, agent_config_id, db)
        elif tool_name == "delete_agent_task":
            result = await fn_delete_agent_task(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_agent_stats":
            result = await fn_get_agent_stats(tool_args, user_id, agent_config_id, db)
        elif tool_name == "send_telegram_notification":
            result = await fn_send_telegram_notification(tool_args, context.get("agent_config"), db)
        elif tool_name == "send_sms":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_send_sms(tool_args, user_id, agent_config, db)
        elif tool_name == "search_contacts":
            result = await fn_search_contacts(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_contact_details":
            result = await fn_get_contact_details(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_contacts_by_stage":
            result = await fn_get_contacts_by_stage(tool_args, user_id, agent_config_id, db)
        elif tool_name == "bulk_create_contacts":
            result = await fn_bulk_create_contacts(tool_args, agent_config_id, user_id, db)
        elif tool_name == "delete_agent_contact":
            result = await fn_delete_agent_contact(tool_args, user_id, agent_config_id, db)
        elif tool_name == "append_contact_note":
            result = await fn_append_contact_note(tool_args, user_id, agent_config_id, db)
        elif tool_name == "update_agent_task":
            result = await fn_update_agent_task(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_upcoming_schedule":
            result = await fn_get_upcoming_schedule(tool_args, user_id, agent_config_id, db)
        elif tool_name == "bulk_schedule_calls":
            result = await fn_bulk_schedule_calls(tool_args, user_id, agent_config_id, db)
        elif tool_name == "bulk_move_contacts_stage":
            result = await fn_bulk_move_contacts_stage(tool_args, user_id, agent_config_id, db)
        elif tool_name == "bulk_cancel_calls":
            result = await fn_bulk_cancel_calls(tool_args, user_id, agent_config_id, db)
        elif tool_name == "trigger_immediate_call":
            result = await fn_trigger_immediate_call(tool_args, user_id, agent_config_id, db)
        elif tool_name == "snooze_contact":
            result = await fn_snooze_contact(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_call_transcript":
            result = await fn_get_call_transcript(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_period_report":
            result = await fn_get_period_report(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_failed_calls":
            result = await fn_get_failed_calls(tool_args, user_id, agent_config_id, db)
        elif tool_name == "search_knowledge_base":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_search_knowledge_base(tool_args, agent_config, db)
        elif tool_name == "send_webhook":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_send_webhook(tool_args, agent_config, db)
        elif tool_name == "telegram_send_message":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_telegram_send_message(tool_args, user_id, agent_config, db)
        elif tool_name == "telegram_get_thread":
            result = await fn_telegram_get_thread(tool_args, user_id, agent_config_id, db)
        elif tool_name == "schedule_telegram_message":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_schedule_telegram_message(tool_args, user_id, agent_config, db)
        elif tool_name == "max_send_message":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_max_send_message(tool_args, user_id, agent_config, db)
        elif tool_name == "max_get_thread":
            result = await fn_max_get_thread(tool_args, user_id, agent_config_id, db)
        elif tool_name == "schedule_max_message":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_schedule_max_message(tool_args, user_id, agent_config, db)
        elif tool_name == "schedule_reply_check":
            result = await fn_schedule_reply_check(tool_args, user_id, agent_config_id, db)
        elif tool_name == "create_pdf_document":
            result = await fn_create_pdf_document(tool_args, user_id, agent_config_id, db)
        elif tool_name == "create_spreadsheet":
            result = await fn_create_spreadsheet(tool_args, user_id, agent_config_id, db)
        elif tool_name == "export_contacts_table":
            result = await fn_export_contacts_table(tool_args, user_id, agent_config_id, db)
        elif tool_name == "get_agent_files":
            result = await fn_get_agent_files(tool_args, user_id, agent_config_id, db)
        elif tool_name == "bulk_schedule_messages":
            agent_config = context.get("agent_config")
            if agent_config is None and agent_config_id:
                agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            result = await fn_bulk_schedule_messages(tool_args, user_id, agent_config, db)
        elif composio_service.is_composio_tool(tool_name):
            result = await fn_execute_connector(tool_name, tool_args, agent_config_id, db)
        else:
            result = {"ok": False, "error": f"Unknown tool: {tool_name}"}

        return json.dumps(result, ensure_ascii=False, default=str)

    except Exception as e:
        logger.error(f"[AGENT-TOOLS] Error executing {tool_name}: {e}", exc_info=True)
        if db is not None:
            # Упавший SQL внутри тулзы оставляет транзакцию прерванной; без rollback
            # следующий запрос оркестратора упадёт с InFailedSqlTransaction и анализ звонка пропадёт.
            safe_rollback(db)
        return json.dumps({"ok": False, "error": str(e)})
