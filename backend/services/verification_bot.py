"""
Telegram-бот модерации верификации физлиц (VERIFICATION_BOT_TOKEN).

Отвечает только одному чату — VERIFICATION_ADMIN_CHAT_ID:
  * новая заявка → файлы документами + карточка анкеты с кнопками
    «Одобрить» / «На доработку» / «Отклонить» / «Открыть в кабинете»;
  * «На доработку» и «Отклонить» просят комментарий: бот присылает сообщение
    с ForceReply, ответ на него применяет решение (для отказа «-» — без
    комментария);
  * служебные уведомления: покупка номера, приостановка за неуплату,
    платёж без подтверждённой подписи.

Обновления приходят на webhook POST /api/telephony/verification/telegram/{secret}
(регистрируется на старте, ensure_webhook). Решение применяет
telephony_verification_service.decide — тот же путь, что и кнопки в кабинете.
"""

import asyncio
import hashlib
import html
import logging
import re
from typing import Optional, Dict, Any, List, Tuple

import httpx

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)


class _MaskBotTokenFilter(logging.Filter):
    """httpx пишет в лог полный URL запроса — вместе с токеном бота. Прячем его."""
    _re = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "/bot" in msg:
            masked = self._re.sub("/bot<hidden>", msg)
            if masked != msg:
                record.msg, record.args = masked, ()
        return True


_httpx_logger = logging.getLogger("httpx")
if not any(isinstance(f, _MaskBotTokenFilter) for f in _httpx_logger.filters):
    _httpx_logger.addFilter(_MaskBotTokenFilter())

API = "https://api.telegram.org/bot{token}/{method}"

CB_APPROVE = "vfa"
CB_REVISION = "vfr"
CB_REJECT = "vfx"


def is_configured() -> bool:
    return bool(settings.VERIFICATION_BOT_TOKEN and settings.VERIFICATION_ADMIN_CHAT_ID)


def webhook_secret() -> str:
    return hashlib.sha256(("vf-verify:" + settings.VERIFICATION_BOT_TOKEN).encode()).hexdigest()[:40]


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=False)


async def call(method: str, payload: Optional[dict] = None,
               files: Optional[dict] = None, timeout: float = 30.0) -> Optional[Any]:
    if not settings.VERIFICATION_BOT_TOKEN:
        return None
    url = API.format(token=settings.VERIFICATION_BOT_TOKEN, method=method)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if files:
                resp = await client.post(url, data=payload or {}, files=files)
            else:
                resp = await client.post(url, json=payload or {})
        data = resp.json()
        if not data.get("ok"):
            logger.warning(f"[VERIFY-BOT] {method} failed: {data.get('description')}")
            return None
        return data.get("result")
    except Exception as e:
        logger.warning(f"[VERIFY-BOT] {method} error: {e}")
        return None


