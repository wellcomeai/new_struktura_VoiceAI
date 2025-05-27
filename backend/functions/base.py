"""
Базовый класс для функций в модульной системе.
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List

class FunctionBase(ABC):
    """Базовый класс для всех функций"""
    
    @classmethod
    @abstractmethod
    def get_name(cls) -> str:
        """Возвращает имя функции"""
        pass
        
    @classmethod
    @abstractmethod
    def get_description(cls) -> str:
        """Возвращает описание функции"""
        pass
        
    @classmethod
    @abstractmethod
    def get_parameters(cls) -> Dict[str, Any]:
        """Возвращает параметры функции"""
        pass
        
    @classmethod
    def get_definition(cls) -> Dict[str, Any]:
        """Возвращает полное определение функции для OpenAI API"""
        return {
            "name": cls.get_name(),
            "description": cls.get_description(),
            "parameters": cls.get_parameters()
        }
        
    @staticmethod
    @abstractmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """Выполняет функцию с заданными аргументами"""
        pass
