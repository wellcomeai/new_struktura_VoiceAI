"""
Тест ручного режима контакта (backend/services/agent_handoff.py).

    DATABASE_URL=postgresql://... python test_agent_handoff.py

Нужен пустой тестовый Postgres: таблицы создаются через metadata.create_all.
Сеть не используется.
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import backend.core.config  # noqa: F401
from backend.db.session import SessionLocal, engine
from backend.models.base import Base
import backend.models  # noqa: F401
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.agent_contact import AgentContact
from backend.models.agent_telegram_account import (
    AgentTelegramAccount, AgentTelegramDialog, AgentTelegramMessage,
)
from backend.models.task import Task, TaskStatus
from backend.services import agent_handoff, telegram_user_service as tg_user
from backend.core import telegram_user_poller as poller
from backend.core.task_scheduler import TaskScheduler


def setup(db):
    user = User(email=f"h{uuid.uuid4().hex[:8]}@example.test", password_hash="x")
    db.add(user); db.flush()
    agent = AgentConfig(user_id=user.id, name="Тест", is_active=True)
    db.add(agent); db.flush()
    contact = AgentContact(agent_config_id=agent.id, user_id=user.id, phone="+79990000001", name="Иван <b>")
    db.add(contact); db.flush()
    account = AgentTelegramAccount(agent_config_id=agent.id, user_id=user.id, status="connected",
                                   session_encrypted="x", auto_reply_enabled=True)
    db.add(account); db.flush()
    dialog = AgentTelegramDialog(account_id=account.id, agent_contact_id=contact.id, tg_peer_id=555,
                                 last_processed_msg_id=10)
    db.add(dialog); db.commit()
    return user, agent, contact, account, dialog


async def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    user, agent, contact, account, dialog = setup(db)

    # --- реестр «отправил агент»
    agent_handoff.mark_agent_sent("telegram", 555, 11)
    assert agent_handoff.was_agent_sent("telegram", 555, 11)
    assert not agent_handoff.was_agent_sent("telegram", 555, 12)
    assert not agent_handoff.was_agent_sent("max", 555, 11)

    # --- поллер: 11 — агент (реестр), 12 — агент (БД), 13 — менеджер
    tg_user.store_message(db, account, "outbound", "от агента", agent_contact_id=contact.id,
                          tg_peer_id=555, tg_message_id=12)
    db.commit()
    outs = [{"id": 11, "text": "a"}, {"id": 12, "text": "от агента"}]
    assert poller._handle_manager_messages(db, account, dialog, 555, outs, {}) == 0
    db.refresh(contact)
    assert not agent_handoff.is_active(contact)

    outs.append({"id": 13, "text": "Здравствуйте, это Пётр, скидка 10% до пятницы"})
    assert poller._handle_manager_messages(db, account, dialog, 555, outs, {}) == 1
    db.refresh(contact)
    assert agent_handoff.is_active(contact) and contact.handoff_source == "telegram"
    row = db.query(AgentTelegramMessage).filter(AgentTelegramMessage.tg_message_id == 13).one()
    assert row.sender == "manager" and row.direction == "outbound"
    assert row.to_dict()["sender"] == "manager"
    assert "МЕНЕДЖЕР" in tg_user.build_thread_text(db, contact.id)
    # повтор того же сообщения (уже в БД) — не дублируется
    assert poller._handle_manager_messages(db, account, dialog, 555, outs, {}) == 0

    # --- одна задача возврата, продление двигает её
    tasks = db.query(Task).filter(Task.agent_contact_id == contact.id,
                                  Task.channel == agent_handoff.HANDOFF_CHANNEL).all()
    assert len(tasks) == 1 and tasks[0].status == TaskStatus.SCHEDULED
    first_until = contact.handoff_until
    contact.handoff_until = first_until - timedelta(minutes=30); db.commit()
    assert agent_handoff.start(db, contact, "telegram") is False      # продление, не новое включение
    db.refresh(contact)
    assert contact.handoff_until > first_until - timedelta(minutes=1)
    assert db.query(Task).filter(Task.agent_contact_id == contact.id,
                                 Task.channel == agent_handoff.HANDOFF_CHANNEL).count() == 1

    # --- планировщик: чужая задача переносится на конец паузы, возврат проходит
    sched = TaskScheduler.__new__(TaskScheduler)
    agent.working_hours_start = agent.working_hours_end = 0   # круглосуточно
    other = Task(is_agent_task=True, channel="telegram", agent_contact_id=contact.id, user_id=user.id,
                 status=TaskStatus.PENDING, scheduled_time=datetime.now(timezone.utc), title="Сообщение")
    db.add(other); db.commit()
    assert sched._agent_task_may_run_now(other, contact, agent, db) is False
    assert other.status == TaskStatus.SCHEDULED
    assert other.scheduled_time.replace(tzinfo=None) > contact.handoff_until
    check = tasks[0]
    assert sched._agent_task_may_run_now(check, contact, agent, db) is True

    # --- тексты уведомлений экранируют имя
    assert "&lt;b&gt;" in agent_handoff.started_text(contact, "telegram")
    assert "Иван" in agent_handoff.returned_text(contact)

    # --- сводка для оркестратора
    tg_user.store_message(db, account, "inbound", "Хорошо, беру", agent_contact_id=contact.id,
                          tg_peer_id=555, tg_message_id=14,
                          created_at=datetime.utcnow() + timedelta(seconds=1))
    db.commit()
    summary = agent_handoff.pause_summary(db, contact, contact.handoff_since)
    assert "МЕНЕДЖЕР: Здравствуйте" in summary and "сообщений менеджера — 1" in summary
    assert "от клиента (без ответа)" in summary, summary

    # --- возврат кнопкой: пауза снята, задача на сейчас
    assert agent_handoff.release(db, contact) is True
    db.refresh(contact); db.refresh(check)
    assert not agent_handoff.is_active(contact)
    assert check.scheduled_time <= datetime.now(timezone.utc) + timedelta(seconds=1)
    assert agent_handoff.release(db, contact) is False
    assert sched._agent_task_may_run_now(other, contact, agent, db) is True

    # --- снятие режима при возврате
    since = agent_handoff.finish(db, contact); db.commit()
    assert since is not None and contact.handoff_until is None and contact.handoff_source is None
    assert contact.to_dict()["handoff_active"] is False

    # --- переподключение: связь диалога с контактом по ID пользователя Telegram
    from backend.api.agent_telegram_account import _store_baseline
    assert tg_user.match_contact_by_peer(db, agent.id, 555).id == contact.id
    assert tg_user.match_contact_by_peer(db, agent.id, 999) is None
    db.delete(account); db.commit()                       # отключение: аккаунт и диалоги удалены
    assert db.query(AgentTelegramMessage).filter(AgentTelegramMessage.tg_peer_id == 555).count() > 0
    account2 = AgentTelegramAccount(agent_config_id=agent.id, user_id=user.id, status="connected",
                                    session_encrypted="x", reply_scope="all")
    db.add(account2); db.commit()
    _store_baseline(account2.id, agent.id, [
        {"peer_id": 555, "phone": None, "top_id": 20, "name": "Иван"},     # номер скрыт
        {"peer_id": 777, "phone": None, "top_id": 5, "name": "Незнакомец"},
    ])
    rows = {r.tg_peer_id: r for r in db.query(AgentTelegramDialog).filter(
        AgentTelegramDialog.account_id == account2.id).all()}
    assert rows[555].agent_contact_id == contact.id, "диалог не привязан к прежнему контакту"
    assert rows[777].agent_contact_id is None
    # поллер: диалог без связи подхватывает контакт по ID
    rows[555].agent_contact_id = None; db.commit()
    assert poller._match_contact(db, agent.id, 555, None).id == contact.id

    db.close()
    print("ALL OK")


if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL не задан — тест пропущен")
        sys.exit(0)
    asyncio.run(main())
