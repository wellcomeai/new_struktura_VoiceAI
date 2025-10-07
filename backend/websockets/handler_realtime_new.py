# backend/websockets/handler_realtime_new.py
"""
🆕 NEW OpenAI Realtime API (GA) Handler
Version: GA 1.0 (gpt-realtime model)
Production-ready handler with new API events and format
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

# Активные соединения
active_connections_new: Dict[str, List[WebSocket]] = {}


async def handle_websocket_connection_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🆕 GA Version - Main WebSocket handler for new Realtime API
    
    Key changes from beta:
    - New model: gpt-realtime
    - Updated event names (output_text, output_audio)
    - Required session type parameter
    - New conversation.item events
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')

    try:
        await websocket.accept()
        logger.info(f"[NEW-API] WebSocket accepted: client_id={client_id}, assistant={assistant_id}")

        # ✅ Проверка ElevenLabs агентов (без изменений)
        elevenlabs_agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == assistant_id
        ).first()
        if elevenlabs_agent:
            logger.info(f"[NEW-API] ElevenLabs agent detected: {assistant_id}")
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

        # Регистрируем соединение
        active_connections_new.setdefault(assistant_id, []).append(websocket)

        # Загружаем ассистента
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
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
            })
            await websocket.close(code=1008)
            return

        # Логируем функции
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        logger.info(f"[NEW-API] Assistant {assistant_id} functions: {enabled_functions}")

        # ✅ Проверка подписки (без изменений)
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    if not subscription_status["active"]:
                        logger.warning(f"[NEW-API] Subscription expired for user {user.id}")
                        
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
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "OpenAI API key required"}
            })
            await websocket.close(code=1008)
            return

        # 🆕 Создаем НОВЫЙ клиент для GA API
        openai_client = OpenAIRealtimeClientNew(api_key, assistant, client_id, db, user_agent)
        if not await openai_client.connect():
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        # Сообщаем об успешном подключении
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connected to new Realtime API",
            "model": "gpt-realtime"
        })

        # Аудио буфер
        audio_buffer = bytearray()
        is_processing = False
        
        # Состояние для перебивания
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        # Запускаем обработку сообщений от OpenAI
        openai_task = asyncio.create_task(
            handle_openai_messages_new(openai_client, websocket, interruption_state)
        )

        # Основной цикл приёма от клиента
        while True:
            try:
                message = await websocket.receive()

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    # 🆕 Клиент не должен отправлять session.update в GA версии
                    if msg_type == "session.update":
                        logger.info(f"[NEW-API] Client sent session.update (ignored - server manages session)")
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        continue

                    # Обработка аудио
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
                    
                    # Обработка перебивания
                    if msg_type == "interruption.manual":
                        logger.info(f"[NEW-API] Manual interruption from {client_id}")
                        await openai_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        logger.info(f"[NEW-API] Client stopped playback: {client_id}")
                        openai_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    # Синхронизация состояний
                    if msg_type == "microphone.state":
                        mic_enabled = data.get("enabled", True)
                        logger.info(f"[NEW-API] Microphone state: {'enabled' if mic_enabled else 'disabled'}")
                        continue
                    
                    if msg_type == "speech.user_started":
                        logger.info(f"[NEW-API] User started speaking: {client_id}")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        if interruption_state["is_assistant_speaking"]:
                            await openai_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        logger.info(f"[NEW-API] User stopped speaking: {client_id}")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                    if msg_type not in ['session.update']:
                        logger.warning(f"[NEW-API] Unknown message type: {msg_type}")

                elif "bytes" in message:
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                break
            except Exception as e:
                logger.error(f"[NEW-API] Error in WebSocket loop: {e}")
                logger.error(f"[NEW-API] Traceback: {traceback.format_exc()}")
                break

        # Завершение
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)

    except Exception as outer_e:
        logger.error(f"[NEW-API] Outer exception: {outer_e}")
        logger.error(f"[NEW-API] Traceback: {traceback.format_exc()}")
        
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
        logger.info(f"[NEW-API] Connection closed: {client_id}")


async def handle_openai_messages_new(
    openai_client: 'OpenAIRealtimeClientNew', 
    websocket: WebSocket, 
    interruption_state: Dict
):
    """
    🆕 GA Version - Handle messages from OpenAI with new event names
    
    Key changes:
    - response.text.delta → response.output_text.delta
    - response.audio.delta → response.output_audio.delta
    - response.audio_transcript.delta → response.output_audio_transcript.delta
    - New conversation.item.added/done events
    """
    if not openai_client.is_connected or not openai_client.ws:
        logger.error("[NEW-API] OpenAI client not connected")
        return
    
    # Транскрипции для логирования
    user_transcript = ""
    assistant_transcript = ""
    function_result = None
    
    # Буфер для функций
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments_buffer": ""
    }
    
    waiting_for_function_response = False
    last_function_delivery_status = None
    
    try:
        logger.info(f"[NEW-API] Started processing OpenAI messages for {openai_client.client_id}")
        logger.info(f"[NEW-API] Enabled functions: {openai_client.enabled_functions}")
        
        while True:
            try:
                raw = await openai_client.ws.recv()
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error(f"[NEW-API] JSON decode error: {raw[:200]}")
                    continue
                    
                msg_type = response_data.get("type", "unknown")
                
                # 🆕 Обработка VAD событий (названия не изменились)
                if msg_type == "input_audio_buffer.speech_started":
                    logger.info(f"[NEW-API] User started speaking (VAD)")
                    interruption_state["is_user_speaking"] = True
                    interruption_state["last_speech_start"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.started",
                        "timestamp": interruption_state["last_speech_start"]
                    })
                    continue
                
                if msg_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[NEW-API] User stopped speaking (VAD)")
                    interruption_state["is_user_speaking"] = False
                    interruption_state["last_speech_stop"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.stopped",
                        "timestamp": interruption_state["last_speech_stop"]
                    })
                    continue
                
                if msg_type == "conversation.interrupted":
                    logger.info(f"[NEW-API] Conversation interrupted")
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
                    logger.info(f"[NEW-API] Response cancelled")
                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)
                    
                    await websocket.send_json({
                        "type": "response.cancelled",
                        "timestamp": time.time()
                    })
                    continue
                
                # Обработка ошибок
                if msg_type == "error":
                    logger.error(f"[NEW-API] API Error: {json.dumps(response_data, ensure_ascii=False)}")
                    
                    if waiting_for_function_response and "item" in str(response_data.get("error", {})):
                        error_message = response_data.get("error", {}).get("message", "Function error")
                        logger.error(f"[NEW-API] Function error: {error_message}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка функции: {error_message}"
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        await openai_client.create_response_after_function()
                        waiting_for_function_response = False
                    else:
                        await websocket.send_json(response_data)
                    continue
                
                logger.info(f"[NEW-API] Received: {msg_type}")
                
                # 🆕 НОВОЕ: Обработка output_audio вместо audio
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
                    
                    # Считаем аудио семплы
                    delta_audio = response_data.get("delta", "")
                    if delta_audio:
                        sample_count = len(base64.b64decode(delta_audio)) // 2
                        openai_client.increment_audio_samples(sample_count)
                
                # 🆕 НОВОЕ: output_audio.done вместо audio.done
                if msg_type == "response.output_audio.done":
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                
                # 🆕 НОВОЕ: output_text события
                if msg_type == "response.output_text.delta":
                    if response_data.get("delta"):
                        await websocket.send_json({
                            "type": "response.text.delta",  # Преобразуем для обратной совместимости с клиентом
                            "delta": response_data.get("delta")
                        })
                
                if msg_type == "response.output_text.done":
                    # Преобразуем для клиента
                    await websocket.send_json({
                        "type": "response.text.done"
                    })
                
                # Обработка функций (без изменений в GA)
                if msg_type == "response.function_call.started":
                    function_name = response_data.get("function_name")
                    function_call_id = response_data.get("call_id")
                    
                    logger.info(f"[NEW-API] Function call started: {function_name}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[NEW-API] Unauthorized function: {normalized_name}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Функция {function_name} не активирована"
                            }
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
                    
                    logger.info(f"[NEW-API] Function arguments done: {function_name}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[NEW-API] Unauthorized function: {normalized_name}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Функция {function_name} не активирована"
                            }
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
                                "type": "function_call.start",
                                "function": normalized_name,
                                "function_call_id": function_call_id
                            })
                            
                            result = await execute_function(
                                name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": openai_client.assistant_config,
                                    "client_id": openai_client.client_id,
                                    "db_session": openai_client.db_session
                                }
                            )
                            
                            function_result = result
                            waiting_for_function_response = True
                            
                            delivery_status = await openai_client.send_function_result(function_call_id, result)
                            last_function_delivery_status = delivery_status
                            
                            if not delivery_status["success"]:
                                logger.error(f"[NEW-API] Function result delivery error: {delivery_status['error']}")
                                
                                error_message = {
                                    "type": "response.content_part.added",
                                    "content": {
                                        "text": f"Ошибка выполнения функции: {delivery_status['error']}"
                                    }
                                }
                                await websocket.send_json(error_message)
                                
                                await openai_client.create_response_after_function()
                                waiting_for_function_response = False
                            
                            await websocket.send_json({
                                "type": "function_call.completed",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "result": result
                            })
                            
                        except json.JSONDecodeError as e:
                            logger.error(f"[NEW-API] Function args parse error: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_args_error", "message": str(e)}
                            })
                        except Exception as e:
                            logger.error(f"[NEW-API] Function execution error: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })
                    
                    pending_function_call = {"name": None, "call_id": None, "arguments_buffer": ""}

                elif msg_type == "response.content_part.added":
                    if waiting_for_function_response:
                        logger.info(f"[NEW-API] Response after function execution")
                        waiting_for_function_response = False
                    
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text
                
                # Транскрипции
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        logger.info(f"[NEW-API] 👤 User: {user_transcript}")
                        
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv:
                                    conv.user_message = user_transcript
                                    openai_client.db_session.commit()
                            except Exception as e:
                                logger.error(f"[NEW-API] DB save error: {e}")
                
                # 🆕 НОВОЕ: output_audio_transcript события
                if msg_type == "response.output_audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text
                
                if msg_type == "response.output_audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        logger.info(f"[NEW-API] 🤖 Assistant: {assistant_transcript}")
                
                if msg_type == "conversation.item.input_audio_transcription.delta":
                    delta_text = response_data.get("delta", "")
                    user_transcript += delta_text
                
                # 🆕 НОВОЕ: Обработка conversation.item.added (новое событие в GA)
                if msg_type == "conversation.item.added":
                    logger.info(f"[NEW-API] Conversation item added")
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
                
                # 🆕 НОВОЕ: conversation.item.done (новое событие в GA)
                if msg_type == "conversation.item.done":
                    logger.info(f"[NEW-API] Conversation item done")
                
                # 🆕 НОВОЕ: Преобразуем output_audio.delta для клиента (обратная совместимость)
                if msg_type == "response.output_audio.delta":
                    # Отправляем клиенту в старом формате для совместимости
                    await websocket.send_json({
                        "type": "response.audio.delta",
                        "delta": response_data.get("delta", "")
                    })
                    continue
                
                # Обычное аудио (если есть)
                if msg_type == "audio":
                    b64 = response_data.get("data", "")
                    chunk = base64.b64decode(b64)
                    await websocket.send_bytes(chunk)
                    continue
                
                # Завершение ответа
                if msg_type == "response.done":
                    logger.info(f"[NEW-API] Response done")
                    
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                    
                    logger.info(f"[NEW-API] Conversation complete")
                    logger.info(f"[NEW-API] User: {user_transcript}")
                    logger.info(f"[NEW-API] Assistant: {assistant_transcript}")
                    
                    # Сохраняем в БД
                    if openai_client.db_session and openai_client.conversation_record_id and assistant_transcript:
                        try:
                            conv = openai_client.db_session.query(Conversation).get(
                                uuid.UUID(openai_client.conversation_record_id)
                            )
                            if conv:
                                conv.assistant_message = assistant_transcript
                                if user_transcript and not conv.user_message:
                                    conv.user_message = user_transcript
                                openai_client.db_session.commit()
                        except Exception as e:
                            logger.error(f"[NEW-API] DB save error: {e}")
                    
                    # Google Sheets
                    if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                        sheet_id = openai_client.assistant_config.google_sheet_id
                        
                        if user_transcript or assistant_transcript:
                            try:
                                sheets_result = await GoogleSheetsService.log_conversation(
                                    sheet_id=sheet_id,
                                    user_message=user_transcript,
                                    assistant_message=assistant_transcript,
                                    function_result=function_result
                                )
                                if sheets_result:
                                    logger.info(f"[NEW-API] Logged to Google Sheets")
                            except Exception as e:
                                logger.error(f"[NEW-API] Google Sheets error: {e}")
                        
                        function_result = None
                    
                    waiting_for_function_response = False
                
                # Все остальные сообщения пробрасываем клиенту
                await websocket.send_json(response_data)

            except ConnectionClosed as e:
                logger.warning(f"[NEW-API] OpenAI connection closed: {e}")
                if await openai_client.reconnect():
                    logger.info("[NEW-API] Reconnected to OpenAI")
                    continue
                else:
                    logger.error("[NEW-API] Reconnection failed")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        logger.info(f"[NEW-API] Connection closed for {openai_client.client_id}")
        return
    except Exception as e:
        logger.error(f"[NEW-API] Handler error: {e}")
        logger.error(f"[NEW-API] Traceback: {traceback.format_exc()}")
