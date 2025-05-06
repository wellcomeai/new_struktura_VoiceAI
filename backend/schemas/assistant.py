"""
Assistant schemas for WellcomeAI application.
Defines schemas for assistant-related requests and responses.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Union
from datetime import datetime

class FunctionParameter(BaseModel):
    """Schema for одного параметра функции"""
    type: str
    description: Optional[str] = None

class FunctionParameters(BaseModel):
    """Schema для всех параметров функции"""
    type: str = "object"
    properties: Dict[str, FunctionParameter]
    required: Optional[List[str]] = None

class Function(BaseModel):
    """Schema для описания одной функции"""
    name: str
    description: str
    parameters: FunctionParameters

class AssistantBase(BaseModel):
    """Базовая схема ассистента с общими полями"""
    name: str = Field(..., description="Assistant name")
    description: Optional[str] = Field(None, description="Assistant description")
    system_prompt: str = Field(..., description="System prompt for the assistant")
    voice: str = Field("alloy", description="Voice for the assistant")
    language: str = Field("ru", description="Language for the assistant")
    google_sheet_id: Optional[str] = Field(None, description="Google Sheet ID for data source")
    # Здесь меняем: допускаем и список, и словарь
    functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = Field(
        None,
        description="Functions configuration (list of function dicts, or dict with enabled_functions)"
    )

    @validator('voice')
    def validate_voice(cls, v):
        """Проверяем, что голос из списка"""
        allowed_voices = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]
        if v not in allowed_voices:
            raise ValueError(f'Voice must be one of {", ".join(allowed_voices)}')
        return v

    @validator('functions', pre=True)
    def coerce_functions(cls, v):
        """
        — Если прислали словарь, оборачиваем в список.
        — Гарантируем, что дальше у нас всегда List[Dict].
        """
        if isinstance(v, dict):
            return [v]
        return v

class AssistantCreate(AssistantBase):
    """Схема для создания нового ассистента"""
    pass

class AssistantUpdate(BaseModel):
    # (аналогично AssistantBase, но все поля Optional)
    name: Optional[str] = Field(None, description="Assistant name")
    description: Optional[str] = Field(None, description="Assistant description")
    system_prompt: Optional[str] = Field(None, description="System prompt for the assistant")
    voice: Optional[str] = Field(None, description="Voice for the assistant")
    language: Optional[str] = Field(None, description="Language for the assistant")
    google_sheet_id: Optional[str] = Field(None, description="Google Sheet ID for data source")
    functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = Field(
        None,
        description="Functions configuration (list or dict)"
    )
    is_active: Optional[bool] = Field(None, description="Whether the assistant is active")
    is_public: Optional[bool] = Field(None, description="Whether the assistant is public")
    temperature: Optional[float] = Field(None, description="Temperature for generation")
    max_tokens: Optional[int] = Field(None, description="Max tokens for generation")

    @validator('voice')
    def validate_voice(cls, v):
        if v is None:
            return v
        allowed_voices = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]
        if v not in allowed_voices:
            raise ValueError(f'Voice must be one of {", ".join(allowed_voices)}')
        return v

    @validator('temperature')
    def validate_temperature(cls, v):
        if v is None:
            return v
        if v < 0 or v > 1:
            raise ValueError('Temperature must be between 0 and 1')
        return v

class AssistantResponse(AssistantBase):
    """Схема ответа от API с полным описанием ассистента"""
    id: str = Field(..., description="Assistant ID")
    user_id: str = Field(..., description="User ID")
    is_active: bool = Field(..., description="Whether the assistant is active")
    is_public: bool = Field(False, description="Whether the assistant is public")
    created_at: datetime = Field(..., description="Assistant creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Assistant update timestamp")
    total_conversations: Optional[int] = Field(None, description="Total number of conversations")
    temperature: Optional[float] = Field(0.7, description="Temperature for generation")
    max_tokens: Optional[int] = Field(500, description="Max tokens for generation")

    class Config:
        orm_mode = True  # чтобы можно было отдавать ORM-объекты напрямую

class EmbedCodeResponse(BaseModel):
    """Схема для кода вставки виджета"""
    embed_code: str = Field(..., description="HTML code for embedding the assistant")
    assistant_id: str = Field(..., description="Assistant ID")
