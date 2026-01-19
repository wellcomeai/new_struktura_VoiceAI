# backend/api/voximplant.py - Production Version 3.8

"""
Voximplant API endpoints для WellcomeAI, обновленные для гибкой архитектуры.
🆕 v2.1: Enhanced logging with caller_number and conversation_id tracking
🆕 v2.2: Added database persistence for conversations
🆕 v3.1: Phone normalization and call direction extraction
🆕 v3.2: Support for both OpenAI and Gemini assistants in logging
🆕 v3.3: Cloudflare R2 Storage for permanent call recordings
🆕 v3.4: Service Account JWT авторизация для secure записей Voximplant
🆕 v3.5: Поддержка call_cost и call_duration для биллинга
🆕 v3.6: ПОЛНАЯ стоимость звонка через GetCallHistory API (calls + records + other_resource_usage)
🆕 v3.7: ОТЛОЖЕННЫЙ ПЕРЕСЧЁТ стоимости через 15 секунд если GetCallHistory не вернул данные сразу
🆕 v3.8: СТРУКТУРИРОВАННЫЙ ДИАЛОГ (dialog) для отображения чат-интерфейса в UI
"""

from fastapi import APIRouter, WebSocket, Depends, Query, HTTPException, status, Header, Body
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, List
import time
import uuid
import json
import traceback
import httpx
import asyncio

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.db.session import get_db, SessionLocal
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.user import User
from backend.models.conversation import Conversation
from backend.models.voximplant_child import VoximplantChildAccount
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
# 🆕 v3.6: ПОЛУЧЕНИЕ VOXIMPLANT API CREDENTIALS
# =============================================================================

def get_voximplant_api_credentials(db: Session, user_id: uuid.UUID) -> Optional[Dict[str, Any]]:
    """
    Получает API credentials (account_id, api_key) для пользователя.
    
    Находит дочерний аккаунт Voximplant и возвращает credentials
    для вызова GetCallHistory API.
    
    Args:
        db: Сессия БД
        user_id: UUID пользователя (владельца ассистента)
        
    Returns:
        Dict с credentials или None:
        {
            "account_id": str,
            "api_key": str
        }
    """
    try:
        # Находим дочерний аккаунт по user_id
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == user_id
        ).first()
        
        if not child_account:
            logger.warning(f"[VOXIMPLANT-v3.8] No child account found for user {user_id}")
            return None
        
        # Проверяем наличие API credentials
        if not child_account.vox_account_id or not child_account.vox_api_key:
            logger.warning(f"[VOXIMPLANT-v3.8] Missing API credentials for user {user_id}")
            return None
        
        logger.info(f"[VOXIMPLANT-v3.8] ✅ Loaded API credentials for account {child_account.vox_account_id}")
        
        return {
            "account_id": child_account.vox_account_id,
            "api_key": child_account.vox_api_key
        }
            
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] Error getting API credentials: {e}")
        return None


# =============================================================================
# 🆕 v3.6: ПОЛУЧЕНИЕ ПОЛНОЙ СТОИМОСТИ ЗВОНКА ЧЕРЕЗ GetCallHistory
# =============================================================================

async def get_full_call_cost(
    call_session_history_id: str,
    account_id: str,
    api_key: str
) -> Dict[str, Any]:
    """
    Получает полную стоимость звонка через Voximplant GetCallHistory API.
    
    Суммирует все компоненты стоимости:
    - calls[].cost - стоимость телефонии
    - records[].cost - стоимость записи
    - other_resource_usage[].cost - стоимость WebSocket/AI и других ресурсов
    
    Args:
        call_session_history_id: ID сессии звонка от Voximplant
        account_id: ID аккаунта Voximplant
        api_key: API ключ аккаунта
        
    Returns:
        Dict с результатами:
        {
            "success": bool,
            "total_cost": float,
            "calls_cost": float,
            "records_cost": float,
            "other_cost": float,
            "duration": int,
            "details": {...}  # Полный ответ API для отладки
        }
    """
    try:
        logger.info(f"[VOXIMPLANT-v3.8] 📊 Getting full call cost for session {call_session_history_id}")
        
        # URL Voximplant API
        voximplant_url = "https://api.voximplant.com/platform_api/GetCallHistory"
        
        # Параметры запроса
        params = {
            "account_id": account_id,
            "api_key": api_key,
            "call_session_history_id": call_session_history_id,
            "with_calls": "true",
            "with_records": "true",
            "with_other_resources": "true"
        }
        
        logger.info(f"[VOXIMPLANT-v3.8] 📡 Requesting GetCallHistory...")
        logger.info(f"[VOXIMPLANT-v3.8]    Account ID: {account_id}")
        logger.info(f"[VOXIMPLANT-v3.8]    Session ID: {call_session_history_id}")
        
        # Выполняем запрос
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(voximplant_url, data=params)
            
            if response.status_code != 200:
                logger.error(f"[VOXIMPLANT-v3.8] ❌ HTTP Error: {response.status_code}")
                logger.error(f"[VOXIMPLANT-v3.8]    Response: {response.text[:500]}")
                return {
                    "success": False,
                    "error": f"HTTP {response.status_code}",
                    "total_cost": 0,
                    "calls_cost": 0,
                    "records_cost": 0,
                    "other_cost": 0,
                    "duration": 0
                }
            
            result = response.json()
        
        # Проверяем наличие результатов
        if not result.get("result") or len(result["result"]) == 0:
            logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ No results found for session {call_session_history_id}")
            return {
                "success": False,
                "error": "No results found",
                "total_cost": 0,
                "calls_cost": 0,
                "records_cost": 0,
                "other_cost": 0,
                "duration": 0
            }
        
        # Берём первый (и единственный) результат
        call_data = result["result"][0]
        
        # Суммируем стоимость из calls[]
        calls_cost = 0.0
        total_duration = 0
        calls_list = call_data.get("calls", [])
        for call in calls_list:
            cost = call.get("cost", 0)
            if cost:
                calls_cost += float(cost)
            duration = call.get("duration", 0)
            if duration:
                total_duration = max(total_duration, int(duration))
        
        logger.info(f"[VOXIMPLANT-v3.8]    📞 Calls cost: {calls_cost} ({len(calls_list)} calls)")
        
        # Суммируем стоимость из records[]
        records_cost = 0.0
        records_list = call_data.get("records", [])
        for record in records_list:
            cost = record.get("cost", 0)
            if cost:
                records_cost += float(cost)
        
        logger.info(f"[VOXIMPLANT-v3.8]    🎙️ Records cost: {records_cost} ({len(records_list)} records)")
        
        # Суммируем стоимость из other_resource_usage[]
        other_cost = 0.0
        other_list = call_data.get("other_resource_usage", [])
        for resource in other_list:
            cost = resource.get("cost", 0)
            if cost:
                other_cost += float(cost)
        
        logger.info(f"[VOXIMPLANT-v3.8]    ⚡ Other resources cost: {other_cost} ({len(other_list)} resources)")
        
        # Общая стоимость
        total_cost = calls_cost + records_cost + other_cost
        
        # Также берём duration из верхнего уровня если есть
        if call_data.get("duration"):
            total_duration = max(total_duration, int(call_data["duration"]))
        
        logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logger.info(f"[VOXIMPLANT-v3.8] 💰 TOTAL COST: {total_cost}")
        logger.info(f"[VOXIMPLANT-v3.8]    Calls:   {calls_cost}")
        logger.info(f"[VOXIMPLANT-v3.8]    Records: {records_cost}")
        logger.info(f"[VOXIMPLANT-v3.8]    Other:   {other_cost}")
        logger.info(f"[VOXIMPLANT-v3.8]    Duration: {total_duration}s")
        logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        
        return {
            "success": True,
            "total_cost": round(total_cost, 6),
            "calls_cost": round(calls_cost, 6),
            "records_cost": round(records_cost, 6),
            "other_cost": round(other_cost, 6),
            "duration": total_duration,
            "details": {
                "rule_name": call_data.get("rule_name"),
                "application_name": call_data.get("application_name"),
                "finish_reason": call_data.get("finish_reason"),
                "start_date": call_data.get("start_date"),
                "calls_count": len(calls_list),
                "records_count": len(records_list),
                "other_resources_count": len(other_list)
            }
        }
        
    except httpx.TimeoutException:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Timeout calling GetCallHistory")
        return {
            "success": False,
            "error": "Timeout",
            "total_cost": 0,
            "calls_cost": 0,
            "records_cost": 0,
            "other_cost": 0,
            "duration": 0
        }
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Error getting call cost: {e}")
        logger.error(traceback.format_exc())
        return {
            "success": False,
            "error": str(e),
            "total_cost": 0,
            "calls_cost": 0,
            "records_cost": 0,
            "other_cost": 0,
            "duration": 0
        }


