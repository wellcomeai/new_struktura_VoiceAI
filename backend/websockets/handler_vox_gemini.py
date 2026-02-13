# backend/websockets/handler_vox_gemini.py
"""
🚀 PRODUCTION VERSION 2.0 — Voximplant ↔ Gemini Live API Bridge

🆕 v2.0: INSTANT GREETING (буферизация + сигнал ready)
  - Подключение к Gemini идёт ПОКА звонящий слышит гудки
  - Greeting генерируется и БУФЕРИЗУЕТСЯ до ответа на звонок
  - Когда greeting готов → шлём customEvent "ready" в Voximplant
  - Voximplant снимает трубку → забуферизованное аудио сразу летит
  - Звонящий МГНОВЕННО слышит приветствие

АРХИТЕКТУРА v2.0:
┌──────────────┐   Vox WS Protocol   ┌──────────────┐   Native WS   ┌─────────┐
│  Voximplant   │◄──────────────────►│  This Handler │◄────────────►│  Gemini  │
│  (телефония)  │  start/media/stop   │  (мост)       │  PCM audio    │  Live API│
└──────────────┘                     └──────────────┘               └─────────┘

TIMELINE v2.0:
  Звонящий слышит гудки
    ├── Bridge подключается к Gemini
    ├── Gemini: SetupComplete
    ├── Bridge: send_initial_greeting()
    ├── Gemini генерирует аудио → БУФЕР
    ├── Gemini: turnComplete → greeting готов
    ├── Bridge → Voximplant: {"customEvent":"ready"}
    └── Voximplant: call.answer()
  Звонящий СРАЗУ слышит приветствие (из буфера)
    └── Дальше — обычный диалог в реальном времени

ПРОТОКОЛ:
  Входящие: {"event":"start"}, {"event":"media","media":{"payload":"base64"}}, {"event":"stop"}
  Исходящие: тот же формат + {"customEvent":"ready"} + {"customEvent":"transcription",...}

АУДИО:
  Voximplant → нас: PCM16 16kHz
  Gemini → нас: PCM16 24kHz  
  Мы → Voximplant: PCM16 16kHz (даунсэмплим 24→16kHz)
"""

import struct
import base64
import json
import asyncio
import uuid
import time
import traceback
import sys

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from typing import Optional, Dict, List
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.websockets.gemini_client import GeminiLiveClient
from backend.services.conversation_service import ConversationService
from backend.services.google_sheets_service import GoogleSheetsService
from backend.functions import execute_function, normalize_function_name

logger = get_logger(__name__)


# ====================================================================
# АУДИО УТИЛИТЫ
# ====================================================================

def resample_24k_to_16k(pcm_data: bytes) -> bytes:
    """
    Даунсэмплинг PCM16 моно: 24kHz → 16kHz.
    Линейная интерполяция, достаточная для голоса.
    """
    if not pcm_data or len(pcm_data) < 4:
        return pcm_data

    num_samples = len(pcm_data) // 2
    samples = struct.unpack(f"<{num_samples}h", pcm_data)

    # Соотношение: 16000/24000 = 2/3
    new_count = int(num_samples * 2 / 3)
    result = []

    for i in range(new_count):
        src = i * 3.0 / 2.0
        idx = int(src)
        frac = src - idx

        if idx + 1 < num_samples:
            val = int(samples[idx] * (1.0 - frac) + samples[idx + 1] * frac)
        elif idx < num_samples:
            val = samples[idx]
        else:
            break

        result.append(max(-32768, min(32767, val)))

    return struct.pack(f"<{len(result)}h", *result)


