"""
🚀 PRODUCTION VERSION 1.4 - Google Gemini Live API Handler
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
ENABLE_DETAILED_LOGGING = True


def log_to_render(message: str, level: str = "INFO"):
    """Force log to Render stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [GEMINI] {level} - {message}"
    print(log_msg, flush=True)
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)


async def handle_gemini_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🚀 PRODUCTION v1.2 - Main WebSocket handler for Gemini Live API
    ✅ Pure Gemini VAD - continuous audio streaming
    ✅ Audio transcription support
    """
    client_id = str(uuid.uuid4())
    gemini_client = None
    connection_start = time.time()
    
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log_to_render(f"🚀 NEW GEMINI CONNECTION INITIATED")
    log_to_render(f"   Client ID: {client_id}")
    log_to_render(f"   Assistant ID: {assistant_id}")
    log_to_render(f"   Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')
        log_to_render(f"📱 User-Agent: {user_agent[:100]}")

    try:
        await websocket.accept()
        log_to_render(f"✅ WebSocket accepted for client {client_id}")

        # Register connection
        active_gemini_connections.setdefault(assistant_id, []).append(websocket)
        log_to_render(f"📝 Active Gemini connections for {assistant_id}: {len(active_gemini_connections.get(assistant_id, []))}")

        # Load assistant
        log_to_render(f"🔍 Loading Gemini assistant: {assistant_id}")
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

        log_to_render(f"✅ Gemini assistant loaded: {getattr(assistant, 'name', assistant_id)}")
        log_to_render(f"   Voice: {getattr(assistant, 'voice', 'Aoede')}")
        log_to_render(f"   Model: gemini-2.5-flash-native-audio-preview-09-2025")
        log_to_render(f"   Thinking enabled: {getattr(assistant, 'enable_thinking', False)}")
        log_to_render(f"   Transcription: ENABLED")

        # Extract enabled functions
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        log_to_render(f"🔧 Functions configuration:")
        log_to_render(f"   Enabled count: {len(enabled_functions)}")
        log_to_render(f"   Functions: {enabled_functions}")

        # Check Google Sheets config
        if hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
            log_to_render(f"📊 Google Sheets logging ENABLED")
            log_to_render(f"   Sheet ID: {assistant.google_sheet_id[:20]}...")
        else:
            log_to_render(f"⚠️ Google Sheets logging DISABLED (no sheet_id)")

        # Check subscription
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                log_to_render(f"👤 User loaded:")
                log_to_render(f"   Email: {user.email}")
                log_to_render(f"   User ID: {user.id}")
                
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    log_to_render(f"💳 Subscription check:")
                    log_to_render(f"   Active: {subscription_status.get('active')}")
                    log_to_render(f"   Trial: {subscription_status.get('is_trial')}")
                    
                    if not subscription_status["active"]:
                        log_to_render(f"❌ Subscription expired for user {user.id}", "WARNING")
                        
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
                if api_key:
                    log_to_render(f"🔑 Gemini API key loaded: {api_key[:10]}...{api_key[-5:]}")
                else:
                    log_to_render(f"⚠️ No Gemini API key for user", "WARNING")
        
        if not api_key:
            log_to_render(f"❌ No Gemini API key available", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Google Gemini API key required"}
            })
            await websocket.close(code=1008)
            return

        # Create Gemini Live client
        log_to_render(f"🚀 Creating Gemini Live client...")
        log_to_render(f"   Client ID: {client_id}")
        log_to_render(f"   API Key: {api_key[:10]}...")
        gemini_client = GeminiLiveClient(api_key, assistant, client_id, db, user_agent)
        
        log_to_render(f"🔌 Connecting to Gemini Live API...")
        connect_start = time.time()
        if not await gemini_client.connect():
            log_to_render(f"❌ Failed to connect to Gemini", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "gemini_connection_failed", "message": "Failed to connect to Gemini"}
            })
            await websocket.close(code=1008)
            return

        connection_time = time.time() - connect_start
        log_to_render(f"✅ Connected to Gemini in {connection_time:.2f}s")

        # Send connection status
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connected to Gemini Live API (Production v1.2 - Transcription)",
            "model": "gemini-2.5-flash-native-audio-preview-09-2025",
            "functions_enabled": len(enabled_functions),
            "google_sheets": bool(getattr(assistant, 'google_sheet_id', None)),
            "thinking_enabled": getattr(assistant, 'enable_thinking', False),
            "transcription_enabled": True,
            "client_id": client_id,
            "vad_mode": "gemini_native"
        })

        # ✅ NO AUDIO BUFFER - continuous streaming
        
        # Interruption state
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        log_to_render(f"🎬 Starting Gemini message handler...")
        # Start Gemini message handler
        gemini_task = asyncio.create_task(
            handle_gemini_messages(gemini_client, websocket, interruption_state)
        )

        # Main client receive loop
        log_to_render(f"🔄 Starting main WebSocket receive loop (continuous streaming mode)...")
        message_count = 0
        audio_chunks_sent = 0
        
        while True:
            try:
                message = await websocket.receive()
                message_count += 1

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if ENABLE_DETAILED_LOGGING and message_count % 10 == 0:
                        log_to_render(f"📨 Client message #{message_count}: {msg_type}")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    if msg_type == "session.update":
                        log_to_render(f"📝 Client session.update received")
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        continue

                    # Screen context handler (silent mode)
                    if msg_type == "screen.context":
                        log_to_render(f"📸 Screen context received (silent mode)")
                        
                        image_data = data.get("image")
                        is_silent = data.get("silent", True)
                        
                        if not image_data:
                            log_to_render(f"❌ No image data in screen.context", "ERROR")
                            continue
                        
                        image_size_kb = len(image_data) // 1024
                        log_to_render(f"📸 Image size: {image_size_kb}KB")
                        log_to_render(f"📸 Silent mode: {is_silent}")
                        
                        if gemini_client.is_connected:
                            success = await gemini_client.send_screen_context(image_data, silent=is_silent)
                            if success:
                                log_to_render(f"✅ Screen context added to conversation")
                            else:
                                log_to_render(f"❌ Failed to send screen context", "ERROR")
                        else:
                            log_to_render(f"❌ Gemini not connected", "ERROR")
                        
                        continue

                    # ✅ PURE GEMINI VAD - continuous audio streaming
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        audio_chunks_sent += 1
                        
                        if gemini_client.is_connected:
                            # ✅ Just send to Gemini - it handles everything
                            await gemini_client.process_audio(audio_chunk)
                        
                        # Send ack
                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack", 
                            "event_id": data.get("event_id")
                        })
                        
                        if audio_chunks_sent % 100 == 0:
                            log_to_render(f"📤 Sent {audio_chunks_sent} audio chunks (continuous stream)")
                        
                        continue

                    # ❌ REMOVED: input_audio_buffer.commit - not needed!
                    # Gemini's VAD handles this automatically
                    
                    # ❌ REMOVED: input_audio_buffer.clear - not needed!
                    # Gemini handles its own buffer

                    if msg_type == "response.cancel":
                        log_to_render(f"🛑 Response cancellation requested")
                        await websocket.send_json({
                            "type": "response.cancel.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    # Interruption handling
                    if msg_type == "interruption.manual":
                        log_to_render(f"⚡ Manual interruption triggered")
                        await gemini_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        log_to_render(f"🔇 Client stopped playback")
                        gemini_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    # Speech events - for logging only
                    if msg_type == "speech.user_started":
                        log_to_render(f"🗣️ User started speaking (UI event)")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        # Check if interrupting assistant
                        if interruption_state["is_assistant_speaking"]:
                            log_to_render(f"⚡ User interrupted assistant!")
                            await gemini_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        log_to_render(f"🤐 User stopped speaking (UI event)")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                elif "bytes" in message:
                    # Binary audio data (if sent this way)
                    audio_chunks_sent += 1
                    if gemini_client.is_connected:
                        await gemini_client.process_audio(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                log_to_render(f"🔌 Client WebSocket disconnected: {client_id}")
                break
            except Exception as e:
                log_to_render(f"❌ Error in WebSocket loop: {e}", "ERROR")
                log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                break

        # Cleanup
        log_to_render(f"🧹 Cleaning up connection...")
        if not gemini_task.done():
            gemini_task.cancel()
            await asyncio.sleep(0)

        session_duration = time.time() - connection_start
        log_to_render(f"📊 Session stats:")
        log_to_render(f"   Duration: {session_duration:.2f}s")
        log_to_render(f"   Messages processed: {message_count}")
        log_to_render(f"   Audio chunks sent: {audio_chunks_sent}")
        log_to_render(f"   Interruptions: {interruption_state['interruption_count']}")
        log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

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
    🚀 PRODUCTION v1.2 - Handle messages from Gemini Live API
    ✅ Complete function calling support
    ✅ Google Sheets logging
    ✅ Database integration
    ✅ Audio transcription support (input + output)
    ✅ Maximum logging for debugging
    """
    if not gemini_client.is_connected or not gemini_client.ws:
        log_to_render(f"❌ Gemini client not connected", "ERROR")
        return
    
    # Transcripts
    user_transcript = ""
    assistant_transcript = ""
    
    # Function tracking
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments": {}
    }
    
    # Metrics
    event_count = 0
    function_execution_count = 0
    transcript_events_received = 0
    
    try:
        log_to_render(f"🎭 Gemini message handler started")
        log_to_render(f"   Client ID: {gemini_client.client_id}")
        log_to_render(f"   Session ID: {gemini_client.session_id}")
        log_to_render(f"   Enabled functions: {gemini_client.enabled_functions}")
        log_to_render(f"   VAD mode: Pure Gemini (automatic)")
        log_to_render(f"   Transcription: ENABLED")
        
        while True:
            try:
                raw = await gemini_client.ws.recv()
                event_count += 1
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    log_to_render(f"❌ JSON decode error: {raw[:200]}", "ERROR")
                    continue
                
                # Detailed logging
                should_log = (
                    ENABLE_DETAILED_LOGGING and (
                        event_count % 20 == 0 or
                        "toolCall" in response_data or
                        "serverContent" in response_data
                    )
                )
                
                if should_log:
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_to_render(f"📡 Gemini Event #{event_count}")
                    log_to_render(f"   Keys: {list(response_data.keys())}")
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                
                # Setup complete
                if "setupComplete" in response_data:
                    log_to_render(f"✅ Gemini setup complete (transcription enabled)")
                    await websocket.send_json({
                        "type": "gemini.setup.complete",
                        "timestamp": time.time(),
                        "transcription_enabled": True
                    })
                    continue
                
                # ✅ Tool Call event (top-level, outside serverContent)
                if "toolCall" in response_data:
                    tool_call = response_data["toolCall"]
                    function_calls = tool_call.get("functionCalls", [])
                    
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_to_render(f"🔧 TOOL CALL EVENT (top-level)")
                    log_to_render(f"   Function calls: {len(function_calls)}")
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    
                    for func_call in function_calls:
                        function_name = func_call.get("name")
                        function_id = func_call.get("id")
                        arguments = func_call.get("args", {})
                        
                        log_to_render(f"📞 Function: {function_name}")
                        log_to_render(f"   ID: {function_id}")
                        log_to_render(f"   Args: {json.dumps(arguments, ensure_ascii=False)[:200]}")
                        
                        # Store pending call
                        pending_function_call = {
                            "name": function_name,
                            "call_id": function_id,
                            "arguments": arguments
                        }
                        
                        # Execute immediately
                        try:
                            start_time = time.time()
                            normalized_name = normalize_function_name(function_name)
                            
                            log_to_render(f"⚙️ Executing function: {normalized_name}")
                            
                            # ✅ Установка last_function_name для send_function_result
                            gemini_client.last_function_name = normalized_name
                            
                            # ✅ execute_function с правильной сигнатурой
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
                            
                            execution_time = time.time() - start_time
                            function_execution_count += 1
                            
                            log_to_render(f"✅ Function executed: {execution_time:.3f}s")
                            
                            # Send result to Gemini (используем позиционные аргументы как в основном коде)
                            log_to_render(f"📤 Sending function result to Gemini...")
                            delivery_status = await gemini_client.send_function_result(
                                function_id,  # call_id
                                result
                            )
                            
                            if delivery_status and delivery_status.get("success"):
                                log_to_render(f"✅ Result delivered to Gemini")
                                
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
                            log_to_render(f"❌ Function execution error: {e}", "ERROR")
                            log_to_render(f"   Traceback: {traceback.format_exc()}", "ERROR")
                            
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })
                    
                    continue
                
                # Server content (main response container)
                if "serverContent" in response_data:
                    server_content = response_data["serverContent"]
                    
                    # ✅ ТРАНСКРИПЦИЯ ВХОДЯЩЕГО АУДИО (пользователя)
                    if "inputTranscription" in server_content:
                        input_trans = server_content["inputTranscription"]
                        if "text" in input_trans:
                            transcript_text = input_trans["text"]
                            user_transcript += transcript_text
                            transcript_events_received += 1
                            log_to_render(f"👤 USER TRANSCRIPT: {transcript_text}")
                            
                            await websocket.send_json({
                                "type": "input.transcription",
                                "text": transcript_text
                            })
                    
                    # ✅ ТРАНСКРИПЦИЯ ОТВЕТА МОДЕЛИ (ассистента)
                    if "outputTranscription" in server_content:
                        output_trans = server_content["outputTranscription"]
                        if "text" in output_trans:
                            transcript_text = output_trans["text"]
                            assistant_transcript += transcript_text
                            transcript_events_received += 1
                            log_to_render(f"🤖 ASSISTANT TRANSCRIPT: {transcript_text}")
                            
                            await websocket.send_json({
                                "type": "output.transcription",
                                "text": transcript_text
                            })
                    
                    # Check for interruption
                    if server_content.get("interrupted"):
                        log_to_render(f"⚡ Conversation interrupted by Gemini")
                        interruption_state["interruption_count"] += 1
                        interruption_state["last_interruption_time"] = time.time()
                        interruption_state["is_assistant_speaking"] = False
                        gemini_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "conversation.interrupted",
                            "timestamp": interruption_state["last_interruption_time"]
                        })
                        continue
                    
                    # Model turn
                    if "modelTurn" in server_content:
                        model_turn = server_content["modelTurn"]
                        parts = model_turn.get("parts", [])
                        
                        for part in parts:
                            # Text content (может быть дополнительно)
                            if "text" in part:
                                text = part["text"]
                                # Не добавляем в assistant_transcript - уже есть из outputTranscription
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
                                        log_to_render(f"🔊 Assistant started speaking")
                                        interruption_state["is_assistant_speaking"] = True
                                        gemini_client.set_assistant_speaking(True)
                                        
                                        await websocket.send_json({
                                            "type": "assistant.speech.started",
                                            "timestamp": time.time()
                                        })
                                    
                                    # Send audio delta
                                    await websocket.send_json({
                                        "type": "response.audio.delta",
                                        "delta": data
                                    })
                                    
                                    # Count samples
                                    sample_count = len(base64.b64decode(data)) // 2
                                    gemini_client.increment_audio_samples(sample_count)
                            
                            # Function call (tool call)
                            if "functionCall" in part:
                                function_call = part["functionCall"]
                                function_name = function_call.get("name")
                                arguments = function_call.get("args", {})
                                
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                log_to_render(f"🔧 FUNCTION CALL DETECTED")
                                log_to_render(f"   Function: {function_name}")
                                log_to_render(f"   Arguments: {json.dumps(arguments, ensure_ascii=False)[:200]}")
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                
                                normalized_name = normalize_function_name(function_name) or function_name
                                
                                if normalized_name not in gemini_client.enabled_functions:
                                    log_to_render(f"❌ UNAUTHORIZED function: {normalized_name}", "WARNING")
                                    
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
                                try:
                                    await websocket.send_json({
                                        "type": "function_call.executing",
                                        "function": normalized_name,
                                        "function_call_id": pending_function_call["call_id"],
                                        "arguments": arguments
                                    })
                                    
                                    log_to_render(f"🚀 EXECUTING FUNCTION: {normalized_name}")
                                    start_time = time.time()
                                    
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
                                    
                                    execution_time = time.time() - start_time
                                    function_execution_count += 1
                                    
                                    log_to_render(f"✅ FUNCTION EXECUTED SUCCESSFULLY")
                                    log_to_render(f"   Execution time: {execution_time:.3f}s")
                                    
                                    # Fast display for query_llm
                                    if normalized_name == "query_llm":
                                        log_to_render(f"⚡ QUERY_LLM - sending result IMMEDIATELY")
                                        
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
                                    
                                    # Save to DB
                                    if gemini_client.db_session and gemini_client.conversation_record_id:
                                        try:
                                            conv = gemini_client.db_session.query(GeminiConversation).get(
                                                uuid.UUID(gemini_client.conversation_record_id)
                                            )
                                            if conv:
                                                function_summary = f"[Function: {normalized_name}] Result: {json.dumps(result, ensure_ascii=False)[:200]}"
                                                conv.assistant_message = function_summary
                                                if user_transcript and not conv.user_message:
                                                    conv.user_message = user_transcript
                                                gemini_client.db_session.commit()
                                                log_to_render(f"✅ DATABASE UPDATE SUCCESSFUL")
                                        except Exception as e:
                                            log_to_render(f"❌ DB save error: {e}", "ERROR")
                                    
                                    # Google Sheets logging for function calls
                                    if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                        sheet_id = gemini_client.assistant_config.google_sheet_id
                                        
                                        try:
                                            sheets_result = await GoogleSheetsService.log_conversation(
                                                sheet_id=sheet_id,
                                                user_message=user_transcript or f"[Function call: {normalized_name}]",
                                                assistant_message=f"[Function executed: {normalized_name}]",
                                                function_result=result,
                                                conversation_id=gemini_client.conversation_record_id
                                            )
                                            
                                            if sheets_result:
                                                log_to_render(f"✅ Google Sheets logged (function call)")
                                            else:
                                                log_to_render(f"❌ Google Sheets failed", "WARNING")
                                        except Exception as e:
                                            log_to_render(f"❌ Sheets error: {e}", "ERROR")
                                    
                                    # Send result to Gemini
                                    log_to_render(f"📤 Sending function result to Gemini...")
                                    delivery_status = await gemini_client.send_function_result(
                                        pending_function_call["call_id"], 
                                        result
                                    )
                                    
                                    if delivery_status["success"]:
                                        log_to_render(f"✅ Function result delivered")
                                        
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
                                    log_to_render(f"❌ Function execution ERROR: {e}", "ERROR")
                                    log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                                    
                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {"code": "function_execution_error", "message": str(e)}
                                    })
                                
                                # Clear pending
                                pending_function_call = {"name": None, "call_id": None, "arguments": {}}
                        
                        # Turn complete
                        if server_content.get("turnComplete"):
                            log_to_render(f"🏁 Turn complete")
                            log_to_render(f"📊 TRANSCRIPTS - User: {len(user_transcript)} chars | Assistant: {len(assistant_transcript)} chars")
                            
                            if interruption_state["is_assistant_speaking"]:
                                interruption_state["is_assistant_speaking"] = False
                                gemini_client.set_assistant_speaking(False)
                                
                                await websocket.send_json({
                                    "type": "assistant.speech.ended",
                                    "timestamp": time.time()
                                })
                            
                            # ✅ ЛОГИРОВАНИЕ С ТРАНСКРИПТАМИ
                            # Изменено условие: логируем если хотя бы один транскрипт не пустой
                            if user_transcript or assistant_transcript:
                                final_user = user_transcript or "[Voice input - no text transcript]"
                                final_assistant = assistant_transcript or "[Voice response - no text transcript]"
                                
                                log_to_render(f"💾 Saving dialog with transcripts")
                                log_to_render(f"   User: {final_user[:100]}...")
                                log_to_render(f"   Assistant: {final_assistant[:100]}...")
                                
                                # Save to DB
                                try:
                                    await ConversationService.save_conversation(
                                        db=gemini_client.db_session,
                                        assistant_id=str(gemini_client.assistant_config.id),
                                        user_message=final_user,
                                        assistant_message=final_assistant,
                                        session_id=gemini_client.session_id,
                                        caller_number=None,
                                        tokens_used=0
                                    )
                                    log_to_render(f"✅ Dialog saved to DB")
                                except Exception as e:
                                    log_to_render(f"❌ Error saving dialog: {e}", "ERROR")
                                
                                # ✅ Google Sheets logging for regular dialog
                                if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                    log_to_render(f"📊 Attempting Google Sheets log...")
                                    log_to_render(f"   Sheet ID: {gemini_client.assistant_config.google_sheet_id[:20]}...")
                                    
                                    try:
                                        sheets_result = await GoogleSheetsService.log_conversation(
                                            sheet_id=gemini_client.assistant_config.google_sheet_id,
                                            user_message=final_user,
                                            assistant_message=final_assistant,
                                            function_result=None,
                                            conversation_id=gemini_client.conversation_record_id
                                        )
                                        
                                        if sheets_result:
                                            log_to_render(f"✅ ✅ ✅ GOOGLE SHEETS LOGGED SUCCESSFULLY ✅ ✅ ✅")
                                        else:
                                            log_to_render(f"❌ Google Sheets returned False", "ERROR")
                                    except Exception as e:
                                        log_to_render(f"❌ Sheets error: {e}", "ERROR")
                                        log_to_render(f"   Traceback: {traceback.format_exc()}", "ERROR")
                                else:
                                    log_to_render(f"⚠️ Skipping Sheets: no google_sheet_id configured", "WARNING")
                            else:
                                log_to_render(f"⚠️ Skipping dialog save: both transcripts empty", "WARNING")
                            
                            # Reset transcripts
                            user_transcript = ""
                            assistant_transcript = ""
                
                # User transcript from clientContent (если есть)
                if "clientContent" in response_data:
                    client_content = response_data["clientContent"]
                    turns = client_content.get("turns", [])
                    
                    for turn in turns:
                        parts = turn.get("parts", [])
                        for part in parts:
                            if "text" in part:
                                # Уже обрабатывается через inputTranscription
                                log_to_render(f"👤 CLIENT CONTENT TEXT: {part['text']}")

            except ConnectionClosed as e:
                log_to_render(f"⚠️ Gemini connection closed: {e}", "WARNING")
                if await gemini_client.reconnect():
                    log_to_render(f"✅ Reconnected to Gemini")
                    continue
                else:
                    log_to_render(f"❌ Reconnection failed", "ERROR")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "gemini_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        log_to_render(f"👋 Handler terminated for {gemini_client.client_id}")
        return
    except Exception as e:
        log_to_render(f"❌ CRITICAL Handler error: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
    finally:
        # ✅ РЕЗЕРВНОЕ ЛОГИРОВАНИЕ если есть несохранённые транскрипты
        if (user_transcript or assistant_transcript) and gemini_client.assistant_config:
            log_to_render(f"💾 FINAL SAVE: Found unsaved transcripts on disconnect")
            log_to_render(f"   User: {len(user_transcript)} chars")
            log_to_render(f"   Assistant: {len(assistant_transcript)} chars")
            
            final_user = user_transcript or "[Voice input - no text transcript]"
            final_assistant = assistant_transcript or "[Voice response - incomplete]"
            
            # Save to DB
            try:
                await ConversationService.save_conversation(
                    db=gemini_client.db_session,
                    assistant_id=str(gemini_client.assistant_config.id),
                    user_message=final_user,
                    assistant_message=final_assistant,
                    session_id=gemini_client.session_id,
                    caller_number=None,
                    tokens_used=0
                )
                log_to_render(f"✅ Final transcripts saved to DB")
            except Exception as e:
                log_to_render(f"❌ Final DB save error: {e}", "ERROR")
            
            # Save to Google Sheets
            if gemini_client.assistant_config.google_sheet_id:
                try:
                    sheets_result = await GoogleSheetsService.log_conversation(
                        sheet_id=gemini_client.assistant_config.google_sheet_id,
                        user_message=final_user,
                        assistant_message=final_assistant,
                        function_result=None,
                        conversation_id=gemini_client.conversation_record_id
                    )
                    
                    if sheets_result:
                        log_to_render(f"✅ Final transcripts saved to Google Sheets")
                    else:
                        log_to_render(f"❌ Final Sheets save failed", "ERROR")
                except Exception as e:
                    log_to_render(f"❌ Final Sheets error: {e}", "ERROR")
        
        log_to_render(f"📊 Final handler stats:")
        log_to_render(f"   Total events processed: {event_count}")
        log_to_render(f"   Functions executed: {function_execution_count}")
        log_to_render(f"   Transcript events received: {transcript_events_received}")
