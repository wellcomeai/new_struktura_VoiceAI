"""
ElevenLabs models for WellcomeAI application.
"""

import uuid
from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from backend.models.base import Base

class ElevenLabsAgent(Base):
    """
    ElevenLabs voice agent configuration.
    """
    __tablename__ = "elevenlabs_agents"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    elevenlabs_agent_id = Column(String, nullable=True)  # ID агента в ElevenLabs
    name = Column(String, nullable=False)
    system_prompt = Column(Text, nullable=True)
    voice_id = Column(String, nullable=False)  # ID голоса из ElevenLabs
    voice_name = Column(String, nullable=True)  # Название голоса для удобства
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationship with User
    user = relationship("User", back_populates="elevenlabs_agents")

class ElevenLabsConversation(Base):
    """
    ElevenLabs conversation log.
    """
    __tablename__ = "elevenlabs_conversations"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("elevenlabs_agents.id", ondelete="CASCADE"), nullable=False)
    elevenlabs_conversation_id = Column(String, nullable=True)  # ID разговора в ElevenLabs
    user_message = Column(Text, nullable=True)
    agent_response = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    
    # Relationship with ElevenLabsAgent
    agent = relationship("ElevenLabsAgent")
