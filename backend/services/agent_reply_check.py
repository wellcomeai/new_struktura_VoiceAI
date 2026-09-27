"""
Проверка ответа клиента — задача агента channel="reply_check".

Агент (или владелец через чат) ставит проверку тулзой schedule_reply_check:
«через N часов посмотри, ответил ли клиент». В назначенное время планировщик
(TaskScheduler.execute_agent_reply_check) сначала детерминированно, без LLM,
смотрит, выходил ли клиент на связь после постановки задачи:

  • входящее сообщение в Telegram / MAX (личный аккаунт владельца);
  • входящее SMS;
  • входящий звонок или состоявшийся (answered) исходящий звонок.

Ответил → задача закрывается как выполненная, оркестратор не запускается
(на само сообщение клиента агент уже среагировал входящим прогоном).
Молчит → один прогон оркестратора (call_direction="reply_check"): что делать
дальше, агент решает сам по своему системному промпту и памяти.

Входящие Telegram/MAX/SMS дополнительно снимают ожидающие проверки контакта
сразу (cancel_pending_reply_checks), чтобы в календаре не висели неактуальные.
"""

import json
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import safe_rollback
from backend.models.agent_call import AgentCall
from backend.models.agent_contact import AgentContact
from backend.models.task import Task, TaskStatus

logger = get_logger(__name__)

REPLY_CHECK_CHANNEL = "reply_check"

# Сколько последних сообщений каждого канала смотреть при проверке.
_THREAD_SCAN_LIMIT = 50

_CHANNEL_LABEL = {
    "telegram": "Telegram",
    "max": "MAX",
    "sms": "SMS",
    "call": "звонок",
}


def _naive_utc(dt):
    if dt is not None and dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


def _reply(channel: str, ts, text: str = "") -> dict:
    text = " ".join((text or "").split())
    if len(text) > 200:
        text = text[:200].rstrip() + "…"
    return {
        "channel": channel,
        "channel_label": _CHANNEL_LABEL.get(channel, channel),
        "at": _naive_utc(ts).isoformat() if ts else None,
        "text": text,
    }


def _messenger_reply(rows, since, channel: str) -> Optional[dict]:
    for m in rows:
        if (m.direction or "inbound") != "inbound":
            continue
        ts = _naive_utc(m.created_at)
        if ts and ts > since:
            return _reply(channel, ts, m.body)
    return None


def client_reply_since(db: Session, agent_contact: AgentContact, since) -> Optional[dict]:
    """
    Первый найденный отклик клиента после момента since (naive UTC или aware).
    Возвращает {channel, channel_label, at, text} или None, если клиент молчит.
    Каждый канал best-effort: сбой одного не мешает проверить остальные.
    """
    since = _naive_utc(since)
    if agent_contact is None or since is None:
        return None

    try:
        from backend.services.telegram_user_service import get_thread as tg_thread
        found = _messenger_reply(tg_thread(db, agent_contact.id, limit=_THREAD_SCAN_LIMIT), since, "telegram")
        if found:
            return found
    except Exception as e:
        logger.warning(f"[REPLY-CHECK] telegram scan failed: {e}")

    try:
        from backend.services.max_user_service import get_thread as max_thread
        found = _messenger_reply(max_thread(db, agent_contact.id, limit=_THREAD_SCAN_LIMIT), since, "max")
        if found:
            return found
    except Exception as e:
        logger.warning(f"[REPLY-CHECK] max scan failed: {e}")

    try:
        from backend.models.voximplant_child import VoximplantChildAccount
        from backend.services.sms_history import get_sms_thread
        child = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == agent_contact.user_id
        ).first() if agent_contact.user_id else None
        if child and agent_contact.phone:
            for m in get_sms_thread(db, child.id, agent_contact.phone, limit=_THREAD_SCAN_LIMIT):
                if (m.direction or "inbound") != "inbound":
                    continue
                ts = _naive_utc(m.received_at or m.created_at)
                if ts and ts > since:
                    return _reply("sms", ts, m.body)
    except Exception as e:
        logger.warning(f"[REPLY-CHECK] sms scan failed: {e}")

    try:
        calls = db.query(AgentCall).filter(
            AgentCall.agent_contact_id == agent_contact.id,
            AgentCall.created_at > since,
        ).order_by(AgentCall.created_at.asc()).limit(_THREAD_SCAN_LIMIT).all()
        for c in calls:
            if c._resolve_channel() != "call":
                continue
            if (c.direction or "outbound") == "inbound" or c.status == "answered":
                return _reply("call", c.started_at or c.created_at, c.transcript or "")
    except Exception as e:
        logger.warning(f"[REPLY-CHECK] calls scan failed: {e}")

    return None


def cancel_pending_reply_checks(db: Session, agent_contact_id, reason: str) -> int:
    """
    Снять ожидающие проверки ответа контакта (клиент вышел на связь).
    Коммитит сам; ошибки не пробрасывает — вызывается из входящих хендлеров.
    """
    try:
        tasks = db.query(Task).filter(
            Task.agent_contact_id == agent_contact_id,
            Task.is_agent_task == True,  # noqa: E712
            Task.channel == REPLY_CHECK_CHANNEL,
            Task.status == TaskStatus.SCHEDULED,
        ).all()
        if not tasks:
            return 0
        now = datetime.utcnow()
        for t in tasks:
            t.status = TaskStatus.COMPLETED
            t.post_call_decision = "REPLIED"
            t.call_completed_at = now
            t.call_result = json.dumps({"replied": True, "reason": reason}, ensure_ascii=False)
        db.commit()
        logger.info(f"[REPLY-CHECK] Closed {len(tasks)} pending reply checks for contact {agent_contact_id}: {reason}")
        return len(tasks)
    except Exception as e:
        logger.warning(f"[REPLY-CHECK] cancel_pending_reply_checks failed: {e}")
        safe_rollback(db)
        return 0
