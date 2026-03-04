# backend/websockets/handler_gemini.py
"""
🚀 PRODUCTION VERSION 1.6.1 - Google Gemini Live API Handler
✅ PURE GEMINI VAD - removed client-side commit logic
✅ Continuous audio streaming - Gemini decides when to respond
✅ Complete function calling support with toolCall event handler
✅ Google Sheets logging with transcription support
✅ Database integration
✅ Interruption handling
✅ Screen context support
✅ Audio transcription support (input + output)
✅ Fallback logging on disconnect
✅ Maximum logging for debugging
✅ Ready for production deployment

CRITICAL FIXES in v1.4:
- Added toolCall event handler for top-level function calls
- Fixed execute_function signature (name, arguments, context)
- Added last_function_name assignment before send_function_result
- Added fallback logging in finally block

✨✨✨ NEW in v1.5 - FUNCTION LOG DATABASE TRACKING: ✨✨✨
🔥 Full function call logging to function_logs table!
🔥 Tracks: function_name, arguments, result, execution_time, status
🔥 Links to user_id, assistant_id, conversation_id
🔥 Error tracking with error_message field

✨✨✨ FIX in v1.5.1 - SESSION MANAGEMENT: ✨✨✨
🔧 FIX: async_save_function_log создаёт НОВУЮ сессию БД внутри задачи
🔧 Исправлена ошибка "Session is closed" при асинхронном логировании

✨✨✨ FIX in v1.6.1 - TURN-BASED DIALOG: ✨✨✨
🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Поле `finished` НЕ СУЩЕСТВУЕТ в Gemini API!
🔥 Используем ТОЛЬКО `turnComplete` как маркер конца реплики
🔥 Каждый turnComplete = отдельная запись в БД и Google Sheets
🔥 Буферы очищаются ПОСЛЕ сохранения
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
import traceback
import time
import sys
from typing import Dict, List
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.gemini_assistant import GeminiAssistantConfig, GeminiConversation
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.gemini_client import GeminiLiveClient
from backend.services.google_sheets_service import GoogleSheetsService
from backend.services.conversation_service import ConversationService
from backend.services.function_log_service import FunctionLogService
from backend.functions import execute_function, normalize_function_name

logger = get_logger(__name__)

# Force immediate log flushing to stdout for Render
import logging
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    force=True
)

# Active connections
active_gemini_connections: Dict[str, List[WebSocket]] = {}

# Debug mode
ENABLE_DETAILED_LOGGING = False
# 🆕 v1.6.1: Включить подробное логирование структуры транскриптов
ENABLE_TRANSCRIPT_DEBUG = False


def log_to_render(message: str, level: str = "INFO"):
    """Force log to Render stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [GEMINI v1.6.1] {level} - {message}"
    print(log_msg, flush=True)
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)


# 🆕 v1.5.1: Async function log save (FIX: создаём новую сессию внутри задачи)
async def async_save_function_log(
    function_name: str,
    arguments: dict,
    result: dict,
    status: str,
    execution_time_ms: float,
    user_id: str = None,
    assistant_id: str = None,
    conversation_id: str = None,
    error_message: str = None
):
    """
    🆕 v1.5.1: Async function log save to function_logs table (non-blocking)
    ✅ FIX: Создаём НОВУЮ сессию внутри задачи, т.к. оригинальная уже закрыта
    """
    from backend.db.session import SessionLocal

    db = None
    try:
        db = SessionLocal()

        await FunctionLogService.log_function_call(
            db=db,
            function_name=function_name,
            arguments=arguments,
            result=result,
            status=status,
            execution_time_ms=execution_time_ms,
            user_id=user_id,
            assistant_id=assistant_id,
            conversation_id=conversation_id,
            error_message=error_message
        )

    except Exception as e:
        log_to_render(f"❌ [FUNC-LOG] Error saving function log: {e}", "ERROR")
    finally:
        if db:
            db.close()


