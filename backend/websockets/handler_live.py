"""
WebSocket-хендлер виджета на GPT-Live (gpt-live-1) — экспериментальный контур.

Маршрут /ws/live/{assistant_id}?token=<JWT>. Доступ только владельцу
ассистента или админу: это тестовый транспорт, публичный виджет по-прежнему
ходит через /ws/openai/{assistant_id} (handler_realtime_new.py).

Протокол с браузером (см. backend/static/live-test.html):
  браузер → сервер
    {type: "input_audio_buffer.append", audio: <base64 PCM16 mono 24 kHz>}
    {type: "session.close"}           — вежливо завершить (дождёмся usage)
    {type: "instructions.append", content}  — подсказка модели на лету
    {type: "ping"}
  сервер → браузер
    {type: "session.started", session_id, voice, audio_rate, backend_model, functions}
    {type: "audio.delta", delta}                       — PCM16 base64, играть по порядку
    {type: "transcript.delta", role, delta, start_ms, end_ms}
    {type: "delegation.created", delegation_id, target}
    {type: "backend.text.delta", delegation_id, delta} — текст бэкенд-модели (отладка)
    {type: "function_call", name, arguments, call_id}
    {type: "function_result", name, result, call_id}
    {type: "usage", seconds, context_usage_ratio}
    {type: "session.closed", usage, reason}
    {type: "error", code, message}
    {type: "event", event}                             — всё остальное как есть
"""
import asyncio
import json
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.core.security import decode_jwt_token
from backend.db.session import SessionLocal
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.services import provider_keys
from backend.services.conversation_service import ConversationService
from backend.services.user_service import UserService
from backend.services.voice_billing import VoiceBillingSession
from backend.websockets.live_client import OpenAILiveClient, LIVE_MODEL, LIVE_VOICES

logger = get_logger(__name__)

LIVE_AUDIO_RATE = 24000
# Код тарифа кошелька для этого транспорта (voice_model_tariffs.code)
LIVE_TARIFF_CODE = "openai-live"


# ----------------------------------------------------------------------
# Транскрипт: фрагменты → реплики
# ----------------------------------------------------------------------
class TranscriptCollector:
    """
    GPT-Live отдаёт транскрипт кусками с start_ms/end_ms и без границ реплик;
    пользователь и ассистент могут говорить одновременно. Копим фрагменты по
    ролям, а в конце склеиваем в реплики по порядку времени: новая реплика
    начинается при смене говорящего.
    """

    def __init__(self):
        self.fragments: List[Dict[str, Any]] = []

    def add(self, role: str, text: str, start_ms: Optional[int], end_ms: Optional[int]):
        if not text:
            return
        self.fragments.append({
            "role": role, "text": text,
            "start_ms": start_ms if isinstance(start_ms, (int, float)) else len(self.fragments),
            "end_ms": end_ms,
        })

    def turns(self) -> List[Dict[str, str]]:
        ordered = sorted(self.fragments, key=lambda f: (f["start_ms"], 0 if f["role"] == "user" else 1))
        turns: List[Dict[str, str]] = []
        for f in ordered:
            if turns and turns[-1]["role"] == f["role"]:
                sep = "" if (turns[-1]["text"].endswith(" ") or f["text"].startswith(" ")) else " "
                turns[-1]["text"] += sep + f["text"]
            else:
                turns.append({"role": f["role"], "text": f["text"]})
        for t in turns:
            t["text"] = " ".join(t["text"].split())
        return [t for t in turns if t["text"]]

    def pairs(self) -> List[Dict[str, str]]:
        """Пары (user, assistant) для conversations: как в основном хендлере."""
        pairs: List[Dict[str, str]] = []
        current_user = ""
        for t in self.turns():
            if t["role"] == "user":
                if current_user:
                    pairs.append({"user": current_user, "assistant": ""})
                current_user = t["text"]
            else:
                if pairs and not pairs[-1]["assistant"] and not current_user:
                    pairs[-1]["assistant"] = t["text"]
                else:
                    pairs.append({"user": current_user, "assistant": t["text"]})
                    current_user = ""
        if current_user:
            pairs.append({"user": current_user, "assistant": ""})
        return pairs


# ----------------------------------------------------------------------
# Хендлер
# ----------------------------------------------------------------------
async def _send_json(websocket: WebSocket, payload: Dict[str, Any]) -> bool:
    try:
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


def _authorize(db: Session, token: Optional[str], assistant: AssistantConfig) -> Optional[User]:
    """Владелец ассистента или админ. Иначе None."""
    if not token:
        return None
    try:
        payload = decode_jwt_token(token)
    except Exception:
        return None
    user = db.query(User).filter(User.id == payload.get("sub")).first()
    if user is None:
        return None
    if user.is_admin or (assistant.user_id and str(assistant.user_id) == str(user.id)):
        return user
    return None


