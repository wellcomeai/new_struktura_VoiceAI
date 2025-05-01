"""
Точка входа для запуска приложения WellcomeAI.
Этот файл используется для запуска приложения через uvicorn или gunicorn.
"""

import os
import sys
import importlib
import types
import uvicorn
import logging
from dotenv import load_dotenv

# Настройка импортов - выполняется до всего остального
def fix_imports():
    # Добавляем текущую директорию в Python path
    current_dir = os.path.dirname(os.path.abspath(__file__))
    if current_dir not in sys.path:
        sys.path.append(current_dir)
    
    # 1. Создаем пустые модули-заглушки для всех модулей верхнего уровня
    stub_modules = ['core', 'db', 'models', 'schemas', 'services', 'utils', 'api', 'websockets']
    for module_name in stub_modules:
        if module_name not in sys.modules:
            module = types.ModuleType(module_name)
            sys.modules[module_name] = module
            module.__path__ = []
            print(f"Created stub for {module_name}")
    
    # 2. Импортируем реальные модули из backend
    try:
        import backend.core
        import backend.db
        import backend.models
        import backend.schemas
        import backend.services
        import backend.utils
        
        # 3. Перенаправляем импорты
        sys.modules['core'] = sys.modules['backend.core']
        sys.modules['db'] = sys.modules['backend.db']
        sys.modules['models'] = sys.modules['backend.models']
        sys.modules['schemas'] = sys.modules['backend.schemas']
        sys.modules['services'] = sys.modules['backend.services']
        sys.modules['utils'] = sys.modules['backend.utils']
        
        # 4. Перенаправляем подмодули для каждого модуля
        backend_modules = {
            'core': ['config', 'logging', 'security', 'dependencies', 'exceptions', 'rate_limiter'],
            'db': ['session', 'base', 'repositories'],
            'models': ['user', 'assistant', 'conversation', 'file', 'base'],
            'schemas': ['auth', 'user', 'assistant', 'conversation', 'file'],
            'services': ['auth_service', 'user_service', 'assistant_service', 'file_service', 'conversation_service']
        }
        
        for parent, submodules in backend_modules.items():
            for submodule in submodules:
                full_name = f"{parent}.{submodule}"
                if full_name not in sys.modules:
                    backend_name = f"backend.{full_name}"
                    # Проверяем, существует ли реальный модуль
                    try:
                        real_module = importlib.import_module(backend_name)
                        sys.modules[full_name] = real_module
                        print(f"Redirected {full_name} -> {backend_name}")
                    except ImportError:
                        pass  # Игнорируем, если модуль не существует
                        
        print("Import redirection complete")
        return True
    except Exception as e:
        print(f"Error setting up imports: {str(e)}")
        return False

# Первым делом настраиваем импорты
if not fix_imports():
    sys.exit(1)

# Загружаем переменные окружения из .env файла
load_dotenv()

# Настройки для запуска
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Теперь импортируем приложение - после настройки импортов
from app import app  

# Экспортируем переменную application для Gunicorn
application = app

# Базовая настройка логирования
logger = logging.getLogger("wellcome-ai")

if __name__ == "__main__":
    logger.info(f"Запуск сервера на порту {PORT}, режим отладки: {DEBUG}")
    
    # Запуск uvicorn сервера
    uvicorn.run(
        "app:app", 
        host="0.0.0.0", 
        port=PORT,
        log_level=LOG_LEVEL,
        reload=DEBUG,
        workers=1 if DEBUG else None,
        timeout_keep_alive=120,
    )
