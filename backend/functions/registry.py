# backend/functions/registry.py
from typing import Dict, Callable, List, Any, Optional, Set
import json
import inspect
import functools

# Реестр всех доступных функций
_FUNCTION_REGISTRY: Dict[str, Dict[str, Any]] = {}
# Категории функций
_FUNCTION_CATEGORIES: Dict[str, Set[str]] = {}

def register_function(func_id: str, description: str, parameters: Dict[str, Any], category: str = "general"):
    """
    Декоратор для регистрации функции в реестре.
    
    Args:
        func_id: Уникальный идентификатор функции (snake_case)
        description: Описание функции для модели
        parameters: JSON Schema для параметров функции
        category: Категория функции для группировки (например, "weather", "database", "utils")
        
    Returns:
        Декоратор
        
    Raises:
        ValueError: При некорректном формате func_id или параметров
    """
    # Проверка правильности формата имени функции
    if not func_id.isidentifier() or not func_id.islower() or not all(c.isalnum() or c == '_' for c in func_id):
        raise ValueError(f"Имя функции '{func_id}' должно быть в snake_case и состоять только из букв, цифр и подчеркиваний")
    
    # Проверка на уникальность имени функции
    if func_id in _FUNCTION_REGISTRY:
        raise ValueError(f"Функция с именем '{func_id}' уже зарегистрирована")
    
    # Валидация параметров (проверка на соответствие JSON Schema)
    if not isinstance(parameters, dict) or not parameters.get("properties"):
        raise ValueError("Параметры должны быть JSON Schema объектом с ключом 'properties'")
    
    def decorator(func: Callable):
        # Получение сигнатуры функции для валидации
        sig = inspect.signature(func)
        param_names = set(sig.parameters.keys())
        schema_props = set(parameters.get("properties", {}).keys())
        
        # Проверка соответствия схемы параметров и сигнатуры функции
        if required := parameters.get("required", []):
            for req_param in required:
                if req_param not in param_names:
                    raise ValueError(f"Обязательный параметр '{req_param}' отсутствует в сигнатуре функции {func.__name__}")
        
        # Добавляем метаданные к функции
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            return await func(*args, **kwargs)
        
        # Регистрируем функцию в реестре
        _FUNCTION_REGISTRY[func_id] = {
            "function": wrapper,
            "description": description,
            "parameters": parameters,
            "category": category,
            "original_func": func.__name__
        }
        
        # Добавляем функцию в категорию
        if category not in _FUNCTION_CATEGORIES:
            _FUNCTION_CATEGORIES[category] = set()
        _FUNCTION_CATEGORIES[category].add(func_id)
        
        return wrapper
    
    return decorator

def get_function(func_id: str) -> Optional[Dict[str, Any]]:
    """
    Получить функцию по ID
    
    Args:
        func_id: Идентификатор функции
        
    Returns:
        Информация о функции или None, если функция не найдена
    """
    return _FUNCTION_REGISTRY.get(func_id)

def get_function_by_category(category: str) -> Dict[str, Dict[str, Any]]:
    """
    Получить все функции определенной категории
    
    Args:
        category: Название категории
        
    Returns:
        Словарь функций в указанной категории
    """
    if category not in _FUNCTION_CATEGORIES:
        return {}
    
    return {
        func_id: func_info
        for func_id, func_info in _FUNCTION_REGISTRY.items()
        if func_id in _FUNCTION_CATEGORIES[category]
    }

def get_all_categories() -> List[str]:
    """
    Получить список всех категорий функций
    
    Returns:
        Список названий категорий
    """
    return list(_FUNCTION_CATEGORIES.keys())

def get_all_functions() -> Dict[str, Dict[str, Any]]:
    """
    Получить все зарегистрированные функции
    
    Returns:
        Словарь всех зарегистрированных функций
    """
    return _FUNCTION_REGISTRY

def get_tools_for_openai() -> List[Dict[str, Any]]:
    """
    Получить список инструментов в формате для API OpenAI
    
    Returns:
        Список инструментов в формате для API OpenAI
    """
    tools = []
    for func_id, func_info in _FUNCTION_REGISTRY.items():
        tools.append({
            "type": "function",
            "function": {
                "name": func_id,
                "description": func_info["description"],
                "parameters": func_info["parameters"]
            }
        })
    return tools

def is_function_enabled(func_id: str, functions_config: Optional[Dict[str, Any]]) -> bool:
    """
    Проверяет, включена ли функция в конфигурации
    
    Args:
        func_id: Идентификатор функции
        functions_config: Конфигурация функций из ассистента
        
    Returns:
        True если функция включена, иначе False
    """
    if not functions_config or not isinstance(functions_config, dict):
        return False
    
    enabled_functions = functions_config.get("enabled_functions", [])
    return func_id in enabled_functions

def format_function_for_api(func_id: str, enabled: bool = False) -> Dict[str, Any]:
    """
    Форматирует информацию о функции для API
    
    Args:
        func_id: Идентификатор функции
        enabled: Включена ли функция в конфигурации ассистента
        
    Returns:
        Словарь с информацией о функции в формате API
    """
    func_info = get_function(func_id)
    if not func_info:
        return {}
    
    return {
        "id": func_id,
        "name": func_id,
        "description": func_info["description"],
        "parameters": func_info["parameters"],
        "category": func_info.get("category", "general"),
        "enabled": enabled
    }
