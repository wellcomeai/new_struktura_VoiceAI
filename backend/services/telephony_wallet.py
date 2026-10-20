"""
Телефонный кошелёк физлица (users.telephony_balance, копейки).

Оплачивает номера (покупка, ежемесячное продление) и минуты связи на
аккаунте администратора по себестоимости Voximplant. Пополняется через
Robokassa (Shp_telephony_topup). Журнал — telephony_wallet_transactions,
ref_key делает операцию идемпотентной.

Мутации баланса — под SELECT ... FOR UPDATE строки пользователя.
"""

import math
from typing import Optional

from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.telephony_verification import TelephonyWalletTransaction

logger = get_logger(__name__)


class InsufficientTelephonyBalance(Exception):
    def __init__(self, balance: int, required: int):
        self.balance = balance
        self.required = required
        super().__init__(f"Insufficient telephony balance: {balance} < {required} kopeks")


def rub_to_kopeks(rub: float) -> int:
    """Рубли → копейки с округлением вверх (не недосписываем)."""
    return int(math.ceil(round(float(rub or 0) * 100, 6)))


def balance(db: Session, user_id) -> int:
    row = db.query(User.telephony_balance).filter(User.id == user_id).first()
    return int(row[0] or 0) if row else 0


def _locked_user(db: Session, user_id) -> User:
    user = db.query(User).filter(User.id == user_id).with_for_update().first()
    if not user:
        raise ValueError(f"user {user_id} not found")
    return user


def _existing(db: Session, user_id, ref_key: Optional[str]) -> Optional[TelephonyWalletTransaction]:
    if not ref_key:
        return None
    return db.query(TelephonyWalletTransaction).filter(
        TelephonyWalletTransaction.user_id == user_id,
        TelephonyWalletTransaction.ref_key == ref_key,
    ).first()


def credit(db: Session, user_id, amount_kopeks: int, tx_type: str, *,
           ref_key: Optional[str] = None, notes: Optional[str] = None,
           phone_number: Optional[str] = None, payment_transaction_id=None,
           commit: bool = True) -> TelephonyWalletTransaction:
    """Зачислить (пополнение, возврат, ручная коррекция +)."""
    prev = _existing(db, user_id, ref_key)
    if prev:
        return prev
    user = _locked_user(db, user_id)
    user.telephony_balance = int(user.telephony_balance or 0) + int(amount_kopeks)
    tx = TelephonyWalletTransaction(
        user_id=user_id, type=tx_type, amount_kopeks=int(amount_kopeks),
        balance_after=user.telephony_balance, ref_key=ref_key, notes=notes,
        phone_number=phone_number, payment_transaction_id=payment_transaction_id,
    )
    db.add(tx)
    if commit:
        db.commit()
    logger.info(f"[TEL-WALLET] +{amount_kopeks} kop user={user_id} type={tx_type} → {user.telephony_balance}")
    return tx


def debit(db: Session, user_id, amount_kopeks: int, tx_type: str, *,
          ref_key: Optional[str] = None, notes: Optional[str] = None,
          phone_number: Optional[str] = None, allow_partial: bool = False,
          commit: bool = True) -> Optional[TelephonyWalletTransaction]:
    """
    Списать. Без allow_partial при нехватке — InsufficientTelephonyBalance
    (покупка и продление номера). С allow_partial списываем сколько есть,
    в минус не уходим (минуты уже состоявшегося звонка).
    """
    if amount_kopeks <= 0:
        return None
    prev = _existing(db, user_id, ref_key)
    if prev:
        return prev
    user = _locked_user(db, user_id)
    current = int(user.telephony_balance or 0)
    take = int(amount_kopeks)
    if current < take:
        if not allow_partial:
            raise InsufficientTelephonyBalance(current, take)
        notes = (notes or "") + f" (списано {current} из {take} коп.)"
        take = current
    user.telephony_balance = current - take
    tx = TelephonyWalletTransaction(
        user_id=user_id, type=tx_type, amount_kopeks=-take,
        balance_after=user.telephony_balance, ref_key=ref_key, notes=notes,
        phone_number=phone_number,
    )
    db.add(tx)
    if commit:
        db.commit()
    logger.info(f"[TEL-WALLET] -{take} kop user={user_id} type={tx_type} → {user.telephony_balance}")
    return tx


def history(db: Session, user_id, limit: int = 50, offset: int = 0) -> list:
    rows = db.query(TelephonyWalletTransaction).filter(
        TelephonyWalletTransaction.user_id == user_id
    ).order_by(TelephonyWalletTransaction.created_at.desc()).offset(offset).limit(limit).all()
    return [r.to_dict() for r in rows]
