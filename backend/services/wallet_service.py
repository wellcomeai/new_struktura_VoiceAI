"""
WalletService — единый рублёвый кошелёк Voicyfy и тарифы голосовых моделей.

Кошелёк (`users.wallet_balance`, копейки) оплачивает «мозг и голос»
ассистента по цене модели за минуту, когда разговор идёт на СЕРВЕРНЫХ
ключах платформы. Свой ключ в профиле — бесплатно (см. provider_keys).

Правила списания:
  * единица тарификации — секунда: price_per_min * seconds / 60, копейки
    округляются вверх;
  * минимальная тарификация сессии — 10 секунд;
  * в минус не уходим: не хватило — списываем в ноль с пометкой partial;
  * каждое списание пишет фактические секунды и токены в журнал;
  * `ref_key` делает списание идемпотентным (повторный отчёт о звонке
    не спишет деньги дважды).

Все мутации баланса — через SELECT ... FOR UPDATE.
"""

import math
import time
import threading
from datetime import datetime, timezone
from typing import Optional, Tuple, List, Dict
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.subscription import PaymentTransaction
from backend.models.voice_tariff import VoiceModelTariff, DEFAULT_TARIFFS
from backend.models.wallet_transaction import WalletTransaction, WalletTransactionType

logger = get_logger(__name__)

MIN_BILLABLE_SECONDS = 10
# Порог старта: виджет — 1 минута, телефония — 3 минуты
WIDGET_START_MINUTES = 1
TELEPHONY_START_MINUTES = 3


class InsufficientWalletBalance(Exception):
    def __init__(self, balance: int, required: int, model_code: str):
        self.balance = balance
        self.required = required
        self.model_code = model_code
        super().__init__(
            f"Insufficient wallet balance: {balance} < {required} kopeks for {model_code}"
        )


# ============================================================================
# TARIFFS
# ============================================================================

class TariffService:
    """Витрина моделей с ценами. Кэш в памяти на 60 секунд."""

    _cache: Dict[str, VoiceModelTariff] = {}
    _cache_ts: float = 0.0
    _cache_ttl: float = 60.0
    _lock = threading.Lock()

    @classmethod
    def invalidate(cls):
        with cls._lock:
            cls._cache = {}
            cls._cache_ts = 0.0

    @classmethod
    def _load(cls, db: Session) -> Dict[str, VoiceModelTariff]:
        now = time.time()
        if cls._cache and now - cls._cache_ts < cls._cache_ttl:
            return cls._cache
        rows = db.query(VoiceModelTariff).order_by(VoiceModelTariff.sort_order).all()
        # Отвязываем от сессии, чтобы кэш переживал db.close()
        for r in rows:
            db.expunge(r)
        with cls._lock:
            cls._cache = {r.code: r for r in rows}
            cls._cache_ts = now
        return cls._cache

    @classmethod
    def get_all(cls, db: Session, enabled_only: bool = True) -> List[VoiceModelTariff]:
        rows = list(cls._load(db).values())
        if enabled_only:
            rows = [r for r in rows if r.is_enabled]
        return sorted(rows, key=lambda r: (r.sort_order, r.code))

    @classmethod
    def get(cls, db: Session, code: str) -> Optional[VoiceModelTariff]:
        return cls._load(db).get((code or "").lower())

    @classmethod
    def price_per_min(cls, db: Session, code: str) -> int:
        """Цена минуты в копейках; неизвестная модель — 0 (не списываем)."""
        t = cls.get(db, code)
        return int(t.price_kopeks_per_min or 0) if t else 0

    @classmethod
    def seed_defaults(cls, db: Session) -> int:
        """Идемпотентный сид витрины. Возвращает число добавленных строк."""
        existing = {r.code for r in db.query(VoiceModelTariff.code).all()}
        added = 0
        for row in DEFAULT_TARIFFS:
            if row["code"] in existing:
                continue
            db.add(VoiceModelTariff(**row))
            added += 1
        if added:
            db.commit()
            cls.invalidate()
        return added

    @classmethod
    def update(cls, db: Session, code: str, **fields) -> Optional[VoiceModelTariff]:
        t = db.query(VoiceModelTariff).filter(VoiceModelTariff.code == code).first()
        if not t:
            return None
        allowed = {"name", "description", "badge", "price_kopeks_per_min",
                   "channels", "is_enabled", "sort_order", "notes"}
        for k, v in fields.items():
            if k in allowed and v is not None:
                setattr(t, k, v)
        db.commit()
        db.refresh(t)
        cls.invalidate()
        return t


# ============================================================================
# WALLET
# ============================================================================

