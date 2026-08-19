"""
MAX Poller — минутный опрос личных аккаунтов MAX агентов (коннектор MAX, PyMax).

Зеркалит telegram_user_poller.py. Официального userbot-API и вебхуков у MAX нет,
постоянное push-соединение в 4 gunicorn-воркерах с рециклингом ненадёжно —
поэтому вариант B: раз в check_interval секунд для каждого подключённого
аккаунта с включённым автоответом снимается срез диалогов (PyMax-клиент на один
опрос), новые входящие уходят в PostCall-оркестратор (handle_inbound_max),
который отвечает клиенту тулзой max_send_message.

Мультиворкер: startup-событие запускает поллер в КАЖДОМ воркере, аккаунт
достаётся ровно одному через атомарный claim по БД (UPDATE ... WHERE
last_poll_at < cutoff) — та же идея, что claim финализации в PostCall.

Идемпотентность: сообщения сохраняются в тред и last_processed_msg_time
продвигается ДО запуска оркестратора, поэтому сбой LLM не приводит к повторной
обработке. Маркер — время сообщения (unix ms): у MAX монотонность id в чате не
гарантирована протоколом, а время — да.

Охват автоответа (account.reply_scope):
  contacts — только диалоги, привязанные к контактам агента;
  all      — любые новые личные диалоги (контакт создаётся автоматически).
Группы, каналы и Saved Messages не обрабатываются (фильтр в
max_user_service.poll_dialogs — только type=DIALOG).
"""

import asyncio
from datetime import datetime, timedelta

from sqlalchemy import or_

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.services import max_user_service as max_user

logger = get_logger(__name__)

# Claim должен «протухать» чуть раньше интервала, чтобы не пропускать тики.
CLAIM_CUTOFF_SECONDS = 55

# Максимум запусков оркестратора с одного аккаунта за тик (защита от лавины
# после долгого простоя/переподключения).
MAX_DIALOG_RUNS_PER_TICK = 5


async def start_max_poller(check_interval: int = 60):
    """Запуск поллера. No-op, если MAX_SESSION_KEY не задан или pymax недоступен."""
    if not max_user.is_configured():
        logger.info("[MAX-POLLER] MAX connector not configured, poller disabled")
        return

    logger.info(f"[MAX-POLLER] Started (check every {check_interval}s)")
    while True:
        try:
            await _tick()
        except Exception as e:
            logger.error(f"[MAX-POLLER] tick error: {e}", exc_info=True)
        await asyncio.sleep(check_interval)


async def _tick():
    from backend.models.agent_max_account import AgentMaxAccount

    db = SessionLocal()
    try:
        account_ids = [
            row.id for row in db.query(AgentMaxAccount.id).filter(
                AgentMaxAccount.status == "connected",
                AgentMaxAccount.auto_reply_enabled == True,  # noqa: E712
            ).all()
        ]
        for account_id in account_ids:
            if not _claim(db, account_id):
                continue
            account = db.query(AgentMaxAccount).filter(
                AgentMaxAccount.id == account_id
            ).first()
            if not account:
                continue
            try:
                await _poll_account(db, account)
            except Exception as e:
                logger.error(f"[MAX-POLLER] account {account_id} poll error: {e}", exc_info=True)
                try:
                    db.rollback()
                except Exception:
                    pass
    finally:
        db.close()


def _claim(db, account_id) -> bool:
    """Атомарно занять аккаунт на этот тик (ровно один воркер из всех)."""
    from backend.models.agent_max_account import AgentMaxAccount

    now = datetime.utcnow()
    cutoff = now - timedelta(seconds=CLAIM_CUTOFF_SECONDS)
    claimed = db.query(AgentMaxAccount).filter(
        AgentMaxAccount.id == account_id,
        or_(
            AgentMaxAccount.last_poll_at.is_(None),
            AgentMaxAccount.last_poll_at < cutoff,
        ),
    ).update({"last_poll_at": now}, synchronize_session=False)
    db.commit()
    return bool(claimed)


def _match_contact_by_phone(db, agent_config_id, phone):
    """AgentContact агента по видимому номеру MAX-пользователя (или None)."""
    from backend.models.agent_contact import AgentContact
    from backend.services.sms_history import phone_suffix

    suf = phone_suffix(phone or "")
    if not suf:
        return None
    return db.query(AgentContact).filter(
        AgentContact.agent_config_id == agent_config_id,
        AgentContact.phone.like(f"%{suf}"),
    ).order_by(AgentContact.created_at.desc()).first()


