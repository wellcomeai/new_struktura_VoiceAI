"""
CascadeCreditService — атомарный учёт кредитов каскад-ассистентов.

Отдельный кошелёк (`users.cascade_credits_balance`), независимый от кредитов
оркестратора (`users.credits_balance`) и от подписки `agent`. Доступен на всех
тарифах, включая free. Списание — по фактическим токенам LLM gpt-5.4-nano,
которая крутится в Voximplant на СЕРВЕРНОМ ключе OpenAI (settings.OPENAI_API_KEY).

Тарификация (та же конвенция, что у оркестратора: 1 кредит = $0.0001
себестоимости, ставки уже ×2 → 100% маржа):

    gpt-5.4-nano: $0.20 / 1M input, $1.25 / 1M output
      input  = $0.0002 / 1k  → ×2 → 4  кредита / 1k
      output = $0.00125 / 1k → ×2 → 25 кредитов / 1k

Все мутации баланса идут строго через SELECT ... FOR UPDATE. Каждая операция
фиксируется в `credit_transactions` c product='cascade' — единый источник правды
для биллинга, поддержки и аналитики (общая таблица с оркестратором, разделение
по колонке product).
"""

import math
from typing import Optional, Tuple, List
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.subscription import PaymentTransaction
from backend.models.credit_transaction import CreditTransaction, CreditTransactionType
from backend.models.credit_package import CreditPackage

logger = get_logger(__name__)

PRODUCT = "cascade"

# Ставки списания gpt-5.4-nano (кредитов за 1000 токенов, маржа ×2 уже включена).
CASCADE_MODEL_SLUG = "openai/gpt-5.4-nano"
INPUT_CREDITS_PER_1K = 4
OUTPUT_CREDITS_PER_1K = 25


