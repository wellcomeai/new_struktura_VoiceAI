# backend/websockets/handler_realtime_new.py
"""
🚀 PRODUCTION VERSION 2.12.4 - OpenAI Realtime API Handler (Server VAD Only)
✅ v2.12.4: Client commit ignored — server VAD is the only commit mechanism
✅ Fixed: Function logs now properly linked via conversation_id
✅ Fixed: Messages after function calls saved correctly
✅ Fixed: User transcript preserved across function call responses
✅ All previous features maintained

Previous versions:
✅ v2.12.3: Function logs linked via conversation_id
✅ v2.12.2: Function call transcript preservation
✅ v2.12.1: DB session fix for async tasks
✅ v2.12: No duplicate conversations - single source of truth
✅ v2.11.2: Function name detection, FunctionLog tracking
✅ v2.10: Async function calls (non-blocking)
✅ v2.9: Async logging optimizations
✅ v2.8: Save each dialog as separate DB record

✅ Ready for production deployment
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
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.models.elevenlabs import ElevenLabsAgent
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.openai_client_new import OpenAIRealtimeClientNew
from backend.services.google_sheets_service import GoogleSheetsService
from backend.services.conversation_service import ConversationService
from backend.services.function_log_service import FunctionLogService

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
active_connections_new: Dict[str, List[WebSocket]] = {}

# 🔍 DEBUG MODE - Set to False in production after debugging
ENABLE_DETAILED_LOGGING = False


def log_to_render(message: str, level: str = "INFO"):
    """Force log to Render stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [REALTIME-GA v2.12.3] {level} - {message}"
    print(log_msg, flush=True)  # Force flush to stdout
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)


async def async_save_to_google_sheets(sheet_id: str, user_message: str, assistant_message: str, function_result=None, conversation_id: str = None, context: str = ""):
    """
    🚀 v2.9: Async Google Sheets save (non-blocking)
    """
    try:
        if not sheet_id:
            return

        await GoogleSheetsService.log_conversation(
            sheet_id=sheet_id,
            user_message=user_message,
            assistant_message=assistant_message,
            function_result=function_result,
            conversation_id=conversation_id
        )

    except Exception as e:
        log_to_render(f"❌ [ASYNC] Google Sheets error: {e}", "ERROR")


async def async_save_dialog_to_db(assistant_id: str, user_message: str, assistant_message: str, session_id: str):
    """
    🚀 v2.12.3: Save dialog to database.

    ✅ FIX: Creates NEW db session inside task (original session may be closed)

    NOTE: In v3.3 of openai_client, a conversation record is created at session start.
    This function creates ADDITIONAL records for each dialog turn.
    """
    from backend.db.session import SessionLocal

    db = None
    try:
        if not user_message or not assistant_message:
            return

        # 🆕 v2.12.1 FIX: Create NEW session inside async task
        db = SessionLocal()

        await ConversationService.save_conversation(
            db=db,
            assistant_id=assistant_id,
            user_message=user_message,
            assistant_message=assistant_message,
            session_id=session_id,
            caller_number=None,
            tokens_used=0
        )

    except Exception as e:
        log_to_render(f"❌ [v2.12.3] Dialog save error: {e}", "ERROR")
    finally:
        if db:
            db.close()


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
    🆕 v2.12.3: Async function log save to function_logs table (non-blocking)
    ✅ FIX: Creates NEW session inside task (original session may be closed)
    ✅ FIX: conversation_id now properly passed from openai_client.conversation_record_id
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
        log_to_render(f"❌ [FUNC-LOG v2.12.3] Error saving function log: {e}", "ERROR")
    finally:
        if db:
            db.close()


