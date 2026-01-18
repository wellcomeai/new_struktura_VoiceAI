# backend/api/voximplant.py - Production Version 3.4

"""
Voximplant API endpoints для WellcomeAI, обновленные для гибкой архитектуры.
🆕 v2.1: Enhanced logging with caller_number and conversation_id tracking
🆕 v2.2: Added database persistence for conversations
🆕 v3.1: Phone normalization and call direction extraction
🆕 v3.2: Support for both OpenAI and Gemini assistants in logging
🆕 v3.3: Cloudflare R2 Storage for permanent call recordings
🆕 v3.4: Service Account JWT авторизация для secure записей Voximplant
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
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.user import User
from backend.models.conversation import Conversation
from backend.models.voximplant_child import VoximplantChildAccount  # 🆕 v3.4
from backend.services.user_service import UserService
from backend.functions import get_function_definitions, get_enabled_functions, normalize_function_name, execute_function
from backend.services.google_sheets_service import GoogleSheetsService
from backend.services.conversation_service import ConversationService
from backend.services.r2_storage import R2StorageService

logger = get_logger(__name__)

# Create router
router = APIRouter()


# =============================================================================
# HELPER FUNCTION - Найти ассистента любого типа
# =============================================================================

def find_assistant_by_id(db: Session, assistant_id: str) -> tuple:
    """
    Ищет ассистента по ID в обеих таблицах (OpenAI и Gemini).
    
    Returns:
        tuple: (assistant, assistant_type) где assistant_type = 'openai' | 'gemini' | None
    """
    assistant = None
    assistant_type = None
    
    try:
        assistant_uuid = uuid.UUID(assistant_id)
        
        # Сначала проверяем OpenAI
        assistant = db.query(AssistantConfig).get(assistant_uuid)
        if assistant:
            assistant_type = "openai"
        else:
            # Если не найден - проверяем Gemini
            assistant = db.query(GeminiAssistantConfig).get(assistant_uuid)
            if assistant:
                assistant_type = "gemini"
                
    except ValueError:
        # Пробуем как строку
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id.cast(str) == assistant_id
        ).first()
        if assistant:
            assistant_type = "openai"
        else:
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id.cast(str) == assistant_id
            ).first()
            if assistant:
                assistant_type = "gemini"
    
    return assistant, assistant_type


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


# =============================================================================
# ЭНДПОИНТ: Получение конфигурации ассистента
# =============================================================================

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


# =============================================================================
# ЭНДПОИНТ: Выполнение функций
# =============================================================================

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
        
        # Загружаем ассистента (OpenAI или Gemini)
        assistant, assistant_type = find_assistant_by_id(db, assistant_id)
            
        if not assistant:
            logger.warning(f"[VOXIMPLANT] Ассистент не найден: {assistant_id}")
            return {
                "error": "Ассистент не найден",
                "status": "error"
            }
        
        logger.info(f"[VOXIMPLANT] Найден ассистент типа {assistant_type}: {assistant.name}")
        
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
                "assistant_type": assistant_type,
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


# =============================================================================
# ЭНДПОИНТ: Webhook для транскрипций
# =============================================================================

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


# =============================================================================
# 🆕 v3.4: HELPER - Получение Service Account credentials
# =============================================================================

def get_voximplant_credentials(db: Session, user_id: uuid.UUID) -> Optional[Dict[str, Any]]:
    """
    🆕 v3.4: Получает Service Account credentials для пользователя.
    
    Находит дочерний аккаунт Voximplant и извлекает credentials
    для JWT авторизации при скачивании secure записей.
    
    Args:
        db: Сессия БД
        user_id: UUID пользователя (владельца ассистента)
        
    Returns:
        Dict с credentials или None
        {
            "account_id": int,
            "key_id": str,
            "private_key": str
        }
    """
    try:
        # Находим дочерний аккаунт по user_id
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == user_id
        ).first()
        
        if not child_account:
            logger.warning(f"[VOXIMPLANT-v3.4] No child account found for user {user_id}")
            return None
        
        # Проверяем наличие Service Account credentials
        if not child_account.vox_service_account_key:
            logger.warning(f"[VOXIMPLANT-v3.4] No Service Account credentials for account {child_account.vox_account_id}")
            logger.warning(f"[VOXIMPLANT-v3.4] Run admin/setup-service-accounts to create them")
            return None
        
        # Парсим JSON с credentials
        try:
            credentials = json.loads(child_account.vox_service_account_key)
            
            # Валидируем обязательные поля
            if not credentials.get("account_id"):
                logger.error(f"[VOXIMPLANT-v3.4] Missing account_id in credentials")
                return None
            if not credentials.get("key_id"):
                logger.error(f"[VOXIMPLANT-v3.4] Missing key_id in credentials")
                return None
            if not credentials.get("private_key"):
                logger.error(f"[VOXIMPLANT-v3.4] Missing private_key in credentials")
                return None
            
            logger.info(f"[VOXIMPLANT-v3.4] ✅ Loaded credentials for child account {child_account.vox_account_id}")
            logger.info(f"[VOXIMPLANT-v3.4]    Key ID: {credentials.get('key_id')}")
            
            return credentials
            
        except json.JSONDecodeError as json_error:
            logger.error(f"[VOXIMPLANT-v3.4] Failed to parse credentials JSON: {json_error}")
            return None
            
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.4] Error getting credentials: {e}")
        return None


# =============================================================================
# 🆕 v3.4: ГЛАВНЫЙ ЭНДПОИНТ /log С ПОДДЕРЖКОЙ SERVICE ACCOUNT JWT
# =============================================================================

@router.post("/log")
async def log_conversation_data(
    request_data: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """
    Эндпоинт для логирования данных разговора из Voximplant.
    
    🆕 v2.2: Сохраняет данные И в Google Sheets И в БД
    🆕 v3.1: Извлекает call_direction из caller_number и нормализует номер
    🆕 v3.2: Поддержка OpenAI И Gemini ассистентов
    🆕 v3.3: Сохранение записей звонков в Cloudflare R2
    🆕 v3.4: Service Account JWT авторизация для secure записей
    
    Формат запроса:
    {
        "assistant_id": "uuid",
        "chat_id": "string",
        "call_id": "string",
        "caller_number": "string",  // Номер телефона с префиксом INBOUND:/OUTBOUND:
        "record_url": "string",     // Временный URL записи от Voximplant
        "type": "conversation",
        "data": {
            "user_message": "string",
            "assistant_message": "string",
            "function_result": "object"
        }
    }
    """
    try:
        assistant_id = request_data.get("assistant_id")
        chat_id = request_data.get("chat_id")
        call_id = request_data.get("call_id")
        caller_number = request_data.get("caller_number")
        record_url = request_data.get("record_url")
        data_type = request_data.get("type", "general")
        data = request_data.get("data", {})
        
        logger.info(f"[VOXIMPLANT-v3.4] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logger.info(f"[VOXIMPLANT-v3.4] 📥 Получены данные для логирования:")
        logger.info(f"[VOXIMPLANT-v3.4]   📋 Тип: {data_type}")
        logger.info(f"[VOXIMPLANT-v3.4]   🆔 Assistant ID: {assistant_id}")
        logger.info(f"[VOXIMPLANT-v3.4]   💬 Chat ID: {chat_id}")
        logger.info(f"[VOXIMPLANT-v3.4]   📞 Call ID: {call_id}")
        logger.info(f"[VOXIMPLANT-v3.4]   📱 Caller Number (raw): {caller_number}")
        logger.info(f"[VOXIMPLANT-v3.4]   🎙️ Record URL: {'✅ Есть' if record_url else '❌ Нет'}")
        logger.info(f"[VOXIMPLANT-v3.4] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        
        if not assistant_id or not (chat_id or call_id):
            logger.warning("[VOXIMPLANT-v3.4] ❌ Отсутствуют обязательные параметры")
            return {
                "success": False,
                "message": "Missing required parameters (assistant_id and chat_id/call_id)"
            }
        
        # Если тип данных - разговор, сохраняем и в Sheets и в БД
        if data_type == "conversation":
            # Получаем ассистента (проверяем ОБА типа)
            assistant, assistant_type = find_assistant_by_id(db, assistant_id)
            
            if not assistant:
                logger.error(f"[VOXIMPLANT-v3.4] ❌ Ассистент не найден ни в OpenAI, ни в Gemini: {assistant_id}")
                return {
                    "success": False,
                    "message": "Assistant not found in any table"
                }
            
            logger.info(f"[VOXIMPLANT-v3.4] ✅ Найден ассистент типа {assistant_type}: {assistant.name}")
            
            # Получаем данные сообщений
            user_message = data.get("user_message", "")
            assistant_message = data.get("assistant_message", "")
            function_result = data.get("function_result")
            
            # Логируем длину сообщений
            logger.info(f"[VOXIMPLANT-v3.4] 📏 Длина сообщения пользователя: {len(user_message)} символов")
            logger.info(f"[VOXIMPLANT-v3.4] 📏 Длина сообщения ассистента: {len(assistant_message)} символов")
            
            if not user_message and not assistant_message:
                logger.warning("[VOXIMPLANT-v3.4] ⚠️ Пустые сообщения для логирования, пропускаем")
                return {
                    "success": False,
                    "message": "Empty messages, logging skipped"
                }
            
            # Определяем conversation_id (приоритет - call_id, fallback - chat_id)
            conversation_id = call_id or chat_id
            
            # Извлекаем направление звонка и нормализуем номер
            call_direction = ConversationService._extract_call_direction(caller_number)
            normalized_phone = ConversationService._normalize_phone(caller_number) if caller_number else "unknown"
            
            logger.info(f"[VOXIMPLANT-v3.4] 🔍 Extracted:")
            logger.info(f"[VOXIMPLANT-v3.4]   📞 Direction: {call_direction}")
            logger.info(f"[VOXIMPLANT-v3.4]   📱 Normalized phone: {normalized_phone}")
            logger.info(f"[VOXIMPLANT-v3.4]   🤖 Assistant type: {assistant_type}")
            
            # ================================================================
            # 🆕 v3.4: СОХРАНЕНИЕ ЗАПИСИ В CLOUDFLARE R2 С JWT АВТОРИЗАЦИЕЙ
            # ================================================================
            permanent_record_url = None
            r2_saved = False
            
            if record_url:
                logger.info(f"[VOXIMPLANT-v3.4] 🎙️ Обработка записи звонка...")
                logger.info(f"[VOXIMPLANT-v3.4]   Voximplant URL: {record_url[:60]}...")
                
                if R2StorageService.is_configured():
                    try:
                        # 🆕 v3.4: Получаем Service Account credentials для JWT авторизации
                        voximplant_credentials = None
                        
                        if assistant.user_id:
                            voximplant_credentials = get_voximplant_credentials(db, assistant.user_id)
                            
                            if voximplant_credentials:
                                logger.info(f"[VOXIMPLANT-v3.4] 🔐 Service Account credentials loaded")
                            else:
                                logger.warning(f"[VOXIMPLANT-v3.4] ⚠️ No Service Account credentials available")
                                logger.warning(f"[VOXIMPLANT-v3.4] ⚠️ Secure recordings may fail to download")
                        
                        logger.info(f"[VOXIMPLANT-v3.4] 📤 Загрузка в R2 Storage...")
                        
                        # Передаём credentials в R2StorageService
                        permanent_record_url = await R2StorageService.upload_recording(
                            record_url=record_url,
                            call_id=call_id or chat_id or str(uuid.uuid4()),
                            assistant_id=assistant_id,
                            voximplant_credentials=voximplant_credentials  # 🆕 v3.4
                        )
                        
                        if permanent_record_url:
                            r2_saved = True
                            logger.info(f"[VOXIMPLANT-v3.4] ✅ Запись сохранена в R2:")
                            logger.info(f"[VOXIMPLANT-v3.4]   URL: {permanent_record_url}")
                        else:
                            logger.warning(f"[VOXIMPLANT-v3.4] ⚠️ Не удалось сохранить в R2, используем временный URL")
                            permanent_record_url = record_url
                            
                    except Exception as r2_error:
                        logger.error(f"[VOXIMPLANT-v3.4] ❌ Ошибка R2: {r2_error}")
                        logger.error(f"[VOXIMPLANT-v3.4] Traceback: {traceback.format_exc()}")
                        # Используем временный URL как fallback
                        permanent_record_url = record_url
                else:
                    logger.info(f"[VOXIMPLANT-v3.4] ℹ️ R2 не настроен, используем временный Voximplant URL")
                    permanent_record_url = record_url
            
            # ================================================================
            # СОХРАНЕНИЕ В БД через ConversationService
            # ================================================================
            logger.info(f"[VOXIMPLANT-v3.4] 💾 Сохранение в БД...")
            db_result = None
            
            try:
                db_result = await ConversationService.save_conversation(
                    db=db,
                    assistant_id=assistant_id,
                    user_message=user_message,
                    assistant_message=assistant_message,
                    session_id=conversation_id,
                    caller_number=caller_number,
                    call_direction=call_direction,
                    client_info={
                        "call_id": call_id,
                        "chat_id": chat_id,
                        "source": "voximplant",
                        "assistant_type": assistant_type,
                        "record_url": permanent_record_url
                    },
                    audio_duration=None,
                    tokens_used=0
                )
                
                if db_result:
                    logger.info(f"[VOXIMPLANT-v3.4] ✅ Сохранено в БД:")
                    logger.info(f"[VOXIMPLANT-v3.4]   ID: {db_result.id}")
                    logger.info(f"[VOXIMPLANT-v3.4]   Direction: {db_result.call_direction}")
                    logger.info(f"[VOXIMPLANT-v3.4]   Phone: {db_result.caller_number}")
                    logger.info(f"[VOXIMPLANT-v3.4]   Contact: {db_result.contact_id}")
                    logger.info(f"[VOXIMPLANT-v3.4]   Record URL: {'✅' if permanent_record_url else '❌'}")
                else:
                    logger.warning(f"[VOXIMPLANT-v3.4] ⚠️ Не удалось сохранить в БД")
                    
            except Exception as db_error:
                logger.error(f"[VOXIMPLANT-v3.4] ❌ Ошибка сохранения в БД: {db_error}")
                logger.error(f"[VOXIMPLANT-v3.4] Traceback: {traceback.format_exc()}")
            
            # ================================================================
            # СОХРАНЕНИЕ В GOOGLE SHEETS (оригинальная логика)
            # ================================================================
            sheets_result = False
            if hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
                log_sheet_id = assistant.google_sheet_id
                logger.info(f"[VOXIMPLANT-v3.4] 📊 Запись в Google Sheets: {log_sheet_id}")
                
                try:
                    sheets_result = await GoogleSheetsService.log_conversation(
                        sheet_id=log_sheet_id,
                        user_message=user_message,
                        assistant_message=assistant_message,
                        function_result=function_result,
                        conversation_id=conversation_id,
                        caller_number=normalized_phone
                    )
                    
                    if sheets_result:
                        logger.info(f"[VOXIMPLANT-v3.4] ✅ Данные записаны в Google Sheets")
                    else:
                        logger.error(f"[VOXIMPLANT-v3.4] ❌ Ошибка записи в Google Sheets")
                        
                except Exception as sheets_error:
                    logger.error(f"[VOXIMPLANT-v3.4] ❌ Ошибка Google Sheets: {sheets_error}")
                    logger.error(f"[VOXIMPLANT-v3.4] Traceback: {traceback.format_exc()}")
            else:
                logger.info(f"[VOXIMPLANT-v3.4] ⚠️ Google Sheets логирование не настроено")
            
            # ================================================================
            # ФОРМИРУЕМ ОТВЕТ
            # ================================================================
            logger.info(f"[VOXIMPLANT-v3.4] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[VOXIMPLANT-v3.4] 📊 РЕЗУЛЬТАТЫ ЛОГИРОВАНИЯ:")
            logger.info(f"[VOXIMPLANT-v3.4]   🤖 Тип ассистента: {assistant_type}")
            logger.info(f"[VOXIMPLANT-v3.4]   💾 БД: {'✅ OK' if db_result else '❌ FAIL'}")
            logger.info(f"[VOXIMPLANT-v3.4]   📊 Sheets: {'✅ OK' if sheets_result else '❌ FAIL/SKIP'}")
            logger.info(f"[VOXIMPLANT-v3.4]   🎙️ Запись: {'✅ R2' if r2_saved else '⚠️ Temp' if permanent_record_url else '❌ НЕТ'}")
            logger.info(f"[VOXIMPLANT-v3.4] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            return {
                "success": bool(db_result) or sheets_result,
                "message": "Conversation logged successfully" if (db_result or sheets_result) else "Failed to log conversation",
                "saved_to": {
                    "database": bool(db_result),
                    "google_sheets": sheets_result,
                    "r2_storage": r2_saved
                },
                "conversation_id": str(db_result.id) if db_result else conversation_id,
                "caller_number": normalized_phone,
                "call_direction": call_direction,
                "assistant_type": assistant_type,
                "record_url": permanent_record_url
            }
        
        return {
            "success": True,
            "message": "Log data received and processed"
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.4] ❌ Ошибка логирования: {e}")
        logger.error(f"[VOXIMPLANT-v3.4] Трассировка: {traceback.format_exc()}")
        return {
            "success": False,
            "message": f"Error logging data: {str(e)}"
        }


# =============================================================================
# ЭНДПОИНТ: Проверка Google Sheets
# =============================================================================

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
        
        logger.info(f"[SHEETS-v3.4] 🔍 Проверка подключения к таблице: {sheet_id}")
        
        # Проверяем доступ к таблице
        verify_result = await GoogleSheetsService.verify_sheet_access(sheet_id)
        
        if verify_result["success"]:
            # Настраиваем заголовки таблицы
            setup_result = await GoogleSheetsService.setup_sheet(sheet_id)
            
            # Сохраняем google_sheet_id
            if assistant_id != "new":
                try:
                    # Ищем в обеих таблицах
                    assistant, assistant_type = find_assistant_by_id(db, assistant_id)
                    
                    if assistant:
                        # Сохраняем sheet_id в google_sheet_id
                        assistant.google_sheet_id = sheet_id
                        if hasattr(assistant, 'log_enabled'):
                            assistant.log_enabled = True
                        db.commit()
                        logger.info(f"[SHEETS-v3.4] ✅ ID таблицы сохранен для {assistant_type} ассистента {assistant_id}")
                except Exception as e:
                    logger.error(f"[SHEETS-v3.4] ❌ Ошибка при сохранении ID таблицы: {str(e)}")
                    
            return {
                "success": True,
                "message": "Подключение к таблице успешно проверено и настроено",
                "sheet_title": verify_result.get("title"),
                "columns": ["Timestamp", "User", "Assistant", "Function Result", "Conversation ID", "Caller Number"]
            }
        else:
            return verify_result
            
    except Exception as e:
        logger.error(f"[SHEETS-v3.4] ❌ Ошибка при проверке таблицы: {str(e)}")
        logger.error(traceback.format_exc())
        return {
            "success": False,
            "message": f"Ошибка: {str(e)}"
        }


# =============================================================================
# ЭНДПОИНТ: Запуск исходящих звонков
# =============================================================================

@router.post("/start-outbound-call")
async def start_outbound_call(
    request_data: Dict[str, Any] = Body(...)
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
