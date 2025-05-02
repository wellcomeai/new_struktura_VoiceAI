"""
WebSocket handler for WellcomeAI application.
Handles WebSocket connections and message processing.
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
from typing import Dict, Any, Optional, List

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation

logger = get_logger(__name__)

# Хранение активных соединений для каждого ассистента
active_connections: Dict[str, List[WebSocket]] = {}

async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    Обработчик WebSocket соединения
    
    Args:
        websocket: WebSocket соединение
        assistant_id: ID ассистента
        db: Сессия базы данных
    """
    # Идентификатор клиента
    client_id = str(uuid.uuid4())
    
    try:
        # Принимаем соединение
        await websocket.accept()
        logger.info(f"WebSocket соединение принято: client_id={client_id}, assistant_id={assistant_id}")
        
        # Регистрируем соединение
        if assistant_id not in active_connections:
            active_connections[assistant_id] = []
        active_connections[assistant_id].append(websocket)
        
        # Отправляем приветственное сообщение
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "message": "Соединение установлено"
        })
        
        # Загружаем ассистента из базы данных
        assistant = None
        try:
            assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
            if not assistant:
                logger.warning(f"Ассистент не найден: {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "assistant_not_found",
                        "message": "Ассистент не найден"
                    }
                })
                return
        except Exception as e:
            logger.error(f"Ошибка при загрузке ассистента: {str(e)}")
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "database_error",
                    "message": "Ошибка при загрузке ассистента"
                }
            })
            return
        
        # Главный цикл обработки сообщений
        while True:
            # Получаем сообщение
            data = await websocket.receive_text()
            
            try:
                # Парсим JSON
                message = json.loads(data)
                
                # Обрабатываем сообщение
                if message.get("type") == "ping":
                    # Отвечаем на пинг
                    await websocket.send_text("pong")
                    continue
                
                # Здесь будет основная логика обработки сообщений
                # Пока просто отправляем эхо
                await websocket.send_json({
                    "type": "echo",
                    "message": message
                })
                
            except json.JSONDecodeError:
                logger.warning(f"Получено некорректное JSON сообщение: {data}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "invalid_json",
                        "message": "Некорректный формат JSON"
                    }
                })
            except Exception as e:
                logger.error(f"Ошибка при обработке сообщения: {str(e)}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "processing_error",
                        "message": f"Ошибка при обработке сообщения: {str(e)}"
                    }
                })
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket соединение закрыто: client_id={client_id}")
    except Exception as e:
        logger.error(f"Ошибка WebSocket: {str(e)}")
    finally:
        # Удаляем соединение из списка активных
        if assistant_id in active_connections and websocket in active_connections[assistant_id]:
            active_connections[assistant_id].remove(websocket)
            if not active_connections[assistant_id]:
                del active_connections[assistant_id]
