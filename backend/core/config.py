# backend/core/config.py

"""
Configuration settings for the WellcomeAI application.
ОБНОВЛЕНО: Добавлены настройки Email для верификации
✅ ОБНОВЛЕНО v3.0: Добавлены настройки Voximplant Partner Integration
✅ ОБНОВЛЕНО v3.3: Добавлены настройки Cloudflare R2 Storage
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
    AVAILABLE_VOICES: list = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "onyx", "nova", "fable", "marin", "cedar"]
    
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
    
    # ✅ НОВОЕ: Email settings для верификации
    EMAIL_FROM: str = os.getenv("EMAIL_FROM", "voicyfy@mail.ru")
    EMAIL_HOST: str = os.getenv("EMAIL_HOST", "smtp.mail.ru")
    EMAIL_PORT: int = int(os.getenv("EMAIL_PORT", "465"))
    EMAIL_USERNAME: str = os.getenv("EMAIL_USERNAME", "voicyfy@mail.ru")
    EMAIL_PASSWORD: str = os.getenv("EMAIL_PASSWORD", "")
    EMAIL_USE_SSL: bool = os.getenv("EMAIL_USE_SSL", "True") == "True"
    EMAIL_USE_TLS: bool = os.getenv("EMAIL_USE_TLS", "False") == "True"
    
    # ✅ НОВОЕ: Email verification settings
    VERIFICATION_CODE_LENGTH: int = 6
    VERIFICATION_CODE_EXPIRY_MINUTES: int = 10
    VERIFICATION_MAX_ATTEMPTS: int = 3
    VERIFICATION_RESEND_COOLDOWN_SECONDS: int = 60
    
    # =========================================================================
    # ✅ НОВОЕ v3.0: Voximplant Partner Integration
    # =========================================================================
    
    # Credentials родительского аккаунта (для создания дочерних)
    VOXIMPLANT_PARENT_ACCOUNT_ID: str = os.getenv("VOXIMPLANT_PARENT_ACCOUNT_ID", "")
    VOXIMPLANT_PARENT_API_KEY: str = os.getenv("VOXIMPLANT_PARENT_API_KEY", "")
    
    # ID эталонного аккаунта для клонирования (опционально)
    # Создай его вручную в Voximplant, настрой приложение и сценарии,
    # затем укажи здесь ID для автоматического клонирования
    VOXIMPLANT_TEMPLATE_ACCOUNT_ID: Optional[str] = os.getenv("VOXIMPLANT_TEMPLATE_ACCOUNT_ID")
    
    # =========================================================================
    # ✅ НОВОЕ v3.3: Cloudflare R2 Storage для записей звонков
    # =========================================================================
    
    R2_ACCESS_KEY: str = os.getenv("R2_ACCESS_KEY", "")
    R2_SECRET_KEY: str = os.getenv("R2_SECRET_KEY", "")
    R2_ENDPOINT: str = os.getenv("R2_ENDPOINT", "")
    R2_BUCKET: str = os.getenv("R2_BUCKET", "voicyfy")
    R2_PUBLIC_URL: str = os.getenv("R2_PUBLIC_URL", "")
    
    # =========================================================================
    
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
    
    @validator("EMAIL_PASSWORD")
    def validate_email_password(cls, v):
        """Проверяем, что EMAIL_PASSWORD задан"""
        if not v:
            print("⚠️ WARNING: EMAIL_PASSWORD is not set - email verification will not work!")
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
    
    # ✅ НОВЫЙ validator для Voximplant Partner Integration
    @validator("VOXIMPLANT_PARENT_API_KEY")
    def validate_voximplant_config(cls, v, values):
        """Проверяем конфигурацию Voximplant Partner"""
        account_id = values.get('VOXIMPLANT_PARENT_ACCOUNT_ID')
        
        if account_id and not v:
            print("⚠️ WARNING: VOXIMPLANT_PARENT_ACCOUNT_ID is set but VOXIMPLANT_PARENT_API_KEY is missing!")
        
        if v and not account_id:
            print("⚠️ WARNING: VOXIMPLANT_PARENT_API_KEY is set but VOXIMPLANT_PARENT_ACCOUNT_ID is missing!")
        
        if account_id and v:
            print(f"✅ Voximplant Partner configured: Account ID {account_id}")
        
        return v
    
    # ✅ НОВОЕ v3.3: Validator для Cloudflare R2
    @validator("R2_PUBLIC_URL")
    def validate_r2_config(cls, v, values):
        """Проверяем конфигурацию R2"""
        access_key = values.get('R2_ACCESS_KEY')
        secret_key = values.get('R2_SECRET_KEY')
        endpoint = values.get('R2_ENDPOINT')
        bucket = values.get('R2_BUCKET')
        
        if access_key and secret_key and endpoint:
            if v:
                print(f"✅ Cloudflare R2 configured: {bucket}")
            else:
                print("⚠️ WARNING: R2 credentials set but R2_PUBLIC_URL is missing!")
        else:
            if any([access_key, secret_key, endpoint, v]):
                print("⚠️ WARNING: Partial R2 configuration - recordings will not be saved!")
            # Не выводим предупреждение если R2 полностью не настроен - это опционально
        
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
    
    # Проверяем Email настройки
    if settings.EMAIL_PASSWORD:
        print(f"📧 Email configured: {settings.EMAIL_FROM} via {settings.EMAIL_HOST}:{settings.EMAIL_PORT}")
    else:
        print("⚠️ Email not configured - verification emails will not work")
    
    # ✅ Проверяем Voximplant Partner настройки
    if settings.VOXIMPLANT_PARENT_ACCOUNT_ID and settings.VOXIMPLANT_PARENT_API_KEY:
        print(f"📞 Voximplant Partner configured: Account {settings.VOXIMPLANT_PARENT_ACCOUNT_ID}")
        if settings.VOXIMPLANT_TEMPLATE_ACCOUNT_ID:
            print(f"   Template account: {settings.VOXIMPLANT_TEMPLATE_ACCOUNT_ID}")
        else:
            print("   ⚠️ No template account - will create empty child accounts")
    else:
        print("ℹ️  Voximplant Partner not configured - telephony features disabled")
    
    # ✅ НОВОЕ v3.3: Проверяем R2 настройки
    if settings.R2_ACCESS_KEY and settings.R2_SECRET_KEY and settings.R2_ENDPOINT:
        print(f"💾 R2 Storage configured: {settings.R2_BUCKET}")
        if settings.R2_PUBLIC_URL:
            print(f"   Public URL: {settings.R2_PUBLIC_URL}")
        else:
            print("   ⚠️ R2_PUBLIC_URL not set - recordings won't be publicly accessible")
    else:
        print("ℹ️  R2 Storage not configured - call recordings will use temporary Voximplant URLs")
        
except Exception as e:
    print(f"❌ Configuration error: {str(e)}")
    print("Please check your .env file and fix the configuration issues.")
    raise
