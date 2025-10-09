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

from backend.core.config import settings

# Constants
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
JSON_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
LOG_LEVEL = logging.DEBUG if settings.DEBUG else logging.INFO
LOG_DIR = os.path.join(os.getcwd(), "logs")

# Ensure log directory exists
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)

# ============================================================================
# COLOR CODES (for terminal output)
# ============================================================================

class LogColors:
    """ANSI color codes for terminal output"""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    
    # Levels
    DEBUG = "\033[36m"      # Cyan
    INFO = "\033[32m"       # Green
    WARNING = "\033[33m"    # Yellow
    ERROR = "\033[31m"      # Red
    CRITICAL = "\033[35m"   # Magenta
    
    # Components
    TIMESTAMP = "\033[90m"  # Gray
    NAME = "\033[94m"       # Blue


# ============================================================================
# CUSTOM FORMATTERS
# ============================================================================

class ColoredFormatter(logging.Formatter):
    """
    Formatter that adds colors to console output
    """
    
    LEVEL_COLORS = {
        logging.DEBUG: LogColors.DEBUG,
        logging.INFO: LogColors.INFO,
        logging.WARNING: LogColors.WARNING,
        logging.ERROR: LogColors.ERROR,
        logging.CRITICAL: LogColors.CRITICAL,
    }
    
    def format(self, record):
        if not ENABLE_COLORS:
            return super().format(record)
        
        # Color the level name
        levelname = record.levelname
        if record.levelno in self.LEVEL_COLORS:
            colored_levelname = (
                f"{self.LEVEL_COLORS[record.levelno]}"
                f"{levelname:8s}"
                f"{LogColors.RESET}"
            )
            record.levelname = colored_levelname
        
        # Format the message
        formatted = super().format(record)
        
        # Reset color
        return formatted + LogColors.RESET


class JsonFormatter(logging.Formatter):
    """
    Custom formatter for JSON structured logging
    """
    def format(self, record):
        log_data = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "name": record.name,
            "function": record.funcName,
            "line": record.lineno,
            "message": record.getMessage(),
        }
        
        # Add exception info if available
        if record.exc_info:
            log_data["exception"] = {
                "type": record.exc_info[0].__name__,
                "message": str(record.exc_info[1]),
                "traceback": traceback.format_exception(*record.exc_info)
            }
            
        # Add extra fields if available
        if hasattr(record, "extra") and record.extra:
            log_data.update(record.extra)
            
        return json.dumps(log_data)


# ============================================================================
# SETUP FUNCTIONS
# ============================================================================

