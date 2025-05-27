# backend/websockets/handler.py
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
import traceback
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

    try:
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")

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

        # Определяем API-ключ
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user and user.openai_api_key:
                api_key = user.openai_api_key
        # Удаляем использование глобального ключа и сразу выдаем ошибку
        if not api_key:
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Отсутствует ключ API OpenAI. Пожалуйста, добавьте ключ в настройках личного кабинета."}
            })
            await websocket.close(code=1008)
            return

        # Подключаемся к OpenAI
        openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
        if not await openai_client.connect():
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

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
                        
                        # Добавляем проверку минимального размера буфера (примерно 100мс аудио при 16kHz/16bit/mono)
                        if not audio_buffer or len(audio_buffer) < 3200:  
                            await websocket.send_json({
                                "type": "warning",
                                "warning": {"code": "audio_buffer_too_small", "message": "Аудио слишком короткое, попробуйте говорить дольше"}
                            })
                            audio_buffer.clear()
                            is_processing = False
                            continue

                        if openai_client.is_connected:
                            await openai_client.commit_audio()
                            await websocket.send_json({"type": "input_audio_buffer.commit.ack", "event_id": data.get("event_id")})
                        else:
                            # Пробуем восстановить соединение
                            if await openai_client.reconnect():
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

                    # Любые остальные типы
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "unknown_message_type", "message": f"Unknown message type: {msg_type}"}
                    })

                elif "bytes" in message:
                    # raw-байты от клиента
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                break
            except Exception as e:
                logger.error(f"Error in WebSocket loop: {e}")
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
        logger.info(f"Removed WebSocket connection: client_id={client_id}")