# =============================================================================
# 🆕 v3.7: ОТЛОЖЕННЫЙ ПЕРЕСЧЁТ СТОИМОСТИ
# =============================================================================

async def delayed_cost_recalculation(
    conversation_id: str,
    call_session_history_id: str,
    account_id: str,
    api_key: str,
    delay_seconds: int = 15
):
    """
    Отложенный пересчёт стоимости звонка.
    
    Voximplant обрабатывает биллинг с задержкой, поэтому
    запрашиваем GetCallHistory через delay_seconds секунд.
    
    Args:
        conversation_id: UUID записи разговора в нашей БД
        call_session_history_id: ID сессии звонка в Voximplant
        account_id: ID аккаунта Voximplant
        api_key: API ключ аккаунта
        delay_seconds: Задержка перед пересчётом (по умолчанию 15 секунд)
    """
    try:
        logger.info(f"[VOXIMPLANT-DELAYED] ⏳ Scheduled recalculation for {conversation_id} in {delay_seconds}s")
        
        # Ждём пока Voximplant обработает биллинг
        await asyncio.sleep(delay_seconds)
        
        logger.info(f"[VOXIMPLANT-DELAYED] 🔄 Starting delayed recalculation for {conversation_id}")
        
        # Запрашиваем полную стоимость
        cost_result = await get_full_call_cost(
            call_session_history_id=call_session_history_id,
            account_id=account_id,
            api_key=api_key
        )
        
        if not cost_result["success"]:
            logger.warning(f"[VOXIMPLANT-DELAYED] ⚠️ Failed to get cost: {cost_result.get('error')}")
            return
        
        # Проверяем что есть реальные данные (не нули)
        if cost_result["total_cost"] == 0 and cost_result["calls_cost"] == 0:
            logger.warning(f"[VOXIMPLANT-DELAYED] ⚠️ GetCallHistory returned zero cost, skipping update")
            return
        
        # Обновляем в БД
        db = SessionLocal()
        try:
            conversation = db.query(Conversation).filter(
                Conversation.id == uuid.UUID(conversation_id)
            ).first()
            
            if not conversation:
                logger.warning(f"[VOXIMPLANT-DELAYED] ⚠️ Conversation not found: {conversation_id}")
                return
            
            # Сохраняем старую стоимость для логирования
            old_cost = conversation.call_cost
            old_duration = conversation.duration_seconds
            
            # Обновляем стоимость
            conversation.call_cost = cost_result["total_cost"]
            conversation.duration_seconds = cost_result["duration"]
            
            # Обновляем client_info с breakdown
            client_info = conversation.client_info or {}
            client_info["cost_breakdown"] = {
                "calls_cost": cost_result["calls_cost"],
                "records_cost": cost_result["records_cost"],
                "other_cost": cost_result["other_cost"],
                "details": cost_result["details"],
                "recalculated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "recalculation_type": "delayed_auto",
                "delay_seconds": delay_seconds
            }
            # Сохраняем старые значения для аудита
            client_info["original_script_cost"] = old_cost
            client_info["original_script_duration"] = old_duration
            
            conversation.client_info = client_info
            
            db.commit()
            
            logger.info(f"[VOXIMPLANT-DELAYED] ✅ Updated cost for {conversation_id}")
            logger.info(f"[VOXIMPLANT-DELAYED]    Cost: {old_cost} → {cost_result['total_cost']}")
            logger.info(f"[VOXIMPLANT-DELAYED]    Duration: {old_duration} → {cost_result['duration']}")
            logger.info(f"[VOXIMPLANT-DELAYED]    Breakdown: calls={cost_result['calls_cost']}, records={cost_result['records_cost']}, other={cost_result['other_cost']}")
            
        except Exception as db_error:
            logger.error(f"[VOXIMPLANT-DELAYED] ❌ DB error: {db_error}")
            db.rollback()
        finally:
            db.close()
            
    except asyncio.CancelledError:
        logger.info(f"[VOXIMPLANT-DELAYED] ⚠️ Task cancelled for {conversation_id}")
    except Exception as e:
        logger.error(f"[VOXIMPLANT-DELAYED] ❌ Error in delayed recalculation: {e}")
        logger.error(traceback.format_exc())


