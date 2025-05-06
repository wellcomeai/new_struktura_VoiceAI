# backend/functions/registry.py
from typing import Dict, Callable, List, Any, Optional

# Реестр всех доступных функций
_FUNCTION_REGISTRY: Dict[str, Dict[str, Any]] = {}

def register_function(func_id: str, description: str, parameters: Dict[str, Any]):
    """
    Декоратор для регистрации функции в реестре.
    
    Args:
        func_id: Уникальный идентификатор функции (snake_case)
        description: Описание функции для модели
        parameters: JSON Schema для параметров функции
        
    Returns:
        Декоратор
    """
    # Проверка правильности формата имени функции
    if not func_id.isidentifier() or not func_id.islower() or not all(c.isalnum() or c == '_' for c in func_id):
        raise ValueError(f"Имя функции '{func_id}' должно быть в snake_case и состоять только из букв, цифр и подчеркиваний")
    
    def decorator(func: Callable):
        _FUNCTION_REGISTRY[func_id] = {
            "function": func,
            "description": description,
            "parameters": parameters
        }
        return func
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
