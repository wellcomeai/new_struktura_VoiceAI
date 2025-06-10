# backend/core/config.py

"""
Configuration settings for the WellcomeAI application.
ИСПРАВЛЕННАЯ ВЕРСИЯ - устранены проблемы с localhost и демо-данными
"""

import os
from pydantic_settings import BaseSettings
from pydantic import SecretStr, validator
from typing import Optional
from dotenv import load_dotenv

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
    
    # ✅ ИСПРАВЛЕНО: HOST_URL должен быть публично доступным
    HOST_URL: Optional[str] = os.getenv("HOST_URL")
    
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
    
    # Audio settings
    DEFAULT_VOICE: str = "alloy"
    AVAILABLE_VOICES: list = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]
    
    # Path settings
    STATIC_DIR: str = os.path.join(os.getcwd(), "static")
    TEMPLATE_DIR: str = os.path.join(os.getcwd(), "templates")
    
    # CORS Settings
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")
    
    # ✅ ИСПРАВЛЕНО: Robokassa settings - БЕЗ демо-значений по умолчанию
    ROBOKASSA_MERCHANT_LOGIN: str = os.getenv("ROBOKASSA_MERCHANT_LOGIN", "")
    ROBOKASSA_PASSWORD_1: str = os.getenv("ROBOKASSA_PASSWORD_1", "")  
    ROBOKASSA_PASSWORD_2: str = os.getenv("ROBOKASSA_PASSWORD_2", "")
    ROBOKASSA_TEST_MODE: bool = os.getenv("ROBOKASSA_TEST_MODE", "True") == "True"
    
    # ✅ ИСПРАВЛЕНО: Payment settings
    SUBSCRIPTION_PRICE: float = 1490.0  # Цена подписки в рублях
    SUBSCRIPTION_DURATION_DAYS: int = 30  # Длительность подписки в днях
    
    # ✅ ДОБАВЛЕНО: Validators для критически важных настроек
    @validator("HOST_URL")
    def validate_host_url(cls, v):
        if not v:
            raise ValueError("HOST_URL must be set - localhost is not supported for Robokassa!")
        if v and not v.startswith(("http://", "https://")):
            raise ValueError("HOST_URL must start with http:// or https://")
        if "localhost" in v or "127.0.0.1" in v:
            raise ValueError("HOST_URL cannot be localhost - Robokassa needs public access!")
        return v
    
    @validator("DATABASE_URL")
    def validate_database_url(cls, v):
        if not v and not cls.DEBUG:
            raise ValueError("DATABASE_URL must be set in production mode")
        return v
    
    @validator("ROBOKASSA_MERCHANT_LOGIN")
    def validate_robokassa_merchant(cls, v):
        if not v:
            raise ValueError("ROBOKASSA_MERCHANT_LOGIN must be set - demo values not allowed!")
        if v == "demo":
            print("⚠️ WARNING: Using demo Robokassa merchant login - this will cause errors!")
        return v
    
    @validator("ROBOKASSA_PASSWORD_1")
    def validate_robokassa_password1(cls, v):
        if not v:
            raise ValueError("ROBOKASSA_PASSWORD_1 must be set - demo values not allowed!")
        if v in ["password_1", "password1", "demo"]:
            print("⚠️ WARNING: Using demo Robokassa password 1 - this will cause errors!")
        return v
        
    @validator("ROBOKASSA_PASSWORD_2")
    def validate_robokassa_password2(cls, v):
        if not v:
            raise ValueError("ROBOKASSA_PASSWORD_2 must be set - demo values not allowed!")
        if v in ["password_2", "password2", "demo"]:
            print("⚠️ WARNING: Using demo Robokassa password 2 - this will cause errors!")
        return v
    
    class Config:
        """Pydantic settings configuration"""
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True

# Create a global settings instance
settings = Settings()
