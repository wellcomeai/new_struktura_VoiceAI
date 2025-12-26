# backend/models/conversation.py
"""
Conversation model for WellcomeAI application.
Represents chat interactions between users and assistants.
🆕 v2.0: Added caller_number field for Voximplant integration
🆕 v3.0: Added contact_id for CRM integration
"""

import uuid
from sqlalchemy import Column, String, Float, JSON, ForeignKey, DateTime, Text, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy import Boolean

from .base import Base, BaseModel

class Conversation(Base, BaseModel):
    """
    Conversation model representing chat interactions with assistants.
    🆕 v2.0: Extended with caller_number support
    🆕 v3.0: Extended with contact_id for CRM
    """
    __tablename__ = "conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistant_id = Column(UUID(as_uuid=True), ForeignKey("assistant_configs.id", ondelete="CASCADE"), nullable=False)
    contact_id = Column(UUID(as_uuid=True), ForeignKey("contacts.id", ondelete="CASCADE"), nullable=True, index=True)  # 🆕 v3.0: Link to CRM contact
    session_id = Column(String, nullable=True, index=True)  # Group related messages
    user_message = Column(Text, nullable=True)
    assistant_message = Column(Text, nullable=True)
    caller_number = Column(String(50), nullable=True, index=True)  # 🆕 v2.0: Phone number for Voximplant calls
    duration_seconds = Column(Float, nullable=True)
    client_info = Column(JSON, nullable=True)  # Browser, IP, etc.
    tokens_used = Column(Integer, default=0)  # Token usage for this conversation
    feedback_rating = Column(Integer, nullable=True)  # User feedback (1-5)
    feedback_text = Column(Text, nullable=True)  # Detailed user feedback
    is_flagged = Column(Boolean, default=False)  # Flagged for review
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    audio_duration = Column(Float, nullable=True)  # Duration of audio in seconds
    call_direction = Column(String(20), nullable=True, index=True)
    # Relationships
    assistant = relationship("AssistantConfig", back_populates="conversations")
    contact = relationship("Contact", back_populates="conversations")  # 🆕 v3.0: CRM relationship

    def __repr__(self):
        """String representation of Conversation"""
        return f"<Conversation {self.id} for assistant {self.assistant_id}>"
    
    def to_dict(self):
        """Convert to dictionary with string ID"""
        data = super().to_dict()
        # Convert UUID to string for JSON serialization
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
        if isinstance(data.get("assistant_id"), uuid.UUID):
            data["assistant_id"] = str(data["assistant_id"])
        if isinstance(data.get("contact_id"), uuid.UUID):
            data["contact_id"] = str(data["contact_id"])
            
        return data
    
    @classmethod
    def get_recent_conversations(cls, db_session, assistant_id, limit=10):
        """Get recent conversations for an assistant"""
        return db_session.query(cls).filter(
            cls.assistant_id == assistant_id
        ).order_by(cls.created_at.desc()).limit(limit).all()
