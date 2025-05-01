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

# Загружаем переменные окружения из .env файла
load_dotenv()

# Настройки для запуска
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Базовая настройка логирования для этого файла
logger = logging.getLogger("wellcome-ai")

# Пакетная правка импортов - создаем символические ссылки
def setup_imports():
    # 1. Сначала импортируем backend модули
    try:
        import backend.core.security
        import backend.core.dependencies
        import backend.db.session
        import backend.models.user
        import backend.models.base
        
        # 2. Создаем импорты для корневых модулей
        if 'core' not in sys.modules:
            sys.modules['core'] = sys.modules['backend.core']
        if 'db' not in sys.modules:
            sys.modules['db'] = sys.modules['backend.db']
        if 'models' not in sys.modules:
            sys.modules['models'] = sys.modules['backend.models']
        if 'schemas' not in sys.modules:
            import backend.schemas
            sys.modules['schemas'] = sys.modules['backend.schemas']
        if 'services' not in sys.modules:
            import backend.services
            sys.modules['services'] = sys.modules['backend.services']
        
        # 3. Важное исправление: добавляем get_current_user в security
        if not hasattr(sys.modules['core.security'], 'get_current_user'):
            sys.modules['core.security'].get_current_user = sys.modules['backend.core.dependencies'].get_current_user
        
        print("Import patching complete")
    except Exception as e:
        print(f"Error setting up imports: {str(e)}")
        raise

# Устанавливаем импорты перед загрузкой приложения
setup_imports()

# Импортируем приложение из app.py
from app import app

# Экспортируем переменную application для Gunicorn
application = app

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
