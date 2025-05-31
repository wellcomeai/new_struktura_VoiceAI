"""
Logging configuration for WellcomeAI application.
Sets up structured logging with consistent format.
"""

import logging
import sys
import time
import os
from typing import Dict, Any, Optional
import traceback
import json

# === Получаем переменные окружения вместо импорта settings ===
LOG_LEVEL = logging.DEBUG if os.getenv("DEBUG", "False") == "True" else logging.INFO
APP_NAME = os.getenv("APP_NAME", "WellcomeAI")
VERSION = os.getenv("VERSION", "1.0.0")
ENV = "Development" if LOG_LEVEL == logging.DEBUG else "Production"

# === Каталог логов ===
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_DIR = os.path.join(os.getcwd(), "logs")
JSON_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

# Убедиться, что директория логов существует
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)

class JsonFormatter(logging.Formatter):
    """Custom formatter for JSON structured logging"""
    def format(self, record):
        log_data = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "name": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            log_data["exception"] = {
                "type": record.exc_info[0].__name__,
                "message": str(record.exc_info[1]),
                "traceback": traceback.format_exception(*record.exc_info)
            }
        if hasattr(record, "extra") and record.extra:
            log_data.update(record.extra)
        return json.dumps(log_data)

def setup_logging():
    """Configure the logging system for the application"""
    root_logger = logging.getLogger()
    root_logger.handlers = []
    root_logger.setLevel(LOG_LEVEL)

    # Console (human-readable)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(LOG_LEVEL)
    console_handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root_logger.addHandler(console_handler)

    # File (JSON structured)
    log_file = os.path.join(LOG_DIR, f"wellcomeai_{time.strftime('%Y%m%d')}.log")
    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(LOG_LEVEL)
    file_handler.setFormatter(JsonFormatter())
    root_logger.addHandler(file_handler)

    # Uvicorn noise suppression
    for logger_name in ["uvicorn", "uvicorn.access", "uvicorn.error"]:
        for handler in logging.getLogger(logger_name).handlers:
            logging.getLogger(logger_name).removeHandler(handler)
        logging.getLogger(logger_name).propagate = False

    root_logger.info(
        f"Logging system initialized. Application: {APP_NAME}, "
        f"Version: {VERSION}, Environment: {ENV}"
    )

def get_logger(name: str) -> logging.Logger:
    """Get a logger with the given name"""
    return logging.getLogger(name)

class LoggerAdapter(logging.LoggerAdapter):
    """Logger adapter for adding context information to logs"""
    def process(self, msg, kwargs):
        kwargs.setdefault("extra", {}).update(self.extra)
        return msg, kwargs

def get_context_logger(name: str, context: Dict[str, Any]) -> LoggerAdapter:
    """Get a logger with context information"""
    logger = get_logger(name)
    return LoggerAdapter(logger, {"extra": context})
