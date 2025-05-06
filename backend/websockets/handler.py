# backend/websockets/handler.py
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
from typing import Dict, List
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.openai_client import OpenAIRealtimeClient

logger = get_logger(__name__)

# Активные соединения по каждому assistant_id
active_connections: Dict[str, List[WebSocket]] = {}


async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    client_id = str(uuid.uuid4())
    openai_client = None

    try:
        await websocket.accept()
        logger.info(f"✅ WebSocket соединение принято: client_id={client_id}, assistant_id={assistant_id}")

        active_connections.setdefault(assistant_id, []).append(websocket)

        if assistant_id == "demo":
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
            logger.info(f"🔍 Используется ассистент {assistant.id if assistant else 'None'} для демо")
        else:
            try:
                uuid_obj = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(uuid_obj)
                logger.info(f"🔍 Загружен ассистент: {assistant.id}, имя: {assistant.name}")
            except ValueError:
                assistant = db.query(AssistantConfig).filter(AssistantConfig.id.cast(str) == assistant_id).first()

        if not assistant:
            logger.error(f"❌ Ассистент не найден: {assistant_id}")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
            })
            await websocket.close(code=1008)
            return

        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user and user.openai_api_key:
                api_key = user.openai_api_key
                logger.info(f"🔑 Найден API ключ пользователя для ассистента")
            else:
                logger.warning(f"⚠️ API ключ не найден для пользователя {user.id if user else 'None'}")

        if not api_key:
            logger.error("❌ Отсутствует ключ API OpenAI для ассистента")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Отсутствует ключ API OpenAI. Пожалуйста, добавьте ключ в настройках личного кабинета."}
            })
            await websocket.close(code=1008)
            return

        openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
        if not await openai_client.connect():
            logger.error("❌ Не удалось подключиться к OpenAI")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        if hasattr(assistant, 'functions') and assistant.functions:
            logger.info(f"🔧 Доступные функции ассистента: {json.dumps(assistant.functions)}")

        await websocket.send_json({"type": "connection_status", "status": "connected"})

        while True:
            data = await websocket.receive_json()

            if data["type"] == "audio":
                logger.info("🎤 Пользователь закончил говорить, обрабатываем аудио")
                audio_buffer = base64_to_audio_buffer(data["audio"])
                await openai_client.process_audio(audio_buffer, websocket)

    except WebSocketDisconnect:
        logger.info(f"🔌 Клиент отключился: client_id={client_id}")
    except Exception as e:
        logger.error(f"❌ Ошибка в WebSocket цикле: {e}")
    finally:
        if openai_client:
            await openai_client.close()
        active_connections[assistant_id].remove(websocket)
        logger.info(f"🔌 Удалено WebSocket соединение: client_id={client_id}")
