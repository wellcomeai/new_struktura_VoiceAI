"""
Файлы, созданные агентом (PDF, таблицы xlsx).

Содержимое хранится прямо в Postgres (LargeBinary): файлы маленькие (лимит
AGENT_FILE_MAX_BYTES в services/agent_files.py), а диск Render эфемерный.
Скачивание — публичная ссылка с секретным токеном
(GET /api/agent-files/{id}/{token}/{filename}), чтобы файл можно было
отправить клиенту ссылкой в SMS. Отправка вложением в Telegram/MAX берёт байты
отсюда же.
"""

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, Index, LargeBinary
from sqlalchemy.dialects.postgresql import UUID

from backend.models.base import Base


class AgentFile(Base):
    __tablename__ = "agent_files"
    __table_args__ = (
        Index("ix_agent_files_agent_created", "agent_config_id", "created_at"),
        Index("ix_agent_files_contact", "agent_contact_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_config_id = Column(
        UUID(as_uuid=True), ForeignKey("agent_configs.id", ondelete="CASCADE"), nullable=False
    )
    # К какому контакту относится (КП конкретному клиенту); NULL — общий файл.
    agent_contact_id = Column(
        UUID(as_uuid=True), ForeignKey("agent_contacts.id", ondelete="SET NULL"), nullable=True
    )

    kind = Column(String(20), nullable=False)          # pdf / xlsx
    filename = Column(String(255), nullable=False)
    title = Column(String(255), nullable=True)
    mime_type = Column(String(100), nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    content = Column(LargeBinary, nullable=False)
    # Секрет публичной ссылки на скачивание.
    token = Column(String(64), nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self) -> dict:
        return {
            "file_id": str(self.id),
            "kind": self.kind,
            "filename": self.filename,
            "title": self.title,
            "size_bytes": self.size_bytes,
            "agent_contact_id": str(self.agent_contact_id) if self.agent_contact_id else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