async def handle_openai_messages(openai_client: OpenAIRealtimeClient, websocket: WebSocket):
    if not openai_client.is_connected or not openai_client.ws:
        logger.error("OpenAI клиент не подключен.")
        return
    
    # Переменные для хранения текста диалога и результата функции
    user_transcript = ""
    assistant_transcript = ""
    function_result = None
    
    # Буфер для накопления аргументов функции
    pending_function_call = {
        "name": None,          # Имя функции (устанавливается при .started или извлекается из первого delta)
        "call_id": None,       # ID вызова функции
        "arguments_buffer": "" # Накопленные аргументы
    }
    
    # Флаг ожидания ответа после вызова функции
    waiting_for_function_response = False
    last_function_delivery_status = None
    
    try:
        logger.info(f"[DEBUG] Начало обработки сообщений от OpenAI для клиента {openai_client.client_id}")
        logger.info(f"[DEBUG-FUNCTION] Текущие разрешенные функции: {openai_client.enabled_functions}")
        
        while True:
            try:
                raw = await openai_client.ws.recv()
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error(f"[DEBUG] Ошибка декодирования JSON: {raw[:200]}")
                    continue
                    
                # Логирование каждого полученного сообщения
                msg_type = response_data.get("type", "unknown")
                
                # Подробное логирование для ошибок
                if msg_type == "error":
                    logger.error(f"[DEBUG] ОШИБКА API: {json.dumps(response_data, ensure_ascii=False)}")
                    
                    # Если ошибка связана с отправкой результата функции, обрабатываем особым образом
                    if waiting_for_function_response and "item" in str(response_data.get("error", {})):
                        error_message = response_data.get("error", {}).get("message", "Ошибка отправки результата функции")
                        logger.error(f"[DEBUG] Ошибка при отправке результата функции: {error_message}")
                        
                        # Создаем свое сообщение пользователю об ошибке
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка при выполнении функции: {error_message}"
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        # После сообщения об ошибке явно запрашиваем новый ответ для генерации аудио
                        await openai_client.create_response_after_function()
                        
                        # Сбрасываем флаг ожидания
                        waiting_for_function_response = False
                    else:
                        # Отправляем остальные ошибки клиенту
                        await websocket.send_json(response_data)
                    continue
                
                logger.info(f"[DEBUG] Получено сообщение от OpenAI: тип={msg_type}")
                
                # Дополнительное логирование для транскрипции
                if "transcript" in msg_type or "transcription" in msg_type:
                    try:
                        logger.info(f"[DEBUG-TRANSCRIPT] Данные события: {json.dumps(response_data, ensure_ascii=False)}")
                    except:
                        logger.info(f"[DEBUG-TRANSCRIPT] Данные события (не JSON): {response_data}")
                
                # Обработка вызова функции
                if msg_type == "response.function_call.started":
                    # Получаем данные о функции из события
                    function_name = response_data.get("function_name")
                    function_call_id = response_data.get("call_id")
                    
                    logger.info(f"[DEBUG] Начало вызова функции: {function_name}, ID: {function_call_id}")
                    
                    # Нормализуем имя функции
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    # Проверяем, разрешена ли функция
                    if normalized_name not in openai_client.enabled_functions:
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        # Отправляем сообщение об ошибке пользователю
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        # Отменяем вызов функции, если система все же пытается её вызвать
                        if function_call_id:
                            # Отправляем пустой результат или ошибку
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)
                            
                        continue
                    
                    # Инициализируем данные о текущем вызове функции
                    pending_function_call = {
                        "name": normalized_name,
                        "call_id": function_call_id,
                        "arguments_buffer": ""
                    }
                    
                    # Уведомляем клиента о начале вызова функции
                    await websocket.send_json({
                        "type": "function_call.started",
                        "function": normalized_name,
                        "function_call_id": function_call_id
                    })
                
                # Обработка аргументов функции (начало, если нет response.function_call.started)
                elif msg_type == "response.function_call_arguments.delta":
                    # Добавляем аргументы в буфер
                    delta = response_data.get("delta", "")
                    
                    # Извлекаем имя функции и ID из первого delta, если их еще нет
                    if not pending_function_call["name"] and "call_id" in response_data:
                        pending_function_call["call_id"] = response_data.get("call_id")
                        
                        # Логирум первую часть delta для отладки
                        first_part = delta[:100]
                        logger.info(f"[DEBUG] Получена первая часть аргументов функции: '{first_part}'")
                        
                        # Определение функции по содержимому аргументов
                        if "url" in delta or "event" in delta:
                            pending_function_call["name"] = "send_webhook"
                            logger.info(f"[DEBUG] Определена функция по аргументам: send_webhook")
                        elif "namespace" in delta or "query" in delta:
                            pending_function_call["name"] = "search_pinecone"
                            logger.info(f"[DEBUG] Определена функция по аргументам: search_pinecone")
                    
                    # Добавляем часть аргументов в буфер
                    pending_function_call["arguments_buffer"] += delta
                
                # Завершение получения аргументов и вызов функции
                elif msg_type == "response.function_call_arguments.done":
                    # Получаем окончательные аргументы
                    arguments_str = response_data.get("arguments", pending_function_call["arguments_buffer"])
                    
                    # Если не получили имя функции через started, но есть в done
                    function_name = response_data.get("function_name", pending_function_call["name"])
                    function_call_id = response_data.get("call_id", pending_function_call["call_id"])
                    
                    # Добавляем явное логирование имени функции
                    logger.info(f"[DEBUG-FUNCTION] Завершение получения аргументов для функции: {function_name}")
                    
                    # Восстановить имя функции по содержимому аргументов, если она не определена
                    if not function_name and arguments_str:
                        if "url" in arguments_str:
                            function_name = "send_webhook"
                            logger.info(f"[DEBUG-FUNCTION] Определена функция по аргументам: send_webhook")
                        elif "namespace" in arguments_str and "query" in arguments_str:
                            function_name = "search_pinecone"
                            logger.info(f"[DEBUG-FUNCTION] Определена функция по аргументам: search_pinecone")
                    
                    # Нормализация имени функции
                    normalized_name = normalize_function_name(function_name) or function_name
                    logger.info(f"[DEBUG-FUNCTION] Нормализация окончательного имени: {function_name} -> {normalized_name}")
                    
                    # Проверяем, разрешена ли функция
                    if normalized_name and normalized_name not in openai_client.enabled_functions:
                        # Если функция не разрешена, логируем это и сообщаем пользователю
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        # Отправляем сообщение об ошибке пользователю
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        # Отправляем пустой результат или ошибку, чтобы разблокировать модель
                        if function_call_id:
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)
                            
                        # Сбрасываем буфер аргументов для следующего вызова
                        pending_function_call = {
                            "name": None,
                            "call_id": None,
                            "arguments_buffer": ""
                        }
                        continue
                    
                    # Для разрешенных функций продолжаем нормальную обработку
                    if function_call_id and normalized_name:
                        logger.info(f"[DEBUG] Получены все аргументы функции {normalized_name}: {arguments_str}")
                        
                        try:
                            # Парсим аргументы из JSON-строки
                            arguments = json.loads(arguments_str)
                            
                            # Сообщаем клиенту о процессе выполнения функции
                            await websocket.send_json({
                                "type": "function_call.start",
                                "function": normalized_name,
                                "function_call_id": function_call_id
                            })
                            
                            # Выполняем функцию через новую систему
                            result = await execute_function(
                                name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": openai_client.assistant_config,
                                    "client_id": openai_client.client_id,
                                    "db_session": openai_client.db_session
                                }
                            )
                            
                            # Сохраняем результат для логирования
                            function_result = result
                            
                            # Устанавливаем флаг ожидания ответа после вызова функции
                            waiting_for_function_response = True
                            
                            # Отправляем результат обратно в OpenAI и получаем статус отправки
                            delivery_status = await openai_client.send_function_result(function_call_id, result)
                            last_function_delivery_status = delivery_status
                            
                            # Если произошла ошибка отправки результата
                            if not delivery_status["success"]:
                                logger.error(f"[DEBUG] Ошибка отправки результата функции: {delivery_status['error']}")
                                
                                # Генерируем сообщение для пользователя о проблеме
                                error_message = {
                                    "type": "response.content_part.added",
                                    "content": {
                                        "text": f"Произошла ошибка при выполнении функции: {delivery_status['error']}"
                                    }
                                }
                                await websocket.send_json(error_message)
                                
                                # После сообщения об ошибке явно запрашиваем новый ответ для генерации аудио
                                await openai_client.create_response_after_function()
                                
                                # Сбрасываем флаг ожидания
                                waiting_for_function_response = False
                            
                            # Информируем клиента о результате в любом случае
                            await websocket.send_json({
                                "type": "function_call.completed",
                                "function": normalized_name,
                                "function_call_id": function_call_id,
                                "result": result
                            })
                            
                            # Анализируем результат вебхука для формирования понятного ответа пользователю
                            if normalized_name == "send_webhook" and waiting_for_function_response:
                                status_code = result.get("status", 0)
                                
                                # Если был сбой доставки, но не из-за статус кода HTTP
                                if status_code == 404:
                                    # Webhook не найден, формируем информативное сообщение
                                    webhook_error_message = {
                                        "type": "response.content_part.added",
                                        "content": {
                                            "text": f"Вебхук не найден (ошибка 404). Запрос был отправлен на URL: {arguments.get('url', 'неизвестный URL')}, но такой вебхук не зарегистрирован. Пожалуйста, проверьте настройки n8n и повторите попытку."
                                        }
                                    }
                                    await websocket.send_json(webhook_error_message)
                                    
                                    # Сбрасываем флаг ожидания, т.к. мы уже предоставили пользователю ответ
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
                    
                    # Сбрасываем буфер аргументов для следующего вызова
                    pending_function_call = {
                        "name": None,
                        "call_id": None,
                        "arguments_buffer": ""
                    }

                # Обработка ответа с содержимым (может быть ответ после вызова функции)
                elif msg_type == "response.content_part.added":
                    # Если был вызов функции, и мы ждем ответа - отслеживаем это
                    if waiting_for_function_response:
                        logger.info(f"[DEBUG] Получен ответ после выполнения функции")
                        waiting_for_function_response = False
                    
                    # Обрабатываем текст ответа
                    if "text" in response_data.get("content", {}):
                        new_text = response_data.get("content", {}).get("text", "")
                        assistant_transcript = new_text
                        logger.info(f"[DEBUG] Из response.content_part.added получен текст ассистента: '{new_text}'")
                
                # Старая логика для обратной совместимости с function_call
                elif msg_type == "function_call":
                    # Извлекаем данные вызова функции
                    function_call_id = response_data.get("function_call_id")
                    function_data = response_data.get("function", {})
                    function_name = function_data.get("name")
                    
                    logger.info(f"[DEBUG] Получен вызов функции (legacy): {function_name}, аргументы: {function_data.get('arguments')}")
                    
                    # Нормализация имени функции
                    normalized_name = normalize_function_name(function_name) or function_name
                    
                    # Проверяем, разрешена ли функция
                    if normalized_name not in openai_client.enabled_functions:
                        # Если функция не разрешена, логируем это и сообщаем пользователю
                        logger.warning(f"[DEBUG] Попытка вызвать неразрешенную функцию: {normalized_name}. Разрешены только: {openai_client.enabled_functions}")
                        
                        # Отправляем сообщение об ошибке пользователю
                        error_response = {
                            "type": "response.content_part.added",
                            "content": {
                                "text": f"Ошибка: функция {function_name} не активирована для этого ассистента."
                            }
                        }
                        await websocket.send_json(error_response)
                        
                        # Отправляем пустой результат или ошибку, чтобы разблокировать модель
                        if function_call_id:
                            dummy_result = {
                                "error": f"Функция {normalized_name} не разрешена",
                                "status": "error"
                            }
                            await openai_client.send_function_result(function_call_id, dummy_result)
                        continue
                    
                    # Если функция разрешена, продолжаем нормальную обработку
                    # Сообщаем клиенту о том, что выполняется функция
                    await websocket.send_json({
                        "type": "function_call.start",
                        "function": normalized_name,
                        "function_call_id": function_call_id
                    })
                    
                    # Выполняем функцию через новую систему
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
                    
                    # Сохраняем результат для логирования
                    function_result = result
                    
                    # Отправляем результат в OpenAI
                    delivery_status = await openai_client.send_function_result(function_call_id, result)
                    
                    # Сообщаем клиенту о результате
                    await websocket.send_json({
                        "type": "function_call.completed",
                        "function": normalized_name,
                        "function_call_id": function_call_id,
                        "result": result
                    })
                    
                    continue

                # Обработка транскрипции ввода пользователя
                if msg_type == "conversation.item.input_audio_transcription.completed":
                    if "transcript" in response_data:
                        user_transcript = response_data.get("transcript", "")
                        logger.info(f"[DEBUG] Получена транскрипция пользователя: '{user_transcript}'")
                        
                        # Сохраняем сообщение пользователя в БД
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
                
                # Обработка частей транскрипции для обоих типов сообщений
                if msg_type == "response.audio_transcript.delta":
                    delta_text = response_data.get("delta", "")
                    assistant_transcript += delta_text
                    logger.info(f"[DEBUG] Получен фрагмент транскрипции ассистента: '{delta_text}'")
                
                # Обработка событий транскрипции для обработки ввода пользователя
                if msg_type == "conversation.item.input_audio_transcription.delta":
                    delta_text = response_data.get("delta", "")
                    user_transcript += delta_text
                    logger.info(f"[DEBUG] Получен фрагмент транскрипции пользователя: '{delta_text}'")
                
                # Обработка полной транскрипции аудио ответа
                if msg_type == "response.audio_transcript.done":
                    transcript = response_data.get("transcript", "")
                    if transcript:
                        assistant_transcript = transcript
                        logger.info(f"[DEBUG] Получена полная транскрипция ассистента: '{assistant_transcript}'")
                
                # Извлекаем текст из элементов диалога
                if msg_type == "conversation.item.created":
                    item = response_data.get("item", {})
                    role = item.get("role", "")
                    content = item.get("content", [])
                    
                    # Если это сообщение пользователя, пытаемся извлечь транскрипцию
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

                # если это аудио-чанк — отдаём как bytes
                if msg_type == "audio":
                    b64 = response_data.get("data", "")
                    chunk = base64.b64decode(b64)
                    await websocket.send_bytes(chunk)
                    continue
                
                # Завершение ответа - если функция не обработана должным образом, вставляем информацию
                if msg_type == "response.output_item.done":
                    # Если мы все еще ждем ответа функции и не получили контента
                    if waiting_for_function_response and last_function_delivery_status:
                        # Ассистент не обработал результат функции должным образом
                        if openai_client.last_function_name == "send_webhook" and function_result:
                            status_code = function_result.get("status", 0)
                            
                            # Генерируем информативный ответ в зависимости от статуса вебхука
                            message_text = ""
                            if status_code == 404:
                                message_text = "Вебхук не найден (ошибка 404). Возможно, он не зарегистрирован или не активирован."
                            elif status_code >= 200 and status_code < 300:
                                message_text = "Вебхук успешно выполнен."
                            else:
                                message_text = f"Вебхук вернул статус {status_code}."
                            
                            # Отправляем информацию клиенту
                            await websocket.send_json({
                                "type": "response.content_part.added",
                                "content": {
                                    "text": message_text
                                }
                            })
                            
                            # Явно запрашиваем новый ответ для генерации аудио,
                            # так как текущий ответ не содержит аудио
                            await openai_client.create_response_after_function()
                        
                        # Сбрасываем флаг ожидания
                        waiting_for_function_response = False

                # все остальные — JSON
                await websocket.send_json(response_data)

                # Завершение диалога - записываем данные в БД и Google Sheets
                if msg_type == "response.done":
                    logger.info(f"[DEBUG] Получен сигнал завершения ответа: response.done")
                    
                    # Выводим финальные собранные тексты для анализа
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
                                # Также обновляем пользовательское сообщение, если оно есть
                                if user_transcript and not conv.user_message:
                                    conv.user_message = user_transcript
                                openai_client.db_session.commit()
                        except Exception as e:
                            logger.error(f"[DEBUG] Ошибка при сохранении ответа ассистента: {str(e)}")
                    
                    # Если у ассистента есть google_sheet_id, логируем разговор
                    if openai_client.assistant_config and openai_client.assistant_config.google_sheet_id:
                        sheet_id = openai_client.assistant_config.google_sheet_id
                        logger.info(f"[DEBUG] Запись диалога в Google Sheet {sheet_id}")
                        logger.info(f"[DEBUG] Пользователь: '{user_transcript}'")
                        logger.info(f"[DEBUG] Ассистент: '{assistant_transcript}'")
                        
                        # Проверяем наличие текста перед отправкой
                        if not user_transcript and not assistant_transcript:
                            logger.warning(f"[DEBUG] Пустые тексты диалога, попробуем использовать данные из БД")
                            # Пробуем получить данные из БД
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
                        
                        # Используем сохраненные значения для записи в Google Sheets
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
                        
                        # Сбрасываем результат функции после логирования
                        function_result = None
                    else:
                        logger.info(f"[DEBUG] Запись в Google Sheet пропущена - sheet_id не настроен")
                        
                    # Сбрасываем флаг ожидания функции, если он остался активным
                    waiting_for_function_response = False
            except ConnectionClosed as e:
                logger.warning(f"[DEBUG] Соединение с OpenAI закрыто: {e}")
                # Пробуем переподключиться
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
