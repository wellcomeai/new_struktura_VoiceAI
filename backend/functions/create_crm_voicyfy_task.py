# backend/functions/create_crm_voicyfy_task.py
"""
Функция для создания задач в CRM системе Voicyfy.
Позволяет AI ассистенту автоматически ставить задачи на обратный звонок.
"""
from typing import Dict, Any
from datetime import datetime, timedelta
import re

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function
from backend.services.conversation_service import ConversationService
from backend.models.contact import Contact
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.task import Task, TaskStatus
from backend.db.session import SessionLocal

logger = get_logger(__name__)


def parse_time_string(time_str: str) -> datetime:
    """
    Умный парсинг времени из строки.
    Поддерживает: "через X часов", "завтра в 15:00", "сегодня в 18:00", ISO формат
    """
    time_str = str(time_str).strip()
    now = datetime.utcnow()
    
    # Пытаемся как ISO формат
    try:
        scheduled_time = datetime.fromisoformat(time_str.replace('Z', '+00:00'))
        if scheduled_time.tzinfo is not None:
            scheduled_time = scheduled_time.replace(tzinfo=None)
        return scheduled_time
    except:
        pass
    
    time_str_lower = time_str.lower()
    
    # "через X часов/минут"
    if "через" in time_str_lower or "cherez" in time_str_lower:
        if "час" in time_str_lower or "hour" in time_str_lower:
            match = re.search(r'(\d+)\s*(час|hour)', time_str_lower)
            if match:
                hours = int(match.group(1))
                return now + timedelta(hours=hours)
        if "минут" in time_str_lower or "minut" in time_str_lower or "min" in time_str_lower:
            match = re.search(r'(\d+)\s*(минут|minut|min)', time_str_lower)
            if match:
                minutes = int(match.group(1))
                return now + timedelta(minutes=minutes)
    
    # "завтра в ЧЧ:ММ"
    if "завтра" in time_str_lower or "tomorrow" in time_str_lower:
        match = re.search(r'(\d{1,2}):(\d{2})', time_str)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2))
            tomorrow = now + timedelta(days=1)
            return tomorrow.replace(hour=hour, minute=minute, second=0, microsecond=0)
        else:
            # Завтра в 10:00 по умолчанию
            tomorrow = now + timedelta(days=1)
            return tomorrow.replace(hour=10, minute=0, second=0, microsecond=0)
    
    # "сегодня в ЧЧ:ММ"
    if "сегодня" in time_str_lower or "today" in time_str_lower:
        match = re.search(r'(\d{1,2}):(\d{2})', time_str)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2))
            result = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            # Если время уже прошло сегодня - ставим на завтра
            if result <= now:
                result = result + timedelta(days=1)
            return result
    
    # Просто время "15:00" или "15:30"
    match = re.search(r'^(\d{1,2}):(\d{2})$', time_str.strip())
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2))
        result = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        # Если время уже прошло сегодня - ставим на завтра
        if result <= now:
            result = result + timedelta(days=1)
        return result
    
    # Fallback - через 1 час
    logger.warning(f"[CRM_TASK] Could not parse time string '{time_str}', using default: +1 hour")
    return now + timedelta(hours=1)


