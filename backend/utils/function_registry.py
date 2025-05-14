import json
import inspect
import asyncio
import importlib.util
import re
from typing import Dict, Any, Callable, Optional, List
import sys

from backend.core.logging import get_logger
logger = get_logger(__name__)

# Реестр зарегистрированных функций
FUNCTION_REGISTRY = {}

# Описания функций для отображения в интерфейсе
FUNCTION_DEFINITIONS = {
    "send_webhook": {
        "name": "send_webhook",
        "description": "Отправляет данные на внешний вебхук (например, для n8n)",
        "parameters": {
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
    }
}

def register_function(name: str):
    """
    Декоратор для регистрации функции.
    
    Args:
        name: Имя функции для регистрации
    """
    def decorator(func):
        FUNCTION_REGISTRY[name] = func
        logger.info(f"Функция '{name}' зарегистрирована")
        return func
    return decorator

def get_function_definitions() -> Dict[str, Dict[str, Any]]:
    """
    Возвращает определения всех зарегистрированных функций.
    
    Returns:
        Словарь с определениями функций
    """
    return FUNCTION_DEFINITIONS

def get_enabled_functions(assistant_functions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Формирует список описаний включенных функций для OpenAI API.
    
    Args:
        assistant_functions: Список функций ассистента
        
    Returns:
        Список описаний функций для OpenAI
    """
    if not assistant_functions:
        return []
    
    enabled_functions = []
    
    # Преобразуем формат для OpenAI API
    for func in assistant_functions:
        function_name = func.get("name")
        # Нормализуем имя функции (учитываем camelCase и snake_case)
        if function_name:
            if function_name in FUNCTION_DEFINITIONS:
                enabled_functions.append(FUNCTION_DEFINITIONS[function_name])
            elif function_name.lower() == "sendwebhook" and "send_webhook" in FUNCTION_DEFINITIONS:
                enabled_functions.append(FUNCTION_DEFINITIONS["send_webhook"])
            elif function_name.lower() == "webhook" and "send_webhook" in FUNCTION_DEFINITIONS:
                enabled_functions.append(FUNCTION_DEFINITIONS["send_webhook"])
    
    return enabled_functions

def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает URL вебхука из системного промпта ассистента.
    
    Args:
        prompt: Системный промпт ассистента
        
    Returns:
        Найденный URL или None
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

async def execute_function(
    function_name: str, 
    arguments: Dict[str, Any],
    assistant_config=None,
    client_id=None
) -> Dict[str, Any]:
    """
    Выполнить функцию из реестра.
    
    Args:
        function_name: Имя функции
        arguments: Аргументы функции
        assistant_config: Конфигурация ассистента
        client_id: ID клиента
        
    Returns:
        Результат выполнения функции
    """
    # Нормализуем имя функции
    if function_name and function_name.lower() == "sendwebhook":
        function_name = "send_webhook"
        logger.info(f"Нормализовано имя функции: sendWebHook -> send_webhook")
    
    if function_name not in FUNCTION_REGISTRY:
        logger.error(f"Функция '{function_name}' не найдена в реестре")
        return {"error": f"Function '{function_name}' not found"}
    
    func = FUNCTION_REGISTRY[function_name]
    
    # Если это webhook и URL не указан, ищем его в промпте
    if function_name == "send_webhook" and "url" not in arguments and assistant_config:
        if hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if webhook_url:
                logger.info(f"Извлечен URL вебхука из промпта: {webhook_url}")
                arguments["url"] = webhook_url
    
    # Если event не указан для webhook, используем значение по умолчанию
    if function_name == "send_webhook" and "event" not in arguments:
        arguments["event"] = "default_event"
        logger.info(f"Добавлен параметр event по умолчанию: 'default_event'")
    
    try:
        # Проверяем, является ли функция асинхронной
        if inspect.iscoroutinefunction(func):
            result = await func(arguments, assistant_config, client_id)
        else:
            # Запускаем синхронную функцию в отдельном потоке
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, lambda: func(arguments, assistant_config, client_id)
            )
        
        return result
    except Exception as e:
        logger.error(f"Ошибка выполнения функции '{function_name}': {e}")
        return {"error": str(e)}

# Проверка доступности модулей
def is_module_available(module_name):
    """Проверяет, доступен ли модуль для импорта"""
    try:
        # Проверка на уже импортированные модули
        if module_name in sys.modules:
            return True
            
        # Проверка возможности импорта без фактического импорта
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, AttributeError):
        return False

# Функция для отправки HTTP-запроса с использованием доступных библиотек
async def send_http_request(url, data, timeout=10):
    """
    Отправляет HTTP POST запрос, используя доступные библиотеки
    
    Args:
        url: URL для запроса
        data: Данные для отправки (будут преобразованы в JSON)
        timeout: Таймаут в секундах
        
    Returns:
        Результат запроса
    """
    # Пробуем использовать aiohttp
    if is_module_available("aiohttp"):
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=data, timeout=timeout) as response:
                    response_text = await response.text()
                    return {
                        "status": response.status,
                        "message": "Webhook sent successfully",
                        "response": response_text[:200]  # Ограничиваем размер ответа
                    }
        except Exception as e:
            logger.error(f"Ошибка при отправке запроса через aiohttp: {e}")
            # Если возникла ошибка, продолжаем с другими методами
    
    # Пробуем использовать requests
    if is_module_available("requests"):
        import requests
        try:
            # Выполняем синхронный запрос в отдельном потоке
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: requests.post(
                    url, 
                    json=data,
                    timeout=timeout,
                    headers={"Content-Type": "application/json"}
                )
            )
            return {
                "status": response.status_code,
                "message": "Webhook sent successfully",
                "response": response.text[:200]  # Ограничиваем размер ответа
            }
        except Exception as e:
            logger.error(f"Ошибка при отправке запроса через requests: {e}")
            # Если возникла ошибка, продолжаем с другими методами
    
    # Запасной вариант: используем стандартную библиотеку urllib
    try:
        import urllib.request
        import urllib.error
        import ssl
        
        # Преобразуем данные в JSON
        data_json = json.dumps(data).encode('utf-8')
        
        # Создаем запрос
        req = urllib.request.Request(
            url,
            data=data_json,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        
        # Создаем контекст SSL (игнорируем проверку сертификатов)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        # Выполняем запрос в отдельном потоке
        loop = asyncio.get_event_loop()
        
        def make_request():
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=ctx) as response:
                    response_data = response.read().decode('utf-8')
                    return {
                        "status": response.status,
                        "message": "Webhook sent successfully",
                        "response": response_data[:200]  # Ограничиваем размер ответа
                    }
            except urllib.error.HTTPError as e:
                return {
                    "status": e.code,
                    "error": str(e),
                    "response": e.read().decode('utf-8')[:200] if hasattr(e, 'read') else ""
                }
            except Exception as e:
                return {
                    "status": 0,
                    "error": str(e),
                    "response": ""
                }
                
        result = await loop.run_in_executor(None, make_request)
        return result
    except Exception as e:
        return {
            "status": 0,
            "error": f"Failed to send webhook: {str(e)}",
            "response": ""
        }

# Регистрация встроенных функций
@register_function("send_webhook")
async def send_webhook(args, assistant_config=None, client_id=None):
    """
    Отправляет данные на внешний сервер через указанный URL.
    
    Args:
        args: Словарь аргументов:
            - url: Полный URL вебхука
            - event: Код события
            - payload: Произвольные данные (опционально)
            
    Returns:
        Результат выполнения вебхука
    """
    try:
        url = args.get("url")
        event = args.get("event")
        payload = args.get("payload", {})
        
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
        
        # Отправляем запрос с помощью доступных библиотек
        logger.info(f"Отправка webhook на URL: {url}, с событием: {event}")
        result = await send_http_request(url, data)
        logger.info(f"Результат отправки webhook: {result}")
        
        return result
        
    except Exception as e:
        logger.error(f"Ошибка при отправке вебхука: {e}")
        return {"error": f"Webhook error: {str(e)}"}