# =============================================================================
# HELPER - Получение Service Account credentials (для JWT авторизации записей)
# =============================================================================

def get_voximplant_credentials(db: Session, user_id: uuid.UUID) -> Optional[Dict[str, Any]]:
    """
    Получает Service Account credentials для пользователя.
    
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
            logger.warning(f"[VOXIMPLANT-v3.8] No child account found for user {user_id}")
            return None
        
        # Проверяем наличие Service Account credentials
        if not child_account.vox_service_account_key:
            logger.warning(f"[VOXIMPLANT-v3.8] No Service Account credentials for account {child_account.vox_account_id}")
            logger.warning(f"[VOXIMPLANT-v3.8] Run admin/setup-service-accounts to create them")
            return None
        
        # Парсим JSON с credentials
        try:
            credentials = json.loads(child_account.vox_service_account_key)
            
            # Валидируем обязательные поля
            if not credentials.get("account_id"):
                logger.error(f"[VOXIMPLANT-v3.8] Missing account_id in credentials")
                return None
            if not credentials.get("key_id"):
                logger.error(f"[VOXIMPLANT-v3.8] Missing key_id in credentials")
                return None
            if not credentials.get("private_key"):
                logger.error(f"[VOXIMPLANT-v3.8] Missing private_key in credentials")
                return None
            
            logger.info(f"[VOXIMPLANT-v3.8] ✅ Loaded credentials for child account {child_account.vox_account_id}")
            logger.info(f"[VOXIMPLANT-v3.8]    Key ID: {credentials.get('key_id')}")
            
            return credentials
            
        except json.JSONDecodeError as json_error:
            logger.error(f"[VOXIMPLANT-v3.8] Failed to parse credentials JSON: {json_error}")
            return None
            
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] Error getting credentials: {e}")
        return None


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
# 🆕 v3.8: ГЛАВНЫЙ ЭНДПОИНТ /log С СТРУКТУРИРОВАННЫМ ДИАЛОГОМ
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
    🆕 v3.4: Service Account JWT авторизация для secure записей Voximplant
    🆕 v3.5: Поддержка call_cost и call_duration для биллинга
    🆕 v3.6: ПОЛНАЯ стоимость через GetCallHistory API (calls + records + other_resource_usage)
    🆕 v3.7: ОТЛОЖЕННЫЙ ПЕРЕСЧЁТ стоимости через 15 секунд если GetCallHistory не вернул данные сразу
    🆕 v3.8: СТРУКТУРИРОВАННЫЙ ДИАЛОГ (dialog) для отображения чат-интерфейса в UI
    
    Формат запроса:
    {
        "assistant_id": "uuid",
        "chat_id": "string",
        "call_id": "string",
        "caller_number": "string",              // Номер телефона с префиксом INBOUND:/OUTBOUND:
        "record_url": "string",                 // Временный URL записи от Voximplant
        "call_session_history_id": "string",    // ID сессии для GetCallHistory
        "call_cost": 0.05,                      // Частичная стоимость (fallback)
        "call_duration": 125,                   // Длительность звонка в секундах
        "type": "conversation",
        "data": {
            "user_message": "string",           // Сводный текст пользователя (для поиска)
            "assistant_message": "string",      // Сводный текст ассистента (для поиска)
            "function_result": "object",
            "dialog": [                         // 🆕 v3.8: Структурированный диалог для UI
                {"role": "assistant", "text": "Здравствуйте!", "ts": 1737267554000},
                {"role": "user", "text": "Привет", "ts": 1737267558000}
            ]
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
        
        # 🆕 v3.6: Получаем call_session_history_id для полной стоимости
        call_session_history_id = request_data.get("call_session_history_id")
        
        # Fallback значения от скрипта (частичная стоимость)
        call_cost_from_script = request_data.get("call_cost")
        call_duration_from_script = request_data.get("call_duration")
        
        logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logger.info(f"[VOXIMPLANT-v3.8] 📥 Получены данные для логирования:")
        logger.info(f"[VOXIMPLANT-v3.8]   📋 Тип: {data_type}")
        logger.info(f"[VOXIMPLANT-v3.8]   🆔 Assistant ID: {assistant_id}")
        logger.info(f"[VOXIMPLANT-v3.8]   💬 Chat ID: {chat_id}")
        logger.info(f"[VOXIMPLANT-v3.8]   📞 Call ID: {call_id}")
        logger.info(f"[VOXIMPLANT-v3.8]   📱 Caller Number (raw): {caller_number}")
        logger.info(f"[VOXIMPLANT-v3.8]   🎙️ Record URL: {'✅ Есть' if record_url else '❌ Нет'}")
        logger.info(f"[VOXIMPLANT-v3.8]   🔑 Session History ID: {call_session_history_id or 'НЕТ'}")
        logger.info(f"[VOXIMPLANT-v3.8]   💰 Script Cost (fallback): {call_cost_from_script}")
        logger.info(f"[VOXIMPLANT-v3.8]   ⏱️ Script Duration: {call_duration_from_script}s")
        logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        
        if not assistant_id or not (chat_id or call_id):
            logger.warning("[VOXIMPLANT-v3.8] ❌ Отсутствуют обязательные параметры")
            return {
                "success": False,
                "message": "Missing required parameters (assistant_id and chat_id/call_id)"
            }
        
        # Если тип данных - разговор, сохраняем и в Sheets и в БД
        if data_type == "conversation":
            # Получаем ассистента (проверяем ОБА типа)
            assistant, assistant_type = find_assistant_by_id(db, assistant_id)
            
            if not assistant:
                logger.error(f"[VOXIMPLANT-v3.8] ❌ Ассистент не найден ни в OpenAI, ни в Gemini: {assistant_id}")
                return {
                    "success": False,
                    "message": "Assistant not found in any table"
                }
            
            logger.info(f"[VOXIMPLANT-v3.8] ✅ Найден ассистент типа {assistant_type}: {assistant.name}")
            
            # Получаем данные сообщений
            user_message = data.get("user_message", "")
            assistant_message = data.get("assistant_message", "")
            function_result = data.get("function_result")
            
            # 🆕 v3.8: Получаем структурированный диалог для UI
            dialog = data.get("dialog", [])
            
            if dialog and isinstance(dialog, list) and len(dialog) > 0:
                logger.info(f"[VOXIMPLANT-v3.8] 📝 Received structured dialog: {len(dialog)} turns")
                for i, turn in enumerate(dialog[:3]):  # Логируем первые 3 реплики
                    role = turn.get('role', 'unknown')
                    text = turn.get('text', '')[:50]
                    logger.info(f"[VOXIMPLANT-v3.8]    [{i+1}] {role}: {text}...")
                if len(dialog) > 3:
                    logger.info(f"[VOXIMPLANT-v3.8]    ... и ещё {len(dialog) - 3} реплик")
            else:
                logger.info(f"[VOXIMPLANT-v3.8] ⚠️ No structured dialog in payload, using legacy format")
            
            # Логируем длину сообщений
            logger.info(f"[VOXIMPLANT-v3.8] 📏 Длина сообщения пользователя: {len(user_message)} символов")
            logger.info(f"[VOXIMPLANT-v3.8] 📏 Длина сообщения ассистента: {len(assistant_message)} символов")
            
            if not user_message and not assistant_message and not dialog:
                logger.warning("[VOXIMPLANT-v3.8] ⚠️ Пустые сообщения и диалог для логирования, пропускаем")
                return {
                    "success": False,
                    "message": "Empty messages and dialog, logging skipped"
                }
            
            # Определяем conversation_id (приоритет - call_id, fallback - chat_id)
            conversation_id = call_id or chat_id
            
            # Извлекаем направление звонка и нормализуем номер
            call_direction = ConversationService._extract_call_direction(caller_number)
            normalized_phone = ConversationService._normalize_phone(caller_number) if caller_number else "unknown"
            
            logger.info(f"[VOXIMPLANT-v3.8] 🔍 Extracted:")
            logger.info(f"[VOXIMPLANT-v3.8]   📞 Direction: {call_direction}")
            logger.info(f"[VOXIMPLANT-v3.8]   📱 Normalized phone: {normalized_phone}")
            logger.info(f"[VOXIMPLANT-v3.8]   🤖 Assistant type: {assistant_type}")
            
            # ================================================================
            # 🆕 v3.7: ПОЛУЧЕНИЕ ПОЛНОЙ СТОИМОСТИ ЧЕРЕЗ GetCallHistory
            # ================================================================
            call_cost = None
            call_duration = None
            cost_breakdown = None
            api_credentials = None
            
            if call_session_history_id and assistant.user_id:
                logger.info(f"[VOXIMPLANT-v3.8] 💰 Запрашиваем полную стоимость через GetCallHistory...")
                
                # Получаем API credentials
                api_credentials = get_voximplant_api_credentials(db, assistant.user_id)
                
                if api_credentials:
                    # Запрашиваем полную стоимость
                    cost_result = await get_full_call_cost(
                        call_session_history_id=call_session_history_id,
                        account_id=api_credentials["account_id"],
                        api_key=api_credentials["api_key"]
                    )
                    
                    if cost_result["success"] and cost_result["total_cost"] > 0:
                        call_cost = cost_result["total_cost"]
                        call_duration = cost_result["duration"]
                        cost_breakdown = {
                            "calls_cost": cost_result["calls_cost"],
                            "records_cost": cost_result["records_cost"],
                            "other_cost": cost_result["other_cost"],
                            "details": cost_result["details"]
                        }
                        logger.info(f"[VOXIMPLANT-v3.8] ✅ Получена ПОЛНАЯ стоимость: {call_cost}")
                    else:
                        logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Не удалось получить полную стоимость: {cost_result.get('error')}")
                        logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Будет запланирован отложенный пересчёт")
                else:
                    logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Нет API credentials")
            else:
                if not call_session_history_id:
                    logger.info(f"[VOXIMPLANT-v3.8] ℹ️ Нет call_session_history_id, используем значения от скрипта")
                if not assistant.user_id:
                    logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Нет user_id у ассистента")
            
            # Fallback на значения от скрипта если не получили через API
            if call_cost is None and call_cost_from_script is not None:
                try:
                    call_cost = float(call_cost_from_script)
                    logger.info(f"[VOXIMPLANT-v3.8] 💰 Используем cost от скрипта (fallback): {call_cost}")
                except (ValueError, TypeError):
                    pass
            
            if call_duration is None and call_duration_from_script is not None:
                try:
                    call_duration = float(call_duration_from_script)
                    logger.info(f"[VOXIMPLANT-v3.8] ⏱️ Используем duration от скрипта (fallback): {call_duration}")
                except (ValueError, TypeError):
                    pass
            
            # ================================================================
            # СОХРАНЕНИЕ ЗАПИСИ В CLOUDFLARE R2 С JWT АВТОРИЗАЦИЕЙ
            # ================================================================
            permanent_record_url = None
            r2_saved = False
            
            if record_url:
                logger.info(f"[VOXIMPLANT-v3.8] 🎙️ Обработка записи звонка...")
                logger.info(f"[VOXIMPLANT-v3.8]   Voximplant URL: {record_url[:60]}...")
                
                if R2StorageService.is_configured():
                    try:
                        # Получаем Service Account credentials для JWT авторизации
                        voximplant_credentials = None
                        
                        if assistant.user_id:
                            voximplant_credentials = get_voximplant_credentials(db, assistant.user_id)
                            
                            if voximplant_credentials:
                                logger.info(f"[VOXIMPLANT-v3.8] 🔐 Service Account credentials loaded")
                            else:
                                logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ No Service Account credentials available")
                                logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Secure recordings may fail to download")
                        
                        logger.info(f"[VOXIMPLANT-v3.8] 📤 Загрузка в R2 Storage...")
                        
                        # Передаём credentials в R2StorageService
                        permanent_record_url = await R2StorageService.upload_recording(
                            record_url=record_url,
                            call_id=call_id or chat_id or str(uuid.uuid4()),
                            assistant_id=assistant_id,
                            voximplant_credentials=voximplant_credentials
                        )
                        
                        if permanent_record_url:
                            r2_saved = True
                            logger.info(f"[VOXIMPLANT-v3.8] ✅ Запись сохранена в R2:")
                            logger.info(f"[VOXIMPLANT-v3.8]   URL: {permanent_record_url}")
                        else:
                            logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Не удалось сохранить в R2, используем временный URL")
                            permanent_record_url = record_url
                            
                    except Exception as r2_error:
                        logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка R2: {r2_error}")
                        logger.error(f"[VOXIMPLANT-v3.8] Traceback: {traceback.format_exc()}")
                        # Используем временный URL как fallback
                        permanent_record_url = record_url
                else:
                    logger.info(f"[VOXIMPLANT-v3.8] ℹ️ R2 не настроен, используем временный Voximplant URL")
                    permanent_record_url = record_url
            
            # ================================================================
            # СОХРАНЕНИЕ В БД
            # ================================================================
            logger.info(f"[VOXIMPLANT-v3.8] 💾 Сохранение в БД...")
            db_result = None
            
            try:
                # Подготавливаем client_info с дополнительными данными
                client_info = {
                    "call_id": call_id,
                    "chat_id": chat_id,
                    "source": "voximplant",
                    "assistant_type": assistant_type,
                    "record_url": permanent_record_url
                }
                
                # 🆕 v3.8: Сохраняем структурированный диалог для UI
                if dialog and isinstance(dialog, list) and len(dialog) > 0:
                    client_info["dialog"] = dialog
                    logger.info(f"[VOXIMPLANT-v3.8] 📝 Saved dialog with {len(dialog)} turns to client_info")
                
                # 🆕 v3.6: Добавляем call_session_history_id и breakdown
                if call_session_history_id:
                    client_info["call_session_history_id"] = call_session_history_id
                
                if cost_breakdown:
                    client_info["cost_breakdown"] = cost_breakdown
                
                # Резервное сохранение cost и duration в client_info
                if call_cost is not None:
                    client_info["call_cost"] = call_cost
                if call_duration is not None:
                    client_info["call_duration"] = call_duration
                
                # Вызываем ConversationService для сохранения
                db_result = await ConversationService.save_conversation(
                    db=db,
                    assistant_id=assistant_id,
                    user_message=user_message,
                    assistant_message=assistant_message,
                    session_id=conversation_id,
                    caller_number=caller_number,
                    call_direction=call_direction,
                    client_info=client_info,
                    audio_duration=None,
                    tokens_used=0
                )
                
                # Обновляем call_cost и duration_seconds напрямую в записи
                if db_result:
                    update_needed = False
                    
                    # Сохраняем call_cost в отдельное поле
                    if call_cost is not None:
                        try:
                            db_result.call_cost = float(call_cost)
                            update_needed = True
                            logger.info(f"[VOXIMPLANT-v3.8] 💰 Call cost set: {call_cost}")
                        except (ValueError, TypeError) as e:
                            logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Invalid call_cost value: {call_cost}, error: {e}")
                    
                    # Сохраняем call_duration в duration_seconds
                    if call_duration is not None:
                        try:
                            db_result.duration_seconds = float(call_duration)
                            update_needed = True
                            logger.info(f"[VOXIMPLANT-v3.8] ⏱️ Duration set: {call_duration}s")
                        except (ValueError, TypeError) as e:
                            logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Invalid call_duration value: {call_duration}, error: {e}")
                    
                    # Коммитим изменения если были обновления
                    if update_needed:
                        db.commit()
                        db.refresh(db_result)
                    
                    logger.info(f"[VOXIMPLANT-v3.8] ✅ Сохранено в БД:")
                    logger.info(f"[VOXIMPLANT-v3.8]   ID: {db_result.id}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Direction: {db_result.call_direction}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Phone: {db_result.caller_number}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Contact: {db_result.contact_id}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Record URL: {'✅' if permanent_record_url else '❌'}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Call Cost: {db_result.call_cost}")
                    logger.info(f"[VOXIMPLANT-v3.8]   Duration: {db_result.duration_seconds}s")
                    logger.info(f"[VOXIMPLANT-v3.8]   Dialog turns: {len(dialog) if dialog else 0}")
                    if cost_breakdown:
                        logger.info(f"[VOXIMPLANT-v3.8]   Cost Source: GetCallHistory API (FULL)")
                    else:
                        logger.info(f"[VOXIMPLANT-v3.8]   Cost Source: Script fallback (PARTIAL)")
                else:
                    logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Не удалось сохранить в БД")
                    
            except Exception as db_error:
                logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка сохранения в БД: {db_error}")
                logger.error(f"[VOXIMPLANT-v3.8] Traceback: {traceback.format_exc()}")
            
            # ================================================================
            # 🆕 v3.7: ЗАПУСК ОТЛОЖЕННОГО ПЕРЕСЧЁТА ЕСЛИ НЕ ПОЛУЧИЛИ BREAKDOWN
            # ================================================================
            delayed_recalc_scheduled = False
            
            if (call_session_history_id 
                and api_credentials 
                and not cost_breakdown 
                and db_result):
                try:
                    logger.info(f"[VOXIMPLANT-v3.8] 📅 Планируем отложенный пересчёт через 15 секунд...")
                    
                    asyncio.create_task(
                        delayed_cost_recalculation(
                            conversation_id=str(db_result.id),
                            call_session_history_id=call_session_history_id,
                            account_id=api_credentials["account_id"],
                            api_key=api_credentials["api_key"],
                            delay_seconds=15
                        )
                    )
                    
                    delayed_recalc_scheduled = True
                    logger.info(f"[VOXIMPLANT-v3.8] ✅ Отложенный пересчёт запланирован")
                    
                except Exception as task_error:
                    logger.warning(f"[VOXIMPLANT-v3.8] ⚠️ Не удалось запланировать отложенный пересчёт: {task_error}")
            
            # ================================================================
            # СОХРАНЕНИЕ В GOOGLE SHEETS (оригинальная логика)
            # ================================================================
            sheets_result = False
            if hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
                log_sheet_id = assistant.google_sheet_id
                logger.info(f"[VOXIMPLANT-v3.8] 📊 Запись в Google Sheets: {log_sheet_id}")
                
                try:
                    sheets_result = await GoogleSheetsService.log_conversation(
                        sheet_id=log_sheet_id,
                        user_message=user_message,
                        assistant_message=assistant_message,
                        function_result=function_result,
                        conversation_id=conversation_id,
                        caller_number=normalized_phone,
                        call_cost=call_cost,
                        call_duration=call_duration
                    )
                    
                    if sheets_result:
                        logger.info(f"[VOXIMPLANT-v3.8] ✅ Данные записаны в Google Sheets")
                    else:
                        logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка записи в Google Sheets")
                        
                except Exception as sheets_error:
                    logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка Google Sheets: {sheets_error}")
                    logger.error(f"[VOXIMPLANT-v3.8] Traceback: {traceback.format_exc()}")
            else:
                logger.info(f"[VOXIMPLANT-v3.8] ⚠️ Google Sheets логирование не настроено")
            
            # ================================================================
            # ФОРМИРУЕМ ОТВЕТ
            # ================================================================
            logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[VOXIMPLANT-v3.8] 📊 РЕЗУЛЬТАТЫ ЛОГИРОВАНИЯ:")
            logger.info(f"[VOXIMPLANT-v3.8]   🤖 Тип ассистента: {assistant_type}")
            logger.info(f"[VOXIMPLANT-v3.8]   💾 БД: {'✅ OK' if db_result else '❌ FAIL'}")
            logger.info(f"[VOXIMPLANT-v3.8]   📊 Sheets: {'✅ OK' if sheets_result else '❌ FAIL/SKIP'}")
            logger.info(f"[VOXIMPLANT-v3.8]   🎙️ Запись: {'✅ R2' if r2_saved else '⚠️ Temp' if permanent_record_url else '❌ НЕТ'}")
            logger.info(f"[VOXIMPLANT-v3.8]   📝 Dialog: {len(dialog) if dialog else 0} turns")
            logger.info(f"[VOXIMPLANT-v3.8]   💰 Total Cost: {call_cost}")
            if cost_breakdown:
                logger.info(f"[VOXIMPLANT-v3.8]      ├─ Calls: {cost_breakdown['calls_cost']}")
                logger.info(f"[VOXIMPLANT-v3.8]      ├─ Records: {cost_breakdown['records_cost']}")
                logger.info(f"[VOXIMPLANT-v3.8]      └─ Other: {cost_breakdown['other_cost']}")
            logger.info(f"[VOXIMPLANT-v3.8]   ⏱️ Duration: {call_duration}s")
            logger.info(f"[VOXIMPLANT-v3.8]   📅 Delayed Recalc: {'✅ Scheduled' if delayed_recalc_scheduled else '❌ Not needed'}")
            logger.info(f"[VOXIMPLANT-v3.8] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
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
                "record_url": permanent_record_url,
                # 🆕 v3.8: Возвращаем информацию о диалоге
                "dialog_turns": len(dialog) if dialog else 0,
                # v3.7: Возвращаем полную стоимость и статус отложенного пересчёта
                "call_cost": float(call_cost) if call_cost is not None else None,
                "call_duration": float(call_duration) if call_duration is not None else None,
                "cost_source": "GetCallHistory" if cost_breakdown else "script_fallback",
                "cost_breakdown": cost_breakdown,
                "delayed_recalculation_scheduled": delayed_recalc_scheduled
            }
        
        return {
            "success": True,
            "message": "Log data received and processed"
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка логирования: {e}")
        logger.error(f"[VOXIMPLANT-v3.8] Трассировка: {traceback.format_exc()}")
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
        
        logger.info(f"[SHEETS-v3.8] 🔍 Проверка подключения к таблице: {sheet_id}")
        
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
                        logger.info(f"[SHEETS-v3.8] ✅ ID таблицы сохранен для {assistant_type} ассистента {assistant_id}")
                except Exception as e:
                    logger.error(f"[SHEETS-v3.8] ❌ Ошибка при сохранении ID таблицы: {str(e)}")
                    
            return {
                "success": True,
                "message": "Подключение к таблице успешно проверено и настроено",
                "sheet_title": verify_result.get("title"),
                "columns": ["Timestamp", "User", "Assistant", "Function Result", "Conversation ID", "Caller Number", "Call Cost", "Duration"]
            }
        else:
            return verify_result
            
    except Exception as e:
        logger.error(f"[SHEETS-v3.8] ❌ Ошибка при проверке таблицы: {str(e)}")
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


# =============================================================================
# ЭНДПОИНТЫ ДЛЯ АНАЛИТИКИ СТОИМОСТИ ЗВОНКОВ
# =============================================================================

@router.get("/analytics/costs/{assistant_id}")
async def get_assistant_call_costs(
    assistant_id: str,
    days: int = Query(default=30, ge=1, le=365, description="Период в днях"),
    db: Session = Depends(get_db)
):
    """
    Получение аналитики по стоимости звонков для ассистента.
    
    Returns:
        {
            "total_cost": float,
            "total_calls": int,
            "total_duration": float,
            "avg_cost": float,
            "avg_duration": float,
            "daily_stats": [...]
        }
    """
    try:
        from sqlalchemy import func as sql_func
        from datetime import datetime, timedelta
        
        # Проверяем ассистента
        assistant, assistant_type = find_assistant_by_id(db, assistant_id)
        if not assistant:
            raise HTTPException(status_code=404, detail="Assistant not found")
        
        # Определяем период
        start_date = datetime.utcnow() - timedelta(days=days)
        
        # Общая статистика
        stats = db.query(
            sql_func.count(Conversation.id).label("total_calls"),
            sql_func.sum(Conversation.call_cost).label("total_cost"),
            sql_func.sum(Conversation.duration_seconds).label("total_duration"),
            sql_func.avg(Conversation.call_cost).label("avg_cost"),
            sql_func.avg(Conversation.duration_seconds).label("avg_duration")
        ).filter(
            Conversation.assistant_id == assistant.id,
            Conversation.created_at >= start_date,
            Conversation.call_cost.isnot(None)
        ).first()
        
        # Статистика по дням
        daily_stats = db.query(
            sql_func.date(Conversation.created_at).label("date"),
            sql_func.count(Conversation.id).label("calls"),
            sql_func.sum(Conversation.call_cost).label("cost"),
            sql_func.sum(Conversation.duration_seconds).label("duration")
        ).filter(
            Conversation.assistant_id == assistant.id,
            Conversation.created_at >= start_date,
            Conversation.call_cost.isnot(None)
        ).group_by(
            sql_func.date(Conversation.created_at)
        ).order_by(
            sql_func.date(Conversation.created_at).desc()
        ).all()
        
        return {
            "assistant_id": assistant_id,
            "assistant_name": assistant.name,
            "assistant_type": assistant_type,
            "period_days": days,
            "total_cost": float(stats.total_cost or 0),
            "total_calls": stats.total_calls or 0,
            "total_duration": float(stats.total_duration or 0),
            "avg_cost": float(stats.avg_cost or 0),
            "avg_duration": float(stats.avg_duration or 0),
            "daily_stats": [
                {
                    "date": str(day.date),
                    "calls": day.calls,
                    "cost": float(day.cost or 0),
                    "duration": float(day.duration or 0)
                }
                for day in daily_stats
            ]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка аналитики: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/analytics/costs/user/{user_id}")
async def get_user_call_costs(
    user_id: str,
    days: int = Query(default=30, ge=1, le=365, description="Период в днях"),
    db: Session = Depends(get_db)
):
    """
    Получение общей аналитики по стоимости звонков для пользователя.
    Суммирует данные по всем ассистентам пользователя.
    """
    try:
        from sqlalchemy import func as sql_func
        from datetime import datetime, timedelta
        
        # Проверяем пользователя
        try:
            user_uuid = uuid.UUID(user_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid user_id format")
        
        user = db.query(User).get(user_uuid)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Определяем период
        start_date = datetime.utcnow() - timedelta(days=days)
        
        # Получаем все ассистенты пользователя (OpenAI)
        openai_assistants = db.query(AssistantConfig.id).filter(
            AssistantConfig.user_id == user_uuid
        ).all()
        
        # Получаем все ассистенты пользователя (Gemini)
        gemini_assistants = db.query(GeminiAssistantConfig.id).filter(
            GeminiAssistantConfig.user_id == user_uuid
        ).all()
        
        all_assistant_ids = [a.id for a in openai_assistants] + [a.id for a in gemini_assistants]
        
        if not all_assistant_ids:
            return {
                "user_id": user_id,
                "period_days": days,
                "total_cost": 0,
                "total_calls": 0,
                "total_duration": 0,
                "avg_cost": 0,
                "avg_duration": 0,
                "assistants": []
            }
        
        # Общая статистика по всем ассистентам
        total_stats = db.query(
            sql_func.count(Conversation.id).label("total_calls"),
            sql_func.sum(Conversation.call_cost).label("total_cost"),
            sql_func.sum(Conversation.duration_seconds).label("total_duration"),
            sql_func.avg(Conversation.call_cost).label("avg_cost"),
            sql_func.avg(Conversation.duration_seconds).label("avg_duration")
        ).filter(
            Conversation.assistant_id.in_(all_assistant_ids),
            Conversation.created_at >= start_date,
            Conversation.call_cost.isnot(None)
        ).first()
        
        # Статистика по каждому ассистенту
        per_assistant_stats = db.query(
            Conversation.assistant_id,
            sql_func.count(Conversation.id).label("calls"),
            sql_func.sum(Conversation.call_cost).label("cost"),
            sql_func.sum(Conversation.duration_seconds).label("duration")
        ).filter(
            Conversation.assistant_id.in_(all_assistant_ids),
            Conversation.created_at >= start_date,
            Conversation.call_cost.isnot(None)
        ).group_by(
            Conversation.assistant_id
        ).all()
        
        # Получаем имена ассистентов
        assistant_names = {}
        for a in db.query(AssistantConfig).filter(AssistantConfig.id.in_(all_assistant_ids)).all():
            assistant_names[str(a.id)] = {"name": a.name, "type": "openai"}
        for a in db.query(GeminiAssistantConfig).filter(GeminiAssistantConfig.id.in_(all_assistant_ids)).all():
            assistant_names[str(a.id)] = {"name": a.name, "type": "gemini"}
        
        return {
            "user_id": user_id,
            "user_email": user.email,
            "period_days": days,
            "total_cost": float(total_stats.total_cost or 0),
            "total_calls": total_stats.total_calls or 0,
            "total_duration": float(total_stats.total_duration or 0),
            "avg_cost": float(total_stats.avg_cost or 0),
            "avg_duration": float(total_stats.avg_duration or 0),
            "assistants": [
                {
                    "assistant_id": str(stat.assistant_id),
                    "assistant_name": assistant_names.get(str(stat.assistant_id), {}).get("name", "Unknown"),
                    "assistant_type": assistant_names.get(str(stat.assistant_id), {}).get("type", "unknown"),
                    "calls": stat.calls,
                    "cost": float(stat.cost or 0),
                    "duration": float(stat.duration or 0)
                }
                for stat in per_assistant_stats
            ]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Ошибка аналитики пользователя: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# ЭНДПОИНТ ДЛЯ РУЧНОГО ПЕРЕСЧЁТА СТОИМОСТИ ЗВОНКА
# =============================================================================

@router.post("/recalculate-cost/{conversation_id}")
async def recalculate_call_cost(
    conversation_id: str,
    db: Session = Depends(get_db)
):
    """
    Пересчитывает стоимость звонка через GetCallHistory API.
    
    Используется для обновления стоимости старых записей,
    у которых была сохранена только частичная стоимость.
    
    Args:
        conversation_id: UUID записи разговора
        
    Returns:
        {
            "success": bool,
            "old_cost": float,
            "new_cost": float,
            "cost_breakdown": {...}
        }
    """
    try:
        # Находим запись разговора
        try:
            conv_uuid = uuid.UUID(conversation_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid conversation_id format")
        
        conversation = db.query(Conversation).get(conv_uuid)
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
        
        # Получаем call_session_history_id из client_info
        client_info = conversation.client_info or {}
        call_session_history_id = client_info.get("call_session_history_id")
        
        if not call_session_history_id:
            raise HTTPException(
                status_code=400, 
                detail="No call_session_history_id found in conversation"
            )
        
        # Находим ассистента
        assistant, assistant_type = find_assistant_by_id(db, str(conversation.assistant_id))
        if not assistant:
            raise HTTPException(status_code=404, detail="Assistant not found")
        
        if not assistant.user_id:
            raise HTTPException(status_code=400, detail="Assistant has no user_id")
        
        # Получаем API credentials
        api_credentials = get_voximplant_api_credentials(db, assistant.user_id)
        if not api_credentials:
            raise HTTPException(
                status_code=400, 
                detail="No Voximplant API credentials found for user"
            )
        
        # Сохраняем старую стоимость
        old_cost = conversation.call_cost
        
        # Запрашиваем полную стоимость
        cost_result = await get_full_call_cost(
            call_session_history_id=call_session_history_id,
            account_id=api_credentials["account_id"],
            api_key=api_credentials["api_key"]
        )
        
        if not cost_result["success"]:
            raise HTTPException(
                status_code=400, 
                detail=f"Failed to get call cost: {cost_result.get('error')}"
            )
        
        # Обновляем запись
        new_cost = cost_result["total_cost"]
        conversation.call_cost = new_cost
        conversation.duration_seconds = cost_result["duration"]
        
        # Обновляем client_info с breakdown
        client_info["cost_breakdown"] = {
            "calls_cost": cost_result["calls_cost"],
            "records_cost": cost_result["records_cost"],
            "other_cost": cost_result["other_cost"],
            "details": cost_result["details"],
            "recalculated_at": time.strftime("%Y-%m-%d %H:%M:%S")
        }
        conversation.client_info = client_info
        
        db.commit()
        db.refresh(conversation)
        
        logger.info(f"[VOXIMPLANT-v3.8] ✅ Recalculated cost for {conversation_id}")
        logger.info(f"[VOXIMPLANT-v3.8]    Old: {old_cost} → New: {new_cost}")
        
        return {
            "success": True,
            "conversation_id": conversation_id,
            "old_cost": float(old_cost) if old_cost else None,
            "new_cost": float(new_cost),
            "duration": cost_result["duration"],
            "cost_breakdown": {
                "calls_cost": cost_result["calls_cost"],
                "records_cost": cost_result["records_cost"],
                "other_cost": cost_result["other_cost"]
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Error recalculating cost: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# BATCH ПЕРЕСЧЁТ СТОИМОСТИ ДЛЯ СТАРЫХ ЗАПИСЕЙ
# =============================================================================

@router.post("/recalculate-costs-batch")
async def recalculate_costs_batch(
    request_data: Dict[str, Any] = Body(...),
    db: Session = Depends(get_db)
):
    """
    Пакетный пересчёт стоимости звонков для старых записей.
    
    Параметры:
    {
        "assistant_id": "uuid",       // Опционально - для конкретного ассистента
        "user_id": "uuid",            // Опционально - для всех ассистентов пользователя
        "limit": 100,                 // Максимум записей для обработки
        "only_missing": true          // Только записи без call_cost
    }
    """
    try:
        from datetime import datetime, timedelta
        
        assistant_id = request_data.get("assistant_id")
        user_id = request_data.get("user_id")
        limit = min(request_data.get("limit", 100), 500)  # Max 500
        only_missing = request_data.get("only_missing", True)
        
        if not assistant_id and not user_id:
            raise HTTPException(
                status_code=400, 
                detail="Specify assistant_id or user_id"
            )
        
        # Строим запрос
        query = db.query(Conversation).filter(
            Conversation.client_info.isnot(None)
        )
        
        if assistant_id:
            try:
                assistant_uuid = uuid.UUID(assistant_id)
                query = query.filter(Conversation.assistant_id == assistant_uuid)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid assistant_id")
        
        if user_id:
            try:
                user_uuid = uuid.UUID(user_id)
                # Получаем все ассистенты пользователя
                openai_ids = [a.id for a in db.query(AssistantConfig.id).filter(
                    AssistantConfig.user_id == user_uuid
                ).all()]
                gemini_ids = [a.id for a in db.query(GeminiAssistantConfig.id).filter(
                    GeminiAssistantConfig.user_id == user_uuid
                ).all()]
                all_ids = openai_ids + gemini_ids
                
                if not all_ids:
                    return {"success": True, "processed": 0, "message": "No assistants found"}
                
                query = query.filter(Conversation.assistant_id.in_(all_ids))
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid user_id")
        
        if only_missing:
            query = query.filter(
                (Conversation.call_cost.is_(None)) | (Conversation.call_cost == 0)
            )
        
        # Получаем записи
        conversations = query.order_by(Conversation.created_at.desc()).limit(limit).all()
        
        logger.info(f"[VOXIMPLANT-v3.8] 🔄 Batch recalculation: {len(conversations)} records")
        
        # Кэш для API credentials
        credentials_cache = {}
        
        results = {
            "processed": 0,
            "updated": 0,
            "skipped": 0,
            "errors": []
        }
        
        for conv in conversations:
            try:
                results["processed"] += 1
                
                # Получаем call_session_history_id
                client_info = conv.client_info or {}
                session_id = client_info.get("call_session_history_id")
                
                if not session_id:
                    results["skipped"] += 1
                    continue
                
                # Находим ассистента
                assistant, _ = find_assistant_by_id(db, str(conv.assistant_id))
                if not assistant or not assistant.user_id:
                    results["skipped"] += 1
                    continue
                
                # Получаем credentials (с кэшированием)
                user_key = str(assistant.user_id)
                if user_key not in credentials_cache:
                    credentials_cache[user_key] = get_voximplant_api_credentials(db, assistant.user_id)
                
                credentials = credentials_cache[user_key]
                if not credentials:
                    results["skipped"] += 1
                    continue
                
                # Запрашиваем стоимость
                cost_result = await get_full_call_cost(
                    call_session_history_id=session_id,
                    account_id=credentials["account_id"],
                    api_key=credentials["api_key"]
                )
                
                if cost_result["success"]:
                    conv.call_cost = cost_result["total_cost"]
                    conv.duration_seconds = cost_result["duration"]
                    
                    # Обновляем client_info
                    client_info["cost_breakdown"] = {
                        "calls_cost": cost_result["calls_cost"],
                        "records_cost": cost_result["records_cost"],
                        "other_cost": cost_result["other_cost"],
                        "batch_recalculated_at": time.strftime("%Y-%m-%d %H:%M:%S")
                    }
                    conv.client_info = client_info
                    
                    results["updated"] += 1
                else:
                    results["errors"].append({
                        "conversation_id": str(conv.id),
                        "error": cost_result.get("error")
                    })
                    
            except Exception as e:
                results["errors"].append({
                    "conversation_id": str(conv.id),
                    "error": str(e)
                })
        
        # Коммитим все изменения
        db.commit()
        
        logger.info(f"[VOXIMPLANT-v3.8] ✅ Batch complete: {results['updated']}/{results['processed']} updated")
        
        return {
            "success": True,
            **results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VOXIMPLANT-v3.8] ❌ Batch recalculation error: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))