async def handle_gemini_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🚀 PRODUCTION v1.6.1 - Main WebSocket handler for Gemini Live API
    ✅ Pure Gemini VAD - continuous audio streaming
    ✅ Audio transcription support
    🆕 v1.5: FunctionLog tracking
    🔧 v1.5.1: Fixed db_session issue in async_save_function_log
    🔥 v1.6.1: Fixed turn-based dialog (no finished field, only turnComplete)
    """
    client_id = str(uuid.uuid4())
    gemini_client = None
    connection_start = time.time()

    log_to_render(f"🚀 NEW CONNECTION: client_id={client_id}, assistant_id={assistant_id}")

    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')

    try:
        await websocket.accept()

        # Register connection
        active_gemini_connections.setdefault(assistant_id, []).append(websocket)

        # Load assistant
        if assistant_id == "demo":
            assistant = db.query(GeminiAssistantConfig).filter(GeminiAssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(GeminiAssistantConfig).first()
        else:
            try:
                uuid_obj = uuid.UUID(assistant_id)
                assistant = db.query(GeminiAssistantConfig).get(uuid_obj)
            except ValueError:
                assistant = db.query(GeminiAssistantConfig).filter(
                    GeminiAssistantConfig.id.cast(str) == assistant_id
                ).first()

        if not assistant:
            log_to_render(f"❌ Gemini assistant not found: {assistant_id}", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Gemini assistant not found"}
            })
            await websocket.close(code=1008)
            return

        # Extract enabled functions
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]

        # Check subscription
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))

                    if not subscription_status["active"]:
                        error_code = "TRIAL_EXPIRED" if subscription_status.get("is_trial") else "SUBSCRIPTION_EXPIRED"
                        error_message = "Ваш пробный период истек" if subscription_status.get("is_trial") else "Ваша подписка истекла"

                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": error_code,
                                "message": error_message,
                                "subscription_status": subscription_status,
                                "requires_payment": True
                            }
                        })
                        await websocket.close(code=1008)
                        return

                api_key = user.gemini_api_key

        if not api_key:
            log_to_render(f"❌ No Gemini API key available", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Google Gemini API key required"}
            })
            await websocket.close(code=1008)
            return

        # Create Gemini Live client
        gemini_client = GeminiLiveClient(api_key, assistant, client_id, db, user_agent)

        if not await gemini_client.connect():
            log_to_render(f"❌ Failed to connect to Gemini", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "gemini_connection_failed", "message": "Failed to connect to Gemini"}
            })
            await websocket.close(code=1008)
            return

        # Send connection status
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "message": "Connected to Gemini Live API (Production v1.6.1 - Turn-Based Dialog)",
            "model": "gemini-2.5-flash-native-audio-preview-12-2025",
            "functions_enabled": len(enabled_functions),
            "google_sheets": bool(getattr(assistant, 'google_sheet_id', None)),
            "thinking_enabled": getattr(assistant, 'enable_thinking', False),
            "transcription_enabled": True,
            "client_id": client_id,
            "vad_mode": "gemini_native",
            "function_logging": True,
            "turn_based_dialog": True  # 🆕 v1.6.1
        })

        # Interruption state
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        # Start Gemini message handler
        gemini_task = asyncio.create_task(
            handle_gemini_messages(gemini_client, websocket, interruption_state)
        )

        # Main client receive loop
        message_count = 0
        audio_chunks_sent = 0

        while True:
            try:
                message = await websocket.receive()
                message_count += 1

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    if msg_type == "session.update":
                        await websocket.send_json({
                            "type": "session.update.ack",
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        continue

                    # Screen context handler (silent mode)
                    if msg_type == "screen.context":
                        image_data = data.get("image")
                        is_silent = data.get("silent", True)

                        if not image_data:
                            log_to_render(f"❌ No image data in screen.context", "ERROR")
                            continue

                        if gemini_client.is_connected:
                            success = await gemini_client.send_screen_context(image_data, silent=is_silent)
                            if not success:
                                log_to_render(f"❌ Failed to send screen context", "ERROR")
                        else:
                            log_to_render(f"❌ Gemini not connected", "ERROR")

                        continue

                    # ✅ PURE GEMINI VAD - continuous audio streaming
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        audio_chunks_sent += 1

                        if gemini_client.is_connected:
                            await gemini_client.process_audio(audio_chunk)

                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack",
                            "event_id": data.get("event_id")
                        })

                        continue

                    if msg_type == "response.cancel":
                        await websocket.send_json({
                            "type": "response.cancel.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    # Interruption handling
                    if msg_type == "interruption.manual":
                        await gemini_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "audio_playback.stopped":
                        gemini_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue

                    # Speech events - for logging only
                    if msg_type == "speech.user_started":
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()

                        # Check if interrupting assistant
                        if interruption_state["is_assistant_speaking"]:
                            await gemini_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue

                    if msg_type == "speech.user_stopped":
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                elif "bytes" in message:
                    audio_chunks_sent += 1
                    if gemini_client.is_connected:
                        await gemini_client.process_audio(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                break
            except Exception as e:
                if "disconnect message" in str(e):
                    break
                log_to_render(f"❌ Error in WebSocket loop: {e}", "ERROR")
                log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                break

        # Cleanup
        if not gemini_task.done():
            gemini_task.cancel()
            await asyncio.sleep(0)

    except Exception as outer_e:
        log_to_render(f"❌ CRITICAL ERROR: {outer_e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")

        try:
            await websocket.send_json({
                "type": "error",
                "error": {"code": "server_error", "message": "Internal server error"}
            })
        except:
            pass
    finally:
        if gemini_client:
            await gemini_client.close()

        conns = active_gemini_connections.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        log_to_render(f"👋 Connection closed: {client_id}")


async def handle_gemini_messages(
    gemini_client: GeminiLiveClient,
    websocket: WebSocket,
    interruption_state: Dict
):
    """
    🚀 PRODUCTION v1.6.1 - Handle messages from Gemini Live API

    🔥🔥🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ v1.6.1: 🔥🔥🔥
    Поле `finished` НЕ СУЩЕСТВУЕТ в Gemini Live API!
    Единственный маркер конца реплики — turnComplete.

    Логика:
    1. Накапливаем чанки транскрипции в буферы
    2. При turnComplete — сохраняем буферы как отдельную запись
    3. Очищаем буферы ПОСЛЕ сохранения
    """
    if not gemini_client.is_connected or not gemini_client.ws:
        log_to_render(f"❌ Gemini client not connected", "ERROR")
        return

    # ═══════════════════════════════════════════════════════════════
    # 🔥 v1.6.1: Простые буферы для текущего turn
    # НЕ используем списки user_turns/assistant_turns —
    # каждый turnComplete = один turn = одна запись
    # ═══════════════════════════════════════════════════════════════
    current_user_transcript = ""      # Буфер транскрипции пользователя для текущего turn
    current_assistant_transcript = "" # Буфер транскрипции ассистента для текущего turn

    # Счётчики
    turn_count = 0
    transcript_events_received = 0

    # Function tracking
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments": {}
    }

    # Metrics
    event_count = 0
    function_execution_count = 0

    try:
        while True:
            try:
                raw = await gemini_client.ws.recv()
                event_count += 1

                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    log_to_render(f"❌ JSON decode error: {raw[:200]}", "ERROR")
                    continue

                # Setup complete
                if "setupComplete" in response_data:
                    await websocket.send_json({
                        "type": "gemini.setup.complete",
                        "timestamp": time.time(),
                        "transcription_enabled": True,
                        "turn_based_dialog": True
                    })
                    continue

                # ✅ Tool Call event (top-level, outside serverContent)
                if "toolCall" in response_data:
                    tool_call = response_data["toolCall"]
                    function_calls = tool_call.get("functionCalls", [])

                    for func_call in function_calls:
                        function_name = func_call.get("name")
                        function_id = func_call.get("id")
                        arguments = func_call.get("args", {})

                        # Store pending call
                        pending_function_call = {
                            "name": function_name,
                            "call_id": function_id,
                            "arguments": arguments
                        }

                        # Execute immediately
                        execution_start = time.time()
                        status = "error"
                        error_message = None
                        result = None

                        try:
                            normalized_name = normalize_function_name(function_name)

                            gemini_client.last_function_name = normalized_name

                            result = await execute_function(
                                name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": gemini_client.assistant_config,
                                    "client_id": gemini_client.client_id,
                                    "db_session": gemini_client.db_session,
                                    "websocket": websocket
                                }
                            )

                            execution_time = time.time() - execution_start
                            execution_time_ms = execution_time * 1000
                            function_execution_count += 1
                            status = "success"

                            # 🆕 v1.5.1: Log to FunctionLog (async)
                            user_id = str(gemini_client.assistant_config.user_id) if gemini_client.assistant_config and gemini_client.assistant_config.user_id else None
                            assistant_id = str(gemini_client.assistant_config.id) if gemini_client.assistant_config else None

                            asyncio.create_task(
                                async_save_function_log(
                                    function_name=normalized_name,
                                    arguments=arguments,
                                    result=result if isinstance(result, dict) else {"result": str(result)},
                                    status=status,
                                    execution_time_ms=execution_time_ms,
                                    user_id=user_id,
                                    assistant_id=assistant_id,
                                    conversation_id=gemini_client.conversation_record_id,
                                    error_message=None
                                )
                            )

                            # Send result to Gemini
                            delivery_status = await gemini_client.send_function_result(
                                function_id,
                                result
                            )

                            if delivery_status and delivery_status.get("success"):
                                await websocket.send_json({
                                    "type": "function_call.completed",
                                    "function": normalized_name,
                                    "function_call_id": function_id,
                                    "result": result,
                                    "execution_time": execution_time
                                })
                            else:
                                log_to_render(f"❌ Delivery failed: {delivery_status.get('error')}", "ERROR")

                                await websocket.send_json({
                                    "type": "function_call.delivery_error",
                                    "function_call_id": function_id,
                                    "error": delivery_status.get('error')
                                })

                        except Exception as e:
                            execution_time = time.time() - execution_start
                            execution_time_ms = execution_time * 1000
                            status = "error"
                            error_message = str(e)

                            log_to_render(f"❌ Function execution error: {e}", "ERROR")
                            log_to_render(f"   Traceback: {traceback.format_exc()}", "ERROR")

                            # Log error to FunctionLog
                            user_id = str(gemini_client.assistant_config.user_id) if gemini_client.assistant_config and gemini_client.assistant_config.user_id else None
                            assistant_id = str(gemini_client.assistant_config.id) if gemini_client.assistant_config else None

                            asyncio.create_task(
                                async_save_function_log(
                                    function_name=normalize_function_name(function_name) or function_name,
                                    arguments=arguments,
                                    result={"error": error_message},
                                    status=status,
                                    execution_time_ms=execution_time_ms,
                                    user_id=user_id,
                                    assistant_id=assistant_id,
                                    conversation_id=gemini_client.conversation_record_id,
                                    error_message=error_message
                                )
                            )

                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })

                    continue

                # Server content (main response container)
                if "serverContent" in response_data:
                    server_content = response_data["serverContent"]

                    # ═══════════════════════════════════════════════════════════════
                    # 🔥 v1.6.1: ТРАНСКРИПЦИЯ ВХОДЯЩЕГО АУДИО (пользователя)
                    # ═══════════════════════════════════════════════════════════════
                    if "inputTranscription" in server_content:
                        input_trans = server_content["inputTranscription"]

                        if "text" in input_trans:
                            transcript_text = input_trans["text"]
                            transcript_events_received += 1

                            # Накапливаем в буфер
                            current_user_transcript += transcript_text

                            # Отправляем клиенту стриминговый чанк
                            await websocket.send_json({
                                "type": "input.transcription",
                                "text": transcript_text,
                                "is_chunk": True
                            })

                    # ═══════════════════════════════════════════════════════════════
                    # 🔥 v1.6.1: ТРАНСКРИПЦИЯ ОТВЕТА МОДЕЛИ (ассистента)
                    # ═══════════════════════════════════════════════════════════════
                    if "outputTranscription" in server_content:
                        output_trans = server_content["outputTranscription"]

                        if "text" in output_trans:
                            transcript_text = output_trans["text"]
                            transcript_events_received += 1

                            # Накапливаем в буфер
                            current_assistant_transcript += transcript_text

                            # Отправляем клиенту стриминговый чанк
                            await websocket.send_json({
                                "type": "output.transcription",
                                "text": transcript_text,
                                "is_chunk": True
                            })

                    # ═══════════════════════════════════════════════════════════════
                    # Check for interruption
                    # ═══════════════════════════════════════════════════════════════
                    if server_content.get("interrupted"):
                        interruption_state["interruption_count"] += 1
                        interruption_state["last_interruption_time"] = time.time()
                        interruption_state["is_assistant_speaking"] = False
                        gemini_client.set_assistant_speaking(False)

                        # 🔥 v1.6.1: При прерывании сохраняем что есть
                        if current_user_transcript.strip() or current_assistant_transcript.strip():
                            turn_count += 1

                            user_msg = current_user_transcript.strip() or ""
                            assistant_msg = (current_assistant_transcript.strip() + " [прервано]") if current_assistant_transcript.strip() else ""

                            # Save to DB
                            try:
                                await ConversationService.save_conversation(
                                    db=gemini_client.db_session,
                                    assistant_id=str(gemini_client.assistant_config.id),
                                    user_message=user_msg or "[no user input]",
                                    assistant_message=assistant_msg or "[interrupted]",
                                    session_id=gemini_client.session_id,
                                    caller_number=None,
                                    tokens_used=0
                                )
                            except Exception as e:
                                log_to_render(f"❌ Error saving interrupted turn: {e}", "ERROR")

                            # Save to Google Sheets
                            if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                try:
                                    await GoogleSheetsService.log_conversation(
                                        sheet_id=gemini_client.assistant_config.google_sheet_id,
                                        user_message=user_msg or "[no user input]",
                                        assistant_message=assistant_msg or "[interrupted]",
                                        function_result=None,
                                        conversation_id=gemini_client.conversation_record_id
                                    )
                                except Exception as e:
                                    log_to_render(f"❌ Sheets error: {e}", "ERROR")

                            # 🔥 ОЧИЩАЕМ БУФЕРЫ
                            current_user_transcript = ""
                            current_assistant_transcript = ""

                        await websocket.send_json({
                            "type": "conversation.interrupted",
                            "timestamp": interruption_state["last_interruption_time"]
                        })
                        continue

                    # ═══════════════════════════════════════════════════════════════
                    # Model turn (audio data)
                    # ═══════════════════════════════════════════════════════════════
                    if "modelTurn" in server_content:
                        model_turn = server_content["modelTurn"]
                        parts = model_turn.get("parts", [])

                        for part in parts:
                            # Text content
                            if "text" in part:
                                text = part["text"]
                                await websocket.send_json({
                                    "type": "response.text.delta",
                                    "delta": text
                                })

                            # Inline audio data
                            if "inlineData" in part:
                                inline_data = part["inlineData"]
                                mime_type = inline_data.get("mimeType", "")
                                data = inline_data.get("data", "")

                                if "audio/pcm" in mime_type:
                                    if not interruption_state["is_assistant_speaking"]:
                                        interruption_state["is_assistant_speaking"] = True
                                        gemini_client.set_assistant_speaking(True)

                                        await websocket.send_json({
                                            "type": "assistant.speech.started",
                                            "timestamp": time.time()
                                        })

                                    await websocket.send_json({
                                        "type": "response.audio.delta",
                                        "delta": data
                                    })

                                    sample_count = len(base64.b64decode(data)) // 2
                                    gemini_client.increment_audio_samples(sample_count)

                            # Function call (tool call) inside modelTurn
                            if "functionCall" in part:
                                function_call = part["functionCall"]
                                function_name = function_call.get("name")
                                arguments = function_call.get("args", {})

                                normalized_name = normalize_function_name(function_name) or function_name

                                if normalized_name not in gemini_client.enabled_functions:
                                    await websocket.send_json({
                                        "type": "function_call.error",
                                        "function": normalized_name,
                                        "error": f"Function {function_name} not activated"
                                    })
                                    continue

                                # Store for later
                                pending_function_call = {
                                    "name": normalized_name,
                                    "call_id": f"call_{int(time.time() * 1000)}",
                                    "arguments": arguments
                                }
                                gemini_client.last_function_name = normalized_name

                                await websocket.send_json({
                                    "type": "function_call.started",
                                    "function": normalized_name,
                                    "function_call_id": pending_function_call["call_id"]
                                })

                                # Execute function
                                execution_start = time.time()
                                status = "error"
                                error_message = None
                                result = None

                                try:
                                    await websocket.send_json({
                                        "type": "function_call.executing",
                                        "function": normalized_name,
                                        "function_call_id": pending_function_call["call_id"],
                                        "arguments": arguments
                                    })

                                    result = await execute_function(
                                        name=normalized_name,
                                        arguments=arguments,
                                        context={
                                            "assistant_config": gemini_client.assistant_config,
                                            "client_id": gemini_client.client_id,
                                            "db_session": gemini_client.db_session,
                                            "websocket": websocket
                                        }
                                    )

                                    execution_time = time.time() - execution_start
                                    execution_time_ms = execution_time * 1000
                                    function_execution_count += 1
                                    status = "success"

                                    # Log to FunctionLog (async)
                                    user_id = str(gemini_client.assistant_config.user_id) if gemini_client.assistant_config and gemini_client.assistant_config.user_id else None
                                    assistant_id_str = str(gemini_client.assistant_config.id) if gemini_client.assistant_config else None

                                    asyncio.create_task(
                                        async_save_function_log(
                                            function_name=normalized_name,
                                            arguments=arguments,
                                            result=result if isinstance(result, dict) else {"result": str(result)},
                                            status=status,
                                            execution_time_ms=execution_time_ms,
                                            user_id=user_id,
                                            assistant_id=assistant_id_str,
                                            conversation_id=gemini_client.conversation_record_id,
                                            error_message=None
                                        )
                                    )

                                    # Fast display for query_llm
                                    if normalized_name == "query_llm":
                                        llm_response_content = ""
                                        llm_model = "gpt-4"

                                        if isinstance(result, dict):
                                            llm_response_content = result.get("full_response", result.get("response", str(result)))
                                            llm_model = result.get("model_used", "gpt-4")
                                        else:
                                            llm_response_content = str(result)

                                        await websocket.send_json({
                                            "type": "llm_result",
                                            "content": llm_response_content,
                                            "model": llm_model,
                                            "function": normalized_name,
                                            "execution_time": execution_time,
                                            "timestamp": time.time()
                                        })

                                    # Google Sheets logging for function calls
                                    if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                        sheet_id = gemini_client.assistant_config.google_sheet_id

                                        try:
                                            user_msg = current_user_transcript.strip() if current_user_transcript.strip() else f"[Function call: {normalized_name}]"

                                            await GoogleSheetsService.log_conversation(
                                                sheet_id=sheet_id,
                                                user_message=user_msg,
                                                assistant_message=f"[Function executed: {normalized_name}]",
                                                function_result=result,
                                                conversation_id=gemini_client.conversation_record_id
                                            )
                                        except Exception as e:
                                            log_to_render(f"❌ Sheets error: {e}", "ERROR")

                                    # Send result to Gemini
                                    delivery_status = await gemini_client.send_function_result(
                                        pending_function_call["call_id"],
                                        result
                                    )

                                    if delivery_status["success"]:
                                        await websocket.send_json({
                                            "type": "function_call.completed",
                                            "function": normalized_name,
                                            "function_call_id": pending_function_call["call_id"],
                                            "result": result,
                                            "execution_time": execution_time
                                        })
                                    else:
                                        log_to_render(f"❌ Delivery failed: {delivery_status['error']}", "ERROR")

                                        await websocket.send_json({
                                            "type": "function_call.delivery_error",
                                            "function_call_id": pending_function_call["call_id"],
                                            "error": delivery_status['error']
                                        })

                                except Exception as e:
                                    execution_time = time.time() - execution_start
                                    execution_time_ms = execution_time * 1000
                                    status = "error"
                                    error_message = str(e)

                                    log_to_render(f"❌ Function execution ERROR: {e}", "ERROR")
                                    log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")

                                    # Log error to FunctionLog
                                    user_id = str(gemini_client.assistant_config.user_id) if gemini_client.assistant_config and gemini_client.assistant_config.user_id else None
                                    assistant_id_str = str(gemini_client.assistant_config.id) if gemini_client.assistant_config else None

                                    asyncio.create_task(
                                        async_save_function_log(
                                            function_name=normalized_name,
                                            arguments=arguments,
                                            result={"error": error_message},
                                            status=status,
                                            execution_time_ms=execution_time_ms,
                                            user_id=user_id,
                                            assistant_id=assistant_id_str,
                                            conversation_id=gemini_client.conversation_record_id,
                                            error_message=error_message
                                        )
                                    )

                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {"code": "function_execution_error", "message": str(e)}
                                    })

                                # Clear pending
                                pending_function_call = {"name": None, "call_id": None, "arguments": {}}

                    # ═══════════════════════════════════════════════════════════════
                    # 🔥🔥🔥 v1.6.1: TURN COMPLETE - ГЛАВНЫЙ МАРКЕР! 🔥🔥🔥
                    # Это ЕДИНСТВЕННОЕ место где мы сохраняем диалог!
                    # ═══════════════════════════════════════════════════════════════
                    if server_content.get("turnComplete"):
                        turn_count += 1

                        if interruption_state["is_assistant_speaking"]:
                            interruption_state["is_assistant_speaking"] = False
                            gemini_client.set_assistant_speaking(False)

                            await websocket.send_json({
                                "type": "assistant.speech.ended",
                                "timestamp": time.time()
                            })

                        # Отправляем завершённые транскрипты клиенту
                        if current_user_transcript.strip():
                            await websocket.send_json({
                                "type": "input.transcription.complete",
                                "text": current_user_transcript.strip(),
                                "turn_number": turn_count
                            })

                        if current_assistant_transcript.strip():
                            await websocket.send_json({
                                "type": "output.transcription.complete",
                                "text": current_assistant_transcript.strip(),
                                "turn_number": turn_count
                            })

                        # ═══════════════════════════════════════════════════════════
                        # 💾 СОХРАНЯЕМ TURN В БД И GOOGLE SHEETS
                        # ═══════════════════════════════════════════════════════════
                        user_msg = current_user_transcript.strip()
                        assistant_msg = current_assistant_transcript.strip()

                        if user_msg or assistant_msg:
                            # Save to DB
                            try:
                                await ConversationService.save_conversation(
                                    db=gemini_client.db_session,
                                    assistant_id=str(gemini_client.assistant_config.id),
                                    user_message=user_msg or "[no user input]",
                                    assistant_message=assistant_msg or "[no response]",
                                    session_id=gemini_client.session_id,
                                    caller_number=None,
                                    tokens_used=0
                                )
                            except Exception as e:
                                log_to_render(f"❌ Error saving turn #{turn_count} to DB: {e}", "ERROR")

                            # Save to Google Sheets
                            if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                try:
                                    await GoogleSheetsService.log_conversation(
                                        sheet_id=gemini_client.assistant_config.google_sheet_id,
                                        user_message=user_msg or "[no user input]",
                                        assistant_message=assistant_msg or "[no response]",
                                        function_result=None,
                                        conversation_id=gemini_client.conversation_record_id
                                    )
                                except Exception as e:
                                    log_to_render(f"❌ Sheets error for turn #{turn_count}: {e}", "ERROR")

                            # Отправляем клиенту событие о сохранении
                            await websocket.send_json({
                                "type": "turn.saved",
                                "turn_number": turn_count,
                                "user_message": user_msg,
                                "assistant_message": assistant_msg[:200] + "..." if len(assistant_msg) > 200 else assistant_msg
                            })

                        # ═══════════════════════════════════════════════════════════
                        # 🔥 КРИТИЧЕСКИ ВАЖНО: ОЧИЩАЕМ БУФЕРЫ ПОСЛЕ СОХРАНЕНИЯ!
                        # ═══════════════════════════════════════════════════════════
                        current_user_transcript = ""
                        current_assistant_transcript = ""

                # ═══════════════════════════════════════════════════════════════
                # Top-level transcriptions (if they come separately)
                # ═══════════════════════════════════════════════════════════════
                if "inputTranscription" in response_data and "serverContent" not in response_data:
                    input_trans = response_data["inputTranscription"]
                    if "text" in input_trans:
                        transcript_text = input_trans["text"]
                        transcript_events_received += 1
                        current_user_transcript += transcript_text

                        await websocket.send_json({
                            "type": "input.transcription",
                            "text": transcript_text,
                            "is_chunk": True
                        })

                if "outputTranscription" in response_data and "serverContent" not in response_data:
                    output_trans = response_data["outputTranscription"]
                    if "text" in output_trans:
                        transcript_text = output_trans["text"]
                        transcript_events_received += 1
                        current_assistant_transcript += transcript_text

                        await websocket.send_json({
                            "type": "output.transcription",
                            "text": transcript_text,
                            "is_chunk": True
                        })

            except ConnectionClosed as e:
                if await gemini_client.reconnect():
                    continue
                else:
                    log_to_render(f"❌ Reconnection to Gemini failed", "ERROR")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "gemini_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        return
    except Exception as e:
        log_to_render(f"❌ CRITICAL Handler error: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
    finally:
        # ═══════════════════════════════════════════════════════════════
        # 🔥 v1.6.1: РЕЗЕРВНОЕ СОХРАНЕНИЕ при disconnect
        # ═══════════════════════════════════════════════════════════════

        # Сохраняем оставшиеся буферы
        if (current_user_transcript.strip() or current_assistant_transcript.strip()) and gemini_client.assistant_config:
            turn_count += 1

            user_msg = current_user_transcript.strip()
            assistant_msg = current_assistant_transcript.strip()
            if assistant_msg:
                assistant_msg += " [disconnected]"

            # Save to DB
            try:
                await ConversationService.save_conversation(
                    db=gemini_client.db_session,
                    assistant_id=str(gemini_client.assistant_config.id),
                    user_message=user_msg or "[no user input]",
                    assistant_message=assistant_msg or "[incomplete - disconnected]",
                    session_id=gemini_client.session_id,
                    caller_number=None,
                    tokens_used=0
                )
            except Exception as e:
                log_to_render(f"❌ Final DB save error: {e}", "ERROR")

            # Save to Google Sheets
            if gemini_client.assistant_config.google_sheet_id:
                try:
                    await GoogleSheetsService.log_conversation(
                        sheet_id=gemini_client.assistant_config.google_sheet_id,
                        user_message=user_msg or "[no user input]",
                        assistant_message=assistant_msg or "[incomplete - disconnected]",
                        function_result=None,
                        conversation_id=gemini_client.conversation_record_id
                    )
                except Exception as e:
                    log_to_render(f"❌ Final Sheets error: {e}", "ERROR")
