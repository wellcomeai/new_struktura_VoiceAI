"""
Task Scheduler для автоматического выполнения запланированных задач.
Проверяет каждые 30 секунд наличие задач, которые нужно выполнить.

✅ ВЕРСИЯ v4.0 - PARTNER INTEGRATION + LEGACY FALLBACK
✅ v4.0: Поддержка партнёрской интеграции Voximplant (VoximplantChildAccount)
✅ v4.0: Обратная совместимость со старой интеграцией (user.get_voximplant_config())
✅ v3.4: Восстановлена правильная логика user.get_voximplant_config()
✅ v3.3: Исправлено получение assistant_id (использует task.assistant_id)
✅ v3.2: Исправлена обработка response от Voximplant API
✅ v3.1: Добавлена передача custom_greeting (персонализированное приветствие)
✅ v3.0: Передача контекста задачи в Voximplant
"""

import asyncio
import json
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, Tuple

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.voximplant_child import VoximplantChildAccount
from backend.services.voximplant_partner import get_voximplant_partner_service

logger = get_logger(__name__)

# Voximplant API endpoint (для LEGACY интеграции)
VOXIMPLANT_API_URL = "https://api.voximplant.com/platform_api/StartScenarios/"

# Timezone по умолчанию
DEFAULT_TIMEZONE = "Europe/Moscow"


