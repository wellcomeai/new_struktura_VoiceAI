"""
Agent Telegram API v2.2 — подключение и управление Telegram-ботом агента.

Префикс: /api/agent/telegram

Бот агента: фронтенд для AGENT_CHAT + канал доставки уведомлений тулзы
send_telegram_notification из PostCall-оркестратора.

Старые users.telegram_* (общесистемные уведомления о звонках) не трогаются.
"""

import html
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.core.dependencies import get_current_user
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.services.agent_telegram_service import (
    AgentTelegramService,
    process_telegram_message,
    is_group_chat,
    is_addressed_to_bot,
    bot_id_from_token,
    strip_bot_mention,
    group_reply_extra,
    generate_webhook_secret,
    build_webhook_url,
)

logger = get_logger(__name__)

router = APIRouter()

VALID_CHAT_TYPES = {"private", "group", "supergroup", "channel"}


# ============================================================================
# SCHEMAS
# ============================================================================

class TelegramConnectRequest(BaseModel):
    bot_token: str = Field(..., min_length=10, max_length=100)


class TelegramEnabledRequest(BaseModel):
    enabled: bool


class TelegramOwnerAddRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=20, description="Telegram ID пользователя (число)")
    label: Optional[str] = Field(None, max_length=60, description="Подпись, напр. «Иван»")


class TelegramChatAddRequest(BaseModel):
    chat_id: str = Field(..., min_length=1, max_length=50)
    title: Optional[str] = None
    type: Optional[str] = None


# ============================================================================
# HELPERS
# ============================================================================

def _get_agent(current_user: User, db: Session, agent_id: Optional[str] = None) -> AgentConfig:
    """
    Резолв конкретного агента пользователя для настроек Telegram (v3.1).
    При наличии agent_id ищем именно его (в пределах user_id); иначе — первого
    по дате создания (обратная совместимость с одним агентом).

    Каждый агент имеет собственный telegram_bot_token + уникальный
    telegram_webhook_secret, поэтому у каждого агента — свой бот и свой webhook.
    """
    q = db.query(AgentConfig).filter(AgentConfig.user_id == current_user.id)
    if agent_id:
        agent = q.filter(AgentConfig.id == agent_id).first()
    else:
        agent = q.order_by(AgentConfig.created_at.asc()).first()
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


def _settings_dict(agent: AgentConfig) -> dict:
    """Сериализация настроек Telegram (без раскрытия токена/секрета целиком)."""
    is_configured = agent.has_telegram_bot()
    token_masked = None
    if agent.telegram_bot_token:
        token_masked = "***" + agent.telegram_bot_token[-4:]

    return {
        "enabled": bool(agent.telegram_enabled),
        "is_configured": is_configured,
        "bot_username": agent.telegram_bot_username,
        "bot_token_masked": token_masked,
        "chat_ids": agent.telegram_chat_ids or [],
        # Владельцы бота (полный доступ). Пусто — все в разрешённых чатах владельцы.
        "owner_ids": agent.telegram_owner_ids or [],
    }


# ============================================================================
# ENDPOINTS — SETTINGS
# ============================================================================

