"""
Модульная система функций для WellcomeAI.
"""

from backend.functions.base import FunctionBase
from backend.functions.registry import (
    register_function,
    normalize_function_name,
    get_function_definitions,
    get_enabled_functions,
    execute_function,
    discover_functions
)

# Импортируем новую функцию query_llm
from backend.functions.query_llm import query_llm, FUNCTION_METADATA as query_llm_metadata

# Автоматически загружаем все функции при импорте модуля
discover_functions()

# Явно регистрируем query_llm на случай если автоматика не сработает
try:
    register_function(
        "query_llm",
        query_llm,
        query_llm_metadata
    )
    print("[FUNCTIONS] ✅ query_llm зарегистрирована явно")
except Exception as e:
    print(f"[FUNCTIONS] ⚠️ query_llm уже зарегистрирована или ошибка: {e}")

__all__ = [
    "FunctionBase",
    "register_function", 
    "normalize_function_name",
    "get_function_definitions",
    "get_enabled_functions",
    "execute_function",
    "discover_functions",
    "query_llm"  # Добавляем query_llm в экспорт
]
