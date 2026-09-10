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

Дополнительные попытки выдаёт админ (TestNumberGrant): базовая попытка
одна на пользователя, каждый грант добавляет ещё одну со своей
длительностью. Грант «сгорает» (lease_id заполняется), когда пользователь
включает номер за счёт этого гранта.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, String, DateTime, ForeignKey, Index, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from backend.models.base import Base, BaseModel


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


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
    def duration_seconds(self) -> int:
        st, exp = _aware(self.started_at), _aware(self.expires_at)
        if not st or not exp:
            return 0
        return max(0, int((exp - st).total_seconds()))

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
        data["duration_seconds"] = self.duration_seconds
        return data

    def __repr__(self):
        return f"<TestNumberLease {self.phone_number} user={self.user_id} exp={self.expires_at}>"


class TestNumberGrant(Base, BaseModel):
    """
    Дополнительная попытка тестового номера, выданная администратором.

    Пока lease_id пуст — попытка не использована и учитывается в лимите
    пользователя. При включении номера сервис берёт самый старый
    неиспользованный грант, его minutes определяют длительность аренды.
    """
    __tablename__ = "test_number_grants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Длительность аренды по этому гранту, минут
    minutes = Column(Integer, nullable=False, default=10)
    granted_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # Какой арендой грант использован (None — ещё доступен)
    lease_id = Column(UUID(as_uuid=True), ForeignKey("test_number_leases.id", ondelete="SET NULL"), nullable=True)
    used_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User", foreign_keys=[user_id])
    granted_by = relationship("User", foreign_keys=[granted_by_id])
    lease = relationship("TestNumberLease", foreign_keys=[lease_id])

    @property
    def is_used(self) -> bool:
        return self.lease_id is not None

    def to_dict(self):
        data = super().to_dict()
        for k in ("id", "user_id", "granted_by_id", "lease_id"):
            if isinstance(data.get(k), uuid.UUID):
                data[k] = str(data[k])
        data["is_used"] = self.is_used
        return data

    def __repr__(self):
        return f"<TestNumberGrant user={self.user_id} {self.minutes}min used={self.is_used}>"
