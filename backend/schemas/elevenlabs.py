"""
ElevenLabs schemas for WellcomeAI application.
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class ElevenLabsApiKeyRequest(BaseModel):
    """Schema for ElevenLabs API key request"""
    api_key: str = Field(..., description="ElevenLabs API key")

class ElevenLabsVoiceResponse(BaseModel):
    """Schema for ElevenLabs voice response"""
    voice_id: str = Field(..., description="Voice ID")
    name: str = Field(..., description="Voice name")
    preview_url: Optional[str] = Field(None, description="Preview URL")
    category: Optional[str] = Field(None, description="Voice category")

class ElevenLabsAgentCreate(BaseModel):
    """Schema for creating ElevenLabs agent"""
    name: str = Field(..., description="Agent name")
    system_prompt: Optional[str] = Field(None, description="System prompt")
    voice_id: str = Field(..., description="Voice ID")
    voice_name: Optional[str] = Field(None, description="Voice name")
    
    # ✅ Новые поля для расширенных настроек
    first_message: Optional[str] = Field(None, description="First message from agent")
    language: Optional[str] = Field("ru", description="Agent language")
    llm_model: Optional[str] = Field("gpt-4o-mini", description="LLM model")
    llm_temperature: Optional[float] = Field(0.7, description="LLM temperature", ge=0, le=2)
    max_tokens: Optional[int] = Field(1000, description="Maximum tokens", ge=100, le=4000)
    
    # ✅ Настройки голоса
    voice_stability: Optional[float] = Field(0.5, description="Voice stability", ge=0, le=1)
    voice_similarity: Optional[float] = Field(0.8, description="Voice similarity", ge=0, le=1)
    voice_speed: Optional[float] = Field(1.0, description="Voice speed", ge=0.5, le=2.0)
    
    # ✅ Встроенные инструменты
    built_in_tools: Optional[List[str]] = Field([], description="Built-in tools")

class ElevenLabsAgentUpdate(BaseModel):
    """Schema for updating ElevenLabs agent"""
    name: Optional[str] = Field(None, description="Agent name")
    system_prompt: Optional[str] = Field(None, description="System prompt")
    voice_id: Optional[str] = Field(None, description="Voice ID")
    voice_name: Optional[str] = Field(None, description="Voice name")
    is_active: Optional[bool] = Field(None, description="Whether agent is active")
    
    # ✅ Новые поля для расширенных настроек
    first_message: Optional[str] = Field(None, description="First message from agent")
    language: Optional[str] = Field(None, description="Agent language")
    llm_model: Optional[str] = Field(None, description="LLM model")
    llm_temperature: Optional[float] = Field(None, description="LLM temperature", ge=0, le=2)
    max_tokens: Optional[int] = Field(None, description="Maximum tokens", ge=100, le=4000)
    
    # ✅ Настройки голоса
    voice_stability: Optional[float] = Field(None, description="Voice stability", ge=0, le=1)
    voice_similarity: Optional[float] = Field(None, description="Voice similarity", ge=0, le=1)
    voice_speed: Optional[float] = Field(None, description="Voice speed", ge=0.5, le=2.0)
    
    # ✅ Встроенные инструменты
    built_in_tools: Optional[List[str]] = Field(None, description="Built-in tools")

class ElevenLabsAgentResponse(BaseModel):
    """Schema for ElevenLabs agent response"""
    id: str = Field(..., description="Agent ID")
    user_id: str = Field(..., description="User ID")
    elevenlabs_agent_id: Optional[str] = Field(None, description="ElevenLabs agent ID")
    name: str = Field(..., description="Agent name")
    system_prompt: Optional[str] = Field(None, description="System prompt")
    voice_id: str = Field(..., description="Voice ID")
    voice_name: Optional[str] = Field(None, description="Voice name")
    is_active: bool = Field(..., description="Whether agent is active")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Update timestamp")
    
    # ✅ Новые поля для расширенных настроек
    first_message: Optional[str] = Field(None, description="First message from agent")
    language: Optional[str] = Field(None, description="Agent language")
    llm_model: Optional[str] = Field(None, description="LLM model")
    llm_temperature: Optional[float] = Field(None, description="LLM temperature")
    max_tokens: Optional[int] = Field(None, description="Maximum tokens")
    
    # ✅ Настройки голоса
    voice_stability: Optional[float] = Field(None, description="Voice stability")
    voice_similarity: Optional[float] = Field(None, description="Voice similarity")
    voice_speed: Optional[float] = Field(None, description="Voice speed")
    
    # ✅ Встроенные инструменты
    built_in_tools: Optional[List[str]] = Field(None, description="Built-in tools")

    class Config:
        orm_mode = True

class ElevenLabsEmbedResponse(BaseModel):
    """Schema for ElevenLabs embed code response"""
    embed_code: str = Field(..., description="HTML embed code")
    agent_id: str = Field(..., description="Agent ID")
