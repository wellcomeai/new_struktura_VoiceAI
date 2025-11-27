# backend/models/contact.py
"""
Contact model для CRM функциональности.
Хранит информацию о контактах (клиентах) с их телефонами и именами.
"""

from sqlalchemy import Column, String, DateTime, Text, ForeignKey, Index, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from .base import Base


class Contact(Base):
    """
    Контакт (клиент) в CRM системе.
    Автоматически создается при первом звонке с нового номера.
    Связан с диалогами через Conversation.contact_id
    """
    __tablename__ = "contacts"
    
    # Основные поля
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    
    # Информация о контакте
    phone = Column(String(50), nullable=False, index=True)  # +79123456789
    name = Column(String(255), nullable=True)  # "Иван Петров" - задается вручную
    
    # Статус контакта
    status = Column(
        String(50), 
        default="new",
        nullable=False
    )  # new, active, client, archived
    
    # Заметки
    notes = Column(Text, nullable=True)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    last_interaction = Column(DateTime, nullable=True)  # дата последнего диалога (обновляется автоматически)
    
    # Relationships
    user = relationship("User", backref="contacts")
    conversations = relationship("Conversation", back_populates="contact", cascade="all, delete-orphan")
    
    # Уникальность: один номер телефона у одного пользователя
    __table_args__ = (
        UniqueConstraint('user_id', 'phone', name='uq_user_phone'),
        Index('ix_contacts_user_phone', 'user_id', 'phone'),
        Index('ix_contacts_status', 'status'),
        Index('ix_contacts_last_interaction', 'last_interaction'),
    )
    
    def __repr__(self):
        return f"<Contact {self.name or self.phone} (user_id={self.user_id})>"
    
    def to_dict(self):
        """Сериализация для API"""
        return {
            "id": str(self.id),
            "phone": self.phone,
            "name": self.name,
            "status": self.status,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "last_interaction": self.last_interaction.isoformat() if self.last_interaction else None
        }
