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
    UPDATE_CONTACT_INFO_TOOL,
    MOVE_CONTACT_STAGE_TOOL,
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
    UPDATE_CONTACT_INFO_TOOL,
    MOVE_CONTACT_STAGE_TOOL,
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

    # Унифицированная проверка рабочих часов агента (МСК) — переносим звонок
    # на ближайший рабочий день, если время выпадает на нерабочие часы.
    if agent_config is not None:
        adjusted, _shifted = adjust_to_working_hours(
            scheduled_at,
            agent_config.working_hours_start,
            agent_config.working_hours_end,
        )
        scheduled_at = adjusted

    # Cancel only exact-time duplicates for this contact (same contact + same
    # scheduled_time). Tasks scheduled for other dates/times are preserved, so
    # a contact can have several upcoming calls planned at different moments.
    existing_tasks = db.query(Task).filter(
        Task.agent_contact_id == agent_contact_id,
        Task.status == TaskStatus.SCHEDULED,
        Task.is_agent_task == True,
        Task.scheduled_time == scheduled_at,
    ).all()

    cancelled_count = 0
    for existing_task in existing_tasks:
        existing_task.status = TaskStatus.CANCELLED
        cancelled_count += 1

    if cancelled_count > 0:
        logger.info(f"[AGENT-TOOLS] Cancelled {cancelled_count} duplicate SCHEDULED tasks for contact {agent_contact_id} at {scheduled_at}")

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


async def fn_update_contact_info(args: dict, user_id: str, db: Session) -> dict:
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


async def fn_move_contact_stage(args: dict, user_id: str, db: Session) -> dict:
    """
    Перевести контакт на стадию воронки (status). Скоупится по user_id, чтобы
    агент/чат не мог тронуть чужой контакт. Валидирует стадию по единому
    справочнику pipeline_stages.
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
    base_filters = [
        Task.user_id == user_id,
        Task.is_agent_task == True,
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
                "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
                "description": t.description,
                "agent_contact_id": str(t.agent_contact_id) if t.agent_contact_id else None,
            }
            for t in tasks
        ],
    }


async def fn_delete_agent_task(args: dict, user_id: str, db: Session) -> dict:
    """Удалить задачу агента по ID.

    Hard-delete (как delete_agent_contact). Скоупится по user_id + is_agent_task,
    чтобы агент не мог удалить чужую или не-агентскую задачу.
    """
    task_id = args.get("task_id")
    if not task_id:
        return {"ok": False, "error": "task_id is required"}

    task = db.query(Task).filter(
        Task.id == task_id,
        Task.user_id == user_id,
        Task.is_agent_task == True,
    ).first()

    if not task:
        logger.warning(f"[AGENT-TOOLS] delete_agent_task: task {task_id} not found for user {user_id}")
        return {"ok": False, "error": "Task not found"}

    title = task.title
    db.delete(task)
    db.commit()

    logger.info(f"[AGENT-TOOLS] Deleted agent task {task_id} ('{title}') for user {user_id}")
    return {"ok": True, "deleted": True, "task_id": str(task_id), "title": title}


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
    "update_contact_info": "fn_update_contact_info",
    "move_contact_stage": "fn_move_contact_stage",
    "get_agent_contacts": "fn_get_agent_contacts",
    "get_contact_call_history": "fn_get_contact_call_history",
    "get_agent_tasks": "fn_get_agent_tasks",
    "delete_agent_task": "fn_delete_agent_task",
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
        elif tool_name == "update_contact_info":
            result = await fn_update_contact_info(tool_args, user_id, db)
        elif tool_name == "move_contact_stage":
            result = await fn_move_contact_stage(tool_args, user_id, db)
        elif tool_name == "get_agent_contacts":
            result = await fn_get_agent_contacts(tool_args, user_id, db)
        elif tool_name == "get_contact_call_history":
            result = await fn_get_contact_call_history(tool_args, db)
        elif tool_name == "get_agent_tasks":
            result = await fn_get_agent_tasks(tool_args, user_id, db)
        elif tool_name == "delete_agent_task":
            result = await fn_delete_agent_task(tool_args, user_id, db)
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
