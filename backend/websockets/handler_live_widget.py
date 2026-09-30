"""
Боевой веб-виджет OpenAI на GPT-Live (gpt-live-1).

Маршрут прежний — /ws/{assistant_id} (backend/api/websocket.py): для ассистентов
из assistant_configs вместо Realtime (handler_realtime_new.py) работает этот мост,
если WIDGET_OPENAI_TRANSPORT=live (по умолчанию). Откат — WIDGET_OPENAI_TRANSPORT=realtime.

Протокол с браузером — тот, что уже понимает backend/static/widget.js, поэтому
встроенные на сайты клиентов виджеты менять не нужно:
  браузер → сервер
    {type: "input_audio_buffer.append", audio: <base64 PCM16 mono 24 kHz>}
    {type: "ping"}
    input_audio_buffer.clear / response.cancel / audio_playback.stopped — игнорируем:
    VAD и перебивания GPT-Live решает сам
  сервер → браузер
    {type: "connection_status", status: "connected", full_duplex: true, ...}
    {type: "response.audio.delta", delta}          — PCM16 24 кГц base64
    {type: "response.audio_transcript.delta", delta} — виджет игнорирует, для логов
    {type: "pong"}
    {type: "error", error: {code, message}}

full_duplex: true — сигнал widget.js не глушить микрофон, пока ассистент говорит
(браузерный AEC убирает эхо), иначе GPT-Live не услышит перебивания.

Таймлайн Live идёт только пока в сессию поступает звук (см. inbound_openai.js).
Старые закэшированные копии widget.js глушат микрофон на время воспроизведения,
а до открытия виджета микрофона нет вовсе, — поэтому в паузы досылаем тишину.

Биллинг: тариф openai-live, посекундно (VoiceBillingSession), как в handler_live.
Диалог пишется в conversations (и Google Sheets, если задан) в конце сессии.
"""
import asyncio
import base64
import json
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import SessionLocal, release_db_connection
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.services import provider_keys
from backend.services.conversation_service import ConversationService
from backend.services.voice_billing import VoiceBillingSession
from backend.websockets.handler_live import TranscriptCollector
from backend.websockets.live_client import OpenAILiveClient, LIVE_MODEL, LIVE_TARIFF_CODE

logger = get_logger(__name__)

WIDGET_AUDIO_RATE = 24000          # widget.js пишет и играет PCM16 24 кГц
SILENCE_TICK_MS = 100              # шаг досылки тишины
SILENCE_IDLE_MS = 150              # браузер молчит дольше — досылаем тишину
DEFAULT_GREETING = "Здравствуйте! Чем я могу вам помочь?"
VOICE_EXTRA = "Это разговор через голосовой виджет на сайте. Собеседник говорит с тобой через микрофон браузера."

