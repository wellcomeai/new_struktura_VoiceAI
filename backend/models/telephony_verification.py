"""
Верификация физлица для телефонии и телефонный кошелёк.

Voximplant больше не верифицирует физлиц, поэтому физлицо проходит нашу
проверку: анкета по паспорту РФ + скан паспорта + селфи с листом
«Верификация Voicyfy» и датой. Анкета и файлы лежат в приватном бакете
Timeweb S3 (хранение в РФ), в базе — только статус, ключи объектов и решение
проверяющего. Проверяет админ в Telegram-боте или в разделе «Телефония».

После одобрения пользователь покупает номера на дочернем аккаунте
администратора (HOSTED_NUMBERS_OWNER_EMAIL) и платит за них и за минуты
связи с отдельного телефонного кошелька (users.telephony_balance, копейки),
который пополняется через Robokassa.

Таблицы создаёт ensure_telephony_verification_tables() в app.py.
"""

import uuid
from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey, Index, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .base import Base, BaseModel


class VerificationStatus:
    SUBMITTED = "submitted"            # отправлена, ждёт проверки
    NEEDS_REVISION = "needs_revision"  # вернули на доработку с комментарием
    APPROVED = "approved"
    REJECTED = "rejected"              # окончательно; повтор — через поддержку

    ALL = (SUBMITTED, NEEDS_REVISION, APPROVED, REJECTED)


class TelephonyVerification(Base, BaseModel):
    __tablename__ = "telephony_verifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, unique=True, index=True)
    status = Column(String(20), nullable=False, default=VerificationStatus.SUBMITTED)
    # Номер подачи: 1 — первая, растёт при повторной отправке после доработки
    attempt = Column(Integer, nullable=False, default=1)

    # Ключи объектов в бакете Timeweb: анкета (JSON) и файлы {kind: key}
    data_key = Column(String(255), nullable=True)
    files = Column(JSON, nullable=True)

    reviewer_comment = Column(Text, nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    # "telegram:<user_id>" или email админа из кабинета
    reviewed_by = Column(String(255), nullable=True)

    # Отдельное согласие на обработку паспортных данных
    consent_at = Column(DateTime(timezone=True), nullable=True)
    consent_version = Column(String(20), nullable=True)
    consent_ip = Column(String(64), nullable=True)

    # Сообщения бота по текущей подаче и ожидаемый комментарий проверяющего:
    # {"prompt_message_id": int, "action": "revision" | "reject"}
    tg_message_ids = Column(JSON, nullable=True)
    tg_pending = Column(JSON, nullable=True)
    # Прошлые решения: [{attempt, status, comment, by, at}] — контекст для повторной проверки
    history = Column(JSON, nullable=True)

    submitted_at = Column(DateTime(timezone=True), nullable=True)
    # Когда удалить анкету и файлы (30 дней после отказа или удаления аккаунта)
    purge_after = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User")

    def to_public(self) -> dict:
        return {
            "id": str(self.id),
            "status": self.status,
            "attempt": self.attempt,
            "reviewer_comment": self.reviewer_comment,
            "submitted_at": self.submitted_at.isoformat() if self.submitted_at else None,
            "reviewed_at": self.reviewed_at.isoformat() if self.reviewed_at else None,
        }


class TelephonyWalletTransaction(Base, BaseModel):
    """
    Журнал телефонного кошелька. Отдельно от wallet_transactions: тот кошелёк
    платит за ИИ, этот — за номера и минуты связи на аккаунте администратора.
    ref_key — ключ идемпотентности (уникален в паре с user_id).
    """
    __tablename__ = "telephony_wallet_transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    # topup | number | renewal | call | sms | manual_adjust | refund
    type = Column(String(30), nullable=False)
    amount_kopeks = Column(Integer, nullable=False)
    balance_after = Column(Integer, nullable=False)
    phone_number = Column(String(20), nullable=True)
    ref_key = Column(String(120), nullable=True)
    payment_transaction_id = Column(UUID(as_uuid=True),
                                    ForeignKey("payment_transactions.id"), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("idx_tel_wallet_tx_user_created", "user_id", "created_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "type": self.type,
            "amount_rub": round(self.amount_kopeks / 100.0, 2),
            "balance_after_rub": round(self.balance_after / 100.0, 2),
            "phone_number": self.phone_number,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
