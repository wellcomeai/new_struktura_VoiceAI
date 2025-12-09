import uuid
from sqlalchemy import Column, String, Float, JSON, ForeignKey, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from backend.models.base import Base, BaseModel

class FunctionLog(Base, BaseModel):
    """Модель для логирования вызовов функций"""
    __tablename__ = "function_logs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    assistant_id = Column(UUID(as_uuid=True), ForeignKey("assistant_configs.id", ondelete="CASCADE"), nullable=True)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True)
    
    function_name = Column(String, nullable=False)
    function_version = Column(String, nullable=True)
    arguments = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)
    
    execution_time_ms = Column(Float, nullable=True)
    status = Column(String, nullable=False)  # success, error, timeout
    error_message = Column(Text, nullable=True)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # Связи будут добавлены при импорте моделей