class WalletService:

    # ------------------------------------------------------------------
    # COST
    # ------------------------------------------------------------------
    @staticmethod
    def calculate_cost(price_kopeks_per_min: int, seconds: int,
                       apply_minimum: bool = True) -> int:
        """Стоимость `seconds` секунд по цене минуты (копейки, вверх)."""
        seconds = max(0, int(seconds or 0))
        if apply_minimum and seconds > 0:
            seconds = max(seconds, MIN_BILLABLE_SECONDS)
        if price_kopeks_per_min <= 0 or seconds <= 0:
            return 0
        return int(math.ceil(price_kopeks_per_min * seconds / 60.0))

    # ------------------------------------------------------------------
    # READ
    # ------------------------------------------------------------------
    @classmethod
    def get_balance(cls, db: Session, user_id: UUID) -> int:
        balance = db.execute(
            select(User.wallet_balance).where(User.id == user_id)
        ).scalar_one_or_none()
        return int(balance or 0)

    @classmethod
    def get_transactions(cls, db: Session, user_id: UUID, limit: int = 50,
                         offset: int = 0, type_filter: Optional[str] = None
                         ) -> Tuple[List[WalletTransaction], int]:
        q = db.query(WalletTransaction).filter(WalletTransaction.user_id == user_id)
        if type_filter:
            q = q.filter(WalletTransaction.type == type_filter)
        total = q.count()
        rows = (q.order_by(WalletTransaction.created_at.desc())
                 .offset(offset).limit(limit).all())
        return rows, total

    # ------------------------------------------------------------------
    # PRECHECK
    # ------------------------------------------------------------------
    @classmethod
    def required_to_start(cls, db: Session, model_code: str, minutes: int) -> int:
        return TariffService.price_per_min(db, model_code) * max(1, minutes)

    @classmethod
    def precheck(cls, db: Session, user_id: UUID, model_code: str,
                 minutes: int = WIDGET_START_MINUTES) -> Tuple[bool, int, int]:
        """
        Хватает ли баланса на старт. Возвращает (ok, balance, required).
        Бесплатная модель (цена 0) — всегда ok.
        """
        required = cls.required_to_start(db, model_code, minutes)
        if required <= 0:
            return True, cls.get_balance(db, user_id), 0
        balance = cls.get_balance(db, user_id)
        return balance >= required, balance, required

    # ------------------------------------------------------------------
    # CHARGE (atomic spend)
    # ------------------------------------------------------------------
    @classmethod
    def charge(
        cls,
        db: Session,
        user_id: UUID,
        model_code: str,
        seconds: int,
        channel: str = "widget",
        ref_type: str = "voice_session",
        ref_key: Optional[str] = None,
        prompt_tokens: Optional[int] = None,
        completion_tokens: Optional[int] = None,
        notes: Optional[str] = None,
        apply_minimum: bool = True,
        price_override: Optional[int] = None,
    ) -> Optional[WalletTransaction]:
        """
        Списать стоимость `seconds` секунд разговора по тарифу модели.
        Не бросает исключений при нехватке — списывает в ноль и помечает
        partial (разговор уже состоялся, факт расхода надо зафиксировать).
        Возвращает транзакцию; None — если списывать нечего или ref_key уже
        был обработан.
        """
        seconds = max(0, int(seconds or 0))
        if seconds <= 0:
            return None

        if ref_key:
            dup = db.query(WalletTransaction.id).filter(
                WalletTransaction.user_id == user_id,
                WalletTransaction.ref_key == ref_key,
            ).first()
            if dup:
                logger.info(f"[WALLET] Duplicate charge skipped: user={user_id} ref={ref_key}")
                return None

        price = (price_override if price_override is not None
                 else TariffService.price_per_min(db, model_code))
        cost = cls.calculate_cost(price, seconds, apply_minimum=apply_minimum)

        user = db.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if not user:
            raise ValueError(f"User {user_id} not found")

        current = max(0, user.wallet_balance or 0)
        actual = min(cost, current)
        partial = actual < cost
        user.wallet_balance = current - actual

        note_parts = [f"{seconds}s @ {price / 100:.2f}₽/мин"]
        if partial:
            note_parts.append(f"partial: charged {actual}/{cost}")
        if notes:
            note_parts.append(notes)

        tx = WalletTransaction(
            user_id=user_id,
            type=WalletTransactionType.SPEND.value,
            amount_kopeks=-actual,
            balance_after=user.wallet_balance,
            model_code=model_code,
            channel=channel,
            seconds=seconds,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ref_type=ref_type,
            ref_key=ref_key,
            notes=" | ".join(note_parts),
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        logger.info(
            f"[WALLET] Charged user {user_id}: -{actual} kop (cost {cost}, "
            f"balance {user.wallet_balance}, model={model_code}, {seconds}s, {channel})"
        )
        return tx

    # ------------------------------------------------------------------
    # GRANTS / TOPUP
    # ------------------------------------------------------------------
    @classmethod
    def ensure_welcome_grant(cls, db: Session, user: User) -> Optional[WalletTransaction]:
        """Разовый приветственный грант. Идемпотентно по флагу."""
        amount = int(settings.WALLET_WELCOME_GRANT_RUB or 0) * 100
        if amount <= 0 or getattr(user, "wallet_welcome_granted", False):
            return None

        locked = db.execute(
            select(User).where(User.id == user.id).with_for_update()
        ).scalar_one_or_none()
        if not locked or locked.wallet_welcome_granted:
            return None

        locked.wallet_balance = (locked.wallet_balance or 0) + amount
        locked.wallet_welcome_granted = True
        tx = WalletTransaction(
            user_id=locked.id,
            type=WalletTransactionType.WELCOME_GRANT.value,
            amount_kopeks=amount,
            balance_after=locked.wallet_balance,
            ref_type="welcome",
            notes=f"Приветственный грант {amount / 100:.0f} ₽",
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        try:
            user.wallet_balance = locked.wallet_balance
            user.wallet_welcome_granted = True
        except Exception:
            pass
        logger.info(f"[WALLET] Welcome grant +{amount} kop to user {user.id}")
        return tx

    @classmethod
    def topup(cls, db: Session, user: User, amount_kopeks: int,
              payment_transaction: Optional[PaymentTransaction] = None,
              notes: Optional[str] = None) -> Optional[WalletTransaction]:
        """Пополнение. Идемпотентно по платежу (один TOPUP на payment_transaction)."""
        amount_kopeks = int(amount_kopeks or 0)
        if amount_kopeks <= 0:
            return None
        if payment_transaction is not None:
            existing = db.query(WalletTransaction).filter(
                WalletTransaction.payment_transaction_id == payment_transaction.id,
                WalletTransaction.type == WalletTransactionType.TOPUP.value,
            ).first()
            if existing:
                logger.info(f"[WALLET] Topup already applied for payment {payment_transaction.id}")
                return None

        locked = db.execute(
            select(User).where(User.id == user.id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user.id} not found")

        locked.wallet_balance = (locked.wallet_balance or 0) + amount_kopeks
        tx = WalletTransaction(
            user_id=locked.id,
            type=WalletTransactionType.TOPUP.value,
            amount_kopeks=amount_kopeks,
            balance_after=locked.wallet_balance,
            ref_type="robokassa",
            payment_transaction_id=payment_transaction.id if payment_transaction else None,
            notes=notes or f"Пополнение {amount_kopeks / 100:.2f} ₽",
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        try:
            user.wallet_balance = locked.wallet_balance
        except Exception:
            pass
        logger.info(f"[WALLET] Topup +{amount_kopeks} kop to user {user.id}")
        return tx

    @classmethod
    def manual_adjust(cls, db: Session, user_id: UUID, amount_kopeks: int,
                      notes: str) -> WalletTransaction:
        """Ручная корректировка админом (плюс или минус). notes обязателен."""
        if not notes or not notes.strip():
            raise ValueError("manual_adjust requires non-empty notes")
        locked = db.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user_id} not found")
        locked.wallet_balance = max(0, (locked.wallet_balance or 0) + int(amount_kopeks))
        tx = WalletTransaction(
            user_id=user_id,
            type=WalletTransactionType.MANUAL_ADJUST.value,
            amount_kopeks=int(amount_kopeks),
            balance_after=locked.wallet_balance,
            ref_type="admin",
            notes=notes,
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        logger.info(f"[WALLET] Manual adjust user {user_id}: {int(amount_kopeks):+d} ({notes[:80]})")
        return tx

    @classmethod
    def refund(cls, db: Session, user_id: UUID, amount_kopeks: int,
               ref_key: Optional[str] = None, notes: Optional[str] = None) -> WalletTransaction:
        locked = db.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user_id} not found")
        locked.wallet_balance = (locked.wallet_balance or 0) + max(0, int(amount_kopeks))
        tx = WalletTransaction(
            user_id=user_id,
            type=WalletTransactionType.REFUND.value,
            amount_kopeks=max(0, int(amount_kopeks)),
            balance_after=locked.wallet_balance,
            ref_type="refund",
            ref_key=ref_key,
            notes=notes,
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        return tx

    # ------------------------------------------------------------------
    # ADMIN STATS
    # ------------------------------------------------------------------
    @classmethod
    def usage_by_model(cls, db: Session, days: int = 30) -> List[Dict]:
        """Секунды и списания по моделям за период — для контроля маржи."""
        from sqlalchemy import func
        since = datetime.now(timezone.utc).timestamp() - days * 86400
        since_dt = datetime.fromtimestamp(since, tz=timezone.utc)
        rows = (
            db.query(
                WalletTransaction.model_code,
                func.count(WalletTransaction.id),
                func.coalesce(func.sum(WalletTransaction.seconds), 0),
                func.coalesce(func.sum(-WalletTransaction.amount_kopeks), 0),
            )
            .filter(WalletTransaction.type == WalletTransactionType.SPEND.value,
                    WalletTransaction.created_at >= since_dt)
            .group_by(WalletTransaction.model_code)
            .all()
        )
        return [
            {
                "model_code": r[0],
                "sessions": int(r[1] or 0),
                "seconds": int(r[2] or 0),
                "minutes": round(int(r[2] or 0) / 60.0, 1),
                "charged_kopeks": int(r[3] or 0),
                "charged_rub": round(int(r[3] or 0) / 100.0, 2),
            }
            for r in rows
        ]
