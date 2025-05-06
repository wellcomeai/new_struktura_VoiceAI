# backend/functions/registry.py
from typing import Dict, Callable, List, Any

# Реестр всех доступных функций
_FUNCTION_REGISTRY: Dict[str, Dict[str, Any]] = {}

def register_function(func_id: str, description: str, parameters: Dict[str, Any]):
    """Декоратор для регистрации функции в реестре"""
    def decorator(func: Callable):
        _FUNCTION_REGISTRY[func_id] = {
            "function": func,
            "description": description,
            "parameters": parameters
        }
        return func
    return decorator

def get_function(func_id: str) -> Dict[str, Any]:
    """Получить функцию по ID"""
    return _FUNCTION_REGISTRY.get(func_id)

def get_all_functions() -> Dict[str, Dict[str, Any]]:
    """Получить все зарегистрированные функции"""
    return _FUNCTION_REGISTRY
