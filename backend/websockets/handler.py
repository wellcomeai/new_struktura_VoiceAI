"""
WebSocket handler for WellcomeAI application.
Handles WebSocket connections and message processing.
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
from typing import Dict, Any, Optional, List
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.utils.audio_utils import base64_to_audio_buffer, create_wav_from_pcm
from backend.websockets.openai_client import OpenAIRealtimeClient

logger = get_logger(__name__)

# Store active connections for each assistant
active_connections: Dict[str, List[WebSocket]] = {}

async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    WebSocket connection handler
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID
        db: Database session
    """
    # Client identifier
    client_id = str(uuid.uuid4())
    openai_client = None
    
    try:
        # Accept connection
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")
        
        # Register connection
        if assistant_id not in active_connections:
            active_connections[assistant_id] = []
        active_connections[assistant_id].append(websocket)
        
        # Загружаем ассистента из базы данных
        assistant = None
        try:
            # Проверяем, это демо-режим или нет
            if assistant_id == "demo":
                # Используем демо-логику
                assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public == True).first()
                if not assistant:
                    # Просто берём первого попавшегося ассистента
                    assistant = db.query(AssistantConfig).first()
                logger.info(f"Using assistant {assistant.id if assistant else 'None'} for demo")
            else:
                # Пробуем с разными форматами ID
                try:
                    uuid_obj = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).filter(AssistantConfig.id == uuid_obj).first()
                except ValueError:
                    # Если не UUID, пробуем как строку
                    assistant = db.query(AssistantConfig).filter(
                        AssistantConfig.id.cast(str) == assistant_id
                    ).first()
            
            if not assistant:
                logger.warning(f"Assistant not found: {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "assistant_not_found",
                        "message": "Ассистент не найден. Пожалуйста, проверьте ID или создайте нового ассистента."
                    }
                })
                
                # Создаём временного ассистента для демонстрации, если нет ни одного
                if db.query(AssistantConfig).count() == 0:
                    logger.info("Creating a temporary demo assistant")
                    
                    # Находим любого пользователя
                    demo_user = db.query(User).first()
                    if demo_user:
                        demo_assistant = AssistantConfig(
                            id=uuid.uuid4(),
                            user_id=demo_user.id,
                            name="Демо ассистент",
                            description="Временный демонстрационный ассистент",
                            system_prompt="Ты полезный голосовой ассистент, который отвечает на вопросы вежливо и дружелюбно.",
                            voice="alloy",
                            language="ru",
                            is_active=True,
                            is_public=True
                        )
                        
                        db.add(demo_assistant)
                        db.commit()
                        db.refresh(demo_assistant)
                        
                        assistant = demo_assistant
                        logger.info(f"Created temporary demo assistant with ID: {assistant.id}")
                        
                        # Сообщаем клиенту, что создан временный ассистент
                        await websocket.send_json({
                            "type": "info",
                            "message": "Создан временный демо-ассистент для тестирования"
                        })
                    else:
                        logger.warning("No users found to create demo assistant")
                        await websocket.close(code=1008)
                        return
                else:
                    logger.warning("No assistants available and no demo assistant created")
                    await websocket.close(code=1008)
                    return
                
            # Получаем API ключ для OpenAI
            api_key = None
            if assistant.user_id:
                user = db.query(User).filter(User.id == assistant.user_id).first()
                if user and user.openai_api_key:
                    api_key = user.openai_api_key
            
            # Если нет ключа у пользователя, используем ключ из настроек
            if not api_key:
                api_key = settings.OPENAI_API_KEY
                
            if not api_key:
                logger.error(f"No OpenAI API key found for assistant {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "no_api_key",
                        "message": "Не найден API ключ OpenAI. Пожалуйста, добавьте ключ в настройках."
                    }
                })
                await websocket.close(code=1008)
                return
                
            # Создаем клиент для OpenAI
            openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
            
            # Подключаемся к OpenAI
            connected = await openai_client.connect()
            if not connected:
                logger.error(f"Failed to connect to OpenAI for assistant {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "openai_connection_failed",
                        "message": "Не удалось подключиться к OpenAI. Пожалуйста, попробуйте позже."
                    }
                })
                await websocket.close(code=1008)
                return
            
            # Отправляем подтверждение подключения
            await websocket.send_json({
                "type": "connection_status",
                "status": "connected",
                "message": "Соединение установлено"
            })
            
            # Отправляем информацию о сессии без session_id
            await websocket.send_json({
                "type": "session.created",
                "assistant": {
                    "id": str(assistant.id),
                    "name": assistant.name
                }
            })
            
        except Exception as e:
            logger.error(f"Error loading assistant: {str(e)}")
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "database_error",
                    "message": f"Ошибка загрузки ассистента: {str(e)}"
                }
            })
            await websocket.close(code=1011)
            return
        
        # Буфер для входящего аудио
        audio_buffer = bytearray()
        
        # Флаги состояния
        is_processing = False
        
        # Запускаем задачу для чтения сообщений от OpenAI
        openai_task = asyncio.create_task(handle_openai_messages(openai_client, websocket))
        
        # Главный цикл обработки сообщений от клиента
        while True:
            try:
                # Получаем сообщение (текст или бинарные данные)
                message = await websocket.receive()
                
                # Логирование типа сообщения
                if 'text' in message:
                    logger.debug(f"Received text message: {message['text'][:50]}...")
                elif 'bytes' in message:
                    logger.debug(f"Received binary message: {len(message['bytes'])} bytes")
                else:
                    logger.debug(f"Received unknown message type: {message}")
                
                # Проверяем тип сообщения
                if "text" in message:
                    # Обработка текстового сообщения
                    try:
                        data = json.loads(message["text"])
                        
                        # Обработка различных типов сообщений
                        msg_type = data.get("type", "")
                        logger.debug(f"Processing message type: {msg_type}")
                        
                        # Пинг-понг для поддержания соединения
                        if msg_type == "ping":
                            await websocket.send_json({"type": "pong"})
                            continue
                        
                        # Обработка аудио-буфера
                        if msg_type == "input_audio_buffer.append":
                            if "audio" in data:
                                # Декодируем аудио из base64
                                audio_chunk = base64_to_audio_buffer(data["audio"])
                                audio_buffer.extend(audio_chunk)
                                
                                # Отвечаем подтверждением
                                await websocket.send_json({
                                    "type": "input_audio_buffer.append.ack",
                                    "event_id": data.get("event_id", "unknown")
                                })
                            continue
                        
                        # Завершение буфера и отправка на обработку
                        if msg_type == "input_audio_buffer.commit" and not is_processing:
                            is_processing = True
                            
                            # Проверяем, есть ли данные в буфере
                            if len(audio_buffer) == 0:
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {
                                        "code": "input_audio_buffer_commit_empty",
                                        "message": "Аудио буфер пуст"
                                    }
                                })
                                is_processing = False
                                continue
                            
                            # Отправляем аудио в OpenAI
                            if openai_client and openai_client.is_connected:
                                # Сначала отправляем аудио данные
                                await openai_client.process_audio(audio_buffer)
                                # Затем вызываем commit без session_id
                                await openai_client.commit_audio()
                            else:
                                logger.error("Cannot process audio: OpenAI client not connected")
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {
                                        "code": "openai_not_connected",
                                        "message": "Соединение с OpenAI потеряно"
                                    }
                                })
                            
                            # Сбрасываем состояние
                            audio_buffer.clear()
                            is_processing = False
                            continue
                        
                        # Очистка буфера
                        if msg_type == "input_audio_buffer.clear":
                            audio_buffer.clear()
                            # Вызываем clear_audio_buffer без session_id
                            if openai_client and openai_client.is_connected:
                                await openai_client.clear_audio_buffer()
                            await websocket.send_json({
                                "type": "input_audio_buffer.clear.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue
                        
                        # Отмена текущего ответа
                        if msg_type == "response.cancel":
                            # Отправляем команду отмены без session_id
                            if openai_client and openai_client.is_connected:
                                await openai_client.ws.send(json.dumps({
                                    "type": "response.cancel"
                                    # Не требуется дополнительных полей
                                }))
                            await websocket.send_json({
                                "type": "response.cancel.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue
                        
                        # Обработка неизвестного типа сообщения
                        logger.warning(f"Unknown message type: {msg_type}")
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "unknown_message_type",
                                "message": f"Неизвестный тип сообщения: {msg_type}"
                            }
                        })
                        
                    except json.JSONDecodeError:
                        logger.warning(f"Invalid JSON: {message['text'][:50]}...")
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "invalid_json",
                                "message": "Некорректный формат JSON"
                            }
                        })
                
                # Обработка бинарных данных (если ожидаются)
                elif "bytes" in message:
                    # Просто добавляем в буфер
                    audio_buffer.extend(message["bytes"])
                    
                    # Отправляем подтверждение
                    await websocket.send_json({
                        "type": "binary.ack"
                    })
                
            except WebSocketDisconnect:
                logger.info(f"WebSocket client {client_id} disconnected")
                break
            except ConnectionClosed:
                logger.info(f"WebSocket connection closed for client {client_id}")
                break
            except Exception as e:
                logger.error(f"Error in WebSocket message processing: {str(e)}")
                try:
                    # Проверяем, что соединение все еще активно перед отправкой
                    if websocket.client_state.CONNECTED:
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "processing_error",
                                "message": f"Ошибка обработки сообщения: {str(e)}"
                            }
                        })
                except:
                    # Если не можем отправить сообщение об ошибке, прекращаем обработку
                    logger.error(f"Cannot send error message, connection may be closed")
                    break
        
        # Отменяем задачу чтения сообщений от OpenAI
        if 'openai_task' in locals() and not openai_task.done():
            openai_task.cancel()
            try:
                await asyncio.wait_for(openai_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                logger.info(f"OpenAI task cancelled for client {client_id}")
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket connection closed: client_id={client_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        # Закрываем соединение с OpenAI
        if openai_client:
            try:
                await openai_client.close()
                logger.info(f"Successfully closed OpenAI connection for client {client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI connection: {str(e)}")
            
        # Удаляем соединение из активных
        try:
            if assistant_id in active_connections and websocket in active_connections[assistant_id]:
                active_connections[assistant_id].remove(websocket)
                if not active_connections[assistant_id]:
                    del active_connections[assistant_id]
            logger.info(f"Removed WebSocket connection from active connections: client_id={client_id}")
        except Exception as e:
            logger.error(f"Error removing connection from active_connections: {str(e)}")

async def handle_openai_messages(openai_client, websocket):
    """
    Handle messages from OpenAI and forward to client
    
    Args:
        openai_client: OpenAI client
        websocket: WebSocket connection to client
    """
    if not openai_client or not openai_client.ws:
        return
        
    try:
        while True:
            # Get message from OpenAI
            response = await openai_client.ws.recv()
            
            try:
                # Parse response as JSON
                response_data = json.loads(response)
                
                # Handle different response types
                response_type = response_data.get("type", "")
                
                if response_type == "message":
                    # Проверяем наличие объекта message и его type
                    message = response_data.get("message", {})
                    message_type = message.get("type", "text")
                    content = message.get("content", "")
                    
                    if message_type == "text":
                        # Send text to client character by character
                        for char in content:
                            await websocket.send_json({
                                "type": "response.text.delta",
                                "delta": char
                            })
                            await asyncio.sleep(0.01)  # Simulate typing delay
                        
                        # Complete text response
                        await websocket.send_json({
                            "type": "response.text.done"
                        })
                        
                        # Save response to database if conversation_id exists
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conversation = openai_client.db_session.query(Conversation).filter(
                                    Conversation.id == uuid.UUID(openai_client.conversation_record_id)
                                ).first()
                                
                                if conversation:
                                    conversation.assistant_message = content
                                    openai_client.db_session.commit()
                            except Exception as db_error:
                                logger.error(f"Error updating conversation: {str(db_error)}")
                
                elif response_type == "audio":
                    # Audio response
                    audio_base64 = response_data.get("audio", "")
                    
                    if audio_base64:
                        # Send audio to client
                        await websocket.send_json({
                            "type": "response.audio.delta",
                            "delta": audio_base64
                        })
                        
                        # Complete audio response
                        await websocket.send_json({
                            "type": "response.audio.done"
                        })
                
                elif response_type == "audio_transcript":
                    # Audio transcription
                    transcript = response_data.get("text", "")
                    
                    if transcript:
                        logger.info(f"Got audio transcript: {transcript}")
                        
                        # Отправляем транскрипцию клиенту
                        await websocket.send_json({
                            "type": "response.audio_transcript.delta",
                            "delta": transcript
                        })
                        
                        # Завершение транскрипции
                        await websocket.send_json({
                            "type": "response.audio_transcript.done"
                        })
                        
                        # Update conversation in database
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conversation = openai_client.db_session.query(Conversation).filter(
                                    Conversation.id == uuid.UUID(openai_client.conversation_record_id)
                                ).first()
                                
                                if conversation:
                                    conversation.user_message = transcript
                                    openai_client.db_session.commit()
                            except Exception as db_error:
                                logger.error(f"Error updating conversation with transcript: {str(db_error)}")
                
                elif response_type == "error":
                    # Error from OpenAI
                    error = response_data.get("error", {})
                    error_msg = error.get("message", "Неизвестная ошибка")
                    error_code = error.get("code", "unknown_error")
                    logger.error(f"Error from OpenAI: {error_code} - {error_msg}")
                    
                    await websocket.send_json({
                        "type": "error",
                        "error": {
                            "code": error_code,
                            "message": error_msg
                        }
                    })
                
                elif response_type == "status":
                    # Status from OpenAI
                    status = response_data.get("status", "")
                    logger.debug(f"Status from OpenAI: {status}")
                    
                    # If final status, send response completion
                    if status == "done":
                        await websocket.send_json({
                            "type": "response.done"
                        })
                        
                # Другие типы сообщений
                else:
                    logger.warning(f"Unknown response type from OpenAI: {response_type}")
                
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from OpenAI: {response[:100]}...")
            except Exception as e:
                logger.error(f"Error processing OpenAI message: {str(e)}")
                
    except asyncio.CancelledError:
        logger.info(f"OpenAI message handler cancelled for client {openai_client.client_id}")
    except ConnectionClosed:
        logger.warning(f"OpenAI connection closed for client {openai_client.client_id}")
    except Exception as e:
        logger.error(f"Error in OpenAI message handler: {str(e)}")
