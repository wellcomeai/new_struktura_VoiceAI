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

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.utils.audio_utils import base64_to_audio_buffer, create_wav_from_pcm

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
    
    try:
        # Accept connection
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")
        
        # Register connection
        if assistant_id not in active_connections:
            active_connections[assistant_id] = []
        active_connections[assistant_id].append(websocket)
        
        # Загружаем ассистента из базы данных - улучшенная обработка ошибок
        assistant = None
        try:
            # Попытка найти ассистента напрямую без преобразования ID
            if assistant_id == "demo":
                # Используем демо-логику
                assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public == True).first()
                if not assistant:
                    # Просто берём первого попавшегося ассистента
                    assistant = db.query(AssistantConfig).first()
                logger.info(f"Using assistant {assistant.id if assistant else 'None'} for demo")
            else:
                # Пробуем с разными форматами ID
                # 1. Сначала проверяем UUID формат
                try:
                    uuid_obj = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).filter(AssistantConfig.id == uuid_obj).first()
                except ValueError:
                    # 2. Если не UUID, пробуем как строку
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
            
            # Отправляем подтверждение подключения
            await websocket.send_json({
                "type": "connection_status",
                "status": "connected",
                "message": "Соединение установлено"
            })
            
            # Отправляем информацию о сессии
            await websocket.send_json({
                "type": "session.created",
                "session_id": f"session_{client_id}",
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
        
        # Главный цикл обработки сообщений
        while True:
            try:
                # Получаем сообщение (текст или бинарные данные)
                message = await websocket.receive()
                
                # Тут добавляем подробное логирование
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
                            
                            # В этом месте должна быть отправка аудио на обработку
                            # и получение ответа от модели, но для примера просто отправим эхо
                            
                            # Симулируем ответ от модели
                            response_text = "Я получил ваше сообщение. Чем могу помочь?"
                            
                            # Отправляем текстовый ответ клиенту
                            for char in response_text:
                                await websocket.send_json({
                                    "type": "response.text.delta",
                                    "delta": char
                                })
                                await asyncio.sleep(0.02)  # Имитация задержки набора текста
                            
                            # Завершаем текстовый ответ
                            await websocket.send_json({
                                "type": "response.text.done"
                            })
                            
                            # Отправляем аудио-ответ (эхо входящего аудио для теста)
                            await websocket.send_json({
                                "type": "response.audio.delta",
                                "delta": base64.b64encode(bytes(audio_buffer)).decode('utf-8')
                            })
                            
                            # Завершаем аудио-ответ
                            await websocket.send_json({
                                "type": "response.audio.done"
                            })
                            
                            # Завершаем весь ответ
                            await websocket.send_json({
                                "type": "response.done"
                            })
                            
                            # Сбрасываем состояние
                            audio_buffer.clear()
                            is_processing = False
                            continue
                        
                        # Очистка буфера
                        if msg_type == "input_audio_buffer.clear":
                            audio_buffer.clear()
                            await websocket.send_json({
                                "type": "input_audio_buffer.clear.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue
                        
                        # Отмена текущего ответа
                        if msg_type == "response.cancel":
                            # Здесь должна быть логика отмены, но для примера просто подтвердим
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
            except Exception as e:
                logger.error(f"Error in WebSocket message processing: {str(e)}")
                try:
                    await websocket.send_json({
                        "type": "error",
                        "error": {
                            "code": "processing_error",
                            "message": f"Ошибка обработки сообщения: {str(e)}"
                        }
                    })
                except:
                    # Если не можем отправить сообщение об ошибке, прекращаем обработку
                    break
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket connection closed: client_id={client_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        # Remove connection from active list
        if assistant_id in active_connections and websocket in active_connections[assistant_id]:
            active_connections[assistant_id].remove(websocket)
            if not active_connections[assistant_id]:
                del active_connections[assistant_id]
