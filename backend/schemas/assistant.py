"""
Assistant schemas for WellcomeAI application.
Defines schemas for assistant-related requests and responses.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Union
from datetime import datetime

# Голоса OpenAI-ассистента = встроенные голоса gpt-live-1 (session.audio.output.voice
# в справочнике Live API). Первые десять есть и в Realtime, двенадцать после них —
# только в GPT-Live: сейчас это входящие звонки, исходящие и виджет пока на Realtime.
OPENAI_REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]
OPENAI_LIVE_ONLY_VOICES = ["beacon", "bossa", "cinder", "delta", "gleam", "meridian",
                           "quartz", "ripple", "stone", "tempo", "vesper", "willow"]
OPENAI_VOICES = OPENAI_REALTIME_VOICES + OPENAI_LIVE_ONLY_VOICES

class FunctionParameter(BaseModel):
    """Schema for function parameter"""
    type: str
    description: Optional[str] = None

class FunctionParameters(BaseModel):
    """Schema for function parameters"""
    type: str = "object"
    properties: Dict[str, FunctionParameter]
    required: Optional[List[str]] = None

class Function(BaseModel):
    """Schema for assistant function"""
    name: str
    description: str
    parameters: FunctionParameters

class AssistantBase(BaseModel):
    """Base schema with common assistant attributes"""
    name: str = Field(..., description="Assistant name")
    description: Optional[str] = Field(None, description="Assistant description")
    system_prompt: str = Field(..., description="System prompt for the assistant")
    voice: str = Field("alloy", description="Voice for the assistant")
    language: str = Field("ru", description="Language for the assistant")
    google_sheet_id: Optional[str] = Field(None, description="Google Sheet ID for data source")
    greeting_message: Optional[str] = Field("Здравствуйте! Чем я могу вам помочь?", description="Приветственное сообщение ассистента")  # ✅ НОВОЕ ПОЛЕ
    enable_vision: bool = Field(False, description="Enable Vision AI screen analysis")
    functions: Optional[List[Dict[str, Any]]] = Field(None, description="Functions for the assistant")
    
    @validator('voice')
    def validate_voice(cls, v):
        """Validate voice is one of the supported voices"""
        if v not in OPENAI_VOICES:
            raise ValueError(f'Voice must be one of {", ".join(OPENAI_VOICES)}')
        return v

class AssistantCreate(AssistantBase):
    """Schema for creating a new assistant"""
    pass

class AssistantUpdate(BaseModel):
    """Schema for updating assistant information"""
    name: Optional[str] = Field(None, description="Assistant name")
    description: Optional[str] = Field(None, description="Assistant description")
    system_prompt: Optional[str] = Field(None, description="System prompt for the assistant")
    voice: Optional[str] = Field(None, description="Voice for the assistant")
    language: Optional[str] = Field(None, description="Language for the assistant")
    google_sheet_id: Optional[str] = Field(None, description="Google Sheet ID for data source")
    greeting_message: Optional[str] = Field(None, description="Приветственное сообщение ассистента")  # ✅ НОВОЕ ПОЛЕ
    enable_vision: Optional[bool] = Field(None, description="Enable Vision AI screen analysis")
    functions: Optional[List[Dict[str, Any]]] = Field(None, description="Functions for the assistant")
    is_active: Optional[bool] = Field(None, description="Whether the assistant is active")
    is_public: Optional[bool] = Field(None, description="Whether the assistant is public")
    temperature: Optional[float] = Field(None, description="Temperature for generation")
    max_tokens: Optional[int] = Field(None, description="Max tokens for generation")
    
    @validator('voice')
    def validate_voice(cls, v):
        """Validate voice is one of the supported voices"""
        if v is None:
            return v
        if v not in OPENAI_VOICES:
            raise ValueError(f'Voice must be one of {", ".join(OPENAI_VOICES)}')
        return v
    
    @validator('temperature')
    def validate_temperature(cls, v):
        """Validate temperature is between 0 and 1"""
        if v is None:
            return v
        if v < 0 or v > 1:
            raise ValueError('Temperature must be between 0 and 1')
        return v

class AssistantResponse(AssistantBase):
    """Schema for assistant response"""
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
        orm_mode = True  # Allow conversion from ORM models

class EmbedCodeResponse(BaseModel):
    """Schema for embed code response"""
    embed_code: str = Field(..., description="HTML code for embedding the assistant")
    assistant_id: str = Field(..., description="Assistant ID")
