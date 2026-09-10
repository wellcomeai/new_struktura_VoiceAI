"""
Аренда тестового номера телефонии.

Тестовые номера — обычные купленные номера Voximplant из дочернего аккаунта
администратора, помеченные флагом voximplant_phone_numbers.is_test_pool.
Пользователь один раз может «включить» свободный тестовый номер на
TEST_NUMBER_LEASE_MINUTES минут: к номеру привязывается его голосовой
ассистент, номер на это время выбывает из пула, доступны только входящие
звонки. По истечении срока (или по кнопке «Отключить») привязка снимается
и номер возвращается в пул.

Одна запись = одна попытка. Активная аренда: released_at IS NULL и
expires_at > now().
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, String, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from backend.models.base import Base, BaseModel


class TestNumberLease(Base, BaseModel):
    __tablename__ = "test_number_leases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Кто арендовал. Одна попытка на пользователя — контролируется сервисом
    # (запись остаётся после освобождения как «использовал»).
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Какой номер из пула выдан. При удалении номера аренда остаётся
    # (пользователь всё равно уже использовал попытку).
    phone_number_id = Column(
        UUID(as_uuid=True),
        ForeignKey("voximplant_phone_numbers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Копия номера в E.164 — чтобы показывать историю даже после удаления номера
    phone_number = Column(String(20), nullable=True)

    # Голосовой ассистент пользователя, который отвечал на звонки
    assistant_type = Column(String(20), nullable=False)
    assistant_id = Column(UUID(as_uuid=True), nullable=False)
    assistant_name = Column(String(255), nullable=True)

    started_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    # Когда фактически освобождён (досрочно или планировщиком по истечении)
    released_at = Column(DateTime(timezone=True), nullable=True)
    # 'expired' | 'user' | 'admin'
    release_reason = Column(String(20), nullable=True)

    user = relationship("User")
    phone = relationship("VoximplantPhoneNumber")

    __table_args__ = (
        Index("idx_test_lease_active", "phone_number_id", "released_at"),
    )

    # ------------------------------------------------------------------

    @property
    def is_active(self) -> bool:
        if self.released_at is not None:
            return False
        exp = self.expires_at
        if exp is None:
            return False
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return exp > datetime.now(timezone.utc)

    @property
    def seconds_left(self) -> int:
        if not self.is_active:
            return 0
        exp = self.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return max(0, int((exp - datetime.now(timezone.utc)).total_seconds()))

    def to_dict(self):
        data = super().to_dict()
        for k in ("id", "user_id", "phone_number_id", "assistant_id"):
            if isinstance(data.get(k), uuid.UUID):
                data[k] = str(data[k])
        data["is_active"] = self.is_active
        data["seconds_left"] = self.seconds_left
        return data

    def __repr__(self):
        return f"<TestNumberLease {self.phone_number} user={self.user_id} exp={self.expires_at}>"
