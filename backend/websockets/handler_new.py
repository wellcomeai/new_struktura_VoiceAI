# backend/websockets/handler_new.py - GA VERSION
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
from backend.websockets.openai_client_new import OpenAIRealtimeClientNew, normalize_function_name  # ✅ НОВЫЙ ИМПОРТ
from backend.services.google_sheets_service import GoogleSheetsService
from backend.functions import execute_function, normalize_function_name

logger = get_logger(__name__)

# Активные соединения по каждому assistant_id
active_connections_ga: Dict[str, List[WebSocket]] = {}  # ✅ НОВЫЙ СЛОВАРЬ


async def handle_websocket_connection_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    ✅ GA VERSION: Handle WebSocket connection using new GA Realtime API.
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    
    # Получаем User-Agent для определения типа устройства
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')

    try:
        await websocket.accept()
        logger.info(f"[GA] WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")

        # Проверяем ElevenLabs агентов (без изменений)
        elevenlabs_agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == assistant_id
        ).first()
        if elevenlabs_agent:
            logger.info(f"[GA] 🎙️ ElevenLabs agent detected: {assistant_id}")
            
            await websocket.send_json({
                "type": "elevenlabs_agent_detected",
                "agent_info": {
                    "id": str(elevenlabs_agent.id),
                    "name": elevenlabs_agent.name,
                    "elevenlabs_agent_id": elevenlabs_agent.elevenlabs_agent_id
                },
                "message": "This is an ElevenLabs agent. Use direct connection to ElevenLabs instead.",
                "suggestion": "Use /api/elevenlabs/{agent_id}/signed-url endpoint for proper connection"
            })
            
            await asyncio.sleep(1)
            await websocket.close(code=1000, reason="ElevenLabs agent should use direct connection")
            return

        logger.info(f"[GA] 🤖 Standard assistant detected: {assistant_id}")

        # Регистрируем соединение в новом словаре
        active_connections_ga.setdefault(assistant_id, []).append(websocket)

        # Загружаем конфиг ассистента (без изменений)
        if assistant_id == "demo":
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
            logger.info(f"[GA] Using assistant {assistant.id if assistant else 'None'} for demo")
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

        # Логирование функций (без изменений)
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        logger.info(f"[GA] Ассистент {assistant_id} имеет следующие функции: {enabled_functions}")

        # Проверка подписки (без изменений)
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    if not subscription_status["active"]:
                        logger.warning(f"[GA] WebSocket blocked for user {user.id} - subscription expired")
                        
                        if subscription_status.get("is_trial", False):
                            error_message = "Ваш пробный период истек. Пожалуйста, оплатите подписку для продолжения использования голосовых ассистентов."
                            error_code = "TRIAL_EXPIRED"
                        else:
                            error_message = "Ваша подписка истекла. Пожалуйста, продлите подписку для продолжения использования голосовых ассистентов."
                            error_code = "SUBSCRIPTION_EXPIRED"
                        
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
                "error": {"code": "no_api_key", "message": "Отсутствует ключ API OpenAI. Пожалуйста, добавьте ключ в настройках личного кабинета."}
            })
            await websocket.close(code=1008)
            return

        # ✅ ПОДКЛЮЧАЕМСЯ К НОВОМУ GA КЛИЕНТУ
        openai_client = OpenAIRealtimeClientNew(api_key, assistant, client_id, db, user_agent)
        if not await openai_client.connect():
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI GA"}
            })
            await websocket.close(code=1008)
            return

        # ✅ СООБЩАЕМ О GA ВЕРСИИ
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "GA Connection established",
            "version": "ga",  # Индикатор GA версии
            "model": "gpt-realtime"
        })

        # УПРОЩЕННАЯ обработка аудио (без изменений)
        audio_buffer = bytearray()
        is_processing = False
        
        # Состояния для обработки перебивания
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        # Запускаем приём сообщений от OpenAI GA
        openai_task = asyncio.create_task(handle_openai_messages_ga(openai_client, websocket, interruption_state))

        # Основной цикл приёма от клиента (БЕЗ ИЗМЕНЕНИЙ)
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
                        logger.info(f"[GA] Получен запрос session.update от клиента {client_id}")
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        logger.info(f"[GA] Клиенту отправлено подтверждение session.update.ack")
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
                        
                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({"type": "input_audio_buffer.commit.ack", "event_id": data.get("event_id")})
                        else:
                            if await openai_client.reconnect():
                                await openai_client.commit_audio()
                                await websocket.send_json({"type": "input_audio_buffer.commit.ack", "event_id": data.get("event_id")})
                            else:
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {"code": "openai_not_connected", "message": "Connection to OpenAI GA lost"}
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
                    
                    # Остальные события перебивания (без изменений)
                    if msg_type == "interruption.manual":
                        logger.info(f"[GA] Ручное перебивание от клиента {client_id}")
                        await openai_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        logger.info(f"[GA] Клиент остановил воспроизведение: {client_id}")
                        openai_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    if msg_type == "microphone.state":
                        mic_enabled = data.get("enabled", True)
                        logger.info(f"[GA] Состояние микрофона от клиента {client_id}: {'включен' if mic_enabled else 'выключен'}")
                        continue
                    
                    if msg_type == "speech.user_started":
                        logger.info(f"[GA] Пользователь начал говорить: {client_id}")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        if interruption_state["is_assistant_speaking"]:
                            logger.info(f"[GA] Перебивание ассистента пользователем: {client_id}")
                            await openai_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        logger.info(f"[GA] Пользователь закончил говорить: {client_id}")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                    if msg_type not in ['session.update']:
                        logger.warning(f"[GA] Неизвестный тип сообщения от клиента {client_id}: {msg_type}")
                        continue

                elif "bytes" in message:
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                break
            except Exception as e:
                logger.error(f"[GA] Error in WebSocket loop: {e}")
                logger.error(f"[GA] Traceback: {traceback.format_exc()}")
                break

        # Завершение
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)

    except Exception as outer_e:
        logger.error(f"[GA] Outer exception in handle_websocket_connection_new: {outer_e}")
        logger.error(f"[GA] Outer traceback: {traceback.format_exc()}")
        
        try:
            await websocket.send_json({
                "type": "error",
                "error": {"code": "server_error", "message": "Внутренняя ошибка сервера GA"}
            })
        except:
            pass
    finally:
        if openai_client:
            await openai_client.close()
        # Убираем из active_connections_ga
        conns = active_connections_ga.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        logger.info(f"[GA] Removed WebSocket connection: client_id={client_id}")


