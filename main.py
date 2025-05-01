"""
Точка входа для запуска приложения WellcomeAI.
Этот файл используется для запуска приложения через uvicorn или gunicorn.
"""

import os
import sys
import importlib
import importlib.util
import importlib.abc
import types
import uvicorn
import logging
from dotenv import load_dotenv

# Добавляем текущую директорию в Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# Настройка метаимпортов
class BackendImportFinder(importlib.abc.MetaPathFinder):
    """
    Finder для перенаправления импортов без префикса к backend пакету.
    Например, 'core.config' -> 'backend.core.config'
    """
    
    def __init__(self):
        self.prefix = 'backend.'
        self.main_modules = ['core', 'db', 'models', 'schemas', 'services', 'utils', 'api', 'websockets']
        self.imported_modules = set()
    
    def find_spec(self, fullname, path, target=None):
        # Если модуль уже импортирован, возвращаем None, чтобы продолжить стандартный импорт
        if fullname in sys.modules:
            return None
        
        # Проверяем, что это один из наших модулей
        parts = fullname.split('.')
        if parts[0] not in self.main_modules:
            return None
        
        # Формируем имя модуля с префиксом backend
        backend_name = self.prefix + fullname
        
        try:
            # Пытаемся найти модуль в backend
            spec = importlib.util.find_spec(backend_name)
            if spec:
                # Сохраняем соответствие для loader
                self.imported_modules.add(fullname)
                print(f"Перенаправление импорта: {fullname} -> {backend_name}")
                
                # Создаем новый модуль и устанавливаем его в sys.modules
                loader = BackendImportLoader(fullname, backend_name)
                return importlib.machinery.ModuleSpec(fullname, loader)
        except (ImportError, AttributeError):
            pass
        
        return None

class BackendImportLoader(importlib.abc.Loader):
    """Загрузчик для модулей, перенаправляемых к backend."""
    
    def __init__(self, fullname, backend_name):
        self.fullname = fullname
        self.backend_name = backend_name
    
    def create_module(self, spec):
        # Создаем модуль, если он еще не существует
        if self.fullname in sys.modules:
            return sys.modules[self.fullname]
        
        try:
            # Импортируем модуль из backend
            backend_module = importlib.import_module(self.backend_name)
            
            # Создаем новый модуль
            module = types.ModuleType(self.fullname)
            
            # Копируем атрибуты из backend модуля
            for attr in dir(backend_module):
                if not attr.startswith('__'):
                    setattr(module, attr, getattr(backend_module, attr))
            
            # Добавляем необходимые атрибуты
            module.__file__ = getattr(backend_module, '__file__', None)
            module.__name__ = self.fullname
            module.__package__ = self.fullname.rpartition('.')[0] or None
            
            # Связываем с родительским модулем, если это подмодуль
            if '.' in self.fullname:
                parent_name, _, child_name = self.fullname.rpartition('.')
                if parent_name in sys.modules:
                    setattr(sys.modules[parent_name], child_name, module)
            
            # Регистрируем модуль
            sys.modules[self.fullname] = module
            return module
        except Exception as e:
            print(f"Ошибка при создании модуля {self.fullname}: {str(e)}")
            return None
    
    def exec_module(self, module):
        # Модуль уже инициализирован в create_module
        pass

# Устанавливаем finder в начало списка meta_path перед любыми импортами
sys.meta_path.insert(0, BackendImportFinder())

# Загружаем переменные окружения
load_dotenv()

# Настройки для запуска
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Импортируем приложение из app.py
from app import app

# Экспортируем переменную application для Gunicorn
application = app

# Базовая настройка логирования
logger = logging.getLogger("wellcome-ai")

if __name__ == "__main__":
    logger.info(f"Запуск сервера на порту {PORT}, режим отладки: {DEBUG}")
    
    uvicorn.run(
        "app:app", 
        host="0.0.0.0", 
        port=PORT,
        log_level=LOG_LEVEL,
        reload=DEBUG,
        workers=1 if DEBUG else None,
        timeout_keep_alive=120,
    )
