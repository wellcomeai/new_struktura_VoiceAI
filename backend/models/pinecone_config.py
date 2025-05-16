# backend/models/pinecone_config.py
import uuid
from sqlalchemy import Column, String, ForeignKey, DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from backend.models.base import Base

class PineconeConfig(Base):
    """
    Configuration for Pinecone knowledge base connections.
    """
    __tablename__ = "pinecone_configs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)  # изменено на nullable=True
    assistant_id = Column(UUID(as_uuid=True), ForeignKey("assistant_configs.id", ondelete="CASCADE"), nullable=True)
    namespace = Column(String, nullable=False)
    char_count = Column(Integer, default=0)
    content_preview = Column(Text, nullable=True)  # первые 100-200 символов для предпросмотра
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)
    
    # Обратная связь с ассистентом (опционально)
    assistant = relationship("AssistantConfig", back_populates="pinecone_config", foreign_keys=[assistant_id])
    # Добавляем связь с пользователем
    user = relationship("User", foreign_keys=[user_id])
