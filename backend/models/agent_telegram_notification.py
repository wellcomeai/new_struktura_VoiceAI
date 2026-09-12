"""
AgentTelegramNotification — журнал уведомлений, отправленных ботом агента
владельцу/менеджерам (тулза send_telegram_notification).

Нужен, чтобы при ответе владельца на уведомление (Telegram reply_to_message)
восстановить контекст: о каком звонке / контакте шла речь и что именно было
в уведомлении. Без этого ChatOrchestrator видел только текст ответа.
"""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, BigInteger, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from .base import Base


class AgentTelegramNotification(Base):
    __tablename__ = "agent_telegram_notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_config_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_configs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Куда и каким сообщением ушло уведомление (для поиска по reply_to_message)
    chat_id = Column(String(50), nullable=False)
    message_id = Column(BigInteger, nullable=False)

    # Привязка к событию, породившему уведомление (могут быть пустыми —
    # например, уведомление из веб-чата без конкретного звонка)
    agent_call_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_calls.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    agent_contact_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_contacts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Откуда пришло: outbound / inbound / sms_inbound / telegram_inbound / chat …
    source = Column(String(30), nullable=True)
    # Исходный текст уведомления (Markdown модели, до конвертации в HTML)
    text = Column(Text, nullable=False)

    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    agent_config = relationship("AgentConfig", foreign_keys=[agent_config_id])
    agent_call = relationship("AgentCall", foreign_keys=[agent_call_id])
    agent_contact = relationship("AgentContact", foreign_keys=[agent_contact_id])

    __table_args__ = (
        Index("idx_agent_tg_notif_lookup", "agent_config_id", "chat_id", "message_id"),
    )

    def __repr__(self):
        return f"<AgentTelegramNotification chat={self.chat_id} msg={self.message_id} call={self.agent_call_id}>"
