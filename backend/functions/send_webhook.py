"""
Функция для отправки данных через вебхук.
"""
import asyncio
import json
import re
import aiohttp
from typing import Dict, Any, Optional

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает URL вебхука из системного промпта ассистента.
    """
    if not prompt:
        return None
        
    # Ищем URL с помощью регулярного выражения
    # Паттерн 1: "URL вебхука: https://example.com"
    pattern1 = r'URL\s+(?:вебхука|webhook):\s*(https?://[^\s"\'<>]+)'
    # Паттерн 2: "webhook URL: https://example.com"
    pattern2 = r'(?:вебхука|webhook)\s+URL:\s*(https?://[^\s"\'<>]+)'
    # Паттерн 3: просто URL в тексте (менее точный)
    pattern3 = r'https?://[^\s"\'<>]+'
    
    # Проверяем шаблоны по убыванию специфичности
    for pattern in [pattern1, pattern2, pattern3]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

@register_function
class WebhookFunction(FunctionBase):
    """Функция для отправки данных через вебхук"""
    
    @classmethod
    def get_name(cls) -> str:
        return "send_webhook"
        
    @classmethod
    def get_description(cls) -> str:
        return "Отправляет данные на внешний вебхук (например, для n8n)"
        
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL вебхука для отправки данных"
                },
                "event": {
                    "type": "string",
                    "description": "Код события (например, 'booking', 'request', 'notification')"
                },
                "payload": {
                    "type": "object",
                    "description": "Произвольные данные для отправки"
                }
            },
            "required": ["url", "event"]
        }
        
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Отправляет данные на внешний сервер через указанный URL.
        """
        context = context or {}
        assistant_config = context.get("assistant_config")
        client_id = context.get("client_id")
        
        try:
            url = arguments.get("url")
            event = arguments.get("event")
            payload = arguments.get("payload", {})
            
            # Если нет URL, попробуем извлечь из промпта
            if not url and assistant_config:
                if hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
                    url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
                    logger.info(f"Извлечен URL вебхука из промпта: {url}")
            
            if not url:
                return {"error": "URL is required"}
            
            if not event:
                event = "default_event"  # Устанавливаем значение по умолчанию
                logger.info(f"Используем имя события по умолчанию: {event}")
                
            # Формируем данные для отправки
            data = {
                "event": event,
                "data": payload
            }
            
            # Добавляем информацию об ассистенте и клиенте, если доступно
            if assistant_config:
                data["assistant_id"] = str(assistant_config.id)
                data["assistant_name"] = assistant_config.name
                
            if client_id:
                data["client_id"] = client_id
            
            # Отправляем запрос
            logger.info(f"Отправка webhook на URL: {url}, с событием: {event}")
            
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=data, timeout=10) as response:
                    response_text = await response.text()
                    return {
                        "status": response.status,
                        "message": "Webhook sent successfully",
                        "response": response_text[:200]  # Ограничиваем размер ответа
                    }
                    
        except asyncio.TimeoutError:
            return {
                "status": 0,
                "error": "Timeout error when sending webhook",
                "message": "Webhook timeout"
            }
        except Exception as e:
            logger.error(f"Ошибка при отправке вебхука: {e}")
            return {"error": f"Webhook error: {str(e)}"}
