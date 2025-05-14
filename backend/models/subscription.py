"""
Subscription plan model for WellcomeAI application.
"""

import uuid
from sqlalchemy import Column, String, Boolean, Numeric, Integer, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from .base import Base, BaseModel

class SubscriptionPlan(Base, BaseModel):
    """
    Model representing subscription plans.
    """
    __tablename__ = "subscription_plans"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(50), nullable=False)
    code = Column(String(20), nullable=False, unique=True)
    price = Column(Numeric(10, 2), nullable=False)
    max_assistants = Column(Integer, nullable=False)
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    def __repr__(self):
        """String representation of SubscriptionPlan"""
        return f"<SubscriptionPlan {self.name} (code={self.code})>"
