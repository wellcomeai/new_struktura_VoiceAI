"""
User model for WellcomeAI application.
Represents a user with authentication and profile information.
"""

import uuid
from sqlalchemy import Column, String, Boolean, JSON, DateTime, Integer, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .base import Base, BaseModel

class User(Base, BaseModel):
    """
    User model representing application users.
    """
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    company_name = Column(String, nullable=True)
    openai_api_key = Column(String, nullable=True)
    subscription_plan = Column(String, default="free")
    usage_tokens = Column(Integer, default=0)
    last_login = Column(DateTime(timezone=True), nullable=True)
    google_sheets_token = Column(JSON, nullable=True)
    google_sheets_authorized = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    assistants = relationship("AssistantConfig", back_populates="user", cascade="all, delete-orphan")
    files = relationship("File", back_populates="user", cascade="all, delete-orphan")

    def __repr__(self):
        """String representation of User"""
        return f"<User {self.email}>"
    
    @property
    def full_name(self):
        """Get user's full name"""
        parts = []
        if self.first_name:
            parts.append(self.first_name)
        if self.last_name:
            parts.append(self.last_name)
        return " ".join(parts) if parts else None
    
    def to_dict(self):
        """Convert to dictionary, excluding sensitive fields"""
        data = super().to_dict()
        # Remove sensitive data
        data.pop("password_hash", None)
        data.pop("openai_api_key", None)
        data.pop("google_sheets_token", None)
        
        # Convert UUID to string for JSON serialization
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
            
        return data
    
    def has_api_key(self):
        """Check if user has OpenAI API key configured"""
        return bool(self.openai_api_key)