def _log(msg: str, level: str = "INFO"):
    """Принудительный лог в stdout (для Render/Docker)."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} - [VOX-GEMINI v2.0] {level} - {msg}", flush=True)
    if level == "ERROR":
        logger.error(msg)
    else:
        logger.info(msg)


# ====================================================================
# ГЛАВНЫЙ HANDLER
# ====================================================================

async def handle_vox_gemini_websocket(
    websocket: WebSocket,
    assistant_id: str,
    db: Session,
    caller_number: Optional[str] = None,
    call_id: Optional[str] = None,
) -> None:
    """
    Главный WebSocket handler: Voximplant ↔ Gemini мост.

    🆕 v2.0: Gemini инициализируется ПОКА звонящий слышит гудки.
    Приветствие буферизуется. Когда готово — сигнал "ready" → Voximplant
    снимает трубку → мгновенное приветствие.
    """
    client_id = f"vox_{uuid.uuid4().hex[:12]}"
    gemini_client: Optional[GeminiLiveClient] = None
    gemini_task: Optional[asyncio.Task] = None
    connection_start = time.time()

    _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    _log(f"🚀 VOX-GEMINI BRIDGE v2.0 | Client: {client_id}")
    _log(f"   Assistant: {assistant_id}")
    _log(f"   Caller: {caller_number or 'unknown'}")
    _log(f"   Call ID: {call_id or 'unknown'}")
    _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    try:
        await websocket.accept()
        _log("✅ WebSocket accepted")

        # ──────────────────────────────────────────
        # 1. Загрузка ассистента
        # ──────────────────────────────────────────
        try:
            assistant = db.query(GeminiAssistantConfig).get(uuid.UUID(assistant_id))
        except (ValueError, Exception):
            assistant = None

        if not assistant:
            _log(f"❌ Assistant not found: {assistant_id}", "ERROR")
            await websocket.close(1008, "Assistant not found")
            return

        _log(f"✅ Assistant: {assistant.name} | Voice: {assistant.voice}")

        # ──────────────────────────────────────────
        # 2. API ключ
        # ──────────────────────────────────────────
        user = db.query(User).get(assistant.user_id) if assistant.user_id else None
        api_key = getattr(user, "gemini_api_key", None) if user else None

        if not api_key:
            _log("❌ No Gemini API key", "ERROR")
            await websocket.close(1008, "No API key")
            return

        _log(f"🔑 API key: {api_key[:10]}...{api_key[-5:]}")

        # ──────────────────────────────────────────
        # 3. Подключение к Gemini
        # ──────────────────────────────────────────
        _log("🔌 Connecting to Gemini Live API...")
        t0 = time.time()

        gemini_client = GeminiLiveClient(api_key, assistant, client_id, db)
        
        # ✅ v2.0: Блокируем auto-greeting внутри connect()
        # Мы сами отправим его в bridge после SetupComplete
        gemini_client.greeting_sent = True

        if not await gemini_client.connect():
            _log("❌ Gemini connection failed", "ERROR")
            await websocket.close(1011, "Gemini unavailable")
            return

        _log(f"✅ Gemini connected in {time.time() - t0:.2f}s")

        # ──────────────────────────────────────────
        # 4. Запуск моста Gemini → Voximplant
        #    🆕 v2.0: bridge буферизует greeting
        # ──────────────────────────────────────────
        bridge_state = {
            "vox_seq": 0,
            "chunk_num": 0,
            "user_transcript": "",
            "assistant_transcript": "",
            "turn_count": 0,
            "caller_number": caller_number,
            "greeting_triggered": False,
            # 🆕 v2.0: Буферизация greeting
            "greeting_ready": False,       # True когда greeting полностью сгенерирован
            "greeting_buffer": [],          # Буфер аудио-чанков greeting
            "call_answered": False,         # True когда Voximplant снял трубку
            "audio_buffer": [],             # Буфер аудио пока call не answered
        }

        gemini_task = asyncio.create_task(
            _gemini_to_vox_bridge(gemini_client, websocket, client_id, bridge_state)
        )

        # ✅ v2.0: Даём bridge начать слушать
        await asyncio.sleep(0.05)

        # ──────────────────────────────────────────
        # 5. Основной цикл: Voximplant → Gemini
        # ──────────────────────────────────────────
        _log("🔄 Listening for Voximplant messages...")
        audio_chunks = 0

        while True:
            try:
                raw = await websocket.receive()
            except WebSocketDisconnect:
                _log("📴 Voximplant disconnected")
                break

            # --- Текстовые сообщения (JSON протокол) ---
            if "text" in raw:
                try:
                    msg = json.loads(raw["text"])
                except json.JSONDecodeError:
                    _log(f"⚠️ Invalid JSON: {raw['text'][:100]}", "ERROR")
                    continue

                event = msg.get("event")

                # ─── START: Voximplant объявляет формат входящего аудио ───
                if event == "start":
                    fmt = msg.get("start", {}).get("mediaFormat", {})
                    custom = msg.get("start", {}).get("customParameters", {})

                    _log(f"📡 Vox START | Format: {fmt}")
                    if custom:
                        _log(f"   Custom params: {custom}")
                        if custom.get("caller"):
                            bridge_state["caller_number"] = custom["caller"]

                    # Отправляем наш START
                    await websocket.send_json({
                        "event": "start",
                        "sequenceNumber": bridge_state["vox_seq"],
                        "start": {
                            "mediaFormat": {
                                "encoding": "audio/x-l16",
                                "sampleRate": 16000,
                                "channels": 1,
                            }
                        },
                    })
                    bridge_state["vox_seq"] += 1
                    
                    # 🆕 v2.0: Voximplant снял трубку → сбрасываем буфер
                    bridge_state["call_answered"] = True
                    _log(f"📞 Call answered! Flushing {len(bridge_state['audio_buffer'])} buffered chunks...")
                    
                    # Отправляем все забуферизованные аудио-чанки
                    for buffered_chunk in bridge_state["audio_buffer"]:
                        try:
                            await websocket.send_json(buffered_chunk)
                        except Exception:
                            break
                    
                    flushed = len(bridge_state["audio_buffer"])
                    bridge_state["audio_buffer"] = []
                    _log(f"✅ Flushed {flushed} audio chunks to Voximplant")

                # ─── MEDIA: Аудио чанк от Voximplant ───
                elif event == "media":
                    payload = msg.get("media", {}).get("payload", "")
                    if payload:
                        pcm_data = base64.b64decode(payload)
                        await gemini_client.process_audio(pcm_data)
                        audio_chunks += 1

                        if audio_chunks % 200 == 0:
                            _log(f"📤 Audio chunks received: {audio_chunks}")

                # ─── STOP: Voximplant завершает поток ───
                elif event == "stop":
                    _log("🛑 Vox STOP event received")
                    break

                # ─── CUSTOM EVENT от Voximplant скрипта ───
                elif msg.get("customEvent"):
                    ce = msg["customEvent"]
                    _log(f"📨 Custom event: {ce}")

                    if ce == "hangup":
                        _log("📴 Hangup requested via custom event")
                        break

            # --- Бинарные сообщения ---
            elif "bytes" in raw:
                if gemini_client and gemini_client.is_connected:
                    await gemini_client.process_audio(raw["bytes"])
                    audio_chunks += 1

        # ──────────────────────────────────────────
        # 6. Завершение
        # ──────────────────────────────────────────
        duration = time.time() - connection_start
        _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        _log(f"📊 SESSION COMPLETE | {client_id}")
        _log(f"   Duration: {duration:.1f}s")
        _log(f"   Audio chunks: {audio_chunks}")
        _log(f"   Turns saved: {bridge_state['turn_count']}")
        _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    except WebSocketDisconnect:
        _log(f"📴 Disconnected: {client_id}")
    except Exception as e:
        _log(f"❌ CRITICAL: {e}\n{traceback.format_exc()}", "ERROR")
    finally:
        if gemini_task and not gemini_task.done():
            gemini_task.cancel()
            try:
                await gemini_task
            except (asyncio.CancelledError, Exception):
                pass

        if gemini_client:
            await gemini_client.close()

        _log(f"👋 Closed: {client_id}")


# ====================================================================
# BRIDGE: Gemini → Voximplant (v2.0 с буферизацией)
# ====================================================================

async def _gemini_to_vox_bridge(
    gemini_client: GeminiLiveClient,
    websocket: WebSocket,
    client_id: str,
    state: Dict,
) -> None:
    """
    🆕 v2.0: Читает от Gemini, буферизует greeting, шлёт "ready" сигнал.
    
    Фазы:
      1. WAITING  — ждём SetupComplete
      2. GREETING — greeting отправлен, буферизуем аудио
      3. LIVE     — call answered, аудио идёт напрямую
    """
    _log("🎭 Gemini→Vox bridge v2.0 started")

    try:
        while gemini_client.is_connected and gemini_client.ws:
            try:
                raw = await gemini_client.ws.recv()
            except ConnectionClosed:
                _log("⚠️ Gemini WS closed")
                break

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            # ═══════════════════════════════════════════
            # SETUP COMPLETE
            # ═══════════════════════════════════════════
            if "setupComplete" in data:
                _log("✅ Gemini SetupComplete")
                
                # 🆕 v2.0: Сразу отправляем greeting
                if not state["greeting_triggered"]:
                    state["greeting_triggered"] = True
                    _log("👋 SetupComplete → sending greeting NOW")
                    gemini_client.greeting_sent = False  # Разрешаем отправку
                    await gemini_client.send_initial_greeting()
                
                continue

            # ═══════════════════════════════════════════
            # TOOL CALLS (function calling)
            # ═══════════════════════════════════════════
            if "toolCall" in data:
                await _handle_tool_calls(
                    data["toolCall"], gemini_client, websocket, client_id
                )
                continue

            # ═══════════════════════════════════════════
            # SERVER CONTENT (аудио + транскрипции)
            # ═══════════════════════════════════════════
            if "serverContent" in data:
                sc = data["serverContent"]

                # --- Транскрипция пользователя ---
                if "inputTranscription" in sc:
                    text = sc["inputTranscription"].get("text", "")
                    if text:
                        state["user_transcript"] += text
                        _log(f"👤 USER: '{text}'")

                # --- Транскрипция ассистента ---
                if "outputTranscription" in sc:
                    text = sc["outputTranscription"].get("text", "")
                    if text:
                        state["assistant_transcript"] += text
                        _log(f"🤖 ASST: '{text}'")

                # --- Аудио от Gemini → отправляем/буферизуем ---
                if "modelTurn" in sc:
                    for part in sc["modelTurn"].get("parts", []):
                        if "inlineData" not in part:
                            continue

                        inline = part["inlineData"]
                        mime = inline.get("mimeType", "")

                        if "audio/pcm" not in mime:
                            continue

                        # Декодируем 24kHz PCM, даунсэмплим в 16kHz
                        pcm_24k = base64.b64decode(inline["data"])
                        pcm_16k = resample_24k_to_16k(pcm_24k)

                        # Формируем чанк в формате Voximplant
                        vox_chunk = {
                            "event": "media",
                            "sequenceNumber": state["vox_seq"],
                            "media": {
                                "payload": base64.b64encode(pcm_16k).decode("ascii"),
                                "chunk": state["chunk_num"],
                            },
                        }
                        state["vox_seq"] += 1
                        state["chunk_num"] += 1

                        # 🆕 v2.0: Буферизация или прямая отправка
                        if state["call_answered"]:
                            # Call уже answered → отправляем напрямую
                            try:
                                await websocket.send_json(vox_chunk)
                            except Exception:
                                break
                        else:
                            # Call ещё не answered → буферизуем
                            state["audio_buffer"].append(vox_chunk)

                # --- Прерывание ---
                if sc.get("interrupted"):
                    _log("⚡ Interrupted")
                    await _save_turn(gemini_client, state, suffix=" [прервано]")

                # --- Конец реплики ---
                if sc.get("turnComplete"):
                    _log(f"🏁 Turn complete | greeting_ready={state['greeting_ready']} | call_answered={state['call_answered']}")
                    
                    # 🆕 v2.0: Первый turnComplete после greeting = greeting готов
                    if not state["greeting_ready"] and state["greeting_triggered"]:
                        state["greeting_ready"] = True
                        buffered = len(state["audio_buffer"])
                        
                        _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                        _log(f"🎉 GREETING READY! Buffered: {buffered} chunks")
                        _log(f"   Sending 'ready' signal to Voximplant...")
                        _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                        
                        # Сигнал Voximplant: "можно снимать трубку"
                        try:
                            await websocket.send_json({
                                "customEvent": "ready",
                                "payload": {
                                    "buffered_chunks": buffered,
                                    "greeting_text": state["assistant_transcript"],
                                }
                            })
                            _log("✅ 'ready' signal sent to Voximplant")
                        except Exception as e:
                            _log(f"❌ Failed to send ready: {e}", "ERROR")
                    
                    await _save_turn(gemini_client, state)

            # ═══════════════════════════════════════════
            # TOP-LEVEL TRANSCRIPTIONS
            # ═══════════════════════════════════════════
            if "inputTranscription" in data and "serverContent" not in data:
                text = data["inputTranscription"].get("text", "")
                if text:
                    state["user_transcript"] += text

            if "outputTranscription" in data and "serverContent" not in data:
                text = data["outputTranscription"].get("text", "")
                if text:
                    state["assistant_transcript"] += text

    except asyncio.CancelledError:
        _log("🛑 Bridge cancelled")
    except Exception as e:
        _log(f"❌ Bridge error: {e}\n{traceback.format_exc()}", "ERROR")
    finally:
        await _save_turn(gemini_client, state, suffix=" [disconnected]", is_final=True)

        try:
            await websocket.send_json({
                "event": "stop",
                "sequenceNumber": state["vox_seq"],
                "stop": {"mediaInfo": {"bytesSent": 0, "duration": 0}},
            })
        except Exception:
            pass

        _log("🏁 Gemini→Vox bridge stopped")


# ====================================================================
# СОХРАНЕНИЕ TURN
# ====================================================================

async def _save_turn(
    gemini_client: GeminiLiveClient,
    state: Dict,
    suffix: str = "",
    is_final: bool = False,
) -> None:
    """Сохраняет текущий turn в БД и Google Sheets, очищает буферы."""
    user_msg = state["user_transcript"].strip()
    asst_msg = state["assistant_transcript"].strip()

    if not user_msg and not asst_msg:
        return

    if suffix and asst_msg:
        asst_msg += suffix

    state["turn_count"] += 1
    turn = state["turn_count"]

    _log(f"💾 Turn #{turn}{' (FINAL)' if is_final else ''}")
    _log(f"   User: {user_msg[:80]}...")
    _log(f"   Asst: {asst_msg[:80]}...")

    config = gemini_client.assistant_config

    # --- БД ---
    try:
        await ConversationService.save_conversation(
            db=gemini_client.db_session,
            assistant_id=str(config.id),
            user_message=user_msg or "[no input]",
            assistant_message=asst_msg or "[no response]",
            session_id=gemini_client.session_id,
            caller_number=state.get("caller_number"),
            tokens_used=0,
        )
        _log(f"✅ Turn #{turn} → DB")
    except Exception as e:
        _log(f"❌ DB save error: {e}", "ERROR")

    # --- Google Sheets ---
    sheet_id = getattr(config, "google_sheet_id", None)
    if sheet_id:
        try:
            await GoogleSheetsService.log_conversation(
                sheet_id=sheet_id,
                user_message=user_msg or "[no input]",
                assistant_message=asst_msg or "[no response]",
                function_result=None,
                conversation_id=gemini_client.conversation_record_id,
            )
            _log(f"✅ Turn #{turn} → Sheets")
        except Exception as e:
            _log(f"❌ Sheets error: {e}", "ERROR")

    # --- Очищаем буферы ---
    state["user_transcript"] = ""
    state["assistant_transcript"] = ""


# ====================================================================
# FUNCTION CALLS
# ====================================================================

async def _handle_tool_calls(
    tool_call: Dict,
    gemini_client: GeminiLiveClient,
    websocket: WebSocket,
    client_id: str,
) -> None:
    """Обрабатывает вызовы функций от Gemini."""
    function_calls = tool_call.get("functionCalls", [])

    for fc in function_calls:
        name = fc.get("name", "")
        fc_id = fc.get("id", "")
        args = fc.get("args", {})
        normalized = normalize_function_name(name)

        _log(f"🔧 Function: {normalized} | ID: {fc_id}")
        _log(f"   Args: {json.dumps(args, ensure_ascii=False)[:200]}")

        gemini_client.last_function_name = normalized
        t0 = time.time()

        try:
            result = await execute_function(
                name=normalized,
                arguments=args,
                context={
                    "assistant_config": gemini_client.assistant_config,
                    "client_id": client_id,
                    "db_session": gemini_client.db_session,
                },
            )

            elapsed = time.time() - t0
            _log(f"✅ Function result in {elapsed:.2f}s")

            delivery = await gemini_client.send_function_result(fc_id, result)
            if delivery.get("success"):
                _log(f"✅ Result delivered to Gemini")
            else:
                _log(f"❌ Delivery failed: {delivery.get('error')}", "ERROR")

            try:
                await websocket.send_json({
                    "customEvent": "function_result",
                    "data": {
                        "function": normalized,
                        "success": True,
                        "execution_time": elapsed,
                    },
                })
            except Exception:
                pass

        except Exception as e:
            elapsed = time.time() - t0
            _log(f"❌ Function error: {e}", "ERROR")

            try:
                await gemini_client.send_function_result(
                    fc_id, {"error": str(e)}
                )
            except Exception:
                pass
