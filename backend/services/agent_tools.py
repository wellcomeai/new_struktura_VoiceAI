"""
Agent Tools — tool definitions and implementations for GPT-5 Responses API.
Two tool sets: AGENT_CHAT_TOOLS (user chat) and AGENT_POSTCALL_TOOLS (post-call analysis).
"""

import json
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import func

from backend.core.logging import get_logger
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.models.agent_config import AgentConfig
from backend.models.task import Task, TaskStatus
from backend.models.user import User
from backend.services.telegram_notification import TelegramNotificationService

logger = get_logger(__name__)


# ============================================================================
# HELPERS
# ============================================================================

def assistant_task_kwargs(agent_config) -> dict:
    """
    Возвращает kwargs для Task с правильным FK голосового ассистента
    в зависимости от assistant_type агента (gemini / openai / cartesia).
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
# TOOL DEFINITIONS FOR GPT-5 RESPONSES API
# ============================================================================

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
        "description": "Создать задачу на звонок контакту агента в указанное время.",
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "scheduled_at": {"type": "string", "description": "Дата и время звонка ISO 8601 (UTC)"},
                "title": {"type": "string", "description": "Название задачи"},
                "notes": {"type": "string", "description": "Описание / заметки"},
            },
            "required": ["agent_contact_id", "scheduled_at", "title"],
        },
    },
    {
        "type": "function",
        "name": "get_agent_contacts",
        "description": "Получить список контактов агента.",
        "parameters": {
            "type": "object",
            "properties": {},
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
        "name": "get_agent_tasks",
        "description": "Получить список задач на звонки. Использовать когда пользователь спрашивает о запланированных звонках, расписании, следующих задачах. Также вызывать ПЕРЕД созданием новой задачи чтобы проверить дубли.",
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
        "description": "Создать задачу на перезвон. ОБЯЗАТЕЛЬНО вызывай этот tool после каждого звонка, кроме случая когда цель звонка уже достигнута.",
        "parameters": {
            "type": "object",
            "properties": {
                "agent_contact_id": {"type": "string", "description": "UUID контакта агента"},
                "scheduled_at": {"type": "string", "description": "Дата и время звонка ISO 8601 (UTC)"},
                "title": {"type": "string", "description": "Название задачи"},
                "notes": {"type": "string", "description": "Описание / заметки"},
            },
            "required": ["agent_contact_id", "scheduled_at", "title"],
        },
    },
    {
        "type": "function",
        "name": "send_telegram_notification",
        "description": "Отправить уведомление владельцу в Telegram.",
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Текст уведомления"},
            },
            "required": ["message"],
        },
    },
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


async def fn_create_agent_task(args: dict, user_id: str, agent_config_id: str, db: Session) -> dict:
    agent_contact_id = args["agent_contact_id"]

    # Parse scheduled_at
    scheduled_at_str = args["scheduled_at"]
    try:
        scheduled_at = datetime.fromisoformat(scheduled_at_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        scheduled_at = datetime.utcnow() + timedelta(hours=1)

    # Get assistant from agent_config (type-aware — gemini/openai/cartesia)
    agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()

    # Cancel existing SCHEDULED tasks for this contact to prevent duplicates
    existing_tasks = db.query(Task).filter(
        Task.agent_contact_id == agent_contact_id,
        Task.status == TaskStatus.SCHEDULED,
        Task.is_agent_task == True,
    ).all()

    cancelled_count = 0
    for existing_task in existing_tasks:
        existing_task.status = TaskStatus.CANCELLED
        cancelled_count += 1

    if cancelled_count > 0:
        logger.info(f"[AGENT-TOOLS] Cancelled {cancelled_count} duplicate SCHEDULED tasks for contact {agent_contact_id}")

    # Create new task — route assistant to the correct Task FK by type
    task = Task(
        is_agent_task=True,
        agent_contact_id=agent_contact_id,
        user_id=user_id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=scheduled_at,
        title=args.get("title", "Звонок агента"),
        description=args.get("notes", ""),
        **assistant_task_kwargs(agent_config),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    logger.info(f"[AGENT-TOOLS] Created agent task {task.id} for contact {agent_contact_id} at {scheduled_at}")
    return {
        "ok": True,
        "task_id": str(task.id),
        "scheduled_at": scheduled_at.isoformat(),
        "cancelled_duplicates": cancelled_count,
    }


async def fn_update_contact_memory(args: dict, db: Session) -> dict:
    agent_contact_id = args["agent_contact_id"]
    contact = db.query(AgentContact).filter(AgentContact.id == agent_contact_id).first()
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


async def fn_get_agent_contacts(args: dict, user_id: str, db: Session) -> dict:
    q = db.query(AgentContact).filter(AgentContact.user_id == user_id)
    contacts = q.order_by(AgentContact.created_at.desc()).limit(50).all()
    return {
        "ok": True,
        "count": len(contacts),
        "contacts": [
            {
                "id": str(c.id),
                "name": c.name,
                "phone": c.phone,
                "company": c.company,
                "attempts_count": c.attempts_count,
                "last_called_at": c.last_called_at.isoformat() if c.last_called_at else None,
            }
            for c in contacts
        ],
    }


async def fn_get_contact_call_history(args: dict, db: Session) -> dict:
    agent_contact_id = args["agent_contact_id"]
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


async def fn_get_agent_tasks(args: dict, user_id: str, db: Session) -> dict:
    """Получить задачи агента с опциональными фильтрами."""
    q = db.query(Task).filter(
        Task.user_id == user_id,
        Task.is_agent_task == True,
    )

    if args.get("agent_contact_id"):
        q = q.filter(Task.agent_contact_id == args["agent_contact_id"])

    if args.get("status_filter"):
        q = q.filter(Task.status == args["status_filter"])

    tasks = q.order_by(Task.scheduled_time.asc()).limit(20).all()

    return {
        "ok": True,
        "count": len(tasks),
        "tasks": [
            {
                "id": str(t.id),
                "title": t.title,
                "status": t.status.value,
                "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
                "description": t.description,
                "agent_contact_id": str(t.agent_contact_id) if t.agent_contact_id else None,
            }
            for t in tasks
        ],
    }


async def fn_get_agent_stats(args: dict, user_id: str, db: Session) -> dict:
    total_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.user_id == user_id
    ).scalar() or 0

    active_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.user_id == user_id,
        AgentContact.status.notin_(["rejected", "do_not_call"]),
    ).scalar() or 0

    total_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == user_id
    ).scalar() or 0

    success_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == user_id,
        AgentCall.post_call_decision == "SUCCESS",
    ).scalar() or 0

    followup_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == user_id,
        AgentCall.post_call_decision == "FOLLOWUP",
    ).scalar() or 0

    no_answer_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == user_id,
        AgentCall.post_call_decision == "NO_ANSWER",
    ).scalar() or 0

    scheduled_tasks = db.query(func.count(Task.id)).filter(
        Task.user_id == user_id,
        Task.is_agent_task == True,
        Task.status == TaskStatus.SCHEDULED,
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
    body_html = markdown_to_telegram_html(message)
    text = f"🤖 <b>Voicyfy Agent</b>\n\n{body_html}"
    result = await AgentTelegramService.send_to_all_chats(agent_config, text)

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


# ============================================================================
# DISPATCHER
# ============================================================================

_TOOL_MAP = {
    "create_agent_contact": "fn_create_agent_contact",
    "create_agent_task": "fn_create_agent_task",
    "update_contact_memory": "fn_update_contact_memory",
    "get_agent_contacts": "fn_get_agent_contacts",
    "get_contact_call_history": "fn_get_contact_call_history",
    "get_agent_tasks": "fn_get_agent_tasks",
    "get_agent_stats": "fn_get_agent_stats",
    "send_telegram_notification": "fn_send_telegram_notification",
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
            result = await fn_update_contact_memory(tool_args, db)
        elif tool_name == "get_agent_contacts":
            result = await fn_get_agent_contacts(tool_args, user_id, db)
        elif tool_name == "get_contact_call_history":
            result = await fn_get_contact_call_history(tool_args, db)
        elif tool_name == "get_agent_tasks":
            result = await fn_get_agent_tasks(tool_args, user_id, db)
        elif tool_name == "get_agent_stats":
            result = await fn_get_agent_stats(tool_args, user_id, db)
        elif tool_name == "send_telegram_notification":
            result = await fn_send_telegram_notification(tool_args, context.get("agent_config"), db)
        else:
            result = {"ok": False, "error": f"Unknown tool: {tool_name}"}

        return json.dumps(result, ensure_ascii=False, default=str)

    except Exception as e:
        logger.error(f"[AGENT-TOOLS] Error executing {tool_name}: {e}", exc_info=True)
        return json.dumps({"ok": False, "error": str(e)})
