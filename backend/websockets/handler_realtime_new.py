# backend/websockets/handler_realtime_new.py
"""
🔍 ENHANCED LOGGING VERSION - OpenAI Realtime API Handler
Maximum logging for production debugging and investor demo monitoring
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
active_connections_new: Dict[str, List[WebSocket]] = {}


def log_to_render(message: str, level: str = "INFO"):
    """Force log to Render stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [REALTIME-GA] {level} - {message}"
    print(log_msg, flush=True)  # Force flush to stdout
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)


async def handle_websocket_connection_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🔍 ENHANCED LOGGING - Main WebSocket handler
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    connection_start = time.time()
    
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log_to_render(f"🚀 NEW CONNECTION INITIATED")
    log_to_render(f"   Client ID: {client_id}")
    log_to_render(f"   Assistant ID: {assistant_id}")
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')
        log_to_render(f"📱 User-Agent: {user_agent[:100]}")

    try:
        await websocket.accept()
        log_to_render(f"✅ WebSocket accepted for client {client_id}")

        # Check for ElevenLabs agents
        elevenlabs_agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == assistant_id
        ).first()
        if elevenlabs_agent:
            log_to_render(f"🔊 ElevenLabs agent detected: {assistant_id}")
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
        log_to_render(f"📝 Active connections for {assistant_id}: {len(active_connections_new.get(assistant_id, []))}")

        # Load assistant
        log_to_render(f"🔍 Loading assistant: {assistant_id}")
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

        log_to_render(f"✅ Assistant loaded: {getattr(assistant, 'name', assistant_id)}")

        # Extract enabled functions
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        log_to_render(f"🔧 Functions enabled ({len(enabled_functions)}): {enabled_functions}")

        # Check Google Sheets config
        if hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
            log_to_render(f"📊 Google Sheets logging ENABLED: {assistant.google_sheet_id[:20]}...")
        else:
            log_to_render(f"⚠️ Google Sheets logging DISABLED (no sheet_id)")

        # Check subscription
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                log_to_render(f"👤 User loaded: {user.email}")
                
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    log_to_render(f"💳 Subscription check: active={subscription_status.get('active')}, trial={subscription_status.get('is_trial')}")
                    
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
                
                api_key = user.openai_api_key
                if api_key:
                    log_to_render(f"🔑 API key loaded: {api_key[:10]}...{api_key[-5:]}")
                else:
                    log_to_render(f"⚠️ No API key for user", "WARNING")
        
        if not api_key:
            log_to_render(f"❌ No API key available", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "OpenAI API key required"}
            })
            await websocket.close(code=1008)
            return

        # Create OpenAI Realtime client
        log_to_render(f"🚀 Creating OpenAI Realtime client...")
        openai_client = OpenAIRealtimeClientNew(api_key, assistant, client_id, db, user_agent)
        
        log_to_render(f"🔌 Connecting to OpenAI GA API...")
        connect_start = time.time()
        if not await openai_client.connect():
            log_to_render(f"❌ Failed to connect to OpenAI", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        connection_time = time.time() - connect_start
        log_to_render(f"✅ Connected to OpenAI in {connection_time:.2f}s")

        # Send connection status
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connected to Realtime API (GA version with enhanced logging)",
            "model": "gpt-realtime-mini",
            "functions_enabled": len(enabled_functions),
            "google_sheets": bool(getattr(assistant, 'google_sheet_id', None))
        })

        # Audio buffer
        audio_buffer = bytearray()
        is_processing = False
        
        # Interruption state
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        log_to_render(f"🎬 Starting OpenAI message handler...")
        # Start OpenAI message handler
        openai_task = asyncio.create_task(
            handle_openai_messages_new(openai_client, websocket, interruption_state)
        )

        # Main client receive loop
        log_to_render(f"🔄 Starting main WebSocket receive loop...")
        message_count = 0
        while True:
            try:
                message = await websocket.receive()
                message_count += 1

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if msg_type != "ping" and message_count % 10 == 0:  # Log every 10th message
                        log_to_render(f"📨 Client message #{message_count}: {msg_type}")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    if msg_type == "session.update":
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        continue

                    # Audio processing
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        audio_buffer.extend(audio_chunk)
                        
                        if openai_client.is_connected:
                            await openai_client.process_audio(audio_chunk)
                        
                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "input_audio_buffer.commit" and not is_processing:
                        is_processing = True
                        log_to_render(f"📤 Committing audio buffer: {len(audio_buffer)} bytes")
                        
                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({
                                "type": "input_audio_buffer.commit.ack", 
                                "event_id": data.get("event_id")
                            })
                        else:
                            log_to_render(f"⚠️ OpenAI not connected, attempting reconnect...", "WARNING")
                            if await openai_client.reconnect():
                                await openai_client.commit_audio()
                                await websocket.send_json({
                                    "type": "input_audio_buffer.commit.ack", 
                                    "event_id": data.get("event_id")
                                })
                            else:
                                log_to_render(f"❌ Reconnection failed", "ERROR")
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {"code": "openai_not_connected", "message": "Connection lost"}
                                })

                        audio_buffer.clear()
                        is_processing = False
                        continue

                    if msg_type == "input_audio_buffer.clear":
                        log_to_render(f"🗑️ Clearing audio buffer")
                        audio_buffer.clear()
                        if openai_client.is_connected:
                            await openai_client.clear_audio_buffer()
                        await websocket.send_json({
                            "type": "input_audio_buffer.clear.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue

                    if msg_type == "response.cancel":
                        log_to_render(f"🛑 Response cancellation requested")
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
                        log_to_render(f"⚡ Manual interruption triggered")
                        await openai_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        log_to_render(f"🔇 Client stopped playback")
                        openai_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    if msg_type == "speech.user_started":
                        log_to_render(f"🗣️ User started speaking")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        if interruption_state["is_assistant_speaking"]:
                            log_to_render(f"⚡ User interrupted assistant!")
                            await openai_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        log_to_render(f"🤐 User stopped speaking")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                elif "bytes" in message:
                    audio_buffer.extend(message["bytes"])
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
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)

        session_duration = time.time() - connection_start
        log_to_render(f"📊 Session stats:")
        log_to_render(f"   Duration: {session_duration:.2f}s")
        log_to_render(f"   Messages processed: {message_count}")
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
    🔍 ENHANCED LOGGING - Handle messages from OpenAI
    """
    if not openai_client.is_connected or not openai_client.ws:
        log_to_render(f"❌ OpenAI client not connected", "ERROR")
        return
    
    # Transcripts
    user_transcript = ""
    assistant_transcript = ""
    
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
        log_to_render(f"🎭 OpenAI message handler started for {openai_client.client_id}")
        
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
                
                # Log important events
                if msg_type in [
                    "input_audio_buffer.speech_started",
                    "input_audio_buffer.speech_stopped",
                    "conversation.interrupted",
                    "response.function_call.started",
                    "response.function_call_arguments.done",
                    "response.done",
                    "error"
                ]:
                    log_to_render(f"📡 OpenAI Event #{event_count}: {msg_type}")
                
                # VAD events
                if msg_type == "input_audio_buffer.speech_started":
                    log_to_render(f"🎤 VAD: User speech detected")
                    interruption_state["is_user_speaking"] = True
                    interruption_state["last_speech_start"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.started",
                        "timestamp": interruption_state["last_speech_start"]
                    })
                    continue
                
                if msg_type == "input_audio_buffer.speech_stopped":
                    log_to_render(f"🤐 VAD: User speech ended")
                    interruption_state["is_user_speaking"] = False
                    interruption_state["last_speech_stop"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.stopped",
                        "timestamp": interruption_state["last_speech_stop"]
                    })
                    continue
                
                if msg_type == "conversation.interrupted":
                    log_to_render(f"⚡ Conversation interrupted by OpenAI")
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
                    log_to_render(f"🚫 Response cancelled")
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
                        log_to_render(f"🔊 Assistant started speaking: {response_id}")
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
                    log_to_render(f"🔇 Assistant stopped speaking")
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
                
                # 🔍 ENHANCED: Function execution with detailed logging
                if msg_type == "response.function_call.started":
                    function_name = response_data.get("function_name")
                    function_call_id = response_data.get("call_id")
                    
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_to_render(f"🔧 FUNCTION CALL STARTED")
                    log_to_render(f"   Function: {function_name}")
                    log_to_render(f"   Call ID: {function_call_id}")
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    log_to_render(f"🔄 Normalized name: {normalized_name}")
                    
                    if normalized_name not in openai_client.enabled_functions:
                        log_to_render(f"❌ UNAUTHORIZED function: {normalized_name}", "WARNING")
                        log_to_render(f"   Allowed functions: {openai_client.enabled_functions}", "WARNING")
                        
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
                    
                    await websocket.send_json({
                        "type": "function_call.started",
                        "function": normalized_name,
                        "function_call_id": function_call_id
                    })
                
                elif msg_type == "response.function_call_arguments.delta":
                    delta = response_data.get("delta", "")
                    
                    if not pending_function_call["name"] and "call_id" in response_data:
                        pending_function_call["call_id"] = response_data.get("call_id")
                    
                    pending_function_call["arguments_buffer"] += delta
                
                elif msg_type == "response.function_call_arguments.done":
                    arguments_str = response_data.get("arguments", pending_function_call["arguments_buffer"])
                    function_name = response_data.get("function_name", pending_function_call["name"])
                    function_call_id = response_data.get("call_id", pending_function_call["call_id"])
                    
                    log_to_render(f"📋 Function arguments received")
                    log_to_render(f"   Arguments: {arguments_str[:200]}...")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        log_to_render(f"❌ UNAUTHORIZED function in done: {normalized_name}", "WARNING")
                        
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
                    
                    if function_call_id and normalized_name:
                        try:
                            arguments = json.loads(arguments_str)
                            log_to_render(f"✅ Arguments parsed successfully")
                            
                            await websocket.send_json({
                                "type": "function_call.executing",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "arguments": arguments
                            })
                            
                            log_to_render(f"🚀 EXECUTING FUNCTION: {normalized_name}")
                            start_time = time.time()
                            
                            # Execute function
                            result = await execute_function(
                                name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": openai_client.assistant_config,
                                    "client_id": openai_client.client_id,
                                    "db_session": openai_client.db_session
                                }
                            )
                            
                            execution_time = time.time() - start_time
                            function_execution_count += 1
                            
                            log_to_render(f"✅ FUNCTION EXECUTED SUCCESSFULLY")
                            log_to_render(f"   Execution time: {execution_time:.3f}s")
                            log_to_render(f"   Result type: {type(result)}")
                            log_to_render(f"   Result preview: {str(result)[:200]}...")
                            
                            # 🔍 ENHANCED: Immediate logging with detailed output
                            log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                            log_to_render(f"💾 STARTING IMMEDIATE LOGGING")
                            log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                            
                            try:
                                # Save to database
                                if openai_client.db_session and openai_client.conversation_record_id:
                                    log_to_render(f"💾 Attempting database save...")
                                    conv = openai_client.db_session.query(Conversation).get(
                                        uuid.UUID(openai_client.conversation_record_id)
                                    )
                                    if conv:
                                        function_summary = f"[Function: {normalized_name}] Result: {json.dumps(result, ensure_ascii=False)[:200]}"
                                        conv.assistant_message = function_summary
                                        if user_transcript and not conv.user_message:
                                            conv.user_message = user_transcript
                                        openai_client.db_session.commit()
                                        log_to_render(f"✅ DATABASE SAVE SUCCESSFUL")
                                        log_to_render(f"   Conversation ID: {openai_client.conversation_record_id}")
                                    else:
                                        log_to_render(f"⚠️ Conversation record not found in DB", "WARNING")
                                else:
                                    log_to_render(f"⚠️ No DB session or conversation_record_id", "WARNING")
                                
                                # Save to Google Sheets
                                if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                                    sheet_id = openai_client.assistant_config.google_sheet_id
                                    log_to_render(f"📊 Attempting Google Sheets save...")
                                    log_to_render(f"   Sheet ID: {sheet_id[:20]}...")
                                    log_to_render(f"   User message: {(user_transcript or f'[Function: {normalized_name}]')[:50]}...")
                                    log_to_render(f"   Assistant message: [Function executed: {normalized_name}]")
                                    log_to_render(f"   Function result keys: {list(result.keys()) if isinstance(result, dict) else type(result)}")
                                    
                                    sheets_start = time.time()
                                    sheets_result = await GoogleSheetsService.log_conversation(
                                        sheet_id=sheet_id,
                                        user_message=user_transcript or f"[Function call: {normalized_name}]",
                                        assistant_message=f"[Function executed: {normalized_name}]",
                                        function_result=result
                                    )
                                    sheets_time = time.time() - sheets_start
                                    
                                    if sheets_result:
                                        log_to_render(f"✅ GOOGLE SHEETS SAVE SUCCESSFUL (took {sheets_time:.3f}s)")
                                    else:
                                        log_to_render(f"❌ GOOGLE SHEETS SAVE FAILED (took {sheets_time:.3f}s)", "WARNING")
                                else:
                                    log_to_render(f"⚠️ Google Sheets not configured for this assistant", "WARNING")
                                
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                log_to_render(f"✅ LOGGING COMPLETE")
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                
                            except Exception as log_error:
                                log_to_render(f"❌ LOGGING ERROR: {log_error}", "ERROR")
                                log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                            
                            # Send result to OpenAI
                            log_to_render(f"📤 Sending function result to OpenAI...")
                            delivery_status = await openai_client.send_function_result(function_call_id, result)
                            
                            if not delivery_status["success"]:
                                log_to_render(f"❌ Function result delivery FAILED: {delivery_status['error']}", "ERROR")
                                
                                error_message = {
                                    "type": "function_call.delivery_error",
                                    "function_call_id": function_call_id,
                                    "error": delivery_status['error']
                                }
                                await websocket.send_json(error_message)
                            else:
                                log_to_render(f"✅ Function result delivered to OpenAI")
                                log_to_render(f"⏳ Waiting for model to continue automatically...")
                                
                                await websocket.send_json({
                                    "type": "function_call.completed",
                                    "function": normalized_name,
                                    "function_call_id": function_call_id,
                                    "result": result,
                                    "execution_time": execution_time
                                })
                            
                        except json.JSONDecodeError as e:
                            log_to_render(f"❌ Function args parse error: {e}", "ERROR")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_args_error", "message": str(e)}
                            })
                        except Exception as e:
                            log_to_render(f"❌ Function execution ERROR: {e}", "ERROR")
                            log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })
                    
                    pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}

                elif msg_type == "response.content_part.added":
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text
                        log_to_render(f"📝 Assistant text content: {new_text[:100]}...")
                
                # Transcripts
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        log_to_render(f"👤 USER TRANSCRIPT: {user_transcript}")
                        
                        # Save user message immediately
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv and not conv.user_message:
                                    conv.user_message = user_transcript
                                    openai_client.db_session.commit()
                                    log_to_render(f"💾 User transcript saved to DB")
                            except Exception as e:
                                log_to_render(f"❌ DB save error: {e}", "ERROR")
                
                if msg_type == "response.output_audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text
                
                if msg_type == "response.output_audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        log_to_render(f"🤖 ASSISTANT TRANSCRIPT: {assistant_transcript}")
                
                # Convert output_audio.delta for client
                if msg_type == "response.output_audio.delta":
                    await websocket.send_json({
                        "type": "response.audio.delta",
                        "delta": response_data.get("delta", "")
                    })
                    continue
                
                # Response done
                if msg_type == "response.done":
                    log_to_render(f"🏁 RESPONSE DONE (events: {event_count}, functions: {function_execution_count})")
                    
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                    
                    # Save final transcripts if any
                    if openai_client.db_session and openai_client.conversation_record_id and assistant_transcript:
                        try:
                            conv = openai_client.db_session.query(Conversation).get(
                                uuid.UUID(openai_client.conversation_record_id)
                            )
                            if conv:
                                if not conv.assistant_message:
                                    conv.assistant_message = assistant_transcript
                                if user_transcript and not conv.user_message:
                                    conv.user_message = user_transcript
                                openai_client.db_session.commit()
                                log_to_render(f"💾 Final transcripts saved to DB")
                        except Exception as e:
                            log_to_render(f"❌ DB save error: {e}", "ERROR")
                
                # Forward all other messages to client
                await websocket.send_json(response_data)

            except ConnectionClosed as e:
                log_to_render(f"⚠️ OpenAI connection closed", "WARNING")
                if await openai_client.reconnect():
                    log_to_render(f"✅ Reconnected to OpenAI")
                    continue
                else:
                    log_to_render(f"❌ Reconnection failed", "ERROR")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        log_to_render(f"👋 Handler terminated for {openai_client.client_id}")
        return
    except Exception as e:
        log_to_render(f"❌ CRITICAL Handler error: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
