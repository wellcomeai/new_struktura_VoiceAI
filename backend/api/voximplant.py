# backend/api/voximplant.py

"""
Voximplant API endpoints для WellcomeAI, обновленные для гибкой архитектуры.
"""

from fastapi import APIRouter, WebSocket, Depends, Query, HTTPException, status, Header, Body
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, List
import time
import uuid
import json
import traceback

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.db.session import get_db
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.models.conversation import Conversation
from backend.services.user_service import UserService
from backend.functions import get_function_definitions, get_enabled_functions, normalize_function_name, execute_function
# Добавляем импорт сервиса для работы с Google Sheets
from backend.services.google_sheets_service import GoogleSheetsService

logger = get_logger(__name__)

# Create router
router = APIRouter()

# Функция для построения функций в формате OpenAI Realtime API
def build_functions_for_openai(functions_config):
    """
    Преобразует конфигурацию функций в формат для OpenAI Realtime API
    """
    if not functions_config:
        return []
        
    # Получаем все доступные определения функций
    all_functions_definitions = get_function_definitions()
    all_functions_dict = {normalize_function_name(f["name"]): f for f in all_functions_definitions}
    
    result_functions = []
    try:
        if isinstance(functions_config, list):
            for idx, func in enumerate(functions_config):
                if isinstance(func, dict) and "name" in func:
                    normalized_name = normalize_function_name(func["name"])
                    function_def = all_functions_dict.get(normalized_name)
                    
                    if function_def:
                        # Добавляем function_id в parameters
                        params = function_def["parameters"].copy()
                        if "properties" not in params:
                            params["properties"] = {}
                        
                        # Добавляем function_id как первый параметр
                        params["properties"] = {
                            "function_id": {
                                "type": "string",
                                "description": "ID функции для выполнения",
                                "enum": [str(idx + 1)]
                            },
                            **params["properties"]
                        }
                        
                        # Убеждаемся, что function_id включен в required
                        if "required" not in params or not params["required"]:
                            params["required"] = ["function_id"]
                        elif "function_id" not in params["required"]:
                            params["required"] = ["function_id"] + params["required"]
                        
                        # Формируем функцию в формате OpenAI
                        result_functions.append({
                            "type": "function",
                            "function": {
                                "name": func["name"],
                                "description": func.get("description", function_def["description"]),
                                "parameters": params
                            }
                        })
                        logger.info(f"[VOXIMPLANT] Добавлена функция {func['name']} с ID {idx + 1}")
        
        elif isinstance(functions_config, dict) and "enabled_functions" in functions_config:
            enabled_functions = functions_config.get("enabled_functions", [])
            for idx, name in enumerate(enabled_functions):
                normalized_name = normalize_function_name(name)
                function_def = all_functions_dict.get(normalized_name)
                
                if function_def:
                    # Аналогичная обработка как выше
                    params = function_def["parameters"].copy()
                    if "properties" not in params:
                        params["properties"] = {}
                    
                    params["properties"] = {
                        "function_id": {
                            "type": "string",
                            "description": "ID функции для выполнения",
                            "enum": [str(idx + 1)]
                        },
                        **params["properties"]
                    }
                    
                    if "required" not in params or not params["required"]:
                        params["required"] = ["function_id"]
                    elif "function_id" not in params["required"]:
                        params["required"] = ["function_id"] + params["required"]
                    
                    result_functions.append({
                        "type": "function",
                        "function": {
                            "name": function_def["name"],
                            "description": function_def["description"],
                            "parameters": params
                        }
                    })
                    logger.info(f"[VOXIMPLANT] Добавлена функция {function_def['name']} с ID {idx + 1}")
    
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка при построении функций: {e}")
        logger.error(traceback.format_exc())
    
    return result_functions

