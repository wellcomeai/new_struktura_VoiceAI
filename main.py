"""
Точка входа для запуска приложения WellcomeAI.
Этот файл используется для запуска приложения через uvicorn или gunicorn.
"""

import os
import sys
import uvicorn
import logging
import importlib.util
from dotenv import load_dotenv

# Добавляем текущую директорию в Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# Создаем символические ссылки для импорта модулей из backend
modules_to_patch = ['db', 'core', 'models', 'schemas', 'services', 'utils', 'api']
for module_name in modules_to_patch:
    # Проверяем, что модуль еще не импортирован
    if module_name not in sys.modules:
        # Пытаемся импортировать из backend
        try:
            module_spec = importlib.util.find_spec(f'backend.{module_name}')
            if module_spec:
                # Создаем модуль в корневом пространстве имен
                module = importlib.util.module_from_spec(module_spec)
                sys.modules[module_name] = module
                # Выполняем модуль
                module_spec.loader.exec_module(module)
                print(f"Patched import for {module_name}")
        except Exception as e:
            print(f"Failed to patch {module_name}: {str(e)}")

# Загружаем переменные окружения из .env файла, если он существует
load_dotenv()

# Настройки для запуска
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Импортируем приложение из app.py
from app import app

# Экспортируем переменную application для Gunicorn
application = app

# Базовая настройка логирования для этого файла
logger = logging.getLogger("wellcome-ai")

if __name__ == "__main__":
    # Логирование при запуске
    logger.info(f"Запуск сервера на порту {PORT}, режим отладки: {DEBUG}")
    
    # Запуск uvicorn сервера с оптимизированными настройками
    uvicorn.run(
        "app:app", 
        host="0.0.0.0", 
        port=PORT,
        log_level=LOG_LEVEL,
        reload=DEBUG,  # Автоперезагрузка при изменении кода в режиме отладки
        workers=1 if DEBUG else None,  # В режиме отладки только 1 рабочий процесс
        timeout_keep_alive=120,  # Увеличенный таймаут для долгих запросов
    )