_SILENCE_CHUNK = b"\x00\x00" * (WIDGET_AUDIO_RATE * SILENCE_TICK_MS // 1000)


def is_live_widget_assistant(db: Session, assistant_id: str) -> Optional[AssistantConfig]:
    """OpenAI-ассистент для Live-моста или None (ElevenLabs, demo, не найден — идут в Realtime-хендлер)."""
    try:
        assistant_uuid = uuid.UUID(str(assistant_id))
    except (ValueError, TypeError):
        return None
    return db.query(AssistantConfig).filter(AssistantConfig.id == assistant_uuid).first()


async def _send(websocket: WebSocket, payload: Dict[str, Any]) -> bool:
    try:
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


async def _send_error(websocket: WebSocket, code: str, message: str, **extra):
    await _send(websocket, {"type": "error", "error": {"code": code, "message": message, **extra}})


async def handle_live_widget_connection(websocket: WebSocket, assistant: AssistantConfig, db: Session):
    client_id = f"lw_{uuid.uuid4().hex[:12]}"
    log = lambda msg, level="INFO": getattr(logger, level.lower())(f"[LIVE-WIDGET {client_id}] {msg}")
    assistant_id = str(assistant.id)

    await websocket.accept()
    log(f"connected: assistant={assistant_id}")

    # 1. Владелец: подписка, ключ, кошелёк — как в handler_realtime_new
    owner = db.query(User).filter(User.id == assistant.user_id).first() if assistant.user_id else None
    api_key = None
    billing_session: Optional[VoiceBillingSession] = None
    if owner is not None:
        if not owner.is_admin and owner.email != "well96well@gmail.com":
            from backend.services.user_service import UserService
            sub = UserService.check_subscription_status(db, str(owner.id))
            if not sub.get("active"):
                is_trial = sub.get("is_trial")
                await _send_error(
                    websocket,
                    "TRIAL_EXPIRED" if is_trial else "SUBSCRIPTION_EXPIRED",
                    "Ваш пробный период истек" if is_trial else "Ваша подписка истекла",
                    subscription_status=sub, requires_payment=True,
                )
                await websocket.close(code=1008)
                return
        resolved = provider_keys.resolve(owner, "openai")
        api_key = resolved.api_key
        if resolved.is_server and provider_keys.is_billable(owner, "openai"):
            billing_session = VoiceBillingSession(owner.id, LIVE_TARIFF_CODE, channel="widget", assistant_id=assistant_id)
            ok, err = billing_session.precheck()
            if not ok:
                await _send(websocket, {"type": "error", "error": err})
                await websocket.close(code=1008)
                return
    if not api_key:
        await _send_error(websocket, "no_api_key", "OpenAI API key required")
        await websocket.close(code=1008)
        return

    greeting = (assistant.greeting_message or DEFAULT_GREETING).strip()
    google_sheet_id = getattr(assistant, "google_sheet_id", None)

    # 2. Сессия GPT-Live. Конфиг загружен — соединение с БД возвращаем в пул
    release_db_connection(db)
    client = OpenAILiveClient(
        api_key, assistant, client_id, db_session=db, audio_rate=WIDGET_AUDIO_RATE,
        voice_extra_instructions=VOICE_EXTRA,
    )
    if not await client.connect():
        await _send_error(websocket, "openai_connection_failed", "Failed to connect to OpenAI")
        await websocket.close(code=1008)
        return

    stop_event = asyncio.Event()
    transcript = TranscriptCollector()
    started_at = time.time()
    last_client_audio = [0.0]

    if billing_session is not None:
        async def _on_wallet_exhausted():
            await _send_error(websocket, "wallet_exhausted",
                              "Баланс кошелька Voicyfy исчерпан, разговор завершён. Пополните кошелёк.",
                              requires_topup=True)
            stop_event.set()
        billing_session.start(on_exhausted=_on_wallet_exhausted)

    await _send(websocket, {
        "type": "connection_status",
        "status": "connected",
        "message": "Connected to GPT-Live",
        "model": LIVE_MODEL,
        "full_duplex": True,
        "functions_enabled": len(client.enabled_functions),
        "google_sheets": bool(google_sheet_id),
        "client_id": client_id,
        "enable_vision": False,   # картинки GPT-Live не принимает
        "greeting_message": greeting,
    })
    # Ассистент говорит первым: прозвучит, как только пойдёт таймлайн (тишина ниже)
    await client.say_greeting(greeting)
    log(f"live session {client.session_id} voice={client.voice} backend={client.delegation_model} "
        f"functions={client.enabled_functions}")

    # ---- браузер → Live ----
    async def browser_to_live():
        chunks = 0
        try:
            while not stop_event.is_set():
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                mtype = msg.get("type")
                if mtype == "input_audio_buffer.append":
                    audio = msg.get("audio") or ""
                    if audio and await client.send_audio_b64(audio):
                        last_client_audio[0] = time.time()
                        chunks += 1
                elif mtype == "ping":
                    await _send(websocket, {"type": "pong"})
        except WebSocketDisconnect:
            log("browser disconnected")
        except Exception as e:
            log(f"browser_to_live error: {e}", "ERROR")
        finally:
            log(f"browser_to_live finished, audio chunks={chunks}")
            stop_event.set()

    # ---- тишина в паузы: таймлайн Live не должен стоять ----
    async def silence_filler():
        silence_b64 = base64.b64encode(_SILENCE_CHUNK).decode("ascii")
        try:
            while not stop_event.is_set():
                await asyncio.sleep(SILENCE_TICK_MS / 1000)
                if (time.time() - last_client_audio[0]) * 1000 >= SILENCE_IDLE_MS:
                    await client.send_audio_b64(silence_b64)
        except Exception as e:
            log(f"silence_filler error: {e}", "WARNING")

    # ---- Live → браузер ----
    async def live_to_browser():
        try:
            async for event in client.receive_events():
                etype = event.get("type")
                if etype == "session.output_audio.delta":
                    await _send(websocket, {"type": "response.audio.delta", "delta": event.get("delta")})
                elif etype in ("session.input_transcript.delta", "session.output_transcript.delta"):
                    role = "user" if etype.startswith("session.input") else "assistant"
                    delta = event.get("delta") or ""
                    transcript.add(role, delta, event.get("start_ms"), event.get("end_ms"))
                    if role == "assistant":
                        await _send(websocket, {"type": "response.audio_transcript.delta", "delta": delta})
                elif etype == "live.function_call":
                    await _send(websocket, {"type": "function_call.executing", "function": event.get("name")})
                elif etype == "live.function_result":
                    await _send(websocket, {"type": "function_call.completed", "function": event.get("name")})
                elif etype == "session.closed":
                    stop_event.set()
                elif etype == "error":
                    log(f"live error: {json.dumps(event, ensure_ascii=False)[:500]}", "WARNING")
        except Exception as e:
            log(f"live_to_browser error: {e}", "ERROR")
        finally:
            stop_event.set()

    tasks = [asyncio.create_task(browser_to_live()),
             asyncio.create_task(live_to_browser()),
             asyncio.create_task(silence_filler())]
    try:
        await stop_event.wait()
    finally:
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
        log(f"finished: live_usage={usage_seconds}s elapsed={elapsed}s functions={len(client.function_log)}")
        if billing_session is not None:
            try:
                await billing_session.stop()
            except Exception as e:
                log(f"billing stop error: {e}", "WARNING")
        pairs = transcript.pairs()
        if pairs:
            asyncio.create_task(_save_dialog(
                assistant_id, client.session_id or client_id, pairs,
                usage_seconds if usage_seconds is not None else elapsed, google_sheet_id,
            ))
        try:
            await websocket.close()
        except Exception:
            pass


async def _save_dialog(assistant_id: str, session_id: str, pairs: List[Dict[str, str]],
                       duration: Any, google_sheet_id: Optional[str]):
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
        logger.info(f"[LIVE-WIDGET] saved {len(pairs)} dialog record(s) for session {session_id}")
    except Exception as e:
        logger.error(f"[LIVE-WIDGET] save dialog failed: {e}", exc_info=True)
    finally:
        db.close()
    if google_sheet_id:
        from backend.websockets.handler_realtime_new import async_save_to_google_sheets
        for p in pairs:
            await async_save_to_google_sheets(google_sheet_id, p["user"] or "", p["assistant"] or "",
                                              conversation_id=session_id, context="live-widget")