@register_function
class CreateCrmVoicyfyTaskFunction(FunctionBase):
    """Создать задачу в CRM системе Voicyfy для обратного звонка"""
    
    @classmethod
    def get_name(cls) -> str:
        return "create_crm_voicyfy_task"
    
    @classmethod
    def get_display_name(cls) -> str:
        return "Создать задачу в CRM"
    
    @classmethod
    def get_description(cls) -> str:
        return "Создает задачу на обратный звонок клиенту в CRM системе Voicyfy. Автоматически находит или создает контакт по номеру телефона."
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "phone": {
                    "type": "string",
                    "description": "Номер телефона клиента в любом формате (79991234567, +7 999 123-45-67, 8-999-123-45-67)"
                },
                "assistant_id": {
                    "type": "string",
                    "description": "UUID ассистента, который выполнит задачу (обратный звонок)"
                },
                "scheduled_time": {
                    "type": "string",
                    "description": "Время звонка. Поддерживаются форматы: 'завтра в 15:00', 'через 2 часа', 'сегодня в 18:00', '2024-12-05T15:00:00', '15:30'"
                },
                "title": {
                    "type": "string",
                    "description": "Название задачи, например: 'Перезвонить клиенту', 'Уточнить детали заказа'"
                },
                "description": {
                    "type": "string",
                    "description": "Подробное описание задачи, контекст для менеджера (опционально)"
                },
                "custom_greeting": {
                    "type": "string",
                    "description": "Персонализированное приветствие для звонка, первая фраза (опционально)"
                }
            },
            "required": ["phone", "assistant_id", "scheduled_time", "title"]
        }
    
    @classmethod
    def get_example_prompt(cls) -> str:
        return """
<p>Используй функцию <code>create_crm_voicyfy_task</code> для создания задач на обратный звонок в CRM системе.</p>

<p><strong>Зачем это нужно?</strong></p>
<p>Позволяет AI ассистенту автоматически планировать обратные звонки клиентам и ставить задачи для себя или других ассистентов.</p>

<p><strong>Когда использовать:</strong></p>
<ul>
    <li>Клиент просит перезвонить в определенное время</li>
    <li>Нужно напомнить клиенту о чем-то</li>
    <li>Запланировать звонок для уточнения информации</li>
    <li>Поставить задачу на обратную связь</li>
    <li>Создать напоминание для менеджера</li>
</ul>

<p><strong>Параметры функции:</strong></p>
<ul>
    <li><code>phone</code> — номер телефона клиента (обязательно)</li>
    <li><code>assistant_id</code> — UUID ассистента для звонка (обязательно)</li>
    <li><code>scheduled_time</code> — когда позвонить (обязательно)</li>
    <li><code>title</code> — название задачи (обязательно)</li>
    <li><code>description</code> — описание, контекст (опционально)</li>
    <li><code>custom_greeting</code> — первая фраза при звонке (опционально)</li>
</ul>

<p><strong>Пример 1 - Базовое использование:</strong></p>
<pre>{
  "phone": "79991234567",
  "assistant_id": "550e8400-e29b-41d4-a716-446655440000",
  "scheduled_time": "завтра в 15:00",
  "title": "Перезвонить клиенту"
}</pre>

<p><strong>Пример 2 - С описанием и приветствием:</strong></p>
<pre>{
  "phone": "+7 (999) 123-45-67",
  "assistant_id": "550e8400-e29b-41d4-a716-446655440000",
  "scheduled_time": "через 2 часа",
  "title": "Уточнить детали заказа",
  "description": "Клиент хочет изменить адрес доставки. Заказ #12345",
  "custom_greeting": "Добрый день! Звоню по поводу вашего заказа #12345"
}</pre>

<p><strong>Пример 3 - Звонок сегодня:</strong></p>
<pre>{
  "phone": "89991234567",
  "assistant_id": "550e8400-e29b-41d4-a716-446655440000",
  "scheduled_time": "сегодня в 18:00",
  "title": "Напомнить о встрече",
  "description": "Встреча назначена на завтра в 10:00 по адресу ул. Ленина 5",
  "custom_greeting": "Здравствуйте! Напоминаю о нашей завтрашней встрече"
}</pre>

<p><strong>Форматы времени scheduled_time:</strong></p>
<ul>
    <li><code>"завтра в 15:00"</code> — завтра в указанное время</li>
    <li><code>"через 2 часа"</code> — через N часов от текущего момента</li>
    <li><code>"через 30 минут"</code> — через N минут</li>
    <li><code>"сегодня в 18:00"</code> — сегодня в указанное время</li>
    <li><code>"15:30"</code> — сегодня/завтра в указанное время</li>
    <li><code>"2024-12-05T15:00:00"</code> — точная дата и время (ISO формат)</li>
</ul>

<p><strong>Формат телефона:</strong></p>
<p>Принимает любой формат российского номера:</p>
<ul>
    <li><code>79991234567</code></li>
    <li><code>+7 999 123-45-67</code></li>
    <li><code>8 (999) 123-45-67</code></li>
    <li><code>+7-999-123-45-67</code></li>
</ul>

<p><strong>Что происходит внутри:</strong></p>
<ol>
    <li>Нормализуется номер телефона (убираются префиксы, пробелы, тире)</li>
    <li>Ищется существующий контакт по телефону</li>
    <li>Если контакт не найден — создается новый автоматически</li>
    <li>Парсится время звонка в удобном формате</li>
    <li>Создается задача в CRM с указанным ассистентом</li>
    <li>Задача отображается в UI менеджера</li>
</ol>

<p><strong>Что возвращается:</strong></p>
<pre>{
  "success": true
}</pre>

<p><strong>💬 Примеры диалогов:</strong></p>

<p><em>Клиент:</em> "Перезвоните мне завтра в 15:00"<br>
<em>AI:</em> [вызывает create_crm_voicyfy_task] → "Хорошо, я поставил напоминание позвонить вам завтра в 15:00"</p>

<p><em>Клиент:</em> "Через 2 часа перезвоните, обсудим цены"<br>
<em>AI:</em> [создает задачу] → "Договорились! Я позвоню вам через 2 часа"</p>

<p><em>Клиент:</em> "Напомните мне сегодня в 6 вечера про акцию"<br>
<em>AI:</em> [создает задачу с описанием] → "Конечно! Я позвоню вам сегодня в 18:00 и расскажу об акции"</p>

<p><strong>⚠️ Важно:</strong></p>
<ul>
    <li>Время должно быть в будущем (нельзя поставить задачу на прошлое время)</li>
    <li>assistant_id должен существовать в системе</li>
    <li>Один номер телефона = один контакт (автоматически объединяются)</li>
    <li>Задача отображается в CRM UI для менеджера</li>
</ul>

<p><strong>🎯 Use Cases:</strong></p>

<p><strong>1. Перезвонить клиенту:</strong></p>
<pre>Клиент: "Перезвоните мне завтра с информацией о ценах"
→ AI создает задачу "Перезвонить клиенту" на завтра</pre>

<p><strong>2. Напоминание:</strong></p>
<pre>Клиент: "Напомните мне про встречу за час"
→ AI создает задачу на нужное время</pre>

<p><strong>3. Уточнение информации:</strong></p>
<pre>Клиент: "Я уточню у коллег и вы мне перезвоните через 2 часа"
→ AI создает задачу с контекстом</pre>

<p><strong>4. Обратная связь:</strong></p>
<pre>После доставки: "Позвоните мне завтра, скажу как всё прошло"
→ AI создает задачу для сбора обратной связи</pre>
"""
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Создает задачу в CRM системе Voicyfy.
        
        Логика:
        1. Получает user_id из ассистента
        2. Нормализует телефон
        3. Находит или создает контакт
        4. Парсит время
        5. Создает задачу
        """
        db = SessionLocal()
        
        try:
            # 1. Получаем параметры
            phone_raw = arguments.get("phone")
            assistant_id = arguments.get("assistant_id")
            scheduled_time_str = arguments.get("scheduled_time")
            title = arguments.get("title")
            description = arguments.get("description")
            custom_greeting = arguments.get("custom_greeting")
            
            logger.info(f"[CRM_TASK] ━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[CRM_TASK] 📞 Creating task for phone: {phone_raw}")
            logger.info(f"[CRM_TASK] 🤖 Assistant ID: {assistant_id}")
            logger.info(f"[CRM_TASK] ⏰ Scheduled: {scheduled_time_str}")
            logger.info(f"[CRM_TASK] 📋 Title: {title}")
            
            # Валидация обязательных параметров
            if not phone_raw or not assistant_id or not scheduled_time_str or not title:
                logger.error("[CRM_TASK] ❌ Missing required parameters")
                return {
                    "success": False,
                    "error": "Missing required parameters: phone, assistant_id, scheduled_time, title"
                }
            
            # 2. Находим ассистента и получаем user_id
            from uuid import UUID
            try:
                assistant_uuid = UUID(assistant_id)
            except ValueError:
                logger.error(f"[CRM_TASK] ❌ Invalid assistant_id format: {assistant_id}")
                return {
                    "success": False,
                    "error": "Invalid assistant_id format"
                }
            
            # Проверяем в обеих таблицах (OpenAI и Gemini)
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_uuid
            ).first()
            
            gemini_assistant = None
            if not assistant:
                gemini_assistant = db.query(GeminiAssistantConfig).filter(
                    GeminiAssistantConfig.id == assistant_uuid
                ).first()
            
            if not assistant and not gemini_assistant:
                logger.error(f"[CRM_TASK] ❌ Assistant not found: {assistant_id}")
                return {
                    "success": False,
                    "error": f"Assistant not found: {assistant_id}"
                }
            
            user_id = assistant.user_id if assistant else gemini_assistant.user_id
            logger.info(f"[CRM_TASK] 👤 User ID: {user_id}")
            
            # 3. Нормализуем телефон
            normalized_phone = ConversationService._normalize_phone(phone_raw)
            logger.info(f"[CRM_TASK] 📱 Normalized phone: {phone_raw} → {normalized_phone}")
            
            # 4. Находим или создаем контакт
            contact = db.query(Contact).filter(
                Contact.user_id == user_id,
                Contact.phone == normalized_phone
            ).first()
            
            if not contact:
                logger.info(f"[CRM_TASK] 📝 Creating new contact for phone: {normalized_phone}")
                contact = Contact(
                    user_id=user_id,
                    phone=normalized_phone,
                    status="new",
                    last_interaction=datetime.utcnow()
                )
                db.add(contact)
                db.flush()
                logger.info(f"[CRM_TASK] ✅ Contact created: {contact.id}")
            else:
                logger.info(f"[CRM_TASK] ✅ Contact found: {contact.id} (name: {contact.name or 'No name'})")
                # Обновляем время последнего взаимодействия
                contact.last_interaction = datetime.utcnow()
            
            # 5. Парсим время
            try:
                scheduled_time = parse_time_string(scheduled_time_str)
                logger.info(f"[CRM_TASK] ⏰ Parsed time: {scheduled_time_str} → {scheduled_time}")
            except Exception as e:
                logger.error(f"[CRM_TASK] ❌ Error parsing time: {e}")
                return {
                    "success": False,
                    "error": f"Invalid scheduled_time format: {scheduled_time_str}"
                }
            
            # Проверяем что время в будущем
            if scheduled_time <= datetime.utcnow():
                logger.error(f"[CRM_TASK] ❌ Time is in the past: {scheduled_time}")
                return {
                    "success": False,
                    "error": "Scheduled time must be in the future"
                }
            
            # 6. Создаем задачу
            new_task = Task(
                contact_id=contact.id,
                assistant_id=assistant_uuid if assistant else None,
                gemini_assistant_id=assistant_uuid if gemini_assistant else None,
                user_id=user_id,
                scheduled_time=scheduled_time,
                title=title.strip(),
                description=description.strip() if description else None,
                custom_greeting=custom_greeting.strip() if custom_greeting else None,
                status=TaskStatus.SCHEDULED
            )
            
            db.add(new_task)
            db.commit()
            db.refresh(new_task)
            
            logger.info(f"[CRM_TASK] ✅ Task created successfully!")
            logger.info(f"[CRM_TASK]    Task ID: {new_task.id}")
            logger.info(f"[CRM_TASK]    Contact: {contact.id} ({contact.name or 'No name'})")
            logger.info(f"[CRM_TASK]    Scheduled: {scheduled_time}")
            logger.info(f"[CRM_TASK]    Title: {title}")
            if description:
                logger.info(f"[CRM_TASK]    Description: {description[:100]}...")
            if custom_greeting:
                logger.info(f"[CRM_TASK]    💬 Custom greeting: {custom_greeting[:50]}...")
            logger.info(f"[CRM_TASK] ━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            return {
                "success": True
            }
            
        except Exception as e:
            db.rollback()
            logger.error(f"[CRM_TASK] ❌ Error creating task: {e}", exc_info=True)
            return {
                "success": False,
                "error": f"Failed to create task: {str(e)}"
            }
        finally:
            db.close()