async def _poll_account(db, account):
    from backend.models.agent_contact import AgentContact
    from backend.models.agent_max_account import AgentMaxDialog
    from backend.services.agent_orchestrator import handle_inbound_max

    dialog_rows = db.query(AgentMaxDialog).filter(
        AgentMaxDialog.account_id == account.id
    ).all()
    known = {int(r.max_chat_id): int(r.last_processed_msg_time or 0) for r in dialog_rows}
    by_chat = {int(r.max_chat_id): r for r in dialog_rows}

    snap = await max_user.poll_dialogs(str(account.id), account.phone or "", known)
    if not snap.get("ok"):
        err = snap.get("error") or "max_error"
        if err in ("session_revoked", "session_missing"):
            account.status = "error"
        account.last_error = err
        db.commit()
        logger.warning(f"[MAX-POLLER] poll failed for account {account.id}: {err}")
        return

    if account.last_error:
        account.last_error = None

    runs = 0
    for d in snap.get("dialogs", []):
        chat_id = d["chat_id"]
        row = by_chat.get(chat_id)
        msgs = d.get("new_messages") or []
        top_time = int(d.get("top_time") or 0)

        if row is None:
            # Диалог появился после подключения (baseline его не покрыл). Маркер
            # НЕ ставим сразу в top_time — иначе при отложенной обработке ниже
            # сообщения потеряются. Продвинем по факту обработки/отсутствия.
            contact = _match_contact_by_phone(db, account.agent_config_id, d.get("phone"))
            row = AgentMaxDialog(
                account_id=account.id,
                agent_contact_id=(contact.id if contact else None),
                max_chat_id=chat_id,
                max_peer_id=d.get("peer_id"),
                max_name=d.get("name"),
                last_processed_msg_time=0,
                created_via="inbound",
            )
            db.add(row)
            by_chat[chat_id] = row
        else:
            if d.get("name"):
                row.max_name = d["name"]
            if row.max_peer_id is None and d.get("peer_id"):
                row.max_peer_id = d.get("peer_id")
            if row.agent_contact_id is None and d.get("phone"):
                contact = _match_contact_by_phone(db, account.agent_config_id, d.get("phone"))
                if contact:
                    row.agent_contact_id = contact.id

        # Нет новых входящих — просто двигаем маркер к top_time, чтобы не
        # пере-сканировать этот диалог.
        if not msgs:
            if top_time > int(row.last_processed_msg_time or 0):
                row.last_processed_msg_time = top_time
            continue

        # Превышен лимит запусков за тик — маркер НЕ трогаем, добьём в следующий.
        if runs >= MAX_DIALOG_RUNS_PER_TICK:
            continue

        # Охват автоответа: contacts — только привязанные диалоги.
        contact_id = row.agent_contact_id
        if contact_id is None:
            if (account.reply_scope or "contacts") != "all":
                # Не отвечаем — но помечаем прочитанными маркером, чтобы не
                # перебирать каждый тик.
                new_marker = max([int(m["time"] or 0) for m in msgs] + [top_time])
                if new_marker > int(row.last_processed_msg_time or 0):
                    row.last_processed_msg_time = new_marker
                continue
            contact = AgentContact(
                agent_config_id=account.agent_config_id,
                user_id=account.user_id,
                phone=d.get("phone") or f"max:{chat_id}",
                name=d.get("name"),
                status="new",
            )
            db.add(contact)
            db.flush()
            row.agent_contact_id = contact.id
            contact_id = contact.id
            logger.info(f"[MAX-POLLER] 🆕 Создан AgentContact {contact_id} для входящего MAX {chat_id}")

        # Сохраняем входящие в тред и продвигаем маркер ДО запуска оркестратора
        # (идемпотентность: падение LLM не приведёт к повторной обработке).
        max_msg_time = int(row.last_processed_msg_time or 0)
        for m in msgs:
            max_user.store_message(
                db, account, "inbound", m["text"],
                agent_contact_id=contact_id,
                max_chat_id=chat_id,
                max_message_id=m["id"],
            )
            max_msg_time = max(max_msg_time, int(m["time"] or 0))
        row.last_processed_msg_time = max(max_msg_time, top_time)
        db.commit()

        text_joined = "\n".join(m["text"] for m in msgs)
        logger.info(
            f"[MAX-POLLER] {len(msgs)} new message(s) from chat {chat_id} "
            f"(account {account.id}) → orchestrator"
        )
        asyncio.create_task(handle_inbound_max(str(account.id), str(contact_id), text_joined))
        runs += 1

    db.commit()