async def send_text(text: str, reply_markup: Optional[dict] = None,
                    reply_to: Optional[int] = None) -> Optional[dict]:
    if not is_configured():
        return None
    payload = {
        "chat_id": settings.VERIFICATION_ADMIN_CHAT_ID,
        "text": text[:4000],
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    if reply_to:
        payload["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    return await call("sendMessage", payload)


def notify_admin_soon(text: str) -> None:
    """Отправить служебное уведомление, не дожидаясь ответа (из loop)."""
    if not is_configured():
        return
    try:
        asyncio.get_running_loop().create_task(send_text(text))
        return
    except RuntimeError:
        pass
    # Рабочий поток (sync-эндпоинт, asyncio.to_thread): шлём синхронно —
    # поток и так не держит event loop.
    try:
        with httpx.Client(timeout=15.0) as client:
            client.post(
                API.format(token=settings.VERIFICATION_BOT_TOKEN, method="sendMessage"),
                json={"chat_id": settings.VERIFICATION_ADMIN_CHAT_ID, "text": text[:4000],
                      "parse_mode": "HTML", "link_preview_options": {"is_disabled": True}},
            )
    except Exception as e:
        logger.warning(f"[VERIFY-BOT] notify skipped: {e}")


def decision_keyboard(verification_id: str) -> dict:
    cabinet = f"{(settings.HOST_URL or '').rstrip('/')}/static/telephony.html?admin=verifications&vid={verification_id}"
    return {"inline_keyboard": [
        [{"text": "✅ Одобрить", "callback_data": f"{CB_APPROVE}:{verification_id}"}],
        [{"text": "✍️ На доработку", "callback_data": f"{CB_REVISION}:{verification_id}"},
         {"text": "❌ Отклонить", "callback_data": f"{CB_REJECT}:{verification_id}"}],
        [{"text": "🔗 Открыть в кабинете", "url": cabinet}],
    ]}


def format_application(email: str, data: Dict[str, Any], attempt: int, labels: Dict[str, str]) -> str:
    lines = [f"🪪 <b>Заявка на верификацию физлица</b> (подача №{attempt})",
             f"Аккаунт: <code>{esc(email)}</code>", ""]
    for key, label in labels.items():
        if data.get(key):
            lines.append(f"<b>{esc(label)}:</b> {esc(data.get(key))}")
    return "\n".join(lines)


async def send_application(verification_id: str, email: str, data: Dict[str, Any], attempt: int,
                           labels: Dict[str, str],
                           files: List[Tuple[str, str, bytes, str]]) -> List[int]:
    """
    Отправить заявку проверяющему: файлы документами (без сжатия — мелкий
    текст паспорта должен читаться) и карточку с кнопками решения.
    files: [(caption, filename, bytes, content_type)]. Возвращает id сообщений.
    """
    if not is_configured():
        logger.warning("[VERIFY-BOT] not configured — application not sent to Telegram")
        return []
    ids: List[int] = []
    for caption, filename, content, ctype in files:
        payload = {"chat_id": settings.VERIFICATION_ADMIN_CHAT_ID, "caption": f"{caption} — {email}"[:1000]}
        if ctype == "video/mp4":
            # MP4 проигрывается прямо в чате; MOV/WEBM надёжнее отправлять файлом
            res = await call("sendVideo", {**payload, "supports_streaming": "true"},
                             files={"video": (filename, content, ctype)}, timeout=180.0)
        else:
            res = await call("sendDocument", payload,
                             files={"document": (filename, content, ctype)},
                             timeout=180.0 if ctype.startswith("video/") else 60.0)
        if isinstance(res, dict) and res.get("message_id"):
            ids.append(res["message_id"])
    card = await send_text(format_application(email, data, attempt, labels),
                           reply_markup=decision_keyboard(verification_id))
    if card and card.get("message_id"):
        ids.append(card["message_id"])
    return ids


async def ask_comment(verification_id: str, action: str, email: str) -> Optional[int]:
    what = "вернуть на доработку" if action == "revision" else "отклонить"
    hint = ("Напишите, что исправить — пользователь увидит это в кабинете."
            if action == "revision" else
            "Напишите причину отказа или «-», чтобы отклонить без комментария.")
    res = await call("sendMessage", {
        "chat_id": settings.VERIFICATION_ADMIN_CHAT_ID,
        "text": f"Заявка {esc(email)}: {what}.\n{hint}\nОтветьте на это сообщение.",
        "parse_mode": "HTML",
        "reply_markup": {"force_reply": True, "input_field_placeholder": "Комментарий для пользователя"},
    })
    return res.get("message_id") if res else None


async def mark_decided(message_ids: List[int], status_text: str) -> None:
    """Снять кнопки с карточки заявки и дописать итог."""
    if not message_ids:
        return
    card_id = message_ids[-1]
    await call("editMessageReplyMarkup", {
        "chat_id": settings.VERIFICATION_ADMIN_CHAT_ID, "message_id": card_id,
        "reply_markup": {"inline_keyboard": []},
    })
    await send_text(status_text, reply_to=card_id)


def webhook_url() -> str:
    """
    Адрес webhook — напрямую на Render (TELEGRAM_WEBHOOK_BASE_URL), как у ботов
    агентов: прокси voicyfy.ru для серверов Telegram недоступен (Connection
    timed out), и нажатия кнопок не доходили.
    """
    base = (
        settings.TELEGRAM_WEBHOOK_BASE_URL
        or settings.PUBLIC_BASE_URL
        or settings.HOST_URL
        or ""
    ).rstrip("/")
    return f"{base}/api/telephony/verification/telegram/{webhook_secret()}" if base else ""


async def ensure_webhook() -> None:
    """Зарегистрировать webhook бота (на старте приложения)."""
    # Достаточно токена: в чате с ботом /id подскажет chat_id для
    # VERIFICATION_ADMIN_CHAT_ID, решения принимаются только из этого чата.
    url = webhook_url()
    if not settings.VERIFICATION_BOT_TOKEN or not url:
        return
    res = await call("setWebhook", {
        "url": url,
        "secret_token": webhook_secret(),
        "allowed_updates": ["message", "callback_query"],
    })
    host = url.split("/api/")[0]
    logger.info(f"[VERIFY-BOT] setWebhook {host} → {bool(res)}")
