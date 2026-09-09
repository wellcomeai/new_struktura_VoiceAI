"""
WalletTransaction — журнал операций рублёвого кошелька Voicyfy.

Единый кошелёк на аккаунт (`users.wallet_balance`, в копейках) оплачивает
«мозг и голос» ассистента по цене модели за минуту. Каждая операция
(пополнение, списание, возврат, коррекция, приветственный грант) фиксируется
здесь. Вместе со списанием сохраняются фактические секунды и токены сессии —
по ним видна реальная маржа каждой модели.

`ref_key` — идемпотентный ключ списания (например `call:<call_id>`): повторный
отчёт сценария о том же звонке не спишет деньги второй раз.

Таблица создаётся startup-функцией `ensure_wallet_tables()` в app.py.
"""

import uuid
import enum
from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .base import Base, BaseModel


class WalletTransactionType(str, enum.Enum):
    TOPUP = "topup"
    SPEND = "spend"
    REFUND = "refund"
    WELCOME_GRANT = "welcome_grant"
    MANUAL_ADJUST = "manual_adjust"


class WalletTransaction(Base, BaseModel):
    __tablename__ = "wallet_transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    type = Column(String(30), nullable=False)
    # Сумма в копейках, со знаком: пополнение +, списание -
    amount_kopeks = Column(Integer, nullable=False)
    balance_after = Column(Integer, nullable=False)
    # Код тарифа (assistant_type), по которому шло списание
    model_code = Column(String(30), nullable=True)
    # widget | telephony | test
    channel = Column(String(20), nullable=True)
    # Фактические секунды и токены сессии — для расчёта маржи
    seconds = Column(Integer, nullable=True)
    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    ref_type = Column(String(50), nullable=True)
    ref_key = Column(String(120), nullable=True)
    payment_transaction_id = Column(UUID(as_uuid=True),
                                    ForeignKey("payment_transactions.id"), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User")
    payment_transaction = relationship("PaymentTransaction")

    __table_args__ = (
        Index("idx_wallet_tx_user_created", "user_id", "created_at"),
        Index("idx_wallet_tx_user_refkey", "user_id", "ref_key"),
    )

    def __repr__(self):
        return f"<WalletTransaction {self.type} {self.amount_kopeks} user={self.user_id}>"

    def to_dict(self):
        return {
            "id": str(self.id),
            "type": self.type,
            "amount_kopeks": self.amount_kopeks,
            "amount_rub": round(self.amount_kopeks / 100.0, 2),
            "balance_after": self.balance_after,
            "balance_after_rub": round(self.balance_after / 100.0, 2),
            "model_code": self.model_code,
            "channel": self.channel,
            "seconds": self.seconds,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "ref_type": self.ref_type,
            "ref_key": self.ref_key,
            "payment_transaction_id": str(self.payment_transaction_id) if self.payment_transaction_id else None,
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
