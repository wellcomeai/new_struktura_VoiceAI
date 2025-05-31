"""
Configuration settings for the WellcomeAI application.
Handles environment variables and default configuration.
"""

import os
from pydantic_settings import BaseSettings
from pydantic import SecretStr, validator
from typing import Optional
from dotenv import load_dotenv

from backend.core.logging import get_logger

logger = get_logger(__name__)

# Load environment variables from .env file
load_dotenv()

class Settings(BaseSettings):
    """Application settings class using Pydantic for validation"""
    
    # Application info
    APP_NAME: str = "WellcomeAI"
    VERSION: str = "1.0.0"
    DEBUG: bool = os.getenv("DEBUG", "False") == "True"
    PRODUCTION: bool = os.getenv("PRODUCTION", "False") == "True"
    
    # Server settings
    PORT: int = int(os.getenv("PORT", "5050"))
    HOST_URL: Optional[str] = os.getenv("HOST_URL", "http://localhost:5050")
    
    # Database settings
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    
    # Authentication and security
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "change-this-in-production")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 1 day
    
    # OpenAI settings
    OPENAI_API_KEY: Optional[str] = os.getenv("OPENAI_API_KEY")
    REALTIME_WS_URL: str = os.getenv(
        "REALTIME_WS_URL", 
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01"
    )
    
    # WebSocket settings
    WS_PING_INTERVAL: int = 20  # seconds
    WS_PING_TIMEOUT: int = 60   # seconds
    WS_CLOSE_TIMEOUT: int = 30  # seconds
    WS_MAX_MSG_SIZE: int = 15 * 1024 * 1024  # 15MB
    MAX_RECONNECT_ATTEMPTS: int = 5
    
    # === НАСТРОЙКИ ПРЕРЫВАНИЯ ГОЛОСОВОГО АССИСТЕНТА ===
    
    # WebSocket настройки для прерывания
    INTERRUPTION_ENABLED: bool = True
    INTERRUPTION_DEBUG_MODE: bool = False
    
    # Тайминги для команд прерывания (в миллисекундах)
    INTERRUPTION_MIN_GAP_MS: int = 500
    INTERRUPTION_CANCEL_TIMEOUT_MS: int = 5000
    INTERRUPTION_ACK_WAIT_TIMEOUT_MS: int = 3000
    
    # Задержки между командами прерывания
    INTERRUPTION_CANCEL_TO_CLEAR_DELAY_MS: int = 50
    INTERRUPTION_CLEAR_TO_TRUNCATE_DELAY_MS: int = 100
    
    # Аудио параметры для прерывания
    INTERRUPTION_DEFAULT_SAMPLE_RATE: int = 24000
    INTERRUPTION_MIN_SAMPLES_FOR_TRUNCATE: int = 100
    INTERRUPTION_MAX_AUDIO_END_MS: int = 300000  # 5 минут макс
    
    # Повторные попытки
    INTERRUPTION_MAX_CANCEL_RETRIES: int = 3
    INTERRUPTION_MAX_CLEAR_RETRIES: int = 2
    INTERRUPTION_MAX_TRUNCATE_RETRIES: int = 2
    
    # Буферизация команд
    INTERRUPTION_MAX_PENDING_COMMANDS: int = 10
    INTERRUPTION_COMMAND_QUEUE_TIMEOUT_MS: int = 30000  # 30 секунд
    
    # Логирование прерывания
    INTERRUPTION_LOG_ENABLED: bool = True
    INTERRUPTION_LOG_LEVEL: str = "INFO"  # DEBUG, INFO, WARNING, ERROR
    INTERRUPTION_LOG_MAX_PAYLOAD_SIZE: int = 500  # Максимальный размер payload в логах
    
    # Валидация
    INTERRUPTION_VALIDATE_PAYLOADS: bool = True
    INTERRUPTION_STRICT_VALIDATION: bool = False
    
    # Мониторинг производительности
    INTERRUPTION_METRICS_ENABLED: bool = False
    INTERRUPTION_PERFORMANCE_LOG_THRESHOLD_MS: int = 1000
    
    # Совместимость с мобильными устройствами
    INTERRUPTION_MOBILE_OPTIMIZED: bool = True
    INTERRUPTION_IOS_ENHANCED_MODE: bool = True
    
    # Экстренная остановка
    EMERGENCY_STOP_ENABLED: bool = True
    EMERGENCY_STOP_TIMEOUT_MS: int = 2000
    
    # Диагностика
    INTERRUPTION_DIAGNOSTICS_ENABLED: bool = True
    INTERRUPTION_EXPORT_LOGS: bool = True
    INTERRUPTION_MAX_DIAGNOSTIC_EVENTS: int = 100
    
    # Audio settings
    DEFAULT_VOICE: str = "alloy"
    AVAILABLE_VOICES: list = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]
    
    # Path settings
    STATIC_DIR: str = os.path.join(os.getcwd(), "static")
    TEMPLATE_DIR: str = os.path.join(os.getcwd(), "templates")
    
    # CORS Settings
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")
    
    def validate_interruption_settings(self) -> None:
        """Валидирует настройки прерывания"""
        
        # Проверяем тайминги
        if self.INTERRUPTION_MIN_GAP_MS < 100:
            raise ValueError("INTERRUPTION_MIN_GAP_MS должен быть >= 100мс")
        
        if self.INTERRUPTION_CANCEL_TIMEOUT_MS < 1000:
            raise ValueError("INTERRUPTION_CANCEL_TIMEOUT_MS должен быть >= 1000мс")
        
        # Проверяем задержки
        if self.INTERRUPTION_CANCEL_TO_CLEAR_DELAY_MS < 0:
            raise ValueError("INTERRUPTION_CANCEL_TO_CLEAR_DELAY_MS должен быть >= 0")
        
        if self.INTERRUPTION_CLEAR_TO_TRUNCATE_DELAY_MS < 0:
            raise ValueError("INTERRUPTION_CLEAR_TO_TRUNCATE_DELAY_MS должен быть >= 0")
        
        # Проверяем аудио параметры
        if self.INTERRUPTION_DEFAULT_SAMPLE_RATE not in [16000, 24000, 44100, 48000]:
            raise ValueError("INTERRUPTION_DEFAULT_SAMPLE_RATE должен быть стандартным значением")
        
        if self.INTERRUPTION_MIN_SAMPLES_FOR_TRUNCATE < 0:
            raise ValueError("INTERRUPTION_MIN_SAMPLES_FOR_TRUNCATE должен быть >= 0")
        
        # Проверяем retry настройки
        for setting in ["MAX_CANCEL_RETRIES", "MAX_CLEAR_RETRIES", "MAX_TRUNCATE_RETRIES"]:
            value = getattr(self, f"INTERRUPTION_{setting}")
            if not isinstance(value, int) or value < 0 or value > 10:
                raise ValueError(f"INTERRUPTION_{setting} должен быть от 0 до 10")
        
        # Проверяем уровень логирования
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR"]
        if self.INTERRUPTION_LOG_LEVEL not in valid_levels:
            raise ValueError(f"INTERRUPTION_LOG_LEVEL должен быть одним из {valid_levels}")
        
        logger.info("Настройки прерывания валидированы успешно")
    
    # Validators
    @validator("DATABASE_URL")
    def validate_database_url(cls, v):
        if not v and not cls.DEBUG:
            raise ValueError("DATABASE_URL must be set in production mode")
        return v
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Валидируем настройки прерывания при инициализации
        if self.INTERRUPTION_ENABLED:
            self.validate_interruption_settings()
    
    class Config:
        """Pydantic settings configuration"""
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True

# Константы для использования в коде
SUPPORTED_INTERRUPTION_COMMANDS = [
    "response.cancel",
    "output_audio_buffer.clear", 
    "conversation.item.truncate",
    "emergency_stop"
]

INTERRUPTION_ACK_COMMANDS = [
    "response.cancel.ack",
    "output_audio_buffer.clear.ack",
    "conversation.item.truncate.ack", 
    "emergency_stop.ack"
]

# Для мобильных оптимизаций
MOBILE_INTERRUPTION_CONFIG = {
    "enhanced_detection": True,
    "reduced_thresholds": True,
    "faster_response": True,
    "ios_audio_unlock": True,
    "android_optimizations": True
}

# Метрики производительности (если включены)
INTERRUPTION_METRICS_CONFIG = {
    "track_latency": True,
    "track_success_rate": True,
    "track_retry_attempts": True,
    "export_interval_seconds": 300,  # 5 минут
    "max_metric_history": 1000
}

# Create a global settings instance
settings = Settings()