class TaskScheduler:
    """
    Планировщик задач для автоматических звонков.
    
    ✅ v4.0: Поддержка двух типов интеграции:
        1. НОВАЯ: VoximplantChildAccount (партнёрская интеграция)
        2. LEGACY: user.get_voximplant_config() (старая интеграция)
    
    ✅ v3.4: Правильная логика user.get_voximplant_config()
    ✅ v3.3: Правильное получение assistant_id из task
    ✅ v3.2: Корректная обработка response
    ✅ v3.1: Поддержка custom_greeting
    ✅ v3.0: Передача контекста задачи
    """
    
    def __init__(self, check_interval: int = 30):
        """
        Args:
            check_interval: Интервал проверки в секундах (по умолчанию 30 сек)
        """
        self.check_interval = check_interval
        self.is_running = False
        
    async def start(self):
        """Запуск планировщика"""
        if self.is_running:
            logger.warning("[TASK-SCHEDULER] Already running")
            return
            
        self.is_running = True
        logger.info(f"[TASK-SCHEDULER] Started (check every {self.check_interval}s)")
        logger.info(f"[TASK-SCHEDULER] ✅ v4.0: Partner + Legacy integration support")
        
        while self.is_running:
            try:
                await self.check_and_execute_tasks()
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Error: {e}", exc_info=True)
            
            # Ждём перед следующей проверкой
            await asyncio.sleep(self.check_interval)
    
    def stop(self):
        """Остановка планировщика"""
        self.is_running = False
        logger.info("[TASK-SCHEDULER] Stopped")
    
    async def check_and_execute_tasks(self):
        """Проверка и выполнение задач"""
        db = SessionLocal()
        
        try:
            now = datetime.utcnow()
            
            # Находим задачи которые нужно выполнить
            pending_tasks = db.query(Task).filter(
                Task.status == TaskStatus.SCHEDULED,
                Task.scheduled_time <= now
            ).all()
            
            if not pending_tasks:
                logger.debug(f"[TASK-SCHEDULER] No pending tasks at {now}")
                return
            
            logger.info(f"[TASK-SCHEDULER] Found {len(pending_tasks)} tasks to execute")
            
            for task in pending_tasks:
                await self.execute_task(task, db)
            
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error checking tasks: {e}", exc_info=True)
        finally:
            db.close()
    
    def _get_assistant_info(self, task: Task, db: Session) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """
        Получить информацию об ассистенте из задачи.
        
        Returns:
            Tuple[assistant_id, assistant_name, assistant_type]
        """
        assistant_id = None
        assistant_name = "Unknown"
        assistant_type = None
        
        if task.assistant_id:
            # OpenAI Assistant
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == task.assistant_id
            ).first()
            if assistant:
                assistant_id = str(task.assistant_id)
                assistant_name = assistant.name
                assistant_type = "openai"
                logger.info(f"   Assistant: {assistant.name} (OpenAI)")
        elif task.gemini_assistant_id:
            # Gemini Assistant
            gemini_assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == task.gemini_assistant_id
            ).first()
            if gemini_assistant:
                assistant_id = str(task.gemini_assistant_id)
                assistant_name = gemini_assistant.name
                assistant_type = "gemini"
                logger.info(f"   Assistant: {gemini_assistant.name} (Gemini)")
        
        return assistant_id, assistant_name, assistant_type
    
    async def execute_task(self, task: Task, db: Session):
        """
        Выполнение конкретной задачи (инициация звонка).
        
        ✅ v4.0: Выбор интеграции:
            1. Проверяем VoximplantChildAccount (НОВАЯ партнёрская интеграция)
            2. Fallback на user.get_voximplant_config() (СТАРАЯ интеграция)
        
        Args:
            task: Задача для выполнения
            db: Сессия БД
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 🚀 Executing task {task.id}: {task.title}")
            
            # Обновляем статус на PENDING
            task.status = TaskStatus.PENDING
            task.call_started_at = datetime.utcnow()
            db.commit()
            
            # Получаем контакт
            contact = db.query(Contact).filter(Contact.id == task.contact_id).first()
            if not contact:
                logger.error(f"[TASK-SCHEDULER] Contact not found for task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Contact not found"
                db.commit()
                return
            
            # Получаем пользователя через relationship
            user = contact.user
            if not user:
                logger.error(f"[TASK-SCHEDULER] User not found for contact {contact.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "User not found"
                db.commit()
                return
            
            # Получаем информацию об ассистенте
            assistant_id, assistant_name, assistant_type = self._get_assistant_info(task, db)
            
            if not assistant_id or not assistant_type:
                logger.error(f"[TASK-SCHEDULER] No valid assistant found for task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Assistant not found"
                db.commit()
                return
            
            # =====================================================================
            # ✅ v4.0: ВЫБОР ИНТЕГРАЦИИ
            # =====================================================================
            
            # Проверяем наличие партнёрской интеграции (VoximplantChildAccount)
            child_account: Optional[VoximplantChildAccount] = None
            
            # Используем backref relationship
            if hasattr(user, 'voximplant_child_account') and user.voximplant_child_account:
                child_account = user.voximplant_child_account
            
            # Определяем какую интеграцию использовать
            if child_account and child_account.can_make_outbound_calls:
                # ✅ НОВАЯ партнёрская интеграция
                logger.info(f"[TASK-SCHEDULER] 🆕 Using PARTNER integration (VoximplantChildAccount)")
                await self._execute_via_partner_api(
                    task=task,
                    contact=contact,
                    child_account=child_account,
                    assistant_id=assistant_id,
                    assistant_name=assistant_name,
                    assistant_type=assistant_type,
                    db=db
                )
            elif user.has_voximplant_config():
                # ✅ LEGACY интеграция (fallback)
                logger.info(f"[TASK-SCHEDULER] 📦 Using LEGACY integration (user.get_voximplant_config)")
                await self._execute_via_legacy_api(
                    task=task,
                    contact=contact,
                    user=user,
                    assistant_id=assistant_id,
                    assistant_name=assistant_name,
                    assistant_type=assistant_type,
                    db=db
                )
            else:
                # ❌ Нет конфигурации
                logger.error(f"[TASK-SCHEDULER] ❌ No Voximplant configuration found for user {user.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "No Voximplant configuration found. Please configure telephony in Settings or connect Partner integration."
                db.commit()
            
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error executing task {task.id}: {e}", exc_info=True)
            
            # Помечаем задачу как failed
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                db.commit()
            except Exception as commit_error:
                logger.error(f"[TASK-SCHEDULER] Failed to update task status: {commit_error}")
    
    async def _execute_via_partner_api(
        self,
        task: Task,
        contact: Contact,
        child_account: VoximplantChildAccount,
        assistant_id: str,
        assistant_name: str,
        assistant_type: str,
        db: Session
    ):
        """
        ✅ v4.0: Выполнение звонка через НОВУЮ партнёрскую интеграцию.
        
        Использует VoximplantPartnerService для запуска звонка.
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 🆕 PARTNER API CALL")
            logger.info(f"   Contact: {contact.name or contact.phone}")
            logger.info(f"   Assistant: {assistant_name} ({assistant_type})")
            logger.info(f"   Task: {task.title}")
            if task.custom_greeting:
                logger.info(f"   💬 Custom Greeting: {task.custom_greeting[:80]}...")
            
            # Получаем rule_id для CRM сценария (единый для всех типов ассистентов)
            rule_name = "outbound_crm"
            rule_id = child_account.get_rule_id(rule_name)
            
            if not rule_id:
                logger.error(f"[TASK-SCHEDULER] ❌ Rule '{rule_name}' not found in child account")
                logger.error(f"   Available rules: {list(child_account.vox_rule_ids.keys()) if child_account.vox_rule_ids else 'None'}")
                task.status = TaskStatus.FAILED
                task.call_result = f"Outbound rule 'outbound_crm' not configured. Run admin endpoint /api/telephony/admin/setup-crm-rules to create it."
                db.commit()
                return
            
            # Получаем caller_id из первого доступного номера
            caller_id = None
            if child_account.phone_numbers:
                for phone in child_account.phone_numbers:
                    if phone.is_active:
                        caller_id = phone.phone_number
                        break
            
            if not caller_id:
                logger.error(f"[TASK-SCHEDULER] ❌ No active phone numbers for caller_id")
                task.status = TaskStatus.FAILED
                task.call_result = "No active phone numbers available for caller ID"
                db.commit()
                return
            
            logger.info(f"   Rule ID: {rule_id}")
            logger.info(f"   Caller ID: {caller_id}")
            
            # Вызываем VoximplantPartnerService
            service = get_voximplant_partner_service()
            
            result = await service.start_outbound_call(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key,
                rule_id=int(rule_id),
                phone_number=contact.phone,
                assistant_id=assistant_id,
                caller_id=caller_id,
                # ✅ v3.1: CRM контекст
                contact_name=contact.name or "",
                task_title=task.title or "",
                task_description=task.description or "",
                custom_greeting=task.custom_greeting or "",
                timezone=DEFAULT_TIMEZONE
            )
            
            if result.get("success"):
                call_session_id = result.get("call_session_history_id")
                
                task.status = TaskStatus.COMPLETED
                task.call_completed_at = datetime.utcnow()
                task.call_session_id = str(call_session_id) if call_session_id else None
                task.call_result = f"Call initiated successfully via Partner API. Session ID: {call_session_id}"
                
                logger.info(f"[TASK-SCHEDULER] ✅ Task {task.id} completed successfully (Partner API)")
                logger.info(f"   Call session ID: {call_session_id}")
            else:
                error_msg = result.get("error", "Unknown error")
                task.status = TaskStatus.FAILED
                task.call_result = f"Partner API error: {error_msg}"
                
                logger.error(f"[TASK-SCHEDULER] ❌ Partner API error for task {task.id}: {error_msg}")
            
            db.commit()
            
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Partner API exception: {e}", exc_info=True)
            task.status = TaskStatus.FAILED
            task.call_result = f"Partner API exception: {str(e)}"
            db.commit()
    
    async def _execute_via_legacy_api(
        self,
        task: Task,
        contact: Contact,
        user: User,
        assistant_id: str,
        assistant_name: str,
        assistant_type: str,
        db: Session
    ):
        """
        ✅ v4.0: Выполнение звонка через СТАРУЮ (Legacy) интеграцию.
        
        Использует прямой вызов Voximplant API с настройками из user модели.
        Это оригинальный код из v3.4, вынесенный в отдельный метод.
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 📦 LEGACY API CALL")
            logger.info(f"   Contact: {contact.name or contact.phone}")
            logger.info(f"   Assistant: {assistant_name} ({assistant_type})")
            logger.info(f"   Task: {task.title}")
            if task.custom_greeting:
                logger.info(f"   💬 Custom Greeting: {task.custom_greeting[:80]}...")
            
            # Получаем настройки Voximplant из user модели
            voximplant_config = user.get_voximplant_config()
            
            if not voximplant_config:
                logger.error(f"[TASK-SCHEDULER] ❌ User {user.id} has no Voximplant settings")
                task.status = TaskStatus.FAILED
                task.call_result = "User has no Voximplant settings. Please configure in Settings."
                db.commit()
                return
            
            # Для Gemini добавляем префикс к assistant_id
            final_assistant_id = assistant_id
            if assistant_type == "gemini":
                final_assistant_id = f"gemini_{assistant_id}"
            
            # Формируем script_custom_data с контекстом задачи
            script_custom_data_dict = {
                "phone_number": contact.phone,
                "assistant_id": final_assistant_id,
                "caller_id": voximplant_config["caller_id"],
                # Контекст задачи
                "task_title": task.title or "",
                "task_description": task.description or "",
                "contact_name": contact.name or "",
                # Персонализированное приветствие
                "custom_greeting": task.custom_greeting or "",
                # Timezone
                "timezone": DEFAULT_TIMEZONE
            }
            
            logger.info(f"[TASK-SCHEDULER] 📦 Script custom data:")
            logger.info(f"   phone_number: {script_custom_data_dict['phone_number']}")
            logger.info(f"   assistant_id: {script_custom_data_dict['assistant_id']}")
            logger.info(f"   caller_id: {script_custom_data_dict['caller_id']}")
            logger.info(f"   task_title: {script_custom_data_dict['task_title']}")
            logger.info(f"   contact_name: {script_custom_data_dict['contact_name']}")
            if script_custom_data_dict['custom_greeting']:
                logger.info(f"   💬 custom_greeting: {script_custom_data_dict['custom_greeting'][:80]}...")
            
            script_custom_data = json.dumps(script_custom_data_dict, ensure_ascii=False)
            
            # Отправляем запрос в Voximplant API
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    VOXIMPLANT_API_URL,
                    data={
                        "account_id": voximplant_config["account_id"],
                        "api_key": voximplant_config["api_key"],
                        "rule_id": voximplant_config["rule_id"],
                        "script_custom_data": script_custom_data
                    }
                )
                
                response_data = response.json()
                
                logger.info(f"[TASK-SCHEDULER] Voximplant API response: {response_data}")
                
                if response.status_code == 200 and response_data.get("result") == 1:
                    # Успешно запущен звонок
                    call_session_raw = response_data.get("call_session_history_id")
                    
                    if isinstance(call_session_raw, list):
                        call_session_id = call_session_raw[0] if call_session_raw else None
                    else:
                        call_session_id = call_session_raw
                    
                    task.status = TaskStatus.COMPLETED
                    task.call_completed_at = datetime.utcnow()
                    task.call_session_id = str(call_session_id) if call_session_id else None
                    task.call_result = f"Call initiated successfully via Legacy API. Session ID: {call_session_id}"
                    
                    logger.info(f"[TASK-SCHEDULER] ✅ Task {task.id} completed successfully (Legacy API)")
                    logger.info(f"   Call session ID: {call_session_id}")
                else:
                    # Ошибка от Voximplant
                    error_msg = response_data.get("error", {}).get("msg", "Unknown Voximplant error")
                    error_code = response_data.get("error", {}).get("code", "N/A")
                    
                    task.status = TaskStatus.FAILED
                    task.call_result = f"Voximplant error [{error_code}]: {error_msg}"
                    
                    logger.error(f"[TASK-SCHEDULER] ❌ Voximplant error for task {task.id}")
                    logger.error(f"   Error code: {error_code}")
                    logger.error(f"   Error message: {error_msg}")
                
                db.commit()
                
        except httpx.TimeoutException as e:
            logger.error(f"[TASK-SCHEDULER] Timeout calling Voximplant API: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Timeout error: Request to Voximplant took too long"
            db.commit()
            
        except httpx.RequestError as e:
            logger.error(f"[TASK-SCHEDULER] Network error calling Voximplant API: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Network error: {str(e)}"
            db.commit()
            
        except json.JSONDecodeError as e:
            logger.error(f"[TASK-SCHEDULER] Invalid JSON response from Voximplant: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Invalid response from Voximplant API"
            db.commit()
        
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Legacy API exception: {e}", exc_info=True)
            task.status = TaskStatus.FAILED
            task.call_result = f"Legacy API exception: {str(e)}"
            db.commit()


# Глобальный экземпляр планировщика
_task_scheduler: Optional[TaskScheduler] = None


async def start_task_scheduler(check_interval: int = 30):
    """
    Запуск планировщика задач.
    
    Args:
        check_interval: Интервал проверки в секундах
    """
    global _task_scheduler
    
    if _task_scheduler is not None:
        logger.warning("[TASK-SCHEDULER] Already running")
        return
    
    _task_scheduler = TaskScheduler(check_interval=check_interval)
    
    try:
        await _task_scheduler.start()
    except Exception as e:
        logger.error(f"[TASK-SCHEDULER] Fatal error: {e}", exc_info=True)
        _task_scheduler = None


def stop_task_scheduler():
    """Остановка планировщика задач"""
    global _task_scheduler
    
    if _task_scheduler is not None:
        _task_scheduler.stop()
        _task_scheduler = None