class CascadeCreditService:
    # Разовый тестовый грант всем пользователям (одноразово за всю жизнь юзера).
    TRIAL_CREDITS = 1500

    # ------------------------------------------------------------------
    # COST CALCULATION
    # ------------------------------------------------------------------
    @classmethod
    def calculate_cost(cls, prompt_tokens: int, completion_tokens: int) -> int:
        """Стоимость вызова в кредитах. Минимум 1 кредит за любой платный вызов."""
        prompt_tokens = max(0, prompt_tokens or 0)
        completion_tokens = max(0, completion_tokens or 0)
        cost = math.ceil(
            (prompt_tokens / 1000.0) * INPUT_CREDITS_PER_1K +
            (completion_tokens / 1000.0) * OUTPUT_CREDITS_PER_1K
        )
        return max(1, cost)

    # ------------------------------------------------------------------
    # CHARGE (atomic spend)
    # ------------------------------------------------------------------
    @classmethod
    def charge(
        cls,
        db: Session,
        user_id: UUID,
        prompt_tokens: int,
        completion_tokens: int,
        ref_type: str = "cascade_call",
        ref_id: Optional[UUID] = None,
        notes: Optional[str] = None,
    ) -> Optional[CreditTransaction]:
        """
        Атомарное списание кредитов каскада. SELECT FOR UPDATE на user.
        Если баланса не хватает — списывает в ноль (НЕ в минус) и помечает
        транзакцию `partial=...`. НЕ бросает исключение — звонок уже отработал,
        факт расхода надо зафиксировать. При нулевых токенах — ничего не делает.
        """
        if (prompt_tokens or 0) <= 0 and (completion_tokens or 0) <= 0:
            return None

        user = db.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if not user:
            raise ValueError(f"User {user_id} not found")

        cost = cls.calculate_cost(prompt_tokens, completion_tokens)

        current = max(0, user.cascade_credits_balance or 0)
        actual_charge = min(cost, current)
        partial = actual_charge < cost
        user.cascade_credits_balance = current - actual_charge

        note_parts = []
        if partial:
            note_parts.append(f"partial: charged {actual_charge}/{cost}")
        if notes:
            note_parts.append(notes)

        tx = CreditTransaction(
            user_id=user_id,
            product=PRODUCT,
            type=CreditTransactionType.SPEND.value,
            amount=-cost,
            balance_after=user.cascade_credits_balance,
            model_slug=CASCADE_MODEL_SLUG,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ref_type=ref_type,
            ref_id=ref_id,
            notes=" | ".join(note_parts) if note_parts else None,
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        logger.info(
            f"[CASCADE-CREDITS] Charged user {user_id}: -{cost} (actual -{actual_charge}, "
            f"balance {user.cascade_credits_balance}, in={prompt_tokens} out={completion_tokens})"
        )
        return tx

    # ------------------------------------------------------------------
    # GRANTS
    # ------------------------------------------------------------------
    @classmethod
    def grant_trial(cls, db: Session, user: User) -> Optional[CreditTransaction]:
        """
        Выдать разовый тестовый грант (1500 кредитов). Идемпотентно по флагу
        user.cascade_trial_granted. Возвращает транзакцию или None, если грант
        уже был выдан.
        """
        locked = db.execute(
            select(User).where(User.id == user.id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user.id} not found")

        if locked.cascade_trial_granted:
            return None

        locked.cascade_credits_balance = (locked.cascade_credits_balance or 0) + cls.TRIAL_CREDITS
        locked.cascade_trial_granted = True

        tx = CreditTransaction(
            user_id=locked.id,
            product=PRODUCT,
            type=CreditTransactionType.TRIAL_GRANT.value,
            amount=cls.TRIAL_CREDITS,
            balance_after=locked.cascade_credits_balance,
            ref_type="cascade_trial",
            notes=f"Cascade trial grant: {cls.TRIAL_CREDITS} credits",
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        try:
            user.cascade_credits_balance = locked.cascade_credits_balance
            user.cascade_trial_granted = True
        except Exception:
            pass
        logger.info(f"[CASCADE-CREDITS] Trial granted to user {user.id}: +{cls.TRIAL_CREDITS}")
        return tx

    @classmethod
    def grant_purchase(cls, db: Session, user: User, package: CreditPackage,
                       payment_transaction: Optional[PaymentTransaction]) -> Optional[CreditTransaction]:
        """
        Начислить кредиты каскада при покупке пакета. Идемпотентно по платежу:
        если для этого payment_transaction уже была выдача PURCHASE с
        product='cascade' — повторно не начисляем (защита от повторных callback-ов).
        """
        if payment_transaction is not None:
            existing = db.query(CreditTransaction).filter(
                CreditTransaction.payment_transaction_id == payment_transaction.id,
                CreditTransaction.product == PRODUCT,
                CreditTransaction.type == CreditTransactionType.PURCHASE.value,
            ).first()
            if existing:
                logger.info(
                    f"[CASCADE-CREDITS] Purchase already applied for payment "
                    f"{payment_transaction.id}, skipping"
                )
                return None

        locked = db.execute(
            select(User).where(User.id == user.id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user.id} not found")

        locked.cascade_credits_balance = (locked.cascade_credits_balance or 0) + package.credits

        tx = CreditTransaction(
            user_id=locked.id,
            product=PRODUCT,
            type=CreditTransactionType.PURCHASE.value,
            amount=package.credits,
            balance_after=locked.cascade_credits_balance,
            ref_type="cascade_purchase",
            payment_transaction_id=payment_transaction.id if payment_transaction else None,
            credits_package_code=package.code,
            notes=f"Purchase cascade package {package.code}: +{package.credits} credits",
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        try:
            user.cascade_credits_balance = locked.cascade_credits_balance
        except Exception:
            pass
        logger.info(
            f"[CASCADE-CREDITS] Package {package.code} granted to user {user.id}: "
            f"+{package.credits}"
        )
        return tx

    @classmethod
    def manual_adjust(cls, db: Session, user_id: UUID, amount: int,
                      notes: str) -> CreditTransaction:
        """Ручная корректировка баланса каскада админом. notes обязателен."""
        if not notes or not notes.strip():
            raise ValueError("manual_adjust requires non-empty notes")

        locked = db.execute(
            select(User).where(User.id == user_id).with_for_update()
        ).scalar_one_or_none()
        if not locked:
            raise ValueError(f"User {user_id} not found")

        locked.cascade_credits_balance = max(0, (locked.cascade_credits_balance or 0) + amount)

        tx = CreditTransaction(
            user_id=user_id,
            product=PRODUCT,
            type=CreditTransactionType.MANUAL_ADJUST.value,
            amount=amount,
            balance_after=locked.cascade_credits_balance,
            ref_type="grant",
            notes=notes,
        )
        db.add(tx)
        db.commit()
        db.refresh(tx)
        logger.info(f"[CASCADE-CREDITS] Manual adjust for user {user_id}: {amount:+d} ({notes[:80]})")
        return tx

    # ------------------------------------------------------------------
    # READ
    # ------------------------------------------------------------------
    @classmethod
    def get_balance(cls, db: Session, user_id: UUID) -> int:
        balance = db.execute(
            select(User.cascade_credits_balance).where(User.id == user_id)
        ).scalar_one_or_none()
        return int(balance or 0)

    @classmethod
    def get_transactions(
        cls, db: Session, user_id: UUID,
        limit: int = 50, offset: int = 0,
        type_filter: Optional[str] = None,
    ) -> Tuple[List[CreditTransaction], int]:
        """История транзакций каскада (product='cascade'). Возвращает (список, total)."""
        q = db.query(CreditTransaction).filter(
            CreditTransaction.user_id == user_id,
            CreditTransaction.product == PRODUCT,
        )
        if type_filter:
            q = q.filter(CreditTransaction.type == type_filter)

        total = q.count()
        rows = (
            q.order_by(CreditTransaction.created_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        return rows, total