# 🔥🔥🔥 v2.12.3: Async function execution with FunctionLog tracking (FIXED)
async def execute_and_send_function_result(
    openai_client: 'OpenAIRealtimeClientNew',
    websocket: WebSocket,
    function_call_id: str,
    function_name: str,
    arguments: dict,
    context: dict,
    user_transcript: str = ""
):
    """
    🔥 v2.12.3: Execute function in background WITHOUT blocking assistant speech!

    ✨ FIX in v2.12.3:
    - conversation_id now passed from openai_client.conversation_record_id
    - Function logs properly linked to conversations

    Flow:
    1. Function starts executing (this runs in background task)
    2. Assistant continues talking ("Let me check that for you...")
    3. Function completes -> result sent to OpenAI
    4. Assistant integrates result into speech ("Here's what I found...")
    5. Function call logged to function_logs table WITH conversation_id
    """
    execution_start = time.time()
    status = "error"
    error_message = None
    result = None

    try:
        # Execute function (this may take 1-10 seconds, but doesn't block!)
        result = await execute_function(
            name=function_name,
            arguments=arguments,
            context=context
        )

        execution_time = time.time() - execution_start
        execution_time_ms = execution_time * 1000
        status = "success"

        # 🚀 Fast LLM result display for query_llm
        if function_name == "query_llm":
            llm_response_content = ""
            llm_model = "gpt-4"

            if isinstance(result, dict):
                llm_response_content = result.get("full_response", result.get("response", result.get("answer", str(result))))
                llm_model = result.get("model_used", result.get("model", "gpt-4"))
            else:
                llm_response_content = str(result)

            # Send to frontend IMMEDIATELY
            await websocket.send_json({
                "type": "llm_result",
                "content": llm_response_content,
                "model": llm_model,
                "function": function_name,
                "execution_time": execution_time,
                "timestamp": time.time(),
                "async_execution": True
            })

        # Google Sheets logging (async, non-blocking)
        if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
            sheet_id = openai_client.assistant_config.google_sheet_id

            asyncio.create_task(
                async_save_to_google_sheets(
                    sheet_id=sheet_id,
                    user_message=user_transcript or f"[Function call: {function_name}]",
                    assistant_message=f"[Async function executed: {function_name}]",
                    function_result=result,
                    conversation_id=openai_client.conversation_record_id,
                    context="Async Function Call v2.12.3"
                )
            )

        # 🆕 v2.12.3 FIX: FunctionLog save with proper conversation_id
        user_id = str(openai_client.assistant_config.user_id) if openai_client.assistant_config and openai_client.assistant_config.user_id else None
        assistant_id = str(openai_client.assistant_config.id) if openai_client.assistant_config else None

        asyncio.create_task(
            async_save_function_log(
                function_name=function_name,
                arguments=arguments,
                result=result if isinstance(result, dict) else {"result": str(result)},
                status=status,
                execution_time_ms=execution_time_ms,
                user_id=user_id,
                assistant_id=assistant_id,
                conversation_id=openai_client.conversation_record_id,
                error_message=None
            )
        )

        # Send result to OpenAI (v3.3 client with auto response.create)
        delivery_status = await openai_client.send_function_result(function_call_id, result)

        if delivery_status["success"]:
            # Notify frontend
            await websocket.send_json({
                "type": "function_call.completed",
                "function": function_name,
                "function_call_id": function_call_id,
                "result": result,
                "execution_time": execution_time,
                "async_execution": True
            })
        else:
            log_to_render(f"❌ [ASYNC v2.12.3] Function result delivery FAILED: {delivery_status['error']}", "ERROR")

            await websocket.send_json({
                "type": "function_call.delivery_error",
                "function_call_id": function_call_id,
                "error": delivery_status['error'],
                "async_execution": True
            })

    except Exception as e:
        execution_time = time.time() - execution_start
        execution_time_ms = execution_time * 1000
        status = "error"
        error_message = str(e)

        log_to_render(f"❌ [ASYNC FUNCTION v2.12.3] Execution ERROR: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")

        # 🆕 v2.12.3 FIX: Log error with proper conversation_id
        user_id = str(openai_client.assistant_config.user_id) if openai_client.assistant_config and openai_client.assistant_config.user_id else None
        assistant_id = str(openai_client.assistant_config.id) if openai_client.assistant_config else None

        asyncio.create_task(
            async_save_function_log(
                function_name=function_name,
                arguments=arguments,
                result={"error": error_message},
                status=status,
                execution_time_ms=execution_time_ms,
                user_id=user_id,
                assistant_id=assistant_id,
                conversation_id=openai_client.conversation_record_id,
                error_message=error_message
            )
        )

        # Send error to frontend
        await websocket.send_json({
            "type": "function_call.error",
            "function": function_name,
            "function_call_id": function_call_id,
            "error": str(e),
            "async_execution": True
        })


# Import execute_function for the async handler
from backend.functions import execute_function, normalize_function_name


