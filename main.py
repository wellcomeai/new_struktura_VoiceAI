"""
Точка входа для запуска приложения WellcomeAI.
Этот файл используется для запуска приложения через uvicorn или gunicorn.
"""

import os
import uvicorn
import logging
from dotenv import load_dotenv

# Загружаем переменные окружения из .env файла, если он существует
load_dotenv()

# Настройки для запуска
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Импортируем приложение из app.py
from app import app

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
