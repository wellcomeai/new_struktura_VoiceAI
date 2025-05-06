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

        # Регистрируем соединение
        active_connections.setdefault(assistant_id, []).append(websocket)

        # Загружаем конфиг ассистента
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

        # Определяем API-ключ
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

        # Подключаемся к OpenAI
        openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
        if not await openai_client.connect():
            logger.error("❌ Не удалось подключиться к OpenAI")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        # Проверяем настройки функций
        if hasattr(assistant, 'functions') and assistant.functions:
            logger.info(f"🔧 Доступные функции ассистента: {json.dumps(assistant.functions)}")
        else:
            logger.warning("⚠️ Ассистент не имеет настроенных функций")

        # Сообщаем клиенту об успешном подключении
        await websocket.send_json({"type": "connection_status", "status": "connected", "message": "Connection established"})

        audio_buffer = bytearray()
        is_processing = False

        # Запускаем приём сообщений от OpenAI
        openai_task = asyncio.create_task(handle_openai_messages(openai_client, websocket))

        # Основной цикл приёма от клиента
        while True:
            try:
                message = await websocket.receive()

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")
                    logger.debug(f"📩 Получено сообщение от клиента: {msg_type}")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        audio_buffer.extend(audio_chunk)
                        if openai_client.is_connected:
                            await openai_client.process_audio(audio_chunk)
                        await websocket.send_json({"type": "input_audio_buffer.append.ack", "event_id": data.get("event_id")})
                        continue

                    if msg_type == "input_audio_buffer.commit" and not is_processing:
                        is_processing = True
                        logger.info("🎤 Пользователь закончил говорить, обрабатываем аудио")
                        if not audio_buffer:
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "input_audio_buffer_commit_empty", "message": "Audio buffer is empty"}
                            })
                            is_processing = False
                            continue

                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({"type": "input_audio_buffer.commit.ack", "event_id": data.get("event_id")})
                        else:
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "openai_not_connected", "message": "Connection to OpenAI lost"}
                            })

                        audio_buffer.clear()
                        is_processing = False
                        continue

                    if msg_type == "input_audio_buffer.clear":
                        audio_buffer.clear()
                        if openai_client.is_connected:
                            await openai_client.clear_audio_buffer()
                        await websocket.send_json({"type": "input_audio_buffer.clear.ack", "event_id": data.get("event_id")})
                        continue

                    if msg_type == "response.cancel":
                        if openai_client.is_connected:
                            await openai_client.ws.send(json.dumps({
                                "type": "response.cancel",
                                "event_id": data.get("event_id")
                            }))
                        await websocket.send_json({"type": "response.cancel.ack", "event_id": data.get("event_id")})
                        continue
                        
                    if msg_type == "text.input":
                        logger.info(f"📝 Получен текстовый ввод от пользователя: {data.get('text', '')}")
                        if openai_client.is_connected:
                            await openai_client.ws.send(json.dumps({
                                "type": "text.input",
                                "text": data.get("text", ""),
                                "event_id": data.get("event_id")
                            }))
                            await websocket.send_json({"type": "text.input.ack", "event_id": data.get("event_id")})
                        else:
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "openai_not_connected", "message": "Connection to OpenAI lost"}
                            })
                        continue

                    # Любые остальные типы
                    logger.warning(f"⚠️ Неизвестный тип сообщения: {msg_type}")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "unknown_message_type", "message": f"Unknown message type: {msg_type}"}
                    })

                elif "bytes" in message:
                    # raw-байты от клиента
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                logger.info(f"🔌 WebSocket соединение закрыто клиентом: {client_id}")
                break
            except Exception as e:
                logger.error(f"❌ Ошибка в WebSocket цикле: {e}")
                break

        # завершение
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)  # даём задаче отмениться

    finally:
        if openai_client:
            await openai_client.close()
        # убираем из active_connections
        conns = active_connections.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        logger.info(f"🔌 Удалено WebSocket соединение: client_id={client_id}")


async def handle_openai_messages(openai_client: OpenAIRealtimeClient, websocket: WebSocket):
    if not openai_client.is_connected or not openai_client.ws:
        return
    try:
        while True:
            raw = await openai_client.ws.recv()
            response_data = json.loads(raw)
            response_type = response_data.get("type", "unknown")
            
            logger.debug(f"📩 Получено сообщение от OpenAI: тип={response_type}")
            
            # Обрабатываем вызовы инструментов (tools)
            if response_type == "tool_call":
                tool_call = response_data.get("tool_call", {})
                
                # Проверяем, что это вызов функции
                if tool_call.get("type") == "function":
                    function_name = tool_call.get("function", {}).get("name")
                    arguments_str = tool_call.get("function", {}).get("arguments", "{}")
                    
                    try:
                        arguments = json.loads(arguments_str)
                    except json.JSONDecodeError:
                        arguments = {"text": arguments_str}
                    
                    logger.info(f"🛠️ Вызов функции: {function_name} с аргументами: {json.dumps(arguments)}")
                    
                    # Вызываем функцию
                    result = await openai_client.handle_function_call(function_name, arguments)
                    
                    # Отправляем результат обратно в OpenAI
                    await openai_client.ws.send(json.dumps({
                        "type": "tool_call.result",
                        "id": response_data.get("id", ""),
                        "result": result
                    }))
                    
                    # Не отправляем клиенту вызов функции
                    continue
            
            # если это аудио-чанк — отдаём как bytes
            if response_type == "audio":
                b64 = response_data.get("data", "")
                chunk = base64.b64decode(b64)
                await websocket.send_bytes(chunk)
                continue

            # все остальные — JSON
            await websocket.send_json(response_data)

            # сохранение текста/транскрипции
            if response_type == "response.text.done":
                text = response_data.get("text", "")
                logger.info(f"📝 Ответ ассистента: {text}")
                if openai_client.db_session and openai_client.conversation_record_id and text:
                    conv = openai_client.db_session.query(Conversation).get(
                        uuid.UUID(openai_client.conversation_record_id)
                    )
                    conv.assistant_message = text
                    openai_client.db_session.commit()
            elif response_type == "conversation.item.input_audio_transcription.completed":
                transcript = response_data.get("transcript", "")
                logger.info(f"🎤 Транскрипция аудио пользователя: {transcript}")
                if openai_client.db_session and openai_client.conversation_record_id and transcript:
                    conv = openai_client.db_session.query(Conversation).get(
                        uuid.UUID(openai_client.conversation_record_id)
                    )
                    conv.user_message = transcript
                    openai_client.db_session.commit()

    except (ConnectionClosed, asyncio.CancelledError):
        logger.info("🔌 Соединение с OpenAI закрыто")
        return
    except Exception as e:
        logger.error(f"❌ Ошибка в обработчике сообщений OpenAI: {e}")
