"""
Ручной режим контакта: диалог ведёт живой менеджер, агент молчит.

Включается двумя способами:
  • автоматически — менеджер сам написал клиенту с личного Telegram / MAX, к
    которому подключён агент (поллер Telegram и живой клиент MAX видят исходящее
    сообщение, которого агент не отправлял);
  • вручную — кнопка «Взять диалог» в карточке контакта.

Пока режим активен (agent_contacts.handoff_until в будущем), по ЭТОМУ КОНТАКТУ
во всех каналах:
  • входящие сообщения сохраняются, но оркестратор не запускается;
  • запланированные звонки / сообщения / проверки ответа переносятся на конец
    паузы (TaskScheduler._agent_task_may_run_now);
  • фоновые прогоны не могут писать и звонить клиенту (execute_tool).
Каждое новое сообщение менеджера продлевает паузу на HANDOFF_MINUTES от него.

Возврат — задача Task(channel="handoff_check") на момент конца паузы (одна на
контакт, при продлении сдвигается). Планировщик (execute_agent_handoff_check)
снимает режим и запускает один прогон оркестратора
(PostCallOrchestrator.run_for_handoff_return): агент читает переписку, где
реплики человека помечены «менеджер → клиент», фиксирует договорённости в памяти
контакта и решает, что делать дальше. Кнопка «Вернуть агенту» делает то же сразу.
"""

import asyncio
import html
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import safe_rollback
from backend.models.agent_contact import AgentContact
from backend.models.task import Task, TaskStatus

logger = get_logger(__name__)

HANDOFF_CHANNEL = "handoff_check"
HANDOFF_MINUTES = 60

SOURCE_LABEL = {"telegram": "Telegram", "max": "MAX", "manual": "кнопка в кабинете"}

# Что отвечает инструмент, когда фоновый прогон пытается написать/позвонить
# клиенту, которого сейчас ведёт менеджер.
BLOCKED_MESSAGE = (
    "Диалог с этим клиентом сейчас ведёт живой менеджер — писать и звонить клиенту "
    "нельзя. Ничего не отправляй; зафиксируй важное в памяти контакта. Когда менеджер "
    "закончит, тебя разбудят отдельным событием."
)


def is_active(contact, now: Optional[datetime] = None) -> bool:
    until = getattr(contact, "handoff_until", None)
    return bool(until and until > (now or datetime.utcnow()))


# ---------------------------------------------------------------------------
# Сообщения, отправленные самим агентом. Поллер видит их как исходящие наравне
# с сообщениями менеджера; отличаем по id. В БД id попадает после commit тулзы,
# а файл с длинным текстом уходит двумя сообщениями (в БД — только последнее),
# поэтому свежие id дополнительно держим в памяти процесса.
# ---------------------------------------------------------------------------
_AGENT_SENT: Dict[Tuple[str, int, int], float] = {}
_AGENT_SENT_TTL = 15 * 60


def mark_agent_sent(channel: str, chat_id, message_id) -> None:
    try:
        if not chat_id or not message_id:
            return
        now = time.time()
        if len(_AGENT_SENT) > 5000:
            for key in [k for k, ts in _AGENT_SENT.items() if now - ts > _AGENT_SENT_TTL]:
                _AGENT_SENT.pop(key, None)
        _AGENT_SENT[(channel, int(chat_id), int(message_id))] = now
    except Exception:
        pass


def was_agent_sent(channel: str, chat_id, message_id) -> bool:
    try:
        ts = _AGENT_SENT.get((channel, int(chat_id), int(message_id)))
    except Exception:
        return False
    return bool(ts and time.time() - ts <= _AGENT_SENT_TTL)


# ---------------------------------------------------------------------------
# Включение / продление / снятие
# ---------------------------------------------------------------------------

def _check_task(db: Session, contact: AgentContact) -> Optional[Task]:
    return db.query(Task).filter(
        Task.agent_contact_id == contact.id,
        Task.is_agent_task == True,  # noqa: E712
        Task.channel == HANDOFF_CHANNEL,
        Task.status == TaskStatus.SCHEDULED,
    ).order_by(Task.scheduled_time.desc()).first()


def _upsert_check_task(db: Session, contact: AgentContact, when: datetime) -> None:
    from backend.services.agent_tools import assistant_task_kwargs
    when = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when
    task = _check_task(db, contact)
    if task is not None:
        task.scheduled_time = when
        return
    db.add(Task(
        is_agent_task=True,
        channel=HANDOFF_CHANNEL,
        agent_contact_id=contact.id,
        user_id=contact.user_id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=when,
        title="Возврат диалога от менеджера",
        description="Менеджер вёл диалог вручную. Проверить переписку и решить, что делать дальше.",
        **assistant_task_kwargs(contact.agent_config),
    ))


def start(db: Session, contact: AgentContact, source: str, minutes: int = HANDOFF_MINUTES) -> bool:
    """
    Включить или продлить ручной режим. Коммитит сам. Возвращает True, если режим
    включён только что (а не продлён) — тогда стоит уведомить владельца.
    """
    now = datetime.utcnow()
    started = not is_active(contact, now)
    until = now + timedelta(minutes=minutes)
    if contact.handoff_until and contact.handoff_until > until:
        until = contact.handoff_until
    contact.handoff_until = until
    if started:
        contact.handoff_since = now
        contact.handoff_source = source
    _upsert_check_task(db, contact, until)
    db.commit()
    logger.info(
        f"[HANDOFF] contact {contact.id}: {'started' if started else 'extended'} "
        f"via {source} until {until.isoformat()}"
    )
    return started


