# backend/functions/hangup_call.py

"""
Функция завершения звонка для отображения в UI.
Фактическое выполнение происходит в VoxEngine скрипте.
"""

from typing import Dict, Any
from backend.functions.base import FunctionBase
from backend.core.logging import get_logger

logger = get_logger(__name__)

class HangupCallFunction(FunctionBase):
    """
    Функция для завершения текущего звонка.
    
    ВАЖНО: Эта функция создана только для отображения в UI.
    Реальное выполнение происходит локально в VoxEngine скрипте.
    """
    
    @classmethod
    def get_name(cls) -> str:
        return "hangup_call"
    
    @classmethod
    def get_description(cls) -> str:
        return """
        Завершить текущий звонок когда разговор естественно завершен или по просьбе пользователя.
        
        Используйте эту функцию в следующих случаях:
        - Пользователь поблагодарил и завершил разговор
        - Пользователь прямо попросил завершить звонок
        - Разговор достиг естественного завершения
        - Превышено время разговора
        - Возникли технические проблемы
        
        Функция может включать прощальное сообщение перед завершением.
        """
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Причина завершения звонка",
                    "enum": [
                        "conversation_completed",  # Разговор естественно завершен
                        "user_request",           # По просьбе пользователя
                        "time_limit_reached",     # Превышен лимит времени
                        "technical_issue",        # Техническая проблема
                        "emergency"               # Экстренное завершение
                    ]
                },
                "farewell_message": {
                    "type": "string",
                    "description": "Прощальное сообщение, которое будет произнесено перед завершением звонка (опционально)",
                    "maxLength": 200,
                    "examples": [
                        "До свидания! Хорошего дня!",
                        "Спасибо за обращение! До встречи!",
                        "Всего доброго!",
                        "Обращайтесь еще!"
                    ]
                }
            },
            "required": ["reason"]
        }
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Заглушка для выполнения функции.
        
        ВАЖНО: Реальное завершение звонка происходит в VoxEngine скрипте.
        Этот метод вызываться НЕ должен при работе через Voximplant.
        
        Args:
            arguments: Аргументы функции
            context: Контекст выполнения
            
        Returns:
            Информационное сообщение
        """
        reason = arguments.get("reason", "unknown")
        farewell_message = arguments.get("farewell_message", "")
        
        logger.warning(f"[HANGUP] Backend execute() вызван для hangup_call. Это не должно происходить при работе через Voximplant!")
        logger.info(f"[HANGUP] Reason: {reason}, Farewell: {farewell_message}")
        
        # Возвращаем информационное сообщение
        # Этот результат не должен использоваться, так как функция выполняется в VoxEngine
        return {
            "success": True,
            "message": "Функция hangup_call предназначена для выполнения в VoxEngine",
            "reason": reason,
            "farewell_message": farewell_message,
            "note": "Если вы видите это сообщение, значит функция была вызвана не через Voximplant",
            "timestamp": context.get("timestamp") if context else None
        }


# Автоматическая регистрация функции при импорте
def register_hangup_function():
    """Регистрирует функцию завершения звонка в системе."""
    try:
        from backend.functions.registry import register_function
        register_function(HangupCallFunction)
        logger.info("[HANGUP] Функция hangup_call зарегистрирована в системе")
    except Exception as e:
        logger.error(f"[HANGUP] Ошибка регистрации функции: {e}")

# Выполняем регистрацию при импорте модуля
register_hangup_function()
