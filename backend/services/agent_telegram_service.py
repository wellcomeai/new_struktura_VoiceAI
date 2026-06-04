"""
AgentTelegramService — весь Telegram Bot API агента в одном месте.

v2.2 Telegram bot integration

Бот агента выполняет две роли:
1. Фронтенд для AGENT_CHAT — общение с агентом прямо из Telegram.
2. Канал доставки уведомлений от тулзы send_telegram_notification (PostCall).

Используется только REST к https://api.telegram.org/bot{token}/{method}
через httpx.AsyncClient. Никакого python-telegram-bot.
"""

import asyncio
import secrets
from datetime import datetime
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.agent_config import AgentConfig
from backend.models.agent_telegram_chat_history import AgentTelegramChatHistory
from backend.models.user import User

logger = get_logger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
REQUEST_TIMEOUT = 20.0


def generate_webhook_secret() -> str:
    """~43 символа, влезает в VARCHAR(64)."""
    return secrets.token_urlsafe(32)


def build_webhook_url(secret: str) -> str:
    base = (settings.PUBLIC_BASE_URL or settings.HOST_URL or "").rstrip("/")
    return f"{base}/api/agent/telegram/webhook/{secret}"


class AgentTelegramService:
    """Тонкая обёртка над Telegram Bot API для бота агента."""

    @staticmethod
    async def _call(token: str, method: str, payload: dict) -> Optional[dict]:
        """Низкоуровневый вызов метода Telegram Bot API. Возвращает result или None."""
        url = TELEGRAM_API.format(token=token, method=method)
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                resp = await client.post(url, json=payload)
                data = resp.json()
                if resp.status_code == 200 and data.get("ok"):
                    return data.get("result")
                logger.error(
                    f"[AGENT-TG] {method} failed: {data.get('error_code')} - {data.get('description')}"
                )
                return None
        except Exception as e:
            logger.error(f"[AGENT-TG] {method} request error: {e}")
            return None

    @staticmethod
    async def validate_token(token: str) -> Optional[dict]:
        """getMe → {"id", "username", "first_name"} или None при ошибке."""
        if not token:
            return None
        result = await AgentTelegramService._call(token, "getMe", {})
        if not result:
            return None
        return {
            "id": result.get("id"),
            "username": result.get("username"),
            "first_name": result.get("first_name"),
        }

    @staticmethod
    async def setup_webhook(token: str, webhook_url: str, secret: str) -> bool:
        """setWebhook с secret_token, allowed_updates=['message'], drop_pending_updates."""
        result = await AgentTelegramService._call(token, "setWebhook", {
            "url": webhook_url,
            "secret_token": secret,
            "allowed_updates": ["message"],
            "drop_pending_updates": True,
        })
        return result is True or bool(result)

    @staticmethod
    async def delete_webhook(token: str) -> bool:
        """deleteWebhook."""
        if not token:
            return False
        result = await AgentTelegramService._call(token, "deleteWebhook", {
            "drop_pending_updates": False,
        })
        return result is True or bool(result)

    @staticmethod
    async def send_message(token: str, chat_id: str, text: str, parse_mode: str = "HTML") -> bool:
        """sendMessage. Безопасная обёртка — не бросает наружу, только логирует."""
        if not token or not chat_id:
            return False
        result = await AgentTelegramService._call(token, "sendMessage", {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True,
        })
        return result is not None

    @staticmethod
    async def send_to_all_chats(agent_config: AgentConfig, text: str) -> dict:
        """
        Шлёт text во все chat_id из agent_config.telegram_chat_ids параллельно.
        Возвращает {"sent": int, "failed": int, "total": int}.
        """
        if not agent_config.telegram_enabled or not agent_config.has_telegram_bot():
            return {"sent": 0, "failed": 0, "total": 0}

        chat_ids = agent_config.get_telegram_chat_ids_list()
        if not chat_ids:
            return {"sent": 0, "failed": 0, "total": 0}

        token = agent_config.telegram_bot_token
        results = await asyncio.gather(
            *[AgentTelegramService.send_message(token, cid, text) for cid in chat_ids],
            return_exceptions=True,
        )

        sent = sum(1 for r in results if r is True)
        total = len(chat_ids)
        return {"sent": sent, "failed": total - sent, "total": total}


async def process_telegram_message(
    agent: AgentConfig,
    chat_id: str,
    text: str,
    from_user: dict,
    message: dict,
    db: Session,
) -> None:
    """
    Обрабатывает входящее текстовое сообщение в чат-режиме:
    1. Находит/создаёт AgentTelegramChatHistory для чата.
    2. Обновляет метаданные отправителя.
    3. Вызывает ChatOrchestrator.run_telegram.
    4. Отправляет ответ обратно в Telegram.
    """
    # 1. Найти или создать историю чата
    history_row = db.query(AgentTelegramChatHistory).filter(
        AgentTelegramChatHistory.agent_config_id == agent.id,
        AgentTelegramChatHistory.chat_id == chat_id,
    ).first()
    if not history_row:
        chat = message.get("chat", {}) if isinstance(message, dict) else {}
        history_row = AgentTelegramChatHistory(
            agent_config_id=agent.id,
            chat_id=chat_id,
            chat_type=chat.get("type"),
            chat_title=chat.get("title") or chat.get("first_name"),
            history=[],
        )
        db.add(history_row)
        db.flush()

    # 2. Метаданные отправителя
    history_row.last_sender_user_id = str(from_user.get("id", "")) if from_user else None
    history_row.last_sender_username = from_user.get("username") if from_user else None
    history_row.last_message_at = datetime.utcnow()

    # 3. ChatOrchestrator в Telegram-режиме
    from backend.services.agent_orchestrator import ChatOrchestrator
    user = db.query(User).filter(User.id == agent.user_id).first()

    orchestrator = ChatOrchestrator()
    result = await orchestrator.run_telegram(
        message=text,
        agent_config=agent,
        user=user,
        db=db,
        telegram_history_row=history_row,
    )

    # 4. Ответ в Telegram
    await AgentTelegramService.send_message(
        token=agent.telegram_bot_token,
        chat_id=chat_id,
        text=result["reply"],
    )