async def handle_websocket_connection_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🚀 PRODUCTION v2.12.3 - Main WebSocket handler with Function Logs Fix

    v2.12.3 improvements:
    - Fixed: Function logs now properly linked via conversation_id
    - Fixed: Messages after function calls saved correctly
    - User transcript preserved across function call responses

    Previous features maintained:
    - Full function logging to function_logs table
    - Async function execution
    - Async logging
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    connection_start = time.time()

    log_to_render(f"🚀 NEW CONNECTION: client_id={client_id}, assistant_id={assistant_id}")

    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')

    try:
        await websocket.accept()

        # Check for ElevenLabs agents
        elevenlabs_agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == assistant_id
        ).first()
        if elevenlabs_agent:
            await websocket.send_json({
                "type": "elevenlabs_agent_detected",
                "agent_info": {
                    "id": str(elevenlabs_agent.id),
                    "name": elevenlabs_agent.name
                }
            })
            await asyncio.sleep(1)
            await websocket.close(code=1000)
            return

        # Register connection
        active_connections_new.setdefault(assistant_id, []).append(websocket)

        # Load assistant
        if assistant_id == "demo":
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
        else:
            try:
                uuid_obj = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(uuid_obj)
            except ValueError:
                assistant = db.query(AssistantConfig).filter(AssistantConfig.id.cast(str) == assistant_id).first()

        if not assistant:
            log_to_render(f"❌ Assistant not found: {assistant_id}", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
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

                api_key = user.openai_api_key

        if not api_key:
            log_to_render(f"❌ No API key available", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "OpenAI API key required"}
            })
            await websocket.close(code=1008)
            return

        # Create OpenAI Realtime client
        openai_client = OpenAIRealtimeClientNew(api_key, assistant, client_id, db, user_agent)

        if not await openai_client.connect():
            log_to_render(f"❌ Failed to connect to OpenAI", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        # Send connection status
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "message": "Connected to Realtime API (v2.12.3 - Function Logs Fix)",
            "model": "gpt-realtime-mini",
            "functions_enabled": len(enabled_functions),
            "google_sheets": bool(getattr(assistant, 'google_sheet_id', None)),
            "client_id": client_id,
            "performance_mode": "optimized",
            "async_functions": True,
            "function_logging": True,
            "function_logs_linked": True,
            "enable_vision": assistant.enable_vision if hasattr(assistant, 'enable_vision') and assistant.enable_vision else False,
            "greeting_message": assistant.greeting_message or "Здравствуйте! Чем я могу вам помочь?"
        })

        # ✅ Ассистент говорит первым после создания сессии
        greeting = assistant.greeting_message or "Здравствуйте! Чем я могу вам помочь?"

        initial_item = {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": f"[SYSTEM INSTRUCTION: Start the conversation immediately by saying your greeting. Your greeting is: '{greeting}'. Say it now in a natural, friendly way.]"
                    }
                ]
            }
        }
        await openai_client.ws.send(json.dumps(initial_item))

        response_trigger = {
            "type": "response.create"
        }
        await openai_client.ws.send(json.dumps(response_trigger))

        # Interruption state
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        # Start OpenAI message handler
        openai_task = asyncio.create_task(
            handle_openai_messages_new(openai_client, websocket, interruption_state)
        )

        # Main client receive loop
        message_count = 0
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

                        if openai_client.is_connected:
                            success = await openai_client.send_screen_context(image_data, silent=is_silent)
                            if not success:
                                log_to_render(f"❌ Failed to send screen context", "ERROR")
                        else:
                            log_to_render(f"❌ OpenAI not connected", "ERROR")

                        continue

                    # Audio processing
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])

                        if openai_client.is_connected:
                            await openai_client.process_audio(audio_chunk)

                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "input_audio_buffer.commit":
                        # v2.12.4: server VAD manages commits, client commit ignored
                        await websocket.send_json({
                            "type": "input_audio_buffer.commit.ack",
                            "event_id": data.get("event_id"),
                            "note": "server_vad_active"
                        })
                        continue

                    if msg_type == "input_audio_buffer.clear":
                        if openai_client.is_connected:
                            await openai_client.clear_audio_buffer()
                        await websocket.send_json({
                            "type": "input_audio_buffer.clear.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "response.cancel":
                        if openai_client.is_connected:
                            await openai_client.ws.send(json.dumps({
                                "type": "response.cancel",
                                "event_id": data.get("event_id")
                            }))
                        await websocket.send_json({
                            "type": "response.cancel.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    # Interruption handling
                    if msg_type == "interruption.manual":
                        await openai_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack",
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "audio_playback.stopped":
                        openai_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue

                    if msg_type == "speech.user_started":
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()

                        if interruption_state["is_assistant_speaking"]:
                            await openai_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue

                    if msg_type == "speech.user_stopped":
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                elif "bytes" in message:
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
        if not openai_task.done():
            openai_task.cancel()
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
        if openai_client:
            await openai_client.close()

        conns = active_connections_new.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        log_to_render(f"👋 Connection closed: {client_id}")


async def handle_openai_messages_new(
    openai_client: 'OpenAIRealtimeClientNew',
    websocket: WebSocket,
    interruption_state: Dict
):
    """
    🚀 PRODUCTION v2.12.3 - Handle messages from OpenAI with Function Logs Fix

    ✨ FIX in v2.12.3 - FUNCTION LOGS LINKED:
    - conversation_id properly passed to function log saves

    Previous features maintained:
    ✅ v2.12.2: User transcript preservation
    ✅ v2.12: No duplicate conversations
    ✅ v2.11: FunctionLog tracking
    ✅ v2.10: Async function execution (non-blocking)
    ✅ v2.9: Async logging (non-blocking)
    ✅ v2.8: Fast LLM result display
    """
    if not openai_client.is_connected or not openai_client.ws:
        log_to_render(f"❌ OpenAI client not connected", "ERROR")
        return

    # Transcripts
    user_transcript = ""
    assistant_transcript = ""
    last_user_transcript = ""  # v2.12.2: Keep user context for function responses

    # Function tracking map (call_id -> function metadata)
    function_calls_map = {}

    # v2.12.2: Track if current response includes function call
    response_had_function_call = False

    # Function buffer
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments_buffer": ""
    }

    # Metrics
    event_count = 0
    function_execution_count = 0

    try:
        while True:
            try:
                raw = await openai_client.ws.recv()
                event_count += 1

                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    log_to_render(f"❌ JSON decode error: {raw[:200]}", "ERROR")
                    continue

                msg_type = response_data.get("type", "unknown")

                # Track conversation.item.created for function metadata
                if msg_type == "conversation.item.created":
                    item = response_data.get("item", {})
                    item_type = item.get("type")

                    if item_type == "function_call":
                        call_id = item.get("call_id")
                        function_name = item.get("name")

                        if call_id and function_name:
                            normalized_name = normalize_function_name(function_name)
                            function_calls_map[call_id] = {
                                "name": normalized_name,
                                "original_name": function_name,
                                "item_id": item.get("id"),
                                "status": "pending",
                                "timestamp": time.time()
                            }

                # VAD events
                if msg_type == "input_audio_buffer.speech_started":
                    interruption_state["is_user_speaking"] = True
                    interruption_state["last_speech_start"] = time.time()

                    await websocket.send_json({
                        "type": "speech.started",
                        "timestamp": interruption_state["last_speech_start"]
                    })
                    continue

                if msg_type == "input_audio_buffer.speech_stopped":
                    interruption_state["is_user_speaking"] = False
                    interruption_state["last_speech_stop"] = time.time()

                    await websocket.send_json({
                        "type": "speech.stopped",
                        "timestamp": interruption_state["last_speech_stop"]
                    })
                    continue

                if msg_type == "conversation.interrupted":
                    interruption_state["interruption_count"] += 1
                    interruption_state["last_interruption_time"] = time.time()

                    await openai_client.handle_interruption()

                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)

                    await websocket.send_json({
                        "type": "conversation.interrupted",
                        "timestamp": interruption_state["last_interruption_time"],
                        "interruption_count": interruption_state["interruption_count"]
                    })
                    continue

                if msg_type == "response.cancelled":
                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)

                    await websocket.send_json({
                        "type": "response.cancelled",
                        "timestamp": time.time()
                    })
                    continue

                # Error handling
                if msg_type == "error":
                    log_to_render(f"❌ OpenAI API Error: {json.dumps(response_data, ensure_ascii=False)}", "ERROR")
                    await websocket.send_json(response_data)
                    continue

                # Audio output
                if msg_type == "response.output_audio.delta":
                    if not interruption_state["is_assistant_speaking"]:
                        response_id = response_data.get("response_id", f"resp_{time.time()}")
                        interruption_state["is_assistant_speaking"] = True
                        openai_client.set_assistant_speaking(True, response_id)

                        await websocket.send_json({
                            "type": "assistant.speech.started",
                            "response_id": response_id,
                            "timestamp": time.time()
                        })

                    delta_audio = response_data.get("delta", "")
                    if delta_audio:
                        sample_count = len(base64.b64decode(delta_audio)) // 2
                        openai_client.increment_audio_samples(sample_count)

                if msg_type == "response.output_audio.done":
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)

                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })

                # Text output
                if msg_type == "response.output_text.delta":
                    delta_text = response_data.get("delta", "")
                    if delta_text:
                        await websocket.send_json({
                            "type": "response.text.delta",
                            "delta": delta_text
                        })

                if msg_type == "response.output_text.done":
                    await websocket.send_json({
                        "type": "response.text.done"
                    })

                # Function execution events
                if msg_type == "response.function_call.started":
                    function_name = response_data.get("function_name") or response_data.get("name")
                    function_call_id = response_data.get("call_id")

                    if function_name:
                        normalized_name = normalize_function_name(function_name)

                        if normalized_name not in openai_client.enabled_functions:
                            error_response = {
                                "type": "function_call.error",
                                "function": normalized_name,
                                "error": f"Function {function_name} not activated"
                            }
                            await websocket.send_json(error_response)

                            if function_call_id:
                                dummy_result = {
                                    "error": f"Function {normalized_name} not allowed",
                                    "status": "error"
                                }
                                await openai_client.send_function_result(function_call_id, dummy_result)
                            continue

                        pending_function_call = {
                            "name": normalized_name,
                            "call_id": function_call_id,
                            "arguments_buffer": ""
                        }

                        if function_call_id:
                            function_calls_map[function_call_id] = {
                                "name": normalized_name,
                                "original_name": function_name,
                                "status": "started",
                                "timestamp": time.time()
                            }

                        await websocket.send_json({
                            "type": "function_call.started",
                            "function": normalized_name,
                            "function_call_id": function_call_id
                        })

                elif msg_type == "response.function_call_arguments.delta":
                    delta = response_data.get("delta", "")
                    call_id = response_data.get("call_id")

                    function_name = response_data.get("name") or response_data.get("function_name")

                    if function_name and not pending_function_call["name"]:
                        normalized_name = normalize_function_name(function_name)
                        pending_function_call["name"] = normalized_name

                        if call_id:
                            function_calls_map[call_id] = {
                                "name": normalized_name,
                                "original_name": function_name,
                                "status": "streaming",
                                "timestamp": time.time()
                            }

                    if call_id and not pending_function_call["call_id"]:
                        pending_function_call["call_id"] = call_id

                    pending_function_call["arguments_buffer"] += delta

                # 🔥🔥🔥 v2.12.3: ASYNC FUNCTION EXECUTION + LOGGING (FIXED)
                elif msg_type == "response.function_call_arguments.done":
                    # Multi-source detection strategy
                    function_name = response_data.get("function_name") or response_data.get("name")
                    function_call_id = response_data.get("call_id")
                    arguments_str = response_data.get("arguments", "")

                    if not function_name:
                        function_name = pending_function_call.get("name")

                    if not function_call_id:
                        function_call_id = pending_function_call.get("call_id")

                    if not arguments_str:
                        arguments_str = pending_function_call.get("arguments_buffer", "")

                    if not function_name and function_call_id and function_call_id in function_calls_map:
                        function_name = function_calls_map[function_call_id]["name"]

                    if not function_name and len(openai_client.enabled_functions) == 1:
                        function_name = openai_client.enabled_functions[0]

                    if not function_name:
                        log_to_render(f"❌ CRITICAL: Cannot determine function name!", "ERROR")

                        await websocket.send_json({
                            "type": "function_call.error",
                            "error": "Cannot determine function name",
                            "call_id": function_call_id
                        })

                        pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}
                        continue

                    if not function_call_id:
                        log_to_render(f"❌ Missing call_id in response", "ERROR")
                        pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}
                        continue

                    normalized_name = normalize_function_name(function_name) or function_name

                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        error_response = {
                            "type": "function_call.error",
                            "function": normalized_name,
                            "error": f"Function {function_name} not activated"
                        }
                        await websocket.send_json(error_response)

                        if function_call_id:
                            dummy_result = {
                                "error": f"Function {normalized_name} not allowed",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)

                        pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}
                        continue

                    # Parse arguments
                    try:
                        arguments = json.loads(arguments_str)

                        await websocket.send_json({
                            "type": "function_call.executing",
                            "function": normalized_name,
                            "function_call_id": function_call_id,
                            "arguments": arguments,
                            "async_execution": True
                        })

                        function_execution_count += 1

                        # 🚀 Launch function execution in background (NON-BLOCKING!)
                        asyncio.create_task(
                            execute_and_send_function_result(
                                openai_client=openai_client,
                                websocket=websocket,
                                function_call_id=function_call_id,
                                function_name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": openai_client.assistant_config,
                                    "client_id": openai_client.client_id,
                                    "db_session": openai_client.db_session,
                                    "websocket": websocket
                                },
                                user_transcript=user_transcript
                            )
                        )

                        # v2.12.2: Mark that this response has function call
                        response_had_function_call = True

                    except json.JSONDecodeError as e:
                        log_to_render(f"❌ Function args parse error: {e}", "ERROR")
                        await websocket.send_json({
                            "type": "error",
                            "error": {"code": "function_args_error", "message": str(e)}
                        })
                    except Exception as e:
                        log_to_render(f"❌ Function setup ERROR: {e}", "ERROR")
                        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                        await websocket.send_json({
                            "type": "error",
                            "error": {"code": "function_setup_error", "message": str(e)}
                        })

                    # Clear pending
                    pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}

                    # Update map status
                    if function_call_id in function_calls_map:
                        function_calls_map[function_call_id]["status"] = "executing_async"

                elif msg_type == "response.content_part.added":
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text

                # Transcripts
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")

                # Transcript events
                if msg_type == "response.audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text

                if msg_type == "response.audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript

                # Convert audio delta for client
                if msg_type == "response.output_audio.delta":
                    await websocket.send_json({
                        "type": "response.audio.delta",
                        "delta": response_data.get("delta", "")
                    })
                    continue

                # ============================================================================
                # v2.12.3: RESPONSE DONE - Save dialog
                # ============================================================================
                if msg_type == "response.done":
                    # Wait for transcripts
                    if not user_transcript and not last_user_transcript:
                        await asyncio.sleep(0.5)

                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)

                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })

                    # Determine effective user message for saving
                    effective_user_transcript = user_transcript

                    # If user_transcript is empty but we have last_user_transcript
                    if not effective_user_transcript and last_user_transcript:
                        effective_user_transcript = last_user_transcript

                    # Save conversation if we have assistant response
                    if effective_user_transcript and assistant_transcript:
                        asyncio.create_task(
                            async_save_dialog_to_db(
                                str(openai_client.assistant_config.id),
                                effective_user_transcript,
                                assistant_transcript,
                                openai_client.session_id
                            )
                        )

                        # Google Sheets logging (async, non-blocking)
                        if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                            asyncio.create_task(
                                async_save_to_google_sheets(
                                    sheet_id=openai_client.assistant_config.google_sheet_id,
                                    user_message=effective_user_transcript,
                                    assistant_message=assistant_transcript,
                                    function_result=None,
                                    conversation_id=openai_client.conversation_record_id,
                                    context="Dialog v2.12.3"
                                )
                            )

                    # Save current user_transcript for potential function response
                    if user_transcript:
                        last_user_transcript = user_transcript

                    # Reset transcripts for next turn
                    user_transcript = ""
                    assistant_transcript = ""

                    # Reset function call flag for next response
                    response_had_function_call = False

                # Forward all other messages to client
                await websocket.send_json(response_data)

            except ConnectionClosed as e:
                if await openai_client.reconnect():
                    continue
                else:
                    log_to_render(f"❌ Reconnection to OpenAI failed", "ERROR")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        return
    except Exception as e:
        log_to_render(f"❌ CRITICAL Handler error: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