async def handle_openai_messages_ga(openai_client: OpenAIRealtimeClientNew, websocket: WebSocket, interruption_state: Dict):
    """
    ✅ GA VERSION: Handle messages from OpenAI GA Realtime API.
    """
    if not openai_client.is_connected or not openai_client.ws:
        logger.error("[GA] OpenAI клиент не подключен.")
        return
    
    # Переменные для хранения текста диалога и результата функции
    user_transcript = ""
    assistant_transcript = ""
    function_result = None
    
    # Буфер для накопления аргументов функции
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments_buffer": ""
    }
    
    # Флаг ожидания ответа после вызова функции
    waiting_for_function_response = False
    last_function_delivery_status = None
    
    try:
        logger.info(f"[GA] Начало обработки сообщений от OpenAI GA для клиента {openai_client.client_id}")
        logger.info(f"[GA] Текущие разрешенные функции: {openai_client.enabled_functions}")
        
        while True:
            try:
                raw = await openai_client.ws.recv()
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error(f"[GA] Ошибка декодирования JSON: {raw[:200]}")
                    continue
                    
                msg_type = response_data.get("type", "unknown")
                
                # ✅ НОВЫЕ GA СОБЫТИЯ - МОГУТ ОТЛИЧАТЬСЯ
                if msg_type == "session.created":
                    logger.info(f"[GA] 🎉 Session created with GA model")
                    # Отправляем подтверждение клиенту
                    await websocket.send_json({
                        "type": "session.created",
                        "model": "gpt-realtime",
                        "version": "ga"
                    })
                    continue
                
                # Остальная обработка АНАЛОГИЧНА старой версии, но с префиксом [GA]
                if msg_type == "input_audio_buffer.speech_started":
                    logger.info(f"[GA] Пользователь начал говорить (server VAD): {openai_client.client_id}")
                    interruption_state["is_user_speaking"] = True
                    interruption_state["last_speech_start"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.started",
                        "timestamp": interruption_state["last_speech_start"]
                    })
                    continue
                
                if msg_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[GA] Пользователь закончил говорить (server VAD): {openai_client.client_id}")
                    interruption_state["is_user_speaking"] = False
                    interruption_state["last_speech_stop"] = time.time()
                    
                    await websocket.send_json({
                        "type": "speech.stopped",
                        "timestamp": interruption_state["last_speech_stop"]
                    })
                    continue
                
                if msg_type == "conversation.interrupted":
                    logger.info(f"[GA] Получено событие перебивания для клиента {openai_client.client_id}")
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
                    logger.info(f"[GA] Ответ отменен для клиента {openai_client.client_id}")
                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)
                    
                    await websocket.send_json({
                        "type": "response.cancelled",
                        "timestamp": time.time()
                    })
                    continue
                
                # Подробное логирование для ошибок
                if msg_type == "error":
                    logger.error(f"[GA] ОШИБКА API: {json.dumps(response_data, ensure_ascii=False)}")
                    
                    if waiting_for_function_response and "item" in str(response_data.get("error", {})):
                        error_message = response_data.get("error", {}).get("message", "Ошибка отправки результата функции")
                        logger.error(f"[GA] Ошибка при отправке результата функции: {error_message}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка при выполнении функции GA: {error_message}"
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        await openai_client.create_response_after_function()
                        waiting_for_function_response = False
                    else:
                        await websocket.send_json(response_data)
                    continue
                
                logger.info(f"[GA] Получено сообщение от OpenAI GA: тип={msg_type}")
                
                # НАЧАЛО АУДИО ОТВЕТА АССИСТЕНТА
                if msg_type == "response.audio.delta":
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
                
                # ЗАВЕРШЕНИЕ АУДИО ОТВЕТА
                if msg_type == "response.audio.done":
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                
                # ✅ НОВЫЕ GA СОБЫТИЯ ДЛЯ ФУНКЦИЙ - МОГУТ ОТЛИЧАТЬСЯ
                # Здесь может быть другая структура событий в GA
                # Пока оставляем старую логику, но с логами [GA]
                
                # Транскрипции (аналогично старой версии)
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        logger.info(f"[GA] Получена транскрипция пользователя: '{user_transcript}'")
                        
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv:
                                    conv.user_message = user_transcript
                                    openai_client.db_session.commit()
                                    logger.info(f"[GA] Сохранено сообщение пользователя в БД")
                            except Exception as e:
                                logger.error(f"[GA] Ошибка сохранения в БД: {str(e)}")
                
                if msg_type == "response.audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        logger.info(f"[GA] Получена полная транскрипция ассистента: '{assistant_transcript}'")
                
                # ФУНКЦИИ (пока оставляем старую логику с пометкой GA в логах)
                # В GA может измениться структура function calling событий
                
                # Все остальные события пропускаем через websocket как есть
                await websocket.send_json(response_data)

                # ЗАВЕРШЕНИЕ ДИАЛОГА
                if msg_type == "response.done":
                    logger.info(f"[GA] Получен сигнал завершения ответа: response.done")
                    
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time()
                        })
                    
                    logger.info(f"[GA] Завершен диалог. Пользователь: '{user_transcript}'")
                    logger.info(f"[GA] Завершен диалог. Ассистент: '{assistant_transcript}'")
                    
                    # Сохраняем в БД (аналогично старой версии)
                    if openai_client.db_session and openai_client.conversation_record_id and assistant_transcript:
                        logger.info(f"[GA] Сохранение ответа ассистента в БД: {openai_client.conversation_record_id}")
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
                            logger.error(f"[GA] Ошибка при сохранении ответа ассистента: {str(e)}")
                    
                    # Google Sheets логирование
                    if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                        sheet_id = openai_client.assistant_config.google_sheet_id
                        logger.info(f"[GA] Запись диалога в Google Sheet {sheet_id}")
                        
                        if user_transcript or assistant_transcript:
                            try:
                                sheets_result = await GoogleSheetsService.log_conversation(
                                    sheet_id=sheet_id,
                                    user_message=user_transcript,
                                    assistant_message=assistant_transcript,
                                    function_result=function_result
                                )
                                if sheets_result:
                                    logger.info(f"[GA] Успешно записано в Google Sheet")
                                else:
                                    logger.error(f"[GA] Ошибка при записи в Google Sheet")
                            except Exception as e:
                                logger.error(f"[GA] Ошибка при записи в Google Sheet: {str(e)}")
                                logger.error(f"[GA] Трассировка: {traceback.format_exc()}")
                        else:
                            logger.warning(f"[GA] Нет данных для записи в Google Sheet")
                        
                        function_result = None
                    else:
                        logger.info(f"[GA] Запись в Google Sheet пропущена - sheet_id не настроен")
                        
                    waiting_for_function_response = False
                    
            except ConnectionClosed as e:
                logger.warning(f"[GA] Соединение с OpenAI GA закрыто: {e}")
                if await openai_client.reconnect():
                    logger.info("[GA] Соединение с OpenAI GA успешно восстановлено")
                    continue
                else:
                    logger.error("[GA] Не удалось восстановить соединение с OpenAI GA")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Соединение с AI GA потеряно"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        logger.info(f"[GA] Соединение закрыто для клиента {openai_client.client_id}")
        return
    except Exception as e:
        logger.error(f"[GA] Ошибка в обработчике сообщений OpenAI GA: {e}")
        logger.error(f"[GA] Трассировка: {traceback.format_exc()}")
