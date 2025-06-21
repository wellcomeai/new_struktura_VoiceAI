# backend/websockets/handler.py
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
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.openai_client import OpenAIRealtimeClient, normalize_function_name
from backend.services.google_sheets_service import GoogleSheetsService
from backend.functions import execute_function, normalize_function_name

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
    
    # ✅ УЛУЧШЕННОЕ: Определяем тип клиента (веб или Voximplant)
    user_agent = ""
    is_voximplant_client = False
    caller_number = None
    
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')
        
        # ✅ ИСПРАВЛЕНО: Более точное определение Voximplant клиента
        voximplant_header = websocket.headers.get('x-voximplant-call', '')
        voximplant_session = websocket.headers.get('x-voximplant-session', '')
        
        if (voximplant_header or 
            voximplant_session or
            'Voximplant' in user_agent or 
            'Go-http-client' in user_agent or  # Go-http-client - это Voximplant
            'VoxEngine' in user_agent or       # Альтернативный user-agent
            'voximplant' in user_agent.lower()):
            is_voximplant_client = True
            caller_number = (websocket.headers.get('x-caller-number') or 
                           websocket.headers.get('x-caller-id') or 
                           'unknown')
            logger.info(f"🚨 ТЕЛЕФОННЫЙ ЗВОНОК от {caller_number} через Voximplant")
    
    # ✅ НОВОЕ: Дополнительная проверка по IP (если это возможно)
    client_ip = getattr(websocket.client, 'host', '') if hasattr(websocket, 'client') else ''
    if client_ip and ('voximplant' in client_ip.lower() or 
                     client_ip.startswith('185.164.') or  # Известные IP Voximplant
                     client_ip.startswith('185.54.')):
        is_voximplant_client = True
        logger.info(f"🚨 VOXIMPLANT обнаружен по IP: {client_ip}")

    # ✅ СПЕЦИАЛЬНАЯ ОБРАБОТКА: Voximplant телефонные звонки
    if is_voximplant_client:
        logger.info(f"📞 Incoming call from {caller_number} to assistant {assistant_id}")
        logger.info(f"📞 Телефонный режим активирован для клиента {client_id}")
        
        # Специальные настройки для телефонии
        logger.info(f"📞 User-Agent: {user_agent}")
        logger.info(f"📞 Client IP: {client_ip}")
        logger.info(f"📞 Headers: {dict(websocket.headers) if hasattr(websocket, 'headers') else 'N/A'}")

    try:
        await websocket.accept()
        connection_type = "📞 PHONE" if is_voximplant_client else "💻 WEB"
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}, type={connection_type}")

        # Регистрируем соединение
        active_connections.setdefault(assistant_id, []).append(websocket)

        # Загружаем конфиг ассистента
        if assistant_id == "demo":
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
            logger.info(f"Using assistant {assistant.id if assistant else 'None'} for demo")
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

        # Логирование включенных функций для отладки
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        logger.info(f"Ассистент {assistant_id} имеет следующие функции: {enabled_functions}")

        # ✅ УЛУЧШЕННОЕ: Передаем более детальную информацию о типе клиента
        user_agent_with_info = user_agent
        if is_voximplant_client:
            user_agent_with_info = f"Voximplant-Phone-Client/2.0 (caller: {caller_number}, ip: {client_ip})"

        # ✅ ГЛАВНАЯ ПРОВЕРКА: Блокировка WebSocket для пользователей с неактивной подпиской
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                # Проверяем подписку только для НЕ-админов
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    if not subscription_status["active"]:
                        logger.warning(f"WebSocket blocked for user {user.id} - subscription expired")
                        
                        # Определяем тип блокировки
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

        # ✅ ИСПРАВЛЕНО: Подключаемся к OpenAI с передачей обновленного user_agent
        openai_client = OpenAIRealtimeClient(
            api_key, 
            assistant, 
            client_id, 
            db, 
            user_agent_with_info  # ✅ Передаем обновленный user_agent
        )
        
        if not await openai_client.connect():
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        # ✅ УЛУЧШЕННОЕ: Логирование в БД с детальной информацией о соединении
        if openai_client and openai_client.db_session and openai_client.conversation_record_id:
            try:
                conv = openai_client.db_session.query(Conversation).get(
                    uuid.UUID(openai_client.conversation_record_id)
                )
                if conv:
                    # Добавляем подробную информацию о соединении
                    conv.client_info = {
                        "source": "voximplant" if is_voximplant_client else "web",
                        "caller_number": caller_number if is_voximplant_client else None,
                        "type": "phone_call" if is_voximplant_client else "web_session",
                        "user_agent": user_agent,
                        "client_ip": client_ip,
                        "connection_time": time.time(),
                        "headers": dict(websocket.headers) if hasattr(websocket, 'headers') else None
                    }
                    openai_client.db_session.commit()
                    logger.info(f"📞 Сохранена информация о {'телефонном звонке' if is_voximplant_client else 'веб-соединении'} в БД")
            except Exception as e:
                logger.error(f"Ошибка сохранения информации о соединении: {e}")

        # Сообщаем клиенту об успешном подключении
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connection established",
            "client_type": "phone" if is_voximplant_client else "web",
            "optimizations": "voximplant" if is_voximplant_client else "standard",
            "caller_number": caller_number if is_voximplant_client else None
        })

        # ✅ УЛУЧШЕННОЕ: Автоматическое приветствие для телефонных звонков
        if is_voximplant_client and openai_client.is_connected:
            logger.info(f"📞 Отправляем автоматическое приветствие для телефонного звонка")
            try:
                # Более быстрое приветствие для телефонии
                greeting_response = await openai_client.ws.send(json.dumps({
                    "type": "response.create",
                    "event_id": f"phone_greeting_{int(time.time() * 1000)}",
                    "response": {
                        "modalities": ["audio", "text"],
                        "instructions": "Кратко поприветствуй звонящего и спроси чем можешь помочь. Будь дружелюбным но лаконичным.",
                        "max_output_tokens": 100,  # Короткое приветствие
                        "temperature": 0.6
                    }
                }))
                logger.info(f"📞 Автоматическое приветствие отправлено")
            except Exception as e:
                logger.error(f"📞 Ошибка отправки приветствия: {e}")

        # ✅ НОВОЕ: Определяем режим обработки аудио в зависимости от клиента
        if is_voximplant_client:
            # Для Voximplant используем более простую схему без сложных буферов
            audio_processing_mode = "voximplant_direct"
            logger.info(f"📞 Режим обработки аудио: {audio_processing_mode}")
        else:
            # Для веб-клиентов используем стандартную схему
            audio_processing_mode = "web_buffered"
        
        # УПРОЩЕННАЯ обработка аудио - микрофон постоянно активен
        audio_buffer = bytearray()
        is_processing = False
        
        # Упрощенные состояния для обработки перебивания
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0,
            "processing_mode": audio_processing_mode,
            "client_type": "voximplant" if is_voximplant_client else "web"
        }

        # Запускаем приём сообщений от OpenAI
        openai_task = asyncio.create_task(handle_openai_messages(openai_client, websocket, interruption_state))

        # Основной цикл приёма от клиента
        while True:
            try:
                message = await websocket.receive()

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong", "timestamp": time.time()})
                        continue

                    # ✅ НОВОЕ: Улучшенная обработка информации о Voximplant звонке
                    if msg_type == "voximplant.call_info":
                        logger.info(f"📞 Получена информация о Voximplant звонке от клиента {client_id}")
                        is_voximplant_client = True
                        caller_number = data.get("caller_number", "unknown")
                        logger.info(f"🚨 ТЕЛЕФОННЫЙ ЗВОНОК от {caller_number} через Voximplant (из сообщения)")
                        
                        # Обновляем информацию в БД
                        if openai_client and openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv:
                                    if not conv.client_info:
                                        conv.client_info = {}
                                    conv.client_info.update({
                                        "source": "voximplant",
                                        "caller_number": caller_number,
                                        "type": "phone_call",
                                        "detected_from": "message",
                                        "message_time": time.time(),
                                        "event_id": data.get("event_id")
                                    })
                                    openai_client.db_session.commit()
                                    logger.info(f"📞 Обновлена информация о телефонном звонке в БД")
                            except Exception as e:
                                logger.error(f"Ошибка обновления информации о звонке: {e}")
                        
                        await websocket.send_json({
                            "type": "voximplant.call_info.ack", 
                            "event_id": data.get("event_id"),
                            "message": "Call info received",
                            "optimizations_applied": True,
                            "processing_mode": audio_processing_mode
                        })
                        continue

                    # ИСПРАВЛЕНИЕ: Обрабатываем session.update от клиента
                    if msg_type == "session.update":
                        logger.info(f"[SESSION] Получен запрос session.update от клиента {client_id}")
                        # НЕ обрабатываем его - сервер сам управляет сессией
                        # Просто отправляем подтверждение
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}"),
                            "message": "Session managed by server"
                        })
                        logger.info(f"[SESSION] Клиенту отправлено подтверждение session.update.ack")
                        continue

                    # ✅ УЛУЧШЕННАЯ обработка аудио для разных типов клиентов
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        
                        if audio_processing_mode == "voximplant_direct":
                            # Для Voximplant: прямая отправка без буферизации для лучшей производительности
                            if openai_client.is_connected:
                                await openai_client.process_audio(audio_chunk)
                                logger.debug(f"📞 Voximplant audio chunk processed directly: {len(audio_chunk)} bytes")
                        else:
                            # Для веб: стандартная буферизация
                            audio_buffer.extend(audio_chunk)
                            if openai_client.is_connected:
                                await openai_client.process_audio(audio_chunk)
                        
                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack", 
                            "event_id": data.get("event_id"),
                            "processing_mode": audio_processing_mode,
                            "bytes_processed": len(audio_chunk)
                        })
                        continue

                    if msg_type == "input_audio_buffer.commit" and not is_processing:
                        is_processing = True
                        
                        # ✅ АДАПТИВНАЯ обработка в зависимости от типа клиента
                        if audio_processing_mode == "voximplant_direct":
                            logger.info(f"📞 Voximplant audio commit - direct mode")
                        
                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({
                                "type": "input_audio_buffer.commit.ack", 
                                "event_id": data.get("event_id"),
                                "processing_mode": audio_processing_mode,
                                "buffer_size": len(audio_buffer)
                            })
                        else:
                            # Пробуем восстановить соединение
                            logger.warning(f"OpenAI connection lost, attempting to reconnect for {client_id}")
                            if await openai_client.reconnect():
                                await openai_client.commit_audio()
                                await websocket.send_json({
                                    "type": "input_audio_buffer.commit.ack", 
                                    "event_id": data.get("event_id"),
                                    "reconnected": True,
                                    "processing_mode": audio_processing_mode
                                })
                                logger.info(f"OpenAI connection restored for {client_id}")
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
                        await websocket.send_json({
                            "type": "input_audio_buffer.clear.ack", 
                            "event_id": data.get("event_id"),
                            "processing_mode": audio_processing_mode
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
                    
                    # Обработка событий перебивания и управления микрофоном
                    if msg_type == "interruption.manual":
                        logger.info(f"[INTERRUPTION] Ручное перебивание от клиента {client_id}")
                        await openai_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id"),
                            "timestamp": time.time()
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        # Клиент сообщает о том, что остановил воспроизведение
                        logger.info(f"[INTERRUPTION] Клиент остановил воспроизведение: {client_id}")
                        openai_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    # НОВЫЕ типы сообщений для синхронизации состояний
                    if msg_type == "microphone.state":
                        # Клиент сообщает о состоянии микрофона (включен/выключен)
                        mic_enabled = data.get("enabled", True)
                        logger.info(f"[MIC] Состояние микрофона от клиента {client_id}: {'включен' if mic_enabled else 'выключен'}")
                        # В нашем случае микрофон всегда должен быть включен, но можем логировать
                        continue
                    
                    if msg_type == "speech.user_started":
                        # Клиент сообщает о начале речи пользователя
                        logger.info(f"[SPEECH] Пользователь начал говорить: {client_id}")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        # Если ассистент говорил, это перебивание
                        if interruption_state["is_assistant_speaking"]:
                            logger.info(f"[INTERRUPTION] Перебивание ассистента пользователем: {client_id}")
                            await openai_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        # Клиент сообщает об окончании речи пользователя
                        logger.info(f"[SPEECH] Пользователь закончил говорить: {client_id}")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                    # ✅ НОВОЕ: Обработка специфичных для Voximplant сообщений
                    if msg_type == "voximplant.status":
                        # Voximplant может отправлять статусные сообщения
                        status = data.get("status", "unknown")
                        logger.info(f"📞 Voximplant status: {status}")
                        await websocket.send_json({
                            "type": "voximplant.status.ack",
                            "event_id": data.get("event_id"),
                            "received_status": status
                        })
                        continue

                    if msg_type == "voximplant.audio_quality":
                        # Информация о качестве аудио от Voximplant
                        quality_info = data.get("quality", {})
                        logger.info(f"📞 Voximplant audio quality: {quality_info}")
                        continue

                    # ИСПРАВЛЕНИЕ: Логируем неизвестные типы сообщений но не отправляем ошибку
                    if msg_type not in ['session.update']:  # Исключаем известные типы которые мы не обрабатываем
                        logger.warning(f"[MESSAGE] Неизвестный тип сообщения от клиента {client_id}: {msg_type}")
                        # НЕ отправляем ошибку клиенту, просто игнорируем
                        continue

                elif "bytes" in message:
                    # raw-байты от клиента
                    raw_bytes = message["bytes"]
                    audio_buffer.extend(raw_bytes)
                    logger.debug(f"Received raw bytes: {len(raw_bytes)}")
                    await websocket.send_json({
                        "type": "binary.ack",
                        "bytes_received": len(raw_bytes),
                        "processing_mode": audio_processing_mode
                    })

            except (WebSocketDisconnect, ConnectionClosed):
                logger.info(f"WebSocket disconnected for client {client_id}")
                break
            except Exception as e:
                logger.error(f"Error in WebSocket loop: {e}")
                logger.error(f"Traceback: {traceback.format_exc()}")
                break

        # завершение
        if not openai_task.done():
            openai_task.cancel()
            await asyncio.sleep(0)

    except Exception as outer_e:
        logger.error(f"Outer exception in handle_websocket_connection: {outer_e}")
        logger.error(f"Outer traceback: {traceback.format_exc()}")
        
        # Попытаемся отправить ошибку клиенту если соединение еще активно
        try:
            await websocket.send_json({
                "type": "error",
                "error": {"code": "server_error", "message": "Внутренняя ошибка сервера"},
                "client_id": client_id
            })
        except:
            pass  # Игнорируем ошибки при отправке
    finally:
        if openai_client:
            await openai_client.close()
        # убираем из active_connections
        conns = active_connections.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        logger.info(f"[DEBUG] Соединение закрыто для клиента {client_id}")


async def handle_openai_messages(openai_client: OpenAIRealtimeClient, websocket: WebSocket, interruption_state: Dict):
    if not openai_client.is_connected or not openai_client.ws:
        logger.error("OpenAI клиент не подключен.")
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
    
    # Определяем тип клиента для логирования
    client_type = interruption_state.get("client_type", "unknown")
    processing_mode = interruption_state.get("processing_mode", "standard")
    
    try:
        logger.info(f"[DEBUG] Начало обработки сообщений от OpenAI для клиента {openai_client.client_id} (тип: {client_type})")
        logger.info(f"[DEBUG-FUNCTION] Текущие разрешенные функции: {openai_client.enabled_functions}")
        
        while True:
            try:
                raw = await openai_client.ws.recv()
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error(f"[DEBUG] Ошибка декодирования JSON: {raw[:200]}")
                    continue
                    
                msg_type = response_data.get("type", "unknown")
                
                # УПРОЩЕННАЯ обработка событий перебивания
                if msg_type == "input_audio_buffer.speech_started":
                    logger.info(f"[INTERRUPTION] Пользователь начал говорить (server VAD): {openai_client.client_id}")
                    interruption_state["is_user_speaking"] = True
                    interruption_state["last_speech_start"] = time.time()
                    
                    # Отправляем событие клиенту
                    await websocket.send_json({
                        "type": "speech.started",
                        "timestamp": interruption_state["last_speech_start"],
                        "detected_by": "server_vad"
                    })
                    continue
                
                if msg_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[INTERRUPTION] Пользователь закончил говорить (server VAD): {openai_client.client_id}")
                    interruption_state["is_user_speaking"] = False
                    interruption_state["last_speech_stop"] = time.time()
                    
                    # Отправляем событие клиенту
                    await websocket.send_json({
                        "type": "speech.stopped",
                        "timestamp": interruption_state["last_speech_stop"],
                        "detected_by": "server_vad"
                    })
                    continue
                
                if msg_type == "conversation.interrupted":
                    logger.info(f"[INTERRUPTION] Получено событие перебивания для клиента {openai_client.client_id}")
                    interruption_state["interruption_count"] += 1
                    interruption_state["last_interruption_time"] = time.time()
                    
                    # Обрабатываем перебивание в OpenAI клиенте
                    await openai_client.handle_interruption()
                    
                    # Останавливаем воспроизведение ассистента
                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)
                    
                    # Отправляем событие перебивания клиенту
                    await websocket.send_json({
                        "type": "conversation.interrupted",
                        "timestamp": interruption_state["last_interruption_time"],
                        "interruption_count": interruption_state["interruption_count"],
                        "client_type": client_type
                    })
                    continue
                
                if msg_type == "response.cancelled":
                    logger.info(f"[INTERRUPTION] Ответ отменен для клиента {openai_client.client_id}")
                    interruption_state["is_assistant_speaking"] = False
                    openai_client.set_assistant_speaking(False)
                    
                    # Отправляем событие клиенту
                    await websocket.send_json({
                        "type": "response.cancelled",
                        "timestamp": time.time(),
                        "client_type": client_type
                    })
                    continue
                
                # Подробное логирование для ошибок
                if msg_type == "error":
                    logger.error(f"[DEBUG] ОШИБКА API: {json.dumps(response_data, ensure_ascii=False)}")
                    
                    if waiting_for_function_response and "item" in str(response_data.get("error", {})):
                        error_message = response_data.get("error", {}).get("message", "Ошибка отправки результата функции")
                        logger.error(f"[DEBUG] Ошибка при отправке результата функции: {error_message}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка при выполнении функции: {error_message}"
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        await openai_client.create_response_after_function()
                        
                        waiting_for_function_response = False
                    else:
                        await websocket.send_json(response_data)
                    continue
                
                logger.info(f"[DEBUG] Получено сообщение от OpenAI: тип={msg_type}")
                
                if "transcript" in msg_type or "transcription" in msg_type:
                    try:
                        logger.info(f"[DEBUG-TRANSCRIPT] Данные события: {json.dumps(response_data, ensure_ascii=False)}")
                    except:
                        logger.info(f"[DEBUG-TRANSCRIPT] Данные события (не JSON): {response_data}")
                
                # ✅ ИСПРАВЛЕННАЯ обработка начала аудио ответа ассистента
                if msg_type == "response.audio.delta":
                    if not interruption_state["is_assistant_speaking"]:
                        # Ассистент начал генерировать аудио
                        response_id = response_data.get("response_id", f"resp_{time.time()}")
                        interruption_state["is_assistant_speaking"] = True
                        openai_client.set_assistant_speaking(True, response_id)
                        
                        # Отправляем событие клиенту
                        await websocket.send_json({
                            "type": "assistant.speech.started",
                            "response_id": response_id,
                            "timestamp": time.time(),
                            "client_type": client_type
                        })
                    
                    # Подсчитываем аудио семплы для точной отмены
                    delta_audio = response_data.get("delta", "")
                    if delta_audio:
                        try:
                            sample_count = len(base64.b64decode(delta_audio)) // 2
                            openai_client.increment_audio_samples(sample_count)
                        except:
                            pass  # Игнорируем ошибки декодирования
                
                # ✅ ИСПРАВЛЕННОЕ завершение аудио ответа ассистента
                if msg_type == "response.audio.done":
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        # Отправляем событие клиенту
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time(),
                            "client_type": client_type
                        })
                
                # Обработка функций (остается без изменений, но с улучшенным логированием)
                if msg_type == "response.function_call.started":
                    function_name = response_data.get("function_name")
                    function_call_id = response_data.get("call_id")
                    
                    logger.info(f"[DEBUG] Начало вызова функции: {function_name}, ID: {function_call_id}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        if function_call_id:
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
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
                        "function_call_id": function_call_id,
                        "client_type": client_type
                    })
                
                elif msg_type == "response.function_call_arguments.delta":
                    delta = response_data.get("delta", "")
                    
                    if not pending_function_call["name"] and "call_id" in response_data:
                        pending_function_call["call_id"] = response_data.get("call_id")
                        
                        first_part = delta[:100]
                        logger.info(f"[DEBUG] Получена первая часть аргументов функции: '{first_part}'")
                        
                        if "url" in delta or "event" in delta:
                            pending_function_call["name"] = "send_webhook"
                            logger.info(f"[DEBUG] Определена функция по аргументам: send_webhook")
                        elif "namespace" in delta or "query" in delta:
                            pending_function_call["name"] = "search_pinecone"
                            logger.info(f"[DEBUG] Определена функция по аргументам: search_pinecone")
                    
                    pending_function_call["arguments_buffer"] += delta

                elif msg_type == "response.function_call_arguments.done":
                    arguments_str = response_data.get("arguments", pending_function_call["arguments_buffer"])
                    
                    function_name = response_data.get("function_name", pending_function_call["name"])
                    function_call_id = response_data.get("call_id", pending_function_call["call_id"])
                    
                    logger.info(f"[DEBUG-FUNCTION] Завершение получения аргументов для функции: {function_name}")
                    
                    if not function_name and arguments_str:
                        if "url" in arguments_str:
                            function_name = "send_webhook"
                            logger.info(f"[DEBUG-FUNCTION] Определена функция по аргументам: send_webhook")
                        elif "namespace" in arguments_str and "query" in arguments_str:
                            function_name = "search_pinecone"
                            logger.info(f"[DEBUG-FUNCTION] Определена функция по аргументам: search_pinecone")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    logger.info(f"[DEBUG-FUNCTION] Нормализация окончательного имени: {function_name} -> {normalized_name}")
                    
                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        if function_call_id:
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)
                            
                        pending_function_call = {
                            "name": None,
                            "call_id": None,
                            "arguments_buffer": ""
                        }
                        continue
                    
                    if function_call_id and normalized_name:
                        logger.info(f"[DEBUG] Получены все аргументы функции {normalized_name}: {arguments_str}")
                        
                        try:
                            arguments = json.loads(arguments_str)
                            
                            await websocket.send_json({
                                "type": "function_call.start",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "client_type": client_type
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
                                logger.error(f"[DEBUG] Ошибка отправки результата функции: {delivery_status['error']}")
                                
                                error_message = {
                                    "type": "response.content_part.added",
                                    "content": {
                                        "text": f"Произошла ошибка при выполнении функции: {delivery_status['error']}"
                                    }
                                }
                                await websocket.send_json(error_message)
                                
                                await openai_client.create_response_after_function()
                                
                                waiting_for_function_response = False
                            
                            await websocket.send_json({
                                "type": "function_call.completed",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "result": result,
                                "client_type": client_type
                            })
                            
                            if normalized_name == "send_webhook" and waiting_for_function_response:
                                status_code = result.get("status", 0)
                                
                                if status_code == 404:
                                    webhook_error_message = {
                                        "type": "response.content_part.added",
                                        "content": {
                                            "text": f"Вебхук не найден (ошибка 404). Запрос был отправлен на URL: {arguments.get('url', 'неизвестный URL')}, но такой вебхук не зарегистрирован. Пожалуйста, проверьте настройки n8n и повторите попытку."
                                        }
                                    }
                                    await websocket.send_json(webhook_error_message)
                                    
                                    waiting_for_function_response = False
                            
                        except json.JSONDecodeError as e:
                            error_msg = f"Ошибка при парсинге аргументов функции: {e}"
                            logger.error(f"[DEBUG] {error_msg}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_args_error", "message": error_msg}
                            })
                        except Exception as e:
                            error_msg = f"Ошибка при выполнении функции: {e}"
                            logger.error(f"[DEBUG] {error_msg}")
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": error_msg}
                            })
                    
                    pending_function_call = {
                        "name": None,
                        "call_id": None,
                        "arguments_buffer": ""
                    }

                elif msg_type == "response.content_part.added":
                    if waiting_for_function_response:
                        logger.info(f"[DEBUG] Получен ответ после выполнения функции")
                        waiting_for_function_response = False
                    
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text
                        logger.info(f"[DEBUG] Из response.content_part.added получен текст ассистента: '{new_text}'")
                
                elif msg_type == "function_call":
                    function_call_id = response_data.get("function_call_id")
                    function_data = response_data.get("function", {})
                    function_name = function_data.get("name")
                    
                    logger.info(f"[DEBUG] Получен вызов функции (legacy): {function_name}, аргументы: {function_data.get('arguments')}")
                    
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    if normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        if function_call_id:
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)
                        continue
                    
                    await websocket.send_json({
                        "type": "function_call.start",
                        "function": normalized_name,
                        "function_call_id": function_call_id,
                        "client_type": client_type
                    })
                    
                    result = await execute_function(
                        name=normalized_name,
                        arguments=function_data.get("arguments", {}),
                        context={
                            "assistant_config": openai_client.assistant_config,
                            "client_id": openai_client.client_id,
                            "db_session": openai_client.db_session
                        }
                    )
                    
                    logger.info(f"[DEBUG] Результат выполнения функции: {result}")
                    
                    function_result = result
                    
                    delivery_status = await openai_client.send_function_result(function_call_id, result)
                    
                    await websocket.send_json({
                        "type": "function_call.completed",
                        "function": normalized_name,
                        "function_call_id": function_call_id,
                        "result": result,
                        "client_type": client_type
                    })
                    
                    continue

                # Обработка транскрипции ввода пользователя
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        logger.info(f"[DEBUG] Получена транскрипция пользователя: '{user_transcript}'")
                        
                        if openai_client.db_session and openai_client.conversation_record_id:
                            try:
                                conv = openai_client.db_session.query(Conversation).get(
                                    uuid.UUID(openai_client.conversation_record_id)
                                )
                                if conv:
                                    conv.user_message = user_transcript
                                    openai_client.db_session.commit()
                                    logger.info(f"[DEBUG] Сохранено сообщение пользователя в БД")
                            except Exception as e:
                                logger.error(f"[DEBUG] Ошибка сохранения в БД: {str(e)}")
                
                if msg_type == "response.audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text
                    logger.info(f"[DEBUG] Получен фрагмент транскрипции ассистента: '{delta_text}'")
                
                if msg_type == "conversation.item.input_audio_transcription.delta":
                    delta_text = response_data.get("delta", "")
                    user_transcript += delta_text
                    logger.info(f"[DEBUG] Получен фрагмент транскрипции пользователя: '{delta_text}'")
                
                if msg_type == "response.audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        logger.info(f"[DEBUG] Получена полная транскрипция ассистента: '{assistant_transcript}'")
                
                if msg_type == "conversation.item.created":
                    item = response_data.get("item", {})
                    role = item.get("role", "")
                    content = item.get("content", [])
                    
                    if role == "user":
                        for part in content:
                            if part.get("type") == "input_audio" and "transcript" in part:
                                part_transcript = part.get("transcript", "")
                                if part_transcript:
                                    user_transcript = part_transcript
                                    logger.info(f"[DEBUG] Из conversation.item.created получена транскрипция пользователя: '{user_transcript}'")
                            elif part.get("type") == "input_text" and "text" in part:
                                part_text = part.get("text", "")
                                if part_text:
                                    user_transcript = part_text
                                    logger.info(f"[DEBUG] Из conversation.item.created получен текст пользователя: '{user_transcript}'")

                if msg_type == "audio":
                    b64 = response_data.get("data", "")
                    try:
                        chunk = base64.b64decode(b64)
                        await websocket.send_bytes(chunk)
                    except Exception as e:
                        logger.error(f"Error sending audio bytes: {e}")
                    continue
                
                if msg_type == "response.output_item.done":
                    if waiting_for_function_response and last_function_delivery_status:
                        if openai_client.last_function_name == "send_webhook" and function_result:
                            status_code = function_result.get("status", 0)
                            
                            message_text = ""
                            if status_code == 404:
                                message_text = "Вебхук не найден (ошибка 404). Возможно, он не зарегистрирован или не активирован."
                            elif status_code >= 200 and status_code < 300:
                                message_text = "Вебхук успешно выполнен."
                            else:
                                message_text = f"Вебхук вернул статус {status_code}."
                            
                            await websocket.send_json({
                                "type": "response.content_part.added",
                                "content": {
                                    "text": message_text
                                }
                            })
                            
                            await openai_client.create_response_after_function()
                        
                        waiting_for_function_response = False

                # все остальные — JSON
                await websocket.send_json(response_data)

                # Завершение диалога - записываем данные в БД и Google Sheets
                if msg_type == "response.done":
                    logger.info(f"[DEBUG] Получен сигнал завершения ответа: response.done")
                    
                    # ИСПРАВЛЕННОЕ - устанавливаем что ассистент больше не говорит
                    if interruption_state["is_assistant_speaking"]:
                        interruption_state["is_assistant_speaking"] = False
                        openai_client.set_assistant_speaking(False)
                        
                        # Отправляем событие клиенту
                        await websocket.send_json({
                            "type": "assistant.speech.ended",
                            "timestamp": time.time(),
                            "client_type": client_type
                        })
                    
                    logger.info(f"[DEBUG] Завершен диалог. Пользователь: '{user_transcript}'")
                    logger.info(f"[DEBUG] Завершен диалог. Ассистент: '{assistant_transcript}'")
                    
                    # Сохраняем сообщение ассистента в БД
                    if openai_client.db_session and openai_client.conversation_record_id and assistant_transcript:
                        logger.info(f"[DEBUG] Сохранение ответа ассистента в БД: {openai_client.conversation_record_id}")
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
                            logger.error(f"[DEBUG] Ошибка при сохранении ответа ассистента: {str(e)}")
                    
                    # Google Sheets логирование
                    if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                        sheet_id = openai_client.assistant_config.google_sheet_id
                        logger.info(f"[DEBUG] Запись диалога в Google Sheet {sheet_id}")
                        
                        if not user_transcript and not assistant_transcript:
                            logger.warning(f"[DEBUG] Пустые тексты диалога, попробуем использовать данные из БД")
                            if openai_client.db_session and openai_client.conversation_record_id:
                                try:
                                    conv = openai_client.db_session.query(Conversation).get(
                                        uuid.UUID(openai_client.conversation_record_id)
                                    )
                                    if conv:
                                        user_transcript = conv.user_message or ""
                                        assistant_transcript = conv.assistant_message or ""
                                        logger.info(f"[DEBUG] Получены данные из БД: пользователь: '{user_transcript}', ассистент: '{assistant_transcript}'")
                                except Exception as e:
                                    logger.error(f"[DEBUG] Ошибка при получении данных из БД: {str(e)}")
                        
                        if user_transcript or assistant_transcript:
                            try:
                                sheets_result = await GoogleSheetsService.log_conversation(
                                    sheet_id=sheet_id,
                                    user_message=user_transcript,
                                    assistant_message=assistant_transcript,
                                    function_result=function_result
                                )
                                if sheets_result:
                                    logger.info(f"[DEBUG] Успешно записано в Google Sheet")
                                else:
                                    logger.error(f"[DEBUG] Ошибка при записи в Google Sheet")
                            except Exception as e:
                                logger.error(f"[DEBUG] Ошибка при записи в Google Sheet: {str(e)}")
                                logger.error(f"[DEBUG] Трассировка: {traceback.format_exc()}")
                        else:
                            logger.warning(f"[DEBUG] Нет данных для записи в Google Sheet")
                        
                        function_result = None
                    else:
                        logger.info(f"[DEBUG] Запись в Google Sheet пропущена - sheet_id не настроен")
                        
                    waiting_for_function_response = False
                    
            except ConnectionClosed as e:
                logger.warning(f"[DEBUG] Соединение с OpenAI закрыто: {e}")
                if await openai_client.reconnect():
                    logger.info("[DEBUG] Соединение с OpenAI успешно восстановлено")
                    continue
                else:
                    logger.error("[DEBUG] Не удалось восстановить соединение с OpenAI")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "openai_connection_lost", "message": "Соединение с AI потеряно"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        logger.info(f"[DEBUG] Соединение закрыто для клиента {openai_client.client_id}")
        return
    except Exception as e:
        logger.error(f"[DEBUG] Ошибка в обработчике сообщений OpenAI: {e}")
        logger.error(f"[DEBUG] Трассировка: {traceback.format_exc()}")