# Обновленный эндпоинт для получения конфигурации ассистента
@router.get("/assistants/config/{assistant_id}")
async def get_assistant_config(
    assistant_id: str,
    user_id: Optional[str] = Header(None, alias="X-User-ID"),
    db: Session = Depends(get_db)
):
    """
    Получает расширенную конфигурацию ассистента для передачи в Voximplant.
    """
    logger.info(f"[VOXIMPLANT] Запрос конфигурации для ассистента {assistant_id}")
    
    try:
        # Загружаем ассистента из БД
        assistant = None
        
        if assistant_id == "demo":
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
                logger.info("[VOXIMPLANT] Используем первого доступного ассистента для demo")
        else:
            try:
                assistant_uuid = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(assistant_uuid)
                logger.info(f"[VOXIMPLANT] Найден ассистент по UUID: {assistant_id}")
            except ValueError:
                assistant = db.query(AssistantConfig).filter(
                    AssistantConfig.id.cast(str) == assistant_id
                ).first()
                logger.info(f"[VOXIMPLANT] Найден ассистент по строковому ID: {assistant_id}")
                
        if not assistant:
            logger.warning(f"[VOXIMPLANT] Ассистент не найден: {assistant_id}")
            
            # В тестовом режиме возвращаем значения по умолчанию вместо ошибки
            return {
                "api_key": settings.OPENAI_API_KEY,
                "model": "gpt-4o-realtime-preview",
                "prompt": "Вы — тестовый ассистент. Ассистент с указанным ID не найден.",
                "hello": "Здравствуйте! Я тестовый ассистент. Чем могу помочь?",
                "voice": "alloy",
                "language": "ru",
                "temperature": 0.7,
                "functions": [],
                "log_enabled": False,
                "google_sheet_id": None,
                "assistant_id": assistant_id,
                "assistant_name": "Тестовый ассистент (ID не найден)",
                "error": "assistant_not_found"
            }
        
        # Проверяем подписку и API ключ
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                logger.info(f"[VOXIMPLANT] Найден пользователь ассистента: {user.id}")
                
                # Проверяем статус подписки (кроме админов)
                if not user.is_admin and user.email != "well96well@gmail.com":
                    try:
                        subscription_status = await UserService.check_subscription_status(db, str(user.id))
                        if not subscription_status["active"]:
                            logger.warning(f"[VOXIMPLANT] Подписка истекла для пользователя: {user.id}")
                            
                            # В тестовом режиме все равно возвращаем конфигурацию
                            return {
                                "api_key": settings.OPENAI_API_KEY,
                                "model": "gpt-4o-realtime-preview",
                                "prompt": "Вы — тестовый ассистент. Подписка владельца истекла.",
                                "hello": "Здравствуйте! К сожалению, подписка истекла. Обратитесь к администратору.",
                                "voice": assistant.voice or "alloy",
                                "language": assistant.language or "ru",
                                "temperature": assistant.temperature or 0.7,
                                "functions": [],
                                "log_enabled": False,
                                "google_sheet_id": None,
                                "assistant_id": str(assistant.id),
                                "assistant_name": assistant.name,
                                "error": "subscription_expired"
                            }
                    except Exception as sub_error:
                        logger.error(f"[VOXIMPLANT] Ошибка проверки подписки: {sub_error}")
                
                # Получаем API ключ OpenAI
                api_key = user.openai_api_key
                
                if api_key:
                    logger.info(f"[VOXIMPLANT] Используется API ключ пользователя")
                else:
                    logger.warning(f"[VOXIMPLANT] Отсутствует API ключ пользователя")
        
        # Если API ключа нет, используем значение из .env
        if not api_key:
            api_key = settings.OPENAI_API_KEY
            logger.info(f"[VOXIMPLANT] Используется API ключ из настроек сервера")
        
        # Формируем определения функций в формате OpenAI Realtime API
        functions = build_functions_for_openai(assistant.functions)
        
        # Определяем настройки логирования
        log_enabled = False
        google_sheet_id = None
        
        if hasattr(assistant, 'log_enabled'):
            log_enabled = assistant.log_enabled
        if hasattr(assistant, 'google_sheet_id'):
            google_sheet_id = assistant.google_sheet_id
            logger.info(f"[VOXIMPLANT] Найден ID Google Sheet: {google_sheet_id}")
        
        # Получаем приветственное сообщение
        greeting_message = "Здравствуйте! Чем я могу вам помочь?"
        if hasattr(assistant, 'greeting_message') and assistant.greeting_message:
            greeting_message = assistant.greeting_message
        
        # Формируем расширенную конфигурацию для Voximplant
        config = {
            "api_key": api_key,
            "model": "gpt-4o-realtime-preview",
            "prompt": assistant.system_prompt,
            "hello": greeting_message,
            "voice": assistant.voice or "alloy",
            "language": assistant.language or "ru",
            "temperature": assistant.temperature or 0.7,
            "functions": functions,
            "log_enabled": log_enabled,
            "google_sheet_id": google_sheet_id,
            "assistant_id": str(assistant.id),
            "assistant_name": assistant.name
        }
        
        # Опциональные настройки для ElevenLabs, если они есть
        if hasattr(assistant, 'use_elevenlabs') and assistant.use_elevenlabs:
            config["use_elevenlabs"] = True
            config["elevenlabs_api_key"] = settings.ELEVENLABS_API_KEY
            config["elevenlabs_voice_id"] = assistant.elevenlabs_voice_id or "21m00Tcm4TlvDq8ikWAM"
        
        logger.info(f"[VOXIMPLANT] Отправлена конфигурация для ассистента {assistant_id}")
        
        return config
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка при получении конфигурации ассистента: {e}")
        logger.error(f"[VOXIMPLANT] Трассировка: {traceback.format_exc()}")
        
        # В тестовом режиме возвращаем конфигурацию по умолчанию вместо ошибки
        return {
            "api_key": settings.OPENAI_API_KEY,
            "model": "gpt-4o-realtime-preview",
            "prompt": "Вы — тестовый ассистент. Произошла ошибка при загрузке конфигурации.",
            "hello": "Здравствуйте! Произошла ошибка, но я попробую вам помочь.",
            "voice": "alloy",
            "language": "ru",
            "temperature": 0.7,
            "functions": [],
            "log_enabled": False,
            "google_sheet_id": None,
            "assistant_id": assistant_id,
            "assistant_name": "Тестовый ассистент (ошибка)",
            "error": str(e)
        }

