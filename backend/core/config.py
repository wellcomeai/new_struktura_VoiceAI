"""
Configuration settings for the WellcomeAI application.
Handles environment variables and default configuration.
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
    
    # Audio settings
    DEFAULT_VOICE: str = "alloy"
    AVAILABLE_VOICES: list = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]
    
    # Path settings
    STATIC_DIR: str = os.path.join(os.getcwd(), "static")
    TEMPLATE_DIR: str = os.path.join(os.getcwd(), "templates")
    
    # CORS Settings
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")
    
    # Validators
    @validator("DATABASE_URL")
    def validate_database_url(cls, v):
        if not v and not cls.DEBUG:
            raise ValueError("DATABASE_URL must be set in production mode")
        return v
    
    class Config:
        """Pydantic settings configuration"""
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True

# Create a global settings instance
settings = Settings()
