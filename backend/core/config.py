# backend/core/config.py

"""
Configuration settings for the WellcomeAI application.
ИСПРАВЛЕННАЯ ВЕРСИЯ - добавлены правильные валидаторы для Robokassa
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
    
    # ✅ ИСПРАВЛЕНО: Robokassa settings - СТРОГИЕ требования
    ROBOKASSA_MERCHANT_LOGIN: str = os.getenv("ROBOKASSA_MERCHANT_LOGIN", "")
    ROBOKASSA_PASSWORD_1: str = os.getenv("ROBOKASSA_PASSWORD_1", "")  
    ROBOKASSA_PASSWORD_2: str = os.getenv("ROBOKASSA_PASSWORD_2", "")
    ROBOKASSA_TEST_MODE: bool = os.getenv("ROBOKASSA_TEST_MODE", "True") == "True"
    
    # ✅ ИСПРАВЛЕНО: Payment settings
    SUBSCRIPTION_PRICE: float = 1490.0  # Цена подписки в рублях
    SUBSCRIPTION_DURATION_DAYS: int = 30  # Длительность подписки в днях
    
    # ✅ ИСПРАВЛЕНО: Улучшенные validators с детальными проверками
    @validator("HOST_URL")
    def validate_host_url(cls, v):
        if not v:
            raise ValueError("HOST_URL must be set - localhost is not supported for Robokassa payments!")
        
        if not v.startswith(("http://", "https://")):
            raise ValueError("HOST_URL must start with http:// or https://")
        
        # ✅ СТРОГАЯ проверка на localhost
        localhost_indicators = ["localhost", "127.0.0.1", "0.0.0.0", ".local"]
        if any(indicator in v.lower() for indicator in localhost_indicators):
            raise ValueError(
                "HOST_URL cannot be localhost or local domain - Robokassa requires public access! "
                "Use public domain like https://yourdomain.com"
            )
        
        # ✅ Проверка на правильный порт (Robokassa работает только с 80/443)
        if ":8000" in v or ":5000" in v or ":3000" in v:
            print(f"⚠️ WARNING: HOST_URL contains development port ({v}). "
                  f"Robokassa only works with ports 80/443!")
        
        return v
    
    @validator("DATABASE_URL")
    def validate_database_url(cls, v):
        if not v and not cls.__dict__.get('DEBUG', False):
            raise ValueError("DATABASE_URL must be set in production mode")
        return v
    
    @validator("ROBOKASSA_MERCHANT_LOGIN")
    def validate_robokassa_merchant(cls, v):
        if not v:
            raise ValueError(
                "ROBOKASSA_MERCHANT_LOGIN must be set! "
                "Get it from Robokassa personal cabinet -> My Shops"
            )
        
        # ✅ Проверка на демо-значения
        if v.lower() in ["demo", "test", "example", "merchant"]:
            print(f"⚠️ WARNING: Using demo Robokassa merchant login '{v}' - this will cause payment errors!")
        
        return v
    
    @validator("ROBOKASSA_PASSWORD_1")
    def validate_robokassa_password1(cls, v):
        if not v:
            raise ValueError(
                "ROBOKASSA_PASSWORD_1 must be set! "
                "Create it in Robokassa personal cabinet -> My Shops -> Technical Settings"
            )
        
        # ✅ Проверка на демо-значения и слабые пароли
        weak_passwords = ["password_1", "password1", "demo", "test", "123456", "qwerty"]
        if v.lower() in weak_passwords:
            print(f"⚠️ WARNING: Using weak/demo Robokassa password 1 - this will cause payment errors!")
        
        # ✅ Проверка требований Robokassa к паролю
        if len(v) < 8:
            raise ValueError("ROBOKASSA_PASSWORD_1 must be at least 8 characters long")
        
        if not any(c.isdigit() for c in v):
            print(f"⚠️ WARNING: ROBOKASSA_PASSWORD_1 should contain at least one digit")
        
        if not any(c.isalpha() for c in v):
            print(f"⚠️ WARNING: ROBOKASSA_PASSWORD_1 should contain at least one letter")
        
        return v
        
    @validator("ROBOKASSA_PASSWORD_2")
    def validate_robokassa_password2(cls, v):
        if not v:
            raise ValueError(
                "ROBOKASSA_PASSWORD_2 must be set! "
                "Create it in Robokassa personal cabinet -> My Shops -> Technical Settings"
            )
        
        # ✅ Проверка на демо-значения и слабые пароли
        weak_passwords = ["password_2", "password2", "demo", "test", "123456", "qwerty"]
        if v.lower() in weak_passwords:
            print(f"⚠️ WARNING: Using weak/demo Robokassa password 2 - this will cause payment errors!")
        
        # ✅ Проверка требований Robokassa к паролю
        if len(v) < 8:
            raise ValueError("ROBOKASSA_PASSWORD_2 must be at least 8 characters long")
        
        if not any(c.isdigit() for c in v):
            print(f"⚠️ WARNING: ROBOKASSA_PASSWORD_2 should contain at least one digit")
        
        if not any(c.isalpha() for c in v):
            print(f"⚠️ WARNING: ROBOKASSA_PASSWORD_2 should contain at least one letter")
        
        return v
    
    @validator("ROBOKASSA_PASSWORD_2")
    def validate_passwords_different(cls, v, values):
        """Проверяем, что пароли разные"""
        password1 = values.get('ROBOKASSA_PASSWORD_1')
        if password1 and v == password1:
            raise ValueError(
                "ROBOKASSA_PASSWORD_1 and ROBOKASSA_PASSWORD_2 must be different! "
                "Robokassa requires different passwords for initialization and notification."
            )
        return v
    
    # ✅ НОВЫЙ validator для проверки всей конфигурации Robokassa
    @validator("ROBOKASSA_TEST_MODE")
    def validate_robokassa_config(cls, v, values):
        """Финальная проверка всей конфигурации Robokassa"""
        
        # Проверяем, что все параметры заданы
        required_params = ['ROBOKASSA_MERCHANT_LOGIN', 'ROBOKASSA_PASSWORD_1', 'ROBOKASSA_PASSWORD_2', 'HOST_URL']
        missing_params = []
        
        for param in required_params:
            if not values.get(param):
                missing_params.append(param)
        
        if missing_params:
            raise ValueError(
                f"Missing required Robokassa parameters: {', '.join(missing_params)}. "
                f"Please check your .env file and Robokassa personal cabinet settings."
            )
        
        # Если тестовый режим выключен, предупреждаем
        if not v:
            print("🚀 PRODUCTION MODE: Robokassa test mode is disabled - real payments will be processed!")
        else:
            print("🧪 TEST MODE: Robokassa test mode is enabled - no real payments will be charged")
        
        return v
    
    class Config:
        """Pydantic settings configuration"""
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True

# Create a global settings instance
try:
    settings = Settings()
    print("✅ Configuration loaded successfully")
except Exception as e:
    print(f"❌ Configuration error: {str(e)}")
    print("Please check your .env file and fix the configuration issues.")
    raise
