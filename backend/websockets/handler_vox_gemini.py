# backend/websockets/handler_vox_gemini.py
"""
🚀 PRODUCTION VERSION 1.0 — Voximplant ↔ Gemini Live API Bridge

Мост между телефонным звонком (Voximplant) и Google Gemini Live API.
Используется как FALLBACK когда встроенный модуль Gemini в Voximplant
не получает SetupComplete.

АРХИТЕКТУРА:
┌──────────────┐   Vox WS Protocol   ┌──────────────┐   Native WS   ┌─────────┐
│  Voximplant   │◄──────────────────►│  This Handler │◄────────────►│  Gemini  │
│  (телефония)  │  start/media/stop   │  (мост)       │  PCM audio    │  Live API│
└──────────────┘                     └──────────────┘               └─────────┘

ПРОТОКОЛ VOXIMPLANT:
  Входящие: {"event":"start"}, {"event":"media","media":{"payload":"base64"}}, {"event":"stop"}
  Исходящие: тот же формат обратно + {"customEvent":"transcription",...} для текстовых данных

АУДИО:
  Voximplant → нас: PCM16 16kHz (настраивается в скрипте через encoding: PCM16)
  Gemini → нас: PCM16 24kHz  
  Мы → Voximplant: PCM16 16kHz (даунсэмплим 24→16kHz)

ФИЧИ:
✅ Полный Function Calling (через GeminiLiveClient)
✅ Транскрипция (input + output) → передаётся в Voximplant как customEvent
✅ Сохранение диалога в БД + Google Sheets
✅ Автоприветствие из конфига ассистента
✅ Аудио ресэмплинг 24kHz → 16kHz
✅ Поддержка customParameters из Voximplant start event
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
from typing import Optional, Dict
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.models.user import User
from backend.services import provider_keys  # ✅ v6.0: серверные ключи
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
        src = i * 3.0 / 2.0  # обратное соотношение
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
    print(f"{ts} - [VOX-GEMINI v1.0] {level} - {msg}", flush=True)
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

    Args:
        websocket: WebSocket от Voximplant (createWebSocket)
        assistant_id: UUID ассистента из URL
        db: Сессия БД
        caller_number: Номер звонящего (из query param)
        call_id: ID звонка в Voximplant (из query param)
    """
    client_id = f"vox_{uuid.uuid4().hex[:12]}"
    gemini_client: Optional[GeminiLiveClient] = None
    gemini_task: Optional[asyncio.Task] = None
    connection_start = time.time()

    _log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    _log(f"🚀 VOX-GEMINI BRIDGE | Client: {client_id}")
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
        # ✅ v6.0: свой ключ → бесплатно; нет ключа → серверный ключ Voicyfy.
        # Списание за звонок идёт по отчёту сценария (/api/voximplant/log).
        _resolved = provider_keys.resolve(user, "gemini")
        api_key = _resolved.api_key
        if _resolved.is_server:
            _log("💳 Server Gemini key (wallet billing by call report)")

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

        if not await gemini_client.connect():
            _log("❌ Gemini connection failed", "ERROR")
            await websocket.close(1011, "Gemini unavailable")
            return

        _log(f"✅ Gemini connected in {time.time() - t0:.2f}s")

        # ──────────────────────────────────────────
        # 4. Запуск моста Gemini → Voximplant
        # ──────────────────────────────────────────
        bridge_state = {
            "vox_seq": 0,           # sequence counter для исходящих сообщений
            "chunk_num": 0,         # chunk counter для media
            "user_transcript": "",
            "assistant_transcript": "",
            "turn_count": 0,
            "caller_number": caller_number,
            "greeting_triggered": False,
        }

        gemini_task = asyncio.create_task(
            _gemini_to_vox_bridge(gemini_client, websocket, client_id, bridge_state)
        )

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
                        # Обновляем caller/call_id из customParameters
                        if custom.get("caller"):
                            bridge_state["caller_number"] = custom["caller"]
                        if custom.get("call_id"):
                            pass  # можно сохранить

                    # Отправляем наш START (объявляем формат исходящего аудио)
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

                    # Запускаем приветствие (один раз)
                    if not bridge_state["greeting_triggered"]:
                        bridge_state["greeting_triggered"] = True
                        _log("👋 Triggering greeting...")
                        asyncio.create_task(gemini_client.send_initial_greeting())

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

                    # Можно обрабатывать кастомные команды от скрипта
                    if ce == "hangup":
                        _log("📴 Hangup requested via custom event")
                        break

            # --- Бинарные сообщения (на случай прямой передачи) ---
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
        # Останавливаем bridge task
        if gemini_task and not gemini_task.done():
            gemini_task.cancel()
            try:
                await gemini_task
            except (asyncio.CancelledError, Exception):
                pass

        # Закрываем Gemini
        if gemini_client:
            await gemini_client.close()

        _log(f"👋 Closed: {client_id}")


# ====================================================================
# BRIDGE: Gemini → Voximplant
# ====================================================================

async def _gemini_to_vox_bridge(
    gemini_client: GeminiLiveClient,
    websocket: WebSocket,
    client_id: str,
    state: Dict,
) -> None:
    """
    Читает сообщения от Gemini и пересылает аудио в Voximplant.
    Обрабатывает function calls, транскрипции, сохранение диалога.
    """
    _log("🎭 Gemini→Vox bridge started")

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

                # --- Аудио от Gemini → отправляем в Voximplant ---
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

                        # Отправляем в формате Voximplant
                        try:
                            await websocket.send_json({
                                "event": "media",
                                "sequenceNumber": state["vox_seq"],
                                "media": {
                                    "payload": base64.b64encode(pcm_16k).decode("ascii"),
                                    "chunk": state["chunk_num"],
                                },
                            })
                            state["vox_seq"] += 1
                            state["chunk_num"] += 1
                        except Exception:
                            break

                # --- Прерывание ---
                if sc.get("interrupted"):
                    _log("⚡ Interrupted")
                    await _save_turn(gemini_client, state, suffix=" [прервано]")

                # --- Конец реплики ---
                if sc.get("turnComplete"):
                    await _save_turn(gemini_client, state)

            # ═══════════════════════════════════════════
            # TOP-LEVEL TRANSCRIPTIONS (вне serverContent)
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
        # Сохраняем оставшееся
        await _save_turn(gemini_client, state, suffix=" [disconnected]", is_final=True)

        # Отправляем STOP в Voximplant
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
        ConversationService.save_conversation(
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

            # Отправляем результат в Gemini
            delivery = await gemini_client.send_function_result(fc_id, result)
            if delivery.get("success"):
                _log(f"✅ Result delivered to Gemini")
            else:
                _log(f"❌ Delivery failed: {delivery.get('error')}", "ERROR")

            # Уведомляем Voximplant скрипт (опционально)
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