def setup_logging(force_debug: bool = False, use_detailed_format: bool = False):
    """
    Configure the logging system for the application
    
    Args:
        force_debug: Force DEBUG level regardless of settings
        use_detailed_format: Use detailed format with function names and line numbers
    """
    # Determine log level
    if force_debug or FORCE_DEBUG:
        level = logging.DEBUG
        print("🔥 DEBUG LOGGING FORCEFULLY ENABLED!")
    else:
        level = LOG_LEVEL
    
    # Choose format
    console_format = DETAILED_FORMAT if use_detailed_format else LOG_FORMAT
    
    # Reset root logger
    root_logger = logging.getLogger()
    root_logger.handlers = []
    root_logger.setLevel(level)
    
    # ========================================================================
    # CONSOLE HANDLER (colored, human-readable)
    # ========================================================================
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_formatter = ColoredFormatter(console_format)
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)
    
    # ========================================================================
    # FILE HANDLER (JSON format for processing)
    # ========================================================================
    log_file = os.path.join(LOG_DIR, f"wellcomeai_{time.strftime('%Y%m%d')}.log")
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setLevel(level)
    file_handler.setFormatter(JsonFormatter())
    root_logger.addHandler(file_handler)
    
    # ========================================================================
    # UVICORN LOGGING CONFIGURATION
    # ========================================================================
    # Instead of completely disabling uvicorn logs, configure them properly
    uvicorn_loggers = ["uvicorn", "uvicorn.access", "uvicorn.error"]
    
    for logger_name in uvicorn_loggers:
        logger = logging.getLogger(logger_name)
        logger.setLevel(logging.INFO)  # Keep INFO for uvicorn
        logger.propagate = True  # Allow propagation to root
        
        # Remove default handlers
        logger.handlers = []
    
    # ========================================================================
    # DIAGNOSTIC INFORMATION
    # ========================================================================
    root_logger.info("=" * 80)
    root_logger.info(f"🚀 LOGGING SYSTEM INITIALIZED")
    root_logger.info("=" * 80)
    root_logger.info(f"Application: {settings.APP_NAME}")
    root_logger.info(f"Version: {settings.VERSION}")
    root_logger.info(f"Environment: {'Development' if settings.DEBUG else 'Production'}")
    root_logger.info(f"Log Level: {logging.getLevelName(level)}")
    root_logger.info(f"Log File: {log_file}")
    root_logger.info(f"Colors Enabled: {ENABLE_COLORS}")
    root_logger.info(f"Detailed Format: {use_detailed_format}")
    root_logger.info("=" * 80)
    
    # Test all log levels
    root_logger.debug("🐛 DEBUG level test - you should see this if DEBUG is enabled")
    root_logger.info("ℹ️  INFO level test")
    root_logger.warning("⚠️  WARNING level test")
    
    return root_logger


def get_logger(name: str, level: Optional[int] = None) -> logging.Logger:
    """
    Get a logger with the given name
    
    Args:
        name: The name for the logger
        level: Optional specific level for this logger
        
    Returns:
        Logger instance
    """
    logger = logging.getLogger(name)
    if level is not None:
        logger.setLevel(level)
    return logger


class LoggerAdapter(logging.LoggerAdapter):
    """
    Logger adapter for adding context information to logs
    """
    def process(self, msg, kwargs):
        # Add extra fields
        kwargs.setdefault("extra", {}).update(self.extra)
        return msg, kwargs


def get_context_logger(name: str, context: Dict[str, Any]) -> LoggerAdapter:
    """
    Get a logger with context information
    
    Args:
        name: The name for the logger
        context: Dictionary of context information to include in logs
        
    Returns:
        LoggerAdapter instance
    """
    logger = get_logger(name)
    return LoggerAdapter(logger, {"extra": context})


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def log_function_call(logger: logging.Logger):
    """
    Decorator to log function calls with arguments
    
    Usage:
        @log_function_call(logger)
        def my_function(arg1, arg2):
            pass
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            logger.debug(f"🔵 Calling {func.__name__} with args={args}, kwargs={kwargs}")
            try:
                result = func(*args, **kwargs)
                logger.debug(f"🟢 {func.__name__} completed successfully")
                return result
            except Exception as e:
                logger.error(f"🔴 {func.__name__} failed with error: {e}", exc_info=True)
                raise
        return wrapper
    return decorator


def set_log_level(level: str):
    """
    Dynamically change log level
    
    Args:
        level: Log level as string (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    """
    numeric_level = getattr(logging, level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {level}")
    
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    
    for handler in root_logger.handlers:
        handler.setLevel(numeric_level)
    
    root_logger.info(f"Log level changed to: {level.upper()}")


def get_log_stats() -> Dict[str, Any]:
    """
    Get statistics about the logging system
    
    Returns:
        Dictionary with logging statistics
    """
    root_logger = logging.getLogger()
    
    return {
        "level": logging.getLevelName(root_logger.level),
        "handlers": len(root_logger.handlers),
        "handler_types": [type(h).__name__ for h in root_logger.handlers],
        "log_dir": LOG_DIR,
        "colors_enabled": ENABLE_COLORS,
    }


# ============================================================================
# INITIALIZE ON IMPORT (optional)
# ============================================================================

# Uncomment the line below to auto-initialize logging when module is imported
# setup_logging()
