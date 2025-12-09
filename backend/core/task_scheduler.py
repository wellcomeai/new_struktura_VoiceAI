"""
Task Scheduler для автоматического выполнения запланированных задач.
Проверяет каждые 30 секунд наличие задач, которые нужно выполнить.

✅ ВЕРСИЯ v3.4 FINAL - PRODUCTION READY
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
from typing import Optional

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig

logger = get_logger(__name__)

# Voximplant API endpoint
VOXIMPLANT_API_URL = "https://api.voximplant.com/platform_api/StartScenarios/"


class TaskScheduler:
    """
    Планировщик задач для автоматических звонков.
    
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
    
    async def execute_task(self, task: Task, db: Session):
        """
        Выполнение конкретной задачи (инициация звонка).
        
        ✅ v3.4: Восстановлена правильная логика user config
        ✅ v3.3: Правильное получение assistant_id
        ✅ v3.2: Корректная обработка response
        ✅ v3.1: Custom greeting
        ✅ v3.0: Task context
        
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
            
            # ✅ v3.4 FIX: Получаем пользователя через relationship
            user = contact.user
            if not user:
                logger.error(f"[TASK-SCHEDULER] User not found for contact {contact.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "User not found"
                db.commit()
                return
            
            # ✅ v3.4 FIX: Проверяем наличие настроек Voximplant
            if not user.has_voximplant_config():
                logger.error(f"[TASK-SCHEDULER] User {user.id} has no Voximplant settings")
                task.status = TaskStatus.FAILED
                task.call_result = "User has no Voximplant settings. Please configure in Settings."
                db.commit()
                return
            
            # ✅ v3.4 FIX: Получаем настройки Voximplant из user модели
            voximplant_config = user.get_voximplant_config()
            
            # ✅ v3.3 FIX: Получаем ассистента правильно (используем task.assistant_id)
            assistant_id = None
            assistant_name = "Unknown"
            assistant_type = None
            
            if task.assistant_id:
                # OpenAI Assistant
                assistant = db.query(AssistantConfig).filter(
                    AssistantConfig.id == task.assistant_id
                ).first()
                if assistant:
                    # ✅ v3.3: Используем UUID из task, а не из модели assistant
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
                    # ✅ Для Gemini используем префикс
                    assistant_id = f"gemini_{task.gemini_assistant_id}"
                    assistant_name = gemini_assistant.name
                    assistant_type = "gemini"
                    logger.info(f"   Assistant: {gemini_assistant.name} (Gemini)")
            
            if not assistant_id:
                logger.error(f"[TASK-SCHEDULER] No valid assistant found for task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Assistant not found"
                db.commit()
                return
            
            # ✅ РЕАЛЬНАЯ ЛОГИКА ИНИЦИАЦИИ ЗВОНКА ЧЕРЕЗ VOXIMPLANT
            logger.info(f"[TASK-SCHEDULER] 🚀 Initiating call to {contact.phone}")
            logger.info(f"   Contact: {contact.name or 'Unknown'}")
            logger.info(f"   Assistant: {assistant_name} ({assistant_type})")
            logger.info(f"   Task: {task.title}")
            if task.description:
                logger.info(f"   Description: {task.description[:100]}...")
            if task.custom_greeting:
                logger.info(f"   💬 custom_greeting: {task.custom_greeting[:100]}...")
            
            # ✅ v3.1 + v3.0: Формируем script_custom_data с контекстом задачи + custom_greeting
            script_custom_data_dict = {
                "phone_number": contact.phone,
                "assistant_id": assistant_id,
                "caller_id": voximplant_config["caller_id"],
                # ✅ v3.0: Контекст задачи
                "task_title": task.title or "",
                "task_description": task.description or "",
                "contact_name": contact.name or "",
                # ✅ v3.1: Персонализированное приветствие
                "custom_greeting": task.custom_greeting or ""
            }
            
            logger.info(f"[TASK-SCHEDULER] 📦 Script custom data:")
            logger.info(f"   phone_number: {script_custom_data_dict['phone_number']}")
            logger.info(f"   assistant_id: {script_custom_data_dict['assistant_id']}")
            logger.info(f"   caller_id: {script_custom_data_dict['caller_id']}")
            logger.info(f"   task_title: {script_custom_data_dict['task_title']}")
            logger.info(f"   task_description: {script_custom_data_dict['task_description'][:80] if script_custom_data_dict['task_description'] else '(none)'}...")
            logger.info(f"   contact_name: {script_custom_data_dict['contact_name']}")
            if script_custom_data_dict['custom_greeting']:
                logger.info(f"   💬 custom_greeting: {script_custom_data_dict['custom_greeting'][:80]}...")
            else:
                logger.info(f"   💬 custom_greeting: (not set - will use default)")
            
            script_custom_data = json.dumps(script_custom_data_dict)
            
            # Отправляем запрос в Voximplant API
            try:
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
                    
                    # ✅ v3.2 FIX: Корректная обработка response
                    if response.status_code == 200 and response_data.get("result") == 1:
                        # Успешно запущен звонок
                        
                        # ✅ v3.2: Обрабатываем call_session_history_id корректно
                        # Может быть: массив [123], число 123, или строка "123"
                        call_session_raw = response_data.get("call_session_history_id")
                        
                        if isinstance(call_session_raw, list):
                            # Массив - берем первый элемент
                            call_session_id = call_session_raw[0] if call_session_raw else None
                        else:
                            # Одиночное значение (int или str) - используем как есть
                            call_session_id = call_session_raw
                        
                        task.status = TaskStatus.COMPLETED
                        task.call_completed_at = datetime.utcnow()
                        task.call_session_id = str(call_session_id) if call_session_id else None
                        task.call_result = f"Call initiated successfully. Session ID: {call_session_id}"
                        
                        logger.info(f"[TASK-SCHEDULER] ✅ Task {task.id} completed successfully")
                        logger.info(f"   Call session ID: {call_session_id}")
                        logger.info(f"   Contact: {contact.name or contact.phone}")
                        logger.info(f"   Task context sent: {task.title}")
                        if task.custom_greeting:
                            logger.info(f"   💬 Custom greeting sent: {task.custom_greeting[:50]}...")
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
            logger.error(f"[TASK-SCHEDULER] Error executing task {task.id}: {e}", exc_info=True)
            
            # Помечаем задачу как failed
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                db.commit()
            except Exception as commit_error:
                logger.error(f"[TASK-SCHEDULER] Failed to update task status: {commit_error}")


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
