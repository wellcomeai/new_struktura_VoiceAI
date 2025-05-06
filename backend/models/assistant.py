"""
Assistant model for WellcomeAI application.
Represents a virtual assistant configuration with customizable settings.
"""

import uuid
from sqlalchemy import Column, String, Boolean, JSON, ForeignKey, DateTime, Text, Integer
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy import Float

from .base import Base, BaseModel

class AssistantConfig(Base, BaseModel):
    """
    AssistantConfig model representing virtual assistant configurations.
    """
    __tablename__ = "assistant_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    system_prompt = Column(Text, nullable=False)
    voice = Column(String, default="alloy")
    language = Column(String, default="ru")
    google_sheet_id = Column(String, nullable=True)
    functions = Column(JSON, nullable=True)
    integrations = relationship("Integration", back_populates="assistant", cascade="all, delete-orphan")
    api_access_token = Column(String, nullable=True, default=None)
    is_active = Column(Boolean, default=True)
    is_public = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    total_conversations = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    
    # Special settings
    temperature = Column(Float, default=0.7)
    max_tokens = Column(Integer, default=500)
    allowed_domains = Column(ARRAY(String), nullable=True)  # Domains allowed to use this assistant

    # Relationships
    user = relationship("User", back_populates="assistants")
    conversations = relationship("Conversation", back_populates="assistant", cascade="all, delete-orphan")
    files = relationship("File", back_populates="assistant", cascade="all, delete-orphan")

    def __repr__(self):
        """String representation of AssistantConfig"""
        return f"<AssistantConfig {self.name} (id={self.id})>"
    
    def to_dict(self):
        """Convert to dictionary with string ID"""
        data = super().to_dict()
        # Convert UUID to string for JSON serialization
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
        if isinstance(data.get("user_id"), uuid.UUID):
            data["user_id"] = str(data["user_id"])
            
        return data
    
    def increment_conversations(self, db_session):
        """Increment the total conversations counter"""
        self.total_conversations += 1
        db_session.commit()
    
    def add_tokens(self, token_count, db_session):
        """Add tokens to the total token count"""
        self.total_tokens += token_count
        db_session.commit()