@router.get("")
@router.get("/")
async def get_telegram_settings(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Текущие настройки Telegram-бота агента."""
    agent = _get_agent(current_user, db, agent_id)

    # Авто-миграция webhook: если у Telegram зарегистрирован старый URL
    # (например, через Selectel-прокси), тихо переустанавливаем на актуальный.
    if agent.has_telegram_bot() and agent.telegram_webhook_secret:
        try:
            expected_url = build_webhook_url(agent.telegram_webhook_secret)
            info = await AgentTelegramService.get_webhook_info(agent.telegram_bot_token)
            if info and info.get("url") != expected_url:
                logger.info(
                    f"[AGENT-TG] Webhook URL drift detected for user {current_user.id}: "
                    f"{info.get('url')} -> {expected_url}, re-registering..."
                )
                await AgentTelegramService.setup_webhook(
                    agent.telegram_bot_token, expected_url, agent.telegram_webhook_secret
                )
        except Exception as e:
            logger.warning(f"[AGENT-TG] Webhook drift check failed for user {current_user.id}: {e}")

    return _settings_dict(agent)


@router.put("")
@router.put("/")
async def connect_telegram_bot(
    body: TelegramConnectRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Подключить / обновить Telegram-бота агента."""
    agent = _get_agent(current_user, db, agent_id)

    token = body.bot_token.strip()

    # 1. Валидируем токен
    bot_info = await AgentTelegramService.validate_token(token)
    if not bot_info:
        raise HTTPException(status_code=400, detail="invalid_token")

    # 1b. Один бот = один webhook. Запрещаем переиспользовать токен другим
    #     агентом, иначе setup_webhook перезапишет webhook первого агента.
    token_owner = db.query(AgentConfig).filter(
        AgentConfig.telegram_bot_token == token,
        AgentConfig.id != agent.id,
    ).first()
    if token_owner:
        raise HTTPException(status_code=400, detail="token_already_used")

    # 2. Снимаем webhook со старого токена, если он отличается
    old_token = agent.telegram_bot_token
    if old_token and old_token != token:
        await AgentTelegramService.delete_webhook(old_token)

    # 3. Сохраняем токен и username
    agent.telegram_bot_token = token
    agent.telegram_bot_username = bot_info.get("username")

    # 4. Генерируем secret если его нет
    if not agent.telegram_webhook_secret:
        agent.telegram_webhook_secret = generate_webhook_secret()

    # 5. Регистрируем webhook
    webhook_url = build_webhook_url(agent.telegram_webhook_secret)
    ok = await AgentTelegramService.setup_webhook(token, webhook_url, agent.telegram_webhook_secret)
    if not ok:
        logger.warning(f"[AGENT-TG] setup_webhook failed for user {current_user.id} (token saved anyway)")

    # 6. telegram_enabled не трогаем (FALSE при первом подключении — пусть юзер включит сам)
    db.commit()
    db.refresh(agent)

    logger.info(f"[AGENT-TG] Bot @{agent.telegram_bot_username} connected for user {current_user.id}")
    return _settings_dict(agent)


@router.delete("")
@router.delete("/")
async def disconnect_telegram_bot(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Отключить и удалить Telegram-бота агента (истории чатов остаются)."""
    agent = _get_agent(current_user, db, agent_id)

    old_token = agent.telegram_bot_token
    if old_token:
        await AgentTelegramService.delete_webhook(old_token)

    agent.telegram_bot_token = None
    agent.telegram_bot_username = None
    agent.telegram_webhook_secret = None
    agent.telegram_chat_ids = []
    agent.telegram_enabled = False
    flag_modified(agent, "telegram_chat_ids")
    db.commit()

    logger.info(f"[AGENT-TG] Bot disconnected for user {current_user.id}")
    return _settings_dict(agent)


@router.patch("/enabled")
def set_telegram_enabled(
    body: TelegramEnabledRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Рубильник enabled/disabled."""
    agent = _get_agent(current_user, db, agent_id)
    agent.telegram_enabled = bool(body.enabled)
    db.commit()
    db.refresh(agent)
    return _settings_dict(agent)


@router.post("/regenerate-secret")
async def regenerate_telegram_secret(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Перевыпустить webhook secret и переустановить webhook."""
    agent = _get_agent(current_user, db, agent_id)
    if not agent.telegram_bot_token:
        raise HTTPException(status_code=400, detail="telegram_bot_not_configured")

    agent.telegram_webhook_secret = generate_webhook_secret()
    webhook_url = build_webhook_url(agent.telegram_webhook_secret)
    ok = await AgentTelegramService.setup_webhook(
        agent.telegram_bot_token, webhook_url, agent.telegram_webhook_secret
    )
    if not ok:
        logger.warning(f"[AGENT-TG] regenerate-secret: setup_webhook failed for user {current_user.id}")

    db.commit()
    db.refresh(agent)
    return _settings_dict(agent)


# ============================================================================
# ENDPOINTS — CHATS
# ============================================================================

@router.post("/chats")
def add_telegram_chat(
    body: TelegramChatAddRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Добавить chat_id вручную."""
    agent = _get_agent(current_user, db, agent_id)

    chat_id = body.chat_id.strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="chat_id_required")

    chat_type = body.type
    if chat_type and chat_type not in VALID_CHAT_TYPES:
        raise HTTPException(status_code=400, detail="invalid_chat_type")

    chats = list(agent.telegram_chat_ids or [])
    if any(c.get("chat_id") == chat_id for c in chats):
        raise HTTPException(status_code=400, detail="already_exists")

    chats.append({
        "chat_id": chat_id,
        "title": body.title,
        "type": chat_type,
        "added_at": datetime.utcnow().isoformat(),
    })
    agent.telegram_chat_ids = chats
    flag_modified(agent, "telegram_chat_ids")
    db.commit()
    db.refresh(agent)

    logger.info(f"[AGENT-TG] Added chat {chat_id} for user {current_user.id}")
    return _settings_dict(agent)


# ============================================================================
# ENDPOINTS — OWNERS (чьи команды бот выполняет полностью)
# ============================================================================

@router.post("/owners")
def add_telegram_owner(
    body: TelegramOwnerAddRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Добавить владельца бота по Telegram ID пользователя (узнать — командой /id боту)."""
    agent = _get_agent(current_user, db, agent_id)
    user_id = body.user_id.strip()
    if not user_id.isdigit():
        raise HTTPException(status_code=400, detail="invalid_user_id")
    owners = list(agent.telegram_owner_ids or [])
    if any(str(o.get("user_id")) == user_id for o in owners):
        raise HTTPException(status_code=400, detail="already_exists")
    owners.append({
        "user_id": user_id,
        "label": (body.label or "").strip() or None,
        "added_at": datetime.utcnow().isoformat(),
    })
    agent.telegram_owner_ids = owners
    flag_modified(agent, "telegram_owner_ids")
    db.commit()
    db.refresh(agent)
    logger.info(f"[AGENT-TG] Added owner {user_id} for agent {agent.id}")
    return _settings_dict(agent)


@router.delete("/owners/{owner_user_id}")
def delete_telegram_owner(
    owner_user_id: str,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Удалить владельца бота."""
    agent = _get_agent(current_user, db, agent_id)
    owners = [o for o in (agent.telegram_owner_ids or []) if str(o.get("user_id")) != owner_user_id]
    agent.telegram_owner_ids = owners
    flag_modified(agent, "telegram_owner_ids")
    db.commit()
    db.refresh(agent)
    logger.info(f"[AGENT-TG] Removed owner {owner_user_id} for agent {agent.id}")
    return _settings_dict(agent)


@router.delete("/chats/{chat_id}")
def delete_telegram_chat(
    chat_id: str,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Удалить chat_id из массива."""
    agent = _get_agent(current_user, db, agent_id)

    chats = list(agent.telegram_chat_ids or [])
    new_chats = [c for c in chats if c.get("chat_id") != chat_id]
    agent.telegram_chat_ids = new_chats
    flag_modified(agent, "telegram_chat_ids")
    db.commit()
    db.refresh(agent)

    logger.info(f"[AGENT-TG] Removed chat {chat_id} for user {current_user.id}")
    return _settings_dict(agent)


# ============================================================================
# ENDPOINTS — TEST
# ============================================================================

@router.post("/test")
async def test_telegram(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Отправить тестовое сообщение во все добавленные чаты."""
    agent = _get_agent(current_user, db, agent_id)

    if not agent.has_telegram_bot():
        raise HTTPException(status_code=400, detail="telegram_bot_not_configured")
    if not agent.get_telegram_chat_ids_list():
        raise HTTPException(status_code=400, detail="no_chat_ids_configured")

    text = "🧪 Тестовое сообщение от Voicyfy Agent. Если ты это видишь — связь работает."

    # send_to_all_chats требует telegram_enabled — для теста шлём напрямую,
    # чтобы можно было проверить связь до включения рубильника.
    import asyncio
    chat_ids = agent.get_telegram_chat_ids_list()
    token = agent.telegram_bot_token
    results = await asyncio.gather(
        *[AgentTelegramService.send_message(token, cid, text) for cid in chat_ids],
        return_exceptions=True,
    )
    sent = sum(1 for r in results if r is True)
    total = len(chat_ids)
    return {"sent": sent, "failed": total - sent, "total": total}


# ============================================================================
# ENDPOINT — WEBHOOK (public, no auth)
# ============================================================================

def _id_command_reply(message: dict, bot_username: Optional[str]) -> Optional[str]:
    """Ответ на /id (или /id@имя_бота) — Telegram ID отправителя и ID чата; иначе None."""
    text = (message.get("text") or "").strip()
    if not text.startswith("/"):
        return None
    cmd = text.split()[0].lower()
    uname = (bot_username or "").lstrip("@").lower()
    if cmd == "/id" and not is_group_chat(message):
        pass
    elif not (uname and cmd == f"/id@{uname}"):
        return None
    from_user = message.get("from") or {}
    chat = message.get("chat") or {}
    name = " ".join(x for x in (from_user.get("first_name"), from_user.get("last_name")) if x) or "—"
    return (
        f"Ваш Telegram ID: <code>{from_user.get('id', '—')}</code> ({html.escape(name)})\n"
        f"ID этого чата: <code>{chat.get('id', '—')}</code>\n\n"
        "Чтобы бот выполнял ваши команды (контакты, звонки, задачи), добавьте ваш ID в "
        "настройках агента → Telegram-бот → «Владельцы бота». Чтобы бот работал в этом чате, "
        "добавьте ID чата в список чатов."
    )


@router.post("/webhook/{secret}")
async def telegram_webhook(
    secret: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Публичный webhook от Telegram. БЕЗ авторизации.
    Всегда возвращает 200 OK, чтобы Telegram не ретраил.
    """
    try:
        # 1. Найти агента по secret
        agent = db.query(AgentConfig).filter(
            AgentConfig.telegram_webhook_secret == secret
        ).first()
        if not agent:
            return {"ok": True}

        # 2. Проверить заголовок секрет-токена
        header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if header_secret != secret:
            logger.warning(f"[AGENT-TG] Webhook secret header mismatch for agent {agent.id}")
            return {"ok": True}

        # 3. Включён ли бот
        if not agent.telegram_enabled:
            logger.info(f"[AGENT-TG] Webhook ignored: bot disabled (agent {agent.id})")
            return {"ok": True}

        # 4. Распарсить update
        try:
            update = await request.json()
        except Exception:
            return {"ok": True}

        message = update.get("message")
        if not message or not isinstance(message, dict):
            return {"ok": True}

        chat = message.get("chat", {})
        chat_id = str(chat.get("id", ""))

        # 4a. /id — подсказка «ваш ID / ID чата» для настроек бота. Без модели и до
        #     проверки списка чатов: владельцу нужно узнать ID, пока его чат не добавлен.
        #     В группе — только /id@имя_бота, чтобы не отвечать на чужие команды.
        id_reply = _id_command_reply(message, agent.telegram_bot_username)
        if id_reply:
            await AgentTelegramService.send_message(
                token=agent.telegram_bot_token, chat_id=chat_id, text=id_reply,
                extra=group_reply_extra(message),
            )
            return {"ok": True}

        # 5. chat_id в списке разрешённых?
        if not chat_id or chat_id not in agent.get_telegram_chat_ids_list():
            logger.info(
                f"[AGENT-TG] Webhook ignored: chat {chat_id} not in allow-list "
                f"{agent.get_telegram_chat_ids_list()} (agent {agent.id})"
            )
            return {"ok": True}

        # 5a. В группе отвечаем, только когда обращаются к боту: @упоминание,
        #     /команда@бот или ответ (reply) на сообщение бота. Остальное молча
        #     пропускаем — без ответа, распознавания голосовых и записи в историю.
        in_group = is_group_chat(message)
        if in_group and not is_addressed_to_bot(
            message, agent.telegram_bot_username, bot_id_from_token(agent.telegram_bot_token),
        ):
            return {"ok": True}
        reply_extra = group_reply_extra(message)

        # 6. Текст или голосовое (voice → распознаём в текст через STT)
        text = message.get("text") or (message.get("caption") if in_group else None)
        if not text:
            voice = message.get("voice")
            if voice:
                await AgentTelegramService._call(
                    agent.telegram_bot_token, "sendChatAction",
                    {"chat_id": chat_id, "action": "typing",
                     **({"message_thread_id": reply_extra["message_thread_id"]}
                        if reply_extra.get("message_thread_id") else {})},
                )
                text = await AgentTelegramService.transcribe_voice(
                    agent.telegram_bot_token, voice,
                )
                if not text:
                    await AgentTelegramService.send_message(
                        token=agent.telegram_bot_token,
                        chat_id=chat_id,
                        text="Не удалось распознать голосовое. Попробуйте ещё раз или напишите текстом.",
                        extra=reply_extra,
                    )
                    return {"ok": True}
            else:
                await AgentTelegramService.send_message(
                    token=agent.telegram_bot_token,
                    chat_id=chat_id,
                    text="Я понимаю только текстовые и голосовые сообщения.",
                    extra=reply_extra,
                )
                return {"ok": True}

        # Упоминание бота модели не нужно: «@bot сколько звонков?» → «сколько звонков?»
        if in_group:
            text = strip_bot_mention(text, agent.telegram_bot_username)
            if not text:
                await AgentTelegramService.send_message(
                    token=agent.telegram_bot_token,
                    chat_id=chat_id,
                    text="Слушаю! Напишите вопрос после упоминания или ответьте на моё сообщение.",
                    extra=reply_extra,
                )
                return {"ok": True}

        # 7. Отправитель: владелец (полный доступ) или гость (только разговор и справка)
        from_user = message.get("from", {}) or {}
        is_owner = agent.is_telegram_owner(from_user.get("id"))

        # 8. Обработать
        logger.info(f"[AGENT-TG] Incoming message from chat {chat_id} (agent {agent.id}): {text[:80]!r}")
        await process_telegram_message(
            agent=agent,
            chat_id=chat_id,
            text=text,
            from_user=from_user,
            message=message,
            db=db,
            is_owner=is_owner,
        )

    except Exception as e:
        logger.error(f"[AGENT-TG] Webhook error: {e}", exc_info=True)

    # 9. Всегда 200 OK
    return {"ok": True}
