# backend/websockets/handler_realtime_new.py
"""
🚀 PRODUCTION VERSION - OpenAI Realtime API (GA) Handler
Model: gpt-realtime-mini
Optimized for investor demo with reliable function execution logging

Changes from debug version:
✅ Removed verbose DEBUG logs
✅ Added immediate function logging (no waiting for response.done)
✅ Fixed double JSON serialization in function results
✅ Added performance metrics
✅ Enhanced error handling
✅ Improved stability for production deployment
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
import traceback
import time
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

# Active connections
active_connections_new: Dict[str, List[WebSocket]] = {}


async def handle_websocket_connection_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🚀 PRODUCTION - Main WebSocket handler for Realtime API
    
    Features:
    - Immediate function execution logging
    - Reliable error handling
    - Performance monitoring
    - Production-ready stability
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    connection_start = time.time()
    
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')

    try:
        await websocket.accept()
        logger.info(f"[REALTIME-GA] ✅ Connection accepted: client={client_id}, assistant={assistant_id}")

        # Check for ElevenLabs agents
        elevenlabs_agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == assistant_id
        ).first()
        if elevenlabs_agent:
            logger.info(f"[REALTIME-GA] ElevenLabs agent detected: {assistant_id}")
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
            logger.error(f"[REALTIME-GA] ❌ Assistant not found: {assistant_id}")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
            })
            await websocket.close(code=1008)
            return

        logger.info(f"[REALTIME-GA] Assistant loaded: {assistant.name if hasattr(assistant, 'name') else assistant_id}")

        # Extract enabled functions
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        logger.info(f"[REALTIME-GA] Functions enabled: {enabled_functions}")

        # Check subscription
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    if not subscription_status["active"]:
                        logger.warning(f"[REALTIME-GA] Subscription expired for user {user.id}")
                        
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
            logger.error(f"[REALTIME-GA] ❌ No API key found")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "OpenAI API key required"}
            })
            await websocket.close(code=1008)
            return

        # Create OpenAI Realtime client
        openai_client = OpenAIRealtimeClientNew(api_key, assistant, client_id, db, user_agent)
        
        if not await openai_client.connect():
            logger.error(f"[REALTIME-GA] ❌ Failed to connect to OpenAI")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        connection_time = time.time() - connection_start
        logger.info(f"[REALTIME-GA] ✅ Connected to OpenAI in {connection_time:.2f}s")

        # Send connection status
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connected to Realtime API (GA version)",
            "model": "gpt-realtime-mini",
            "functions_enabled": len(enabled_functions)
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

        # Start OpenAI message handler
        openai_task = asyncio.create_task(
            handle_openai_messages_new(openai_client, websocket, interruption_state)
        )

        # Main client receive loop
        while True:
            try:
                message = await websocket.receive()

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
                        
                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({
                                "type": "input_audio_buffer.commit.ack", 
                                "event_id": data.get("event_id")
                            })
                        else:
                            if await openai_client.reconnect():
                                await openai_client.commit_audio()
                                await websocket.send_json({
                                    "type": "input_audio_buffer.commit.ack", 
                                    "event_id": data.get("event_id")
                                })
                            else:
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {"code": "openai_not_connected", "message": "Connection lost"}
                                })

                        audio_buffer.clear()
                        is_processing = False
                        continue

                    if msg_type == "input_audio_buffer.clear":
                        audio_buffer.clear()
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
                    
                    if msg_type == "microphone.state":
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
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                logger.info(f"[REALTIME-GA] Client disconnected: {client_id}")
                break
            except Exception as e:
                logger.error(f"[REALTIME-GA] Error in WebSocket loop: {e}")
                break

        # Cleanup
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)

        session_duration = time.time() - connection_start
        logger.info(f"[REALTIME-GA] Session ended: {client_id}, duration: {session_duration:.2f}s")

    except Exception as outer_e:
        logger.error(f"[REALTIME-GA] Outer exception: {outer_e}")
        logger.error(f"[REALTIME-GA] Traceback: {traceback.format_exc()}")
        
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
        logger.info(f"[REALTIME-GA] Connection closed: {client_id}")


async def handle_openai_messages_new(
    openai_client: 'OpenAIRealtimeClientNew', 
    websocket: WebSocket, 
    interruption_state: Dict
):
    """
    🚀 PRODUCTION - Handle messages from OpenAI with immediate function logging
    
    Key features:
    - Logs function execution IMMEDIATELY (no waiting for response.done)
    - Reliable transcript storage
    - Performance metrics
    """
    if not openai_client.is_connected or not openai_client.ws:
        logger.error("[REALTIME-GA] OpenAI client not connected")
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
    last_event_time = time.time()
    
    try:
        logger.info(f"[REALTIME-GA] Started processing messages for {openai_client.client_id}")
        
        while True:
            try:
                raw = await openai_client.ws.recv()
                event_count += 1
                current_time = time.time()
                time_since_last = current_time - last_event_time
                last_event_time = current_time
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error(f"[REALTIME-GA] JSON decode error: {raw[:200]}")
                    continue
                    
                msg_type = response_data.get("type", "unknown")
                
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
                    logger.error(f"[REALTIME-GA] API Error: {json.dumps(response_data, ensure_ascii=False)}")
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
                
                # 🚀 PRODUCTION: Function execution with IMMEDIATE logging
                if msg_type == "response.function_call.started":
                    function_name = response_data.get("function_name")
                    function_call_id = response_data.get("call_id")
                    
                    logger.info(f"[REALTIME-GA] Function call started: {function_name}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[REALTIME-GA] Unauthorized function: {normalized_name}")
                        
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
                    
                    logger.info(f"[REALTIME-GA] Function arguments done: {function_name}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[REALTIME-GA] Unauthorized function: {normalized_name}")
                        
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
                            
                            await websocket.send_json({
                                "type": "function_call.executing",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "arguments": arguments
                            })
                            
                            logger.info(f"[REALTIME-GA] Executing function: {normalized_name}")
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
                            logger.info(f"[REALTIME-GA] ✅ Function executed in {execution_time:.3f}s")
                            
                            # 🚀 PRODUCTION: Log IMMEDIATELY after function execution
                            try:
                                # Save to database
                                if openai_client.db_session and openai_client.conversation_record_id:
                                    conv = openai_client.db_session.query(Conversation).get(
                                        uuid.UUID(openai_client.conversation_record_id)
                                    )
                                    if conv:
                                        function_summary = f"[Function: {normalized_name}] Result: {json.dumps(result, ensure_ascii=False)[:200]}"
                                        conv.assistant_message = function_summary
                                        if user_transcript and not conv.user_message:
                                            conv.user_message = user_transcript
                                        openai_client.db_session.commit()
                                        logger.info(f"[REALTIME-GA] 💾 Function logged to database")
                                
                                # Save to Google Sheets
                                if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                                    sheet_id = openai_client.assistant_config.google_sheet_id
                                    
                                    sheets_result = await GoogleSheetsService.log_conversation(
                                        sheet_id=sheet_id,
                                        user_message=user_transcript or f"[Function call: {normalized_name}]",
                                        assistant_message=f"[Function executed: {normalized_name}]",
                                        function_result=result
                                    )
                                    if sheets_result:
                                        logger.info(f"[REALTIME-GA] 📊 Function logged to Google Sheets")
                                    else:
                                        logger.warning(f"[REALTIME-GA] ⚠️ Google Sheets logging failed (but function executed)")
                            except Exception as log_error:
                                logger.error(f"[REALTIME-GA] ⚠️ Function logging error (non-critical): {log_error}")
                                # Continue execution - logging failure shouldn't stop the flow
                            
                            # Send result to OpenAI (model will auto-continue)
                            delivery_status = await openai_client.send_function_result(function_call_id, result)
                            
                            if not delivery_status["success"]:
                                logger.error(f"[REALTIME-GA] Function result delivery error: {delivery_status['error']}")
                                
                                error_message = {
                                    "type": "function_call.delivery_error",
                                    "function_call_id": function_call_id,
                                    "error": delivery_status['error']
                                }
                                await websocket.send_json(error_message)
                            else:
                                logger.info(f"[REALTIME-GA] ✅ Function result delivered, waiting for model continuation")
                                
                                await websocket.send_json({
                                    "type": "function_call.completed",
                                    "function": normalized_name,
                                    "function_call_id": function_call_id,
                                    "result": result,
                                    "execution_time": execution_time
                                })
                            
                        except json.JSONDecodeError as e:
                            logger.error(f"[REALTIME-GA] Function args parse error: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_args_error", "message": str(e)}
                            })
                        except Exception as e:
                            logger.error(f"[REALTIME-GA] Function execution error: {e}")
                            logger.error(f"[REALTIME-GA] Traceback: {traceback.format_exc()}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })
                    
                    pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}

                elif msg_type == "response.content_part.added":
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text
                
                # Transcripts
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        logger.info(f"[REALTIME-GA] 👤 User: {user_transcript}")
                        
                        # Save user message immediately
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv and not conv.user_message:
                                    conv.user_message = user_transcript
                                    openai_client.db_session.commit()
                            except Exception as e:
                                logger.error(f"[REALTIME-GA] DB save error: {e}")
                
                if msg_type == "response.output_audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text
                
                if msg_type == "response.output_audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        logger.info(f"[REALTIME-GA] 🤖 Assistant: {assistant_transcript}")
                
                if msg_type == "conversation.item.input_audio_transcription.delta":
                    delta_text = response_data.get("delta", "")
                    user_transcript += delta_text
                
                if msg_type == "conversation.item.added":
                    item = response_data.get("item", {})
                    role = item.get("role", "")
                    content = item.get("content", [])
                    
                    if role == "user":
                        for part in content:
                            if part.get("type") == "input_audio" and "transcript" in part:
                                part_transcript = part.get("transcript", "")
                                if part_transcript:
                                    user_transcript = part_transcript
                            elif part.get("type") == "input_text" and "text" in part:
                                part_text = part.get("text", "")
                                if part_text:
                                    user_transcript = part_text
                
                # Convert output_audio.delta for client
                if msg_type == "response.output_audio.delta":
                    await websocket.send_json({
                        "type": "response.audio.delta",
                        "delta": response_data.get("delta", "")
                    })
                    continue
                
                # Audio
                if msg_type == "audio":
                    b64 = response_data.get("data", "")
                    chunk = base64.b64decode(b64)
                    await websocket.send_bytes(chunk)
                    continue
                
                # Response done - save final transcripts
                if msg_type == "response.done":
                    logger.info(f"[REALTIME-GA] Response done (events processed: {event_count})")
                    
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                    
                    # Save to database if we have transcripts
                    if openai_client.db_session and openai_client.conversation_record_id and assistant_transcript:
                        try:
                            conv = openai_client.db_session.query(Conversation).get(
                                uuid.UUID(openai_client.conversation_record_id)
                            )
                            if conv:
                                # Only update if not already set (function logging might have set it)
                                if not conv.assistant_message:
                                    conv.assistant_message = assistant_transcript
                                if user_transcript and not conv.user_message:
                                    conv.user_message = user_transcript
                                openai_client.db_session.commit()
                                logger.info(f"[REALTIME-GA] 💾 Transcripts saved to database")
                        except Exception as e:
                            logger.error(f"[REALTIME-GA] DB save error: {e}")
                    
                    # Save to Google Sheets (only if not a function execution)
                    if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                        sheet_id = openai_client.assistant_config.google_sheet_id
                        
                        # Only log if we have transcripts and it's not a function-only response
                        if (user_transcript or assistant_transcript) and "[Function:" not in (assistant_transcript or ""):
                            try:
                                sheets_result = await GoogleSheetsService.log_conversation(
                                    sheet_id=sheet_id,
                                    user_message=user_transcript,
                                    assistant_message=assistant_transcript,
                                    function_result=None  # Already logged during function execution
                                )
                                if sheets_result:
                                    logger.info(f"[REALTIME-GA] 📊 Conversation logged to Google Sheets")
                            except Exception as e:
                                logger.error(f"[REALTIME-GA] Google Sheets error: {e}")
                
                # Forward all other messages to client
                await websocket.send_json(response_data)

            except ConnectionClosed as e:
                logger.warning(f"[REALTIME-GA] OpenAI connection closed")
                if await openai_client.reconnect():
                    logger.info("[REALTIME-GA] Reconnected to OpenAI")
                    continue
                else:
                    logger.error("[REALTIME-GA] Reconnection failed")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        logger.info(f"[REALTIME-GA] Connection closed for {openai_client.client_id}")
        return
    except Exception as e:
        logger.error(f"[REALTIME-GA] Handler error: {e}")
        logger.error(f"[REALTIME-GA] Traceback: {traceback.format_exc()}")