async def handle_live_connection(websocket: WebSocket, assistant_id: str, db: Session, token: Optional[str],
                                 voice: Optional[str] = None):
    client_id = f"live_{uuid.uuid4().hex[:12]}"
    log = lambda msg, level="INFO": getattr(logger, level.lower())(f"[LIVE-HANDLER {client_id}] {msg}")

    # 1. Ассистент и авторизация — до accept, чтобы чужим ответить 403
    try:
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
    except Exception as e:
        log(f"assistant lookup failed: {e}", "ERROR")
        assistant = None
    if assistant is None:
        await websocket.close(code=4404, reason="assistant_not_found")
        return
    viewer = _authorize(db, token, assistant)
    if viewer is None:
        log(f"unauthorized access to assistant {assistant_id}", "WARNING")
        await websocket.close(code=4403, reason="forbidden")
        return

    await websocket.accept()
    log(f"connected: assistant={assistant.id} viewer={viewer.email}")

    # 2. Владелец ассистента: подписка, ключ, биллинг (как в handler_realtime_new)
    owner = db.query(User).filter(User.id == assistant.user_id).first() if assistant.user_id else viewer
    api_key = None
    billing_session: Optional[VoiceBillingSession] = None
    if owner is not None:
        try:
            sub = UserService.check_subscription_status(db, str(owner.id))
            if not sub.get("active"):
                await _send_json(websocket, {"type": "error", "code": "subscription_expired",
                                             "message": "Подписка владельца ассистента не активна"})
                await websocket.close(code=4402)
                return
        except Exception as e:
            log(f"subscription check failed (continuing): {e}", "WARNING")
        resolved = provider_keys.resolve(owner, "openai")
        api_key = resolved.api_key
        if resolved.is_server and provider_keys.is_billable(owner, "openai"):
            billing_session = VoiceBillingSession(owner.id, LIVE_TARIFF_CODE, channel="widget", assistant_id=assistant_id)
            ok, err = billing_session.precheck()
            if not ok:
                await _send_json(websocket, {"type": "error", **(err or {"code": "wallet_insufficient"})})
                await websocket.close(code=4402)
                return
            log(f"server key → wallet billing, tariff={LIVE_TARIFF_CODE} price={billing_session.price_per_min}kop/min")
    if not api_key:
        await _send_json(websocket, {"type": "error", "code": "no_api_key", "message": "OpenAI API key required"})
        await websocket.close(code=4401)
        return

    # 3. Сессия GPT-Live
    client = OpenAILiveClient(api_key, assistant, client_id, db_session=db, audio_rate=LIVE_AUDIO_RATE,
                              voice_override=voice)
    if not await client.connect():
        await _send_json(websocket, {"type": "error", "code": "live_connect_failed",
                                     "message": "Не удалось открыть сессию gpt-live-1 (см. логи сервера)"})
        await websocket.close(code=4500)
        return

    await _send_json(websocket, {
        "type": "session.started",
        "session_id": client.session_id,
        "model": LIVE_MODEL,
        "voice": client.voice,
        "voices": LIVE_VOICES,
        "audio_rate": LIVE_AUDIO_RATE,
        "backend_model": client.delegation_model,
        "functions": client.enabled_functions,
        "tools_schema": client.tools_schema,
        "assistant_name": assistant.name,
    })

    stop_event = asyncio.Event()
    transcript = TranscriptCollector()
    started_at = time.time()

    if billing_session is not None:
        async def _on_wallet_exhausted():
            await _send_json(websocket, {"type": "error", "code": "wallet_exhausted",
                                         "message": "Баланс кошелька исчерпан, сессия завершена"})
            stop_event.set()
        billing_session.start(on_exhausted=_on_wallet_exhausted)

    # ---- браузер → OpenAI ----
    async def browser_to_live():
        audio_chunks = 0
        try:
            while not stop_event.is_set():
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                mtype = msg.get("type")
                if mtype == "input_audio_buffer.append":
                    if await client.send_audio_b64(msg.get("audio") or ""):
                        audio_chunks += 1
                elif mtype == "session.close":
                    log("browser requested close")
                    stop_event.set()
                    break
                elif mtype == "instructions.append":
                    await client.append_instructions(str(msg.get("content") or ""))
                elif mtype == "ping":
                    await _send_json(websocket, {"type": "pong"})
        except WebSocketDisconnect:
            log("browser disconnected")
        except Exception as e:
            log(f"browser_to_live error: {e}", "ERROR")
        finally:
            log(f"browser_to_live finished, audio chunks={audio_chunks}")
            stop_event.set()

    # ---- OpenAI → браузер ----
    async def live_to_browser():
        try:
            async for event in client.receive_events():
                etype = event.get("type")
                if etype == "session.output_audio.delta":
                    await _send_json(websocket, {"type": "audio.delta", "delta": event.get("delta")})
                elif etype in ("session.input_transcript.delta", "session.output_transcript.delta"):
                    role = "user" if etype.startswith("session.input") else "assistant"
                    delta = event.get("delta") or event.get("text") or ""
                    transcript.add(role, delta, event.get("start_ms"), event.get("end_ms"))
                    await _send_json(websocket, {"type": "transcript.delta", "role": role, "delta": delta,
                                                 "start_ms": event.get("start_ms"), "end_ms": event.get("end_ms")})
                elif etype == "session.delegation.created":
                    d = event.get("delegation") or {}
                    await _send_json(websocket, {"type": "delegation.created", "delegation_id": d.get("id"),
                                                 "target": d.get("target")})
                elif etype == "live.function_call":
                    await _send_json(websocket, {"type": "function_call", "name": event.get("name"),
                                                 "arguments": event.get("arguments"), "call_id": event.get("call_id")})
                elif etype == "live.function_result":
                    await _send_json(websocket, {"type": "function_result", "name": event.get("name"),
                                                 "result": event.get("result"), "call_id": event.get("call_id")})
                elif etype == "response.event":
                    inner = event.get("event") or {}
                    if inner.get("type") == "response.output_text.delta":
                        await _send_json(websocket, {"type": "backend.text.delta",
                                                     "delegation_id": event.get("delegation_id"),
                                                     "delta": inner.get("delta")})
                    else:
                        await _send_json(websocket, {"type": "event", "event": event})
                elif etype == "session.usage.updated":
                    usage = event.get("usage") or {}
                    ctx = event.get("context_window") or {}
                    await _send_json(websocket, {"type": "usage", "seconds": usage.get("seconds"),
                                                 "context_usage_ratio": ctx.get("usage_ratio")})
                elif etype == "session.closed":
                    # В браузер уйдёт один раз из finally (с итоговым usage, final=True)
                    stop_event.set()
                elif etype == "error":
                    err = event.get("error") or {}
                    log(f"live error: {json.dumps(event, ensure_ascii=False)[:500]}", "WARNING")
                    await _send_json(websocket, {"type": "error", "code": err.get("code") or "live_error",
                                                 "message": err.get("message") or json.dumps(event, ensure_ascii=False),
                                                 "client_event_id": err.get("client_event_id")})
                else:
                    await _send_json(websocket, {"type": "event", "event": event})
        except Exception as e:
            log(f"live_to_browser error: {e}", "ERROR")
        finally:
            stop_event.set()

    tasks = [asyncio.create_task(browser_to_live()), asyncio.create_task(live_to_browser())]
    try:
        await stop_event.wait()
    finally:
        # 4. Завершение: закрыть сессию у OpenAI (дождаться usage), остановить биллинг
        closed = None
        try:
            closed = await client.close()
        except Exception as e:
            log(f"client.close error: {e}", "WARNING")
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        usage_seconds = None
        if closed and isinstance(closed.get("usage"), dict):
            usage_seconds = closed["usage"].get("seconds")
        elif client.last_usage:
            usage_seconds = client.last_usage.get("seconds")
        elapsed = int(time.time() - started_at)
        log(f"session finished: live_usage={usage_seconds}s elapsed={elapsed}s "
            f"reason={(closed or {}).get('reason')} functions={len(client.function_log)}")

        if billing_session is not None:
            try:
                await billing_session.stop()
            except Exception as e:
                log(f"billing stop error: {e}", "WARNING")

        if closed:
            await _send_json(websocket, {"type": "session.closed", "usage": closed.get("usage"),
                                         "reason": closed.get("reason"), "final": True})

        # 5. Диалог в conversations (отдельная DB-сессия, как в основном хендлере)
        pairs = transcript.pairs()
        if pairs:
            asyncio.create_task(_save_dialog(str(assistant.id), client.session_id or client_id, pairs,
                                             usage_seconds if usage_seconds is not None else elapsed))
        try:
            await websocket.close()
        except Exception:
            pass


async def _save_dialog(assistant_id: str, session_id: str, pairs: List[Dict[str, str]], duration: Any):
    db = SessionLocal()
    try:
        for p in pairs:
            ConversationService.save_conversation(
                db=db, assistant_id=assistant_id,
                user_message=p["user"] or "", assistant_message=p["assistant"] or "",
                session_id=session_id, caller_number=None,
                client_info={"transport": "gpt-live-1", "channel": "widget"},
                audio_duration=float(duration) if duration is not None else None,
                tokens_used=0,
            )
        logger.info(f"[LIVE-HANDLER] saved {len(pairs)} dialog record(s) for session {session_id}")
    except Exception as e:
        logger.error(f"[LIVE-HANDLER] save dialog failed: {e}", exc_info=True)
    finally:
        db.close()