def release(db: Session, contact: AgentContact) -> bool:
    """
    «Вернуть агенту»: пауза снимается сейчас, задача возврата переносится на
    текущий момент — ближайший проход планировщика запустит разбор переписки.
    Коммитит сам. False — режим и так не был активен.
    """
    now = datetime.utcnow()
    if not is_active(contact, now):
        return False
    contact.handoff_until = now
    _upsert_check_task(db, contact, now)
    db.commit()
    logger.info(f"[HANDOFF] contact {contact.id}: released manually")
    return True


def finish(db: Session, contact: AgentContact) -> Optional[datetime]:
    """Снять режим при возврате (без commit). Возвращает момент начала паузы."""
    since = contact.handoff_since
    contact.handoff_until = None
    contact.handoff_since = None
    contact.handoff_source = None
    return since


# ---------------------------------------------------------------------------
# Уведомления владельцу в бот агента
# ---------------------------------------------------------------------------

def _contact_label(contact) -> str:
    name = (contact.name or "").strip()
    phone = (contact.phone or "").strip()
    if phone.startswith(("tg:", "max:")):
        phone = ""
    label = name or phone or "клиент"
    if name and phone:
        label = f"{name} ({phone})"
    return html.escape(label)


async def notify_owner(agent_config, text: str) -> None:
    """Best-effort сообщение в бот уведомлений агента (если подключён)."""
    try:
        from backend.services.agent_telegram_service import AgentTelegramService
        await AgentTelegramService.send_to_all_chats(agent_config, text)
    except Exception as e:
        logger.warning(f"[HANDOFF] notify_owner failed: {e}")


def started_text(contact, source: str) -> str:
    from backend.core.timezone_utils import utc_to_msk
    until = utc_to_msk(contact.handoff_until).strftime("%H:%M") if contact.handoff_until else "?"
    how = (
        "Вы взяли диалог на себя" if source == "manual"
        else f"Вы сами написали клиенту в {SOURCE_LABEL.get(source, source)}"
    )
    return (
        f"✋ {how}: {_contact_label(contact)}.\n"
        f"Я не пишу и не звоню этому клиенту до {until} МСК; каждое ваше сообщение продлевает паузу "
        f"на {HANDOFF_MINUTES} мин. Потом прочитаю вашу переписку и продолжу сам.\n"
        f"Вернуть диалог раньше — кнопка «Вернуть агенту» в карточке контакта."
    )


def returned_text(contact) -> str:
    return (
        f"🤖 Пауза закончилась: снова веду {_contact_label(contact)}. "
        f"Вашу переписку прочитал, договорённости записал в память контакта.\n"
        f"Нужно ещё время — напишите клиенту сами или нажмите «Взять диалог» в карточке контакта."
    )


def start_and_notify(db: Session, contact: AgentContact, agent_config, source: str) -> bool:
    """start() + уведомление владельцу при первом включении. Вызывается из event loop."""
    try:
        started = start(db, contact, source)
    except Exception as e:
        logger.error(f"[HANDOFF] start failed for contact {getattr(contact, 'id', None)}: {e}", exc_info=True)
        safe_rollback(db)
        return False
    if started and agent_config is not None:
        try:
            asyncio.get_running_loop().create_task(notify_owner(agent_config, started_text(contact, source)))
        except RuntimeError:
            pass  # вызвали вне event loop — уведомление пропускаем
    return started


def pause_summary(db: Session, contact: AgentContact, since: Optional[datetime]) -> str:
    """Короткая сводка для оркестратора: кто и сколько писал за время паузы."""
    from backend.core.timezone_utils import utc_to_msk
    lines = []
    if since:
        lines.append(f"Менеджер вёл диалог с {utc_to_msk(since).strftime('%d.%m.%Y %H:%M')} МСК.")
    rows = []
    for channel, module in (("Telegram", "telegram_user_service"), ("MAX", "max_user_service")):
        try:
            mod = __import__(f"backend.services.{module}", fromlist=["get_thread"])
            for m in mod.get_thread(db, contact.id, limit=50):
                if since and m.created_at and m.created_at < since - timedelta(minutes=2):
                    continue
                rows.append((m.created_at, channel, m))
        except Exception as e:
            logger.warning(f"[HANDOFF] pause_summary {channel} failed: {e}")
    rows.sort(key=lambda r: r[0] or datetime.min)
    manager = sum(1 for _, _, m in rows if (m.sender or "") == "manager")
    client = sum(1 for _, _, m in rows if (m.direction or "inbound") == "inbound")
    lines.append(f"За это время: сообщений менеджера — {manager}, сообщений клиента — {client}.")
    if rows:
        _, _, last = rows[-1]
        who = "клиента (без ответа)" if (last.direction or "inbound") == "inbound" else (
            "менеджера" if (last.sender or "") == "manager" else "твоё"
        )
        lines.append(f"Последнее сообщение в переписке — от {who}.")
    for ts, channel, m in rows[-30:]:
        who = "клиент" if (m.direction or "inbound") == "inbound" else (
            "МЕНЕДЖЕР" if (m.sender or "") == "manager" else "агент"
        )
        stamp = utc_to_msk(ts).strftime("%d.%m %H:%M") if ts else "?"
        body = " ".join((m.body or "").split())
        lines.append(f"[{stamp}] {channel}, {who}: {body[:500]}")
    if not rows:
        lines.append("В Telegram и MAX новых сообщений за время паузы нет (менеджер мог общаться иначе).")
    return "\n".join(lines)
