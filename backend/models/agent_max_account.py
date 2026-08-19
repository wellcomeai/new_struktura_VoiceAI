"""
Личный аккаунт мессенджера MAX (max.ru) агента — коннектор MAX (PyMax).

Зеркалит коннектор личного Telegram (agent_telegram_account.py): личный аккаунт
владельца, с которого агент пишет клиентам и отвечает на входящие сообщения.
Работает через реверснутую библиотеку PyMax (pip: maxapi-python) — официального
userbot-API у MAX нет.

Три таблицы:
- AgentMaxAccount — одна строка = один личный аккаунт MAX, привязанный к агенту.
  Сессия PyMax (token + device_id + sync-маркеры) сериализуется в JSON и
  шифруется Fernet-ключом MAX_SESSION_KEY (сессия = полный доступ к аккаунту,
  в открытом виде не храним; файловых SQLite-сессий нет — ФС Render эфемерная,
  вместо них кастомный StoreProtocol поверх этой колонки).
- AgentMaxDialog — состояние по каждому личному диалогу: какая последняя
  временная метка сообщения обработана поллером и с каким AgentContact связан
  peer. Маркер — время сообщения (unix ms), а не id: у MAX монотонность id в
  чате не гарантирована документацией протокола.
- AgentMaxMessage — переписка (вход/исход) для карточки контакта и контекста
  оркестратора; аналог agent_telegram_messages для канала MAX.

Авторизация — SMS-код (телефон → код → пароль 2FA при наличии). В отличие от
Telethon, у PyMax auth-flow живёт внутри client.start(), поэтому шаги вводятся
через транзитные колонки sms_code/password_2fa: фоновая задача авторизации
(max_user_service.run_auth) ждёт их появления и продолжает флоу.
"""

import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Boolean, DateTime, Text, ForeignKey, BigInteger,
    UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from .base import Base


class AgentMaxAccount(Base):
    """
    status:
      pending_code     — авторизация запущена, ждём SMS-код
      pending_password — код принят, аккаунт с 2FA, ждём пароль
      connected        — авторизован, сессия рабочая
      error            — сессия отозвана/протухла/авторизация сорвалась
    reply_scope:
      contacts — автоответ только диалогам, привязанным к контактам агента
      all      — автоответ всем новым личным диалогам (создаём контакт)
    """
    __tablename__ = "agent_max_accounts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_config_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_configs.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    phone = Column(String(32), nullable=True)
    # JSON SessionInfo PyMax (token/device_id/phone/mt_instance_id/sync),
    # зашифрованный Fernet (MAX_SESSION_KEY)
    session_encrypted = Column(Text, nullable=True)
    status = Column(String(20), default="pending_code", nullable=False)

    # Транзитные поля шагов авторизации: UI кладёт значение, фоновая задача
    # авторизации забирает и очищает. Живут секунды.
    sms_code = Column(String(16), nullable=True)
    password_2fa = Column(String(256), nullable=True)
    auth_started_at = Column(DateTime, nullable=True)

    # Кто подключён (для UI «Подключён как …»)
    max_user_id = Column(BigInteger, nullable=True)
    max_name = Column(String(128), nullable=True)

    # Автоответ поллера на входящие личные сообщения
    auto_reply_enabled = Column(Boolean, default=False, nullable=False)
    reply_scope = Column(String(16), default="contacts", nullable=False)

    # Атомарный claim поллера при нескольких gunicorn-воркерах:
    # UPDATE ... SET last_poll_at=now() WHERE last_poll_at < cutoff
    last_poll_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    agent_config = relationship("AgentConfig", foreign_keys=[agent_config_id])
    dialogs = relationship(
        "AgentMaxDialog", back_populates="account", cascade="all, delete-orphan"
    )

    def is_connected(self) -> bool:
        return self.status == "connected" and bool(self.session_encrypted)

    def to_dict(self) -> dict:
        phone_masked = None
        if self.phone:
            tail = self.phone[-4:]
            phone_masked = f"{self.phone[:2]}•••{tail}" if len(self.phone) > 6 else f"•••{tail}"
        return {
            "status": self.status,
            "phone_masked": phone_masked,
            "max_name": self.max_name,
            "auto_reply_enabled": bool(self.auto_reply_enabled),
            "reply_scope": self.reply_scope or "contacts",
            "last_error": self.last_error,
        }


class AgentMaxDialog(Base):
    """Состояние личного диалога MAX: baseline поллера + связь peer ↔ AgentContact."""
    __tablename__ = "agent_max_dialogs"
    __table_args__ = (
        UniqueConstraint("account_id", "max_chat_id", name="uq_agent_max_dialog_chat"),
        Index("ix_agent_max_dialogs_contact", "agent_contact_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_max_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_contact_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_contacts.id", ondelete="SET NULL"),
        nullable=True,
    )

    # ID личного чата и собеседника в MAX (int из протокола)
    max_chat_id = Column(BigInteger, nullable=False)
    max_peer_id = Column(BigInteger, nullable=True)
    max_name = Column(String(255), nullable=True)

    # Последняя обработанная поллером временная метка сообщения (unix ms).
    # Baseline при подключении — время top-сообщения, чтобы не отвечать на
    # старую переписку.
    last_processed_msg_time = Column(BigInteger, default=0, nullable=False)

    # Как появился диалог: baseline (снимок при подключении) / inbound (клиент
    # написал сам) / send_phone (агент написал первым по номеру — по нему
    # считается почасовой лимит резолвов, анти-бан) / send_dialog.
    created_via = Column(String(16), default="baseline", nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    account = relationship("AgentMaxAccount", back_populates="dialogs")
    contact = relationship("AgentContact", foreign_keys=[agent_contact_id])


class AgentMaxMessage(Base):
    """
    Сообщение личной MAX-переписки (direction: inbound/outbound).
    Используется карточкой контакта (тред), оркестратором (контекст-блок)
    и единой хронологией build_conversation_timeline.
    """
    __tablename__ = "agent_max_messages"
    __table_args__ = (
        Index("ix_agent_max_messages_contact", "agent_contact_id"),
        Index("ix_agent_max_messages_account", "account_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # SET NULL: при отключении/переподключении аккаунта переписка с контактами
    # должна сохраняться (тред живёт по agent_contact_id).
    account_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_max_accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    agent_contact_id = Column(
        UUID(as_uuid=True),
        ForeignKey("agent_contacts.id", ondelete="CASCADE"),
        nullable=True,
    )

    max_chat_id = Column(BigInteger, nullable=True)
    max_message_id = Column(BigInteger, nullable=True)
    direction = Column(String(10), default="inbound", nullable=False)
    body = Column(Text, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "direction": self.direction or "inbound",
            "body": self.body,
            "ts": self.created_at.isoformat() if self.created_at else None,
        }