# Обновленный эндпоинт для выполнения функций
@router.post("/functions/execute")
async def execute_assistant_function(
    request_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Выполняет функцию для ассистента из Voximplant по ID функции.
    """
    try:
        function_id = request_data.get("function_id")
        arguments = request_data.get("arguments", {})
        call_data = request_data.get("call_data", {})
        
        if not function_id:
            logger.warning(f"[VOXIMPLANT] Не указан ID функции: {request_data}")
            return {
                "error": "Не указан ID функции",
                "status": "error"
            }
        
        logger.info(f"[VOXIMPLANT] Запрос на выполнение функции с ID {function_id}")
        
        # Получаем ID ассистента из аргументов или call_data
        assistant_id = None
        if "assistant_id" in arguments:
            assistant_id = arguments.get("assistant_id")
        elif call_data and "assistant_id" in call_data:
            assistant_id = call_data.get("assistant_id")
        
        if not assistant_id:
            logger.warning(f"[VOXIMPLANT] Не указан ID ассистента для функции: {function_id}")
            return {
                "error": "Не указан ID ассистента",
                "status": "error"
            }
        
        # Загружаем ассистента
        try:
            assistant_uuid = uuid.UUID(assistant_id)
            assistant = db.query(AssistantConfig).get(assistant_uuid)
        except ValueError:
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id.cast(str) == assistant_id
            ).first()
            
        if not assistant:
            logger.warning(f"[VOXIMPLANT] Ассистент не найден: {assistant_id}")
            return {
                "error": "Ассистент не найден",
                "status": "error"
            }
        
        # Получаем список функций ассистента
        enabled_functions = []
        if assistant.functions:
            if isinstance(assistant.functions, list):
                enabled_functions = [f.get("name") for f in assistant.functions if isinstance(f, dict) and "name" in f]
            elif isinstance(assistant.functions, dict) and "enabled_functions" in assistant.functions:
                enabled_functions = assistant.functions.get("enabled_functions", [])
        
        # Проверяем индекс функции
        try:
            func_index = int(function_id) - 1
            if func_index < 0 or func_index >= len(enabled_functions):
                logger.warning(f"[VOXIMPLANT] Индекс функции вне диапазона: {function_id}")
                return {
                    "error": f"Функция с ID {function_id} не найдена",
                    "status": "error"
                }
            
            # Получаем имя функции по индексу
            function_name = enabled_functions[func_index]
            normalized_name = normalize_function_name(function_name)
            
            logger.info(f"[VOXIMPLANT] Найдена функция {function_name} для ID {function_id}")
            
            # Подготавливаем контекст выполнения
            context = {
                "assistant_config": assistant,
                "client_id": call_data.get("chat_id", f"voximplant_{call_data.get('call_id', uuid.uuid4())}"),
                "db_session": db,
                "call_data": call_data
            }
            
            # Удаляем function_id из аргументов, так как это наш внутренний параметр
            if "function_id" in arguments:
                del arguments["function_id"]
            
            logger.info(f"[VOXIMPLANT] Выполняем функцию {function_name} с аргументами: {arguments}")
            
            # Выполняем функцию
            result = await execute_function(
                name=normalized_name,
                arguments=arguments,
                context=context
            )
            
            # Логируем вызов функции
            try:
                from backend.models.function_log import FunctionLog
                
                log_entry = FunctionLog(
                    user_id=assistant.user_id,
                    assistant_id=assistant.id,
                    function_name=function_name,
                    arguments=arguments,
                    result=result,
                    status="success" if "error" not in result else "error",
                    chat_id=call_data.get("chat_id"),
                    call_id=call_data.get("call_id")
                )
                
                db.add(log_entry)
                db.commit()
                
                logger.info(f"[VOXIMPLANT] Результат функции {function_name} записан в лог")
            except Exception as log_error:
                logger.error(f"[VOXIMPLANT] Ошибка при логировании вызова функции: {log_error}")
            
            # Возвращаем результат
            logger.info(f"[VOXIMPLANT] Функция {function_name} выполнена успешно")
            return result
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка при выполнении функции: {e}")
            logger.error(traceback.format_exc())
            return {
                "error": f"Ошибка при выполнении функции: {str(e)}",
                "status": "error"
            }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка при обработке запроса функции: {e}")
        logger.error(traceback.format_exc())
        return {
            "error": f"Внутренняя ошибка сервера: {str(e)}",
            "status": "error"
        }

@router.post("/webhook/transcript")
async def voximplant_transcript_webhook(
    request_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Webhook для получения транскрипций от Voximplant.
    """
    try:
        assistant_id = request_data.get("assistant_id")
        role = request_data.get("role")
        transcript = request_data.get("transcript")
        call_id = request_data.get("call_id")
        chat_id = request_data.get("chat_id")
        timestamp = request_data.get("timestamp")
        
        logger.info(f"[VOXIMPLANT] Получена транскрипция {role} для звонка {call_id}")
        
        if not assistant_id or not role or not transcript:
            return {
                "success": False,
                "message": "Missing required parameters"
            }
        
        # Находим существующую запись разговора или создаем новую
        conversation = None
        
        # Ищем по call_id или chat_id в метаданных
        conversations = db.query(Conversation).filter(
            Conversation.assistant_id == assistant_id
        ).order_by(Conversation.created_at.desc()).limit(10).all()
        
        for conv in conversations:
            metadata = conv.client_info or {}
            if (call_id and metadata.get("call_id") == call_id) or (chat_id and metadata.get("chat_id") == chat_id):
                conversation = conv
                break
        
        # Если не нашли, создаем новую запись
        if not conversation:
            try:
                assistant_uuid = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(assistant_uuid)
                
                if assistant:
                    conversation = Conversation(
                        assistant_id=assistant.id,
                        session_id=chat_id or str(uuid.uuid4()),
                        user_message="",
                        assistant_message="",
                        client_info={
                            "call_id": call_id,
                            "chat_id": chat_id,
                            "source": "voximplant",
                            "timestamp": timestamp
                        }
                    )
                    db.add(conversation)
                    db.commit()
                    db.refresh(conversation)
                    
                    logger.info(f"[VOXIMPLANT] Создана новая запись разговора: {conversation.id}")
            except Exception as e:
                logger.error(f"[VOXIMPLANT] Ошибка создания записи разговора: {e}")
        
        # Обновляем транскрипцию
        if conversation:
            if role == "user":
                # Если уже есть текст, добавляем новый с новой строки
                if conversation.user_message:
                    conversation.user_message += f"\n{transcript}"
                else:
                    conversation.user_message = transcript
            elif role == "assistant":
                if conversation.assistant_message:
                    conversation.assistant_message += f"\n{transcript}"
                else:
                    conversation.assistant_message = transcript
                
            # Обновляем время
            conversation.updated_at = time.time()
            
            db.commit()
            logger.info(f"[VOXIMPLANT] Транскрипция обновлена для разговора {conversation.id}")
        
        return {
            "success": True,
            "message": "Transcript received and processed",
            "conversation_id": str(conversation.id) if conversation else None
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка обработки транскрипции: {e}")
        logger.error(traceback.format_exc())
        return {
            "success": False,
            "message": f"Error processing transcript: {str(e)}"
        }

# Обновленный эндпоинт для внешнего логирования с поддержкой Google Sheets
@router.post("/log")
async def log_conversation_data(
    request_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Эндпоинт для логирования данных разговора из Voximplant в Google Sheets.
    Принимает только одну пару "вопрос-ответ" за раз, не накапливая историю.
    """
    try:
        assistant_id = request_data.get("assistant_id")
        chat_id = request_data.get("chat_id")
        call_id = request_data.get("call_id")
        data_type = request_data.get("type", "general")
        data = request_data.get("data", {})
        
        logger.info(f"[VOXIMPLANT] Получены данные для логирования, тип: {data_type}, chat_id: {chat_id}")
        
        if not assistant_id or not (chat_id or call_id):
            return {
                "success": False,
                "message": "Missing required parameters (assistant_id and chat_id/call_id)"
            }
        
        # Запись в журнал
        logger.info(f"[VOXIMPLANT] LOG: assistant_id={assistant_id}, chat_id={chat_id}, type={data_type}")
        
        # Если тип данных - разговор, пытаемся записать в Google Sheets
        if data_type == "conversation":
            # Получаем ассистента для получения ID таблицы
            try:
                assistant_uuid = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(assistant_uuid)
            except ValueError:
                assistant = db.query(AssistantConfig).filter(
                    AssistantConfig.id.cast(str) == assistant_id
                ).first()
            
            # Проверяем google_sheet_id
            if assistant and hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
                # Используем google_sheet_id для таблицы
                log_sheet_id = assistant.google_sheet_id
                logger.info(f"[VOXIMPLANT] Найден ID Google Sheet: {log_sheet_id}")
                
                # Получаем одну пару вопрос-ответ для записи
                user_message = data.get("user_message", "")
                assistant_message = data.get("assistant_message", "")
                function_result = data.get("function_result")
                
                # Логируем длину сообщений для отладки
                logger.info(f"[VOXIMPLANT] Длина сообщения пользователя: {len(user_message)}, ассистента: {len(assistant_message)}")
                
                if not user_message and not assistant_message:
                    logger.warning("[VOXIMPLANT] Пустые сообщения для логирования, пропускаем")
                    return {
                        "success": False,
                        "message": "Empty messages, logging skipped"
                    }
                
                # Запись в Google Sheets - одна пара вопрос-ответ
                sheet_result = await GoogleSheetsService.log_conversation(
                    sheet_id=log_sheet_id,
                    user_message=user_message,
                    assistant_message=assistant_message,
                    function_result=function_result
                )
                
                if sheet_result:
                    logger.info(f"[VOXIMPLANT] Данные успешно записаны в Google Sheets: {log_sheet_id}")
                    return {
                        "success": True,
                        "message": "Conversation pair logged successfully"
                    }
                else:
                    logger.warning(f"[VOXIMPLANT] Ошибка записи в Google Sheets: {log_sheet_id}")
                    return {
                        "success": False,
                        "message": "Failed to log to Google Sheets"
                    }
            else:
                logger.info(f"[VOXIMPLANT] Google Sheets логирование не настроено для ассистента {assistant_id}")
                return {
                    "success": False,
                    "message": "Google Sheets logging not configured for this assistant"
                }
        
        return {
            "success": True,
            "message": "Log data received and processed"
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка логирования: {e}")
        logger.error(traceback.format_exc())
        return {
            "success": False,
            "message": f"Error logging data: {str(e)}"
        }

# Обновляем эндпоинт для проверки подключения к Google таблице
@router.post("/assistants/{assistant_id}/verify-sheet")
async def verify_google_sheet(
    assistant_id: str,
    sheet_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Проверяет подключение к Google Sheets и настраивает заголовки таблицы
    """
    try:
        sheet_id = sheet_data.get("sheet_id")
        if not sheet_id:
            return {"success": False, "message": "ID таблицы не указан"}
        
        logger.info(f"[SHEETS] Проверка подключения к таблице: {sheet_id}")
        
        # Проверяем доступ к таблице
        verify_result = await GoogleSheetsService.verify_sheet_access(sheet_id)
        
        if verify_result["success"]:
            # Настраиваем заголовки таблицы
            setup_result = await GoogleSheetsService.setup_sheet(sheet_id)
            
            # Сохраняем google_sheet_id
            if assistant_id != "new":
                try:
                    assistant_uuid = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).get(assistant_uuid)
                    
                    if assistant:
                        # Сохраняем sheet_id в google_sheet_id
                        assistant.google_sheet_id = sheet_id
                        assistant.log_enabled = True
                        db.commit()
                        logger.info(f"[SHEETS] ID таблицы сохранен для ассистента {assistant_id}")
                except Exception as e:
                    logger.error(f"[SHEETS] Ошибка при сохранении ID таблицы: {str(e)}")
                    
            return {
                "success": True,
                "message": "Подключение к таблице успешно проверено и настроено",
                "sheet_title": verify_result.get("title")
            }
        else:
            return verify_result
            
    except Exception as e:
        logger.error(f"[SHEETS] Ошибка при проверке таблицы: {str(e)}")
        logger.error(traceback.format_exc())
        return {
            "success": False,
            "message": f"Ошибка: {str(e)}"
        }

# НОВЫЙ ЭНДПОИНТ: Запуск исходящих звонков
@router.post("/start-outbound-call")
async def start_outbound_call(
    request_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Запуск исходящего звонка через Voximplant API.
    Принимает credentials пользователя и параметры звонка из запроса.
    """
    try:
        import httpx
        
        # Получаем credentials из запроса
        account_id = request_data.get("account_id")
        api_key = request_data.get("api_key")
        rule_id = request_data.get("rule_id")
        script_custom_data = request_data.get("script_custom_data")
        
        if not account_id or not api_key:
            logger.warning("[VOXIMPLANT] Не указаны Voximplant credentials")
            raise HTTPException(
                status_code=400, 
                detail="Не указаны Voximplant credentials (account_id и api_key)"
            )
        
        if not rule_id or not script_custom_data:
            logger.warning("[VOXIMPLANT] Не указаны обязательные параметры для звонка")
            raise HTTPException(
                status_code=400, 
                detail="Не указаны обязательные параметры (rule_id и script_custom_data)"
            )
        
        # Формируем запрос к Voximplant API
        voximplant_url = "https://api.voximplant.com/platform_api/StartScenarios"
        
        params = {
            "account_id": account_id,
            "api_key": api_key,
            "rule_id": rule_id,
            "script_custom_data": script_custom_data
        }
        
        logger.info(f"[VOXIMPLANT] Запуск исходящего звонка, rule_id: {rule_id}")
        
        # Отправляем запрос к Voximplant API
        async with httpx.AsyncClient() as client:
            response = await client.post(
                voximplant_url,
                data=params,
                timeout=30.0
            )
            
            result = response.json()
            
            if result.get("result"):
                logger.info(f"[VOXIMPLANT] Исходящий звонок успешно запущен: {result.get('call_session_history_id')}")
                return {
                    "success": True,
                    "message": "Звонок успешно запущен",
                    "call_session_history_id": result.get("call_session_history_id"),
                    "media_session_access_url": result.get("media_session_access_url")
                }
            else:
                error_msg = "Неизвестная ошибка"
                if result.get("error"):
                    error_msg = result["error"].get("msg", error_msg)
                
                logger.error(f"[VOXIMPLANT] Ошибка Voximplant API: {error_msg}")
                return {
                    "success": False,
                    "message": f"Ошибка Voximplant API: {error_msg}"
                }
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка запуска исходящего звонка: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))
