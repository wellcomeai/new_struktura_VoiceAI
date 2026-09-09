"""
/api/wallet — единый рублёвый кошелёк Voicyfy и витрина голосовых моделей.

Пользователь:
  GET  /api/wallet/balance          — баланс (лениво выдаёт приветственный грант)
  GET  /api/wallet/tariffs          — витрина моделей с ценами (публично)
  GET  /api/wallet/transactions     — журнал операций
  POST /api/wallet/topup            — пополнение через Robokassa (Shp_wallet_topup)

Админ:
  GET  /api/wallet/admin/tariffs            — все тарифы, включая скрытые
  PUT  /api/wallet/admin/tariffs/{code}     — правка цены/бейджа/видимости
  POST /api/wallet/admin/adjust             — ручная корректировка баланса
  GET  /api/wallet/admin/usage              — расход по моделям за N дней
  GET  /api/wallet/admin/users/{user_id}    — баланс и история пользователя
"""

import uuid
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.models.subscription import PaymentTransaction
from backend.services.wallet_service import WalletService, TariffService
from backend.services import provider_keys
from backend.api.credits import _build_robokassa_payment

logger = get_logger(__name__)

router = APIRouter(prefix="/api/wallet", tags=["Wallet"])


# ============================================================================
# SCHEMAS
# ============================================================================

class TopupRequest(BaseModel):
    amount_rub: int = Field(..., ge=1, le=1_000_000, description="Сумма пополнения в рублях")


class TariffUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    badge: Optional[str] = None
    price_rub_per_min: Optional[float] = Field(None, ge=0, le=10_000)
    channels: Optional[str] = None
    is_enabled: Optional[bool] = None
    sort_order: Optional[int] = None
    notes: Optional[str] = None


class AdjustRequest(BaseModel):
    user_id: Optional[str] = None
    email: Optional[str] = None
    amount_rub: float = Field(..., description="Сумма со знаком, в рублях")
    notes: str = Field(..., min_length=3)


# ============================================================================
# HELPERS
# ============================================================================

def _require_admin(user: User):
    if not (user.is_admin or user.email == "well96well@gmail.com"):
        raise HTTPException(status_code=403, detail="admin_required")


def _tariff_payload(t, user: Optional[User]) -> Dict[str, Any]:
    d = t.to_dict()
    # Есть ли у платформы серверный ключ для этой модели
    d["server_key_available"] = provider_keys.has_server_key(t.code)
    # Пользователь на своём ключе — работает бесплатно
    own = False
    if user is not None:
        own = not provider_keys.resolve(user, t.code).is_server and \
              provider_keys.resolve(user, t.code).available
    d["own_key"] = own
    d["effective_price_rub_per_min"] = 0 if own else d["price_rub_per_min"]
    return d


# ============================================================================
# USER ENDPOINTS
# ============================================================================

@router.get("/balance")
async def get_balance(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == current_user.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_found")
    try:
        WalletService.ensure_welcome_grant(db, user)
    except Exception as e:
        logger.warning(f"[WALLET] welcome grant failed for {user.id}: {e}")
    balance = WalletService.get_balance(db, user.id)
    return {
        "balance_kopeks": balance,
        "balance_rub": round(balance / 100.0, 2),
        "welcome_granted": bool(user.wallet_welcome_granted),
        "min_topup_rub": settings.WALLET_MIN_TOPUP_RUB,
        "max_topup_rub": settings.WALLET_MAX_TOPUP_RUB,
        "is_admin": bool(user.is_admin),
    }


@router.get("/tariffs")
async def list_tariffs(
    db: Session = Depends(get_db),
):
    """Витрина моделей (без авторизации — цены не секрет)."""
    rows = TariffService.get_all(db, enabled_only=True)
    return {"tariffs": [_tariff_payload(t, None) for t in rows]}


@router.get("/tariffs/me")
async def list_tariffs_for_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Витрина с учётом собственных ключей пользователя (own_key → 0 ₽)."""
    user = db.query(User).filter(User.id == current_user.id).first()
    rows = TariffService.get_all(db, enabled_only=True)
    return {"tariffs": [_tariff_payload(t, user) for t in rows]}


@router.get("/transactions")
async def list_transactions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    type: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows, total = WalletService.get_transactions(db, current_user.id, limit, offset, type)
    return {
        "transactions": [r.to_dict() for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/topup")
async def create_topup(
    body: TopupRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Создать Robokassa-платёж пополнения кошелька."""
    if body.amount_rub < settings.WALLET_MIN_TOPUP_RUB:
        raise HTTPException(status_code=400, detail=f"min_topup_{settings.WALLET_MIN_TOPUP_RUB}")
    if body.amount_rub > settings.WALLET_MAX_TOPUP_RUB:
        raise HTTPException(status_code=400, detail=f"max_topup_{settings.WALLET_MAX_TOPUP_RUB}")

    user = db.query(User).filter(User.id == current_user.id).first()
    amount = float(body.amount_rub)

    payment = _build_robokassa_payment(
        user=user,
        amount=amount,
        description=f"Пополнение кошелька Voicyfy на {body.amount_rub} ₽",
        extra_shp={"Shp_wallet_topup": str(body.amount_rub)},
    )

    transaction = PaymentTransaction(
        user_id=user.id,
        plan_id=None,
        external_payment_id=payment["inv_id"],
        payment_system="robokassa",
        amount=amount,
        currency="RUB",
        status="pending",
        payment_details=f"Shp_wallet_topup={body.amount_rub}",
    )
    db.add(transaction)
    db.commit()
    db.refresh(transaction)

    logger.info(f"[WALLET] Topup payment created: user={user.id} amount={amount} inv={payment['inv_id']}")
    return {**payment, "transaction_id": str(transaction.id)}


# ============================================================================
# ADMIN ENDPOINTS
# ============================================================================

@router.get("/admin/tariffs")
async def admin_list_tariffs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    rows = TariffService.get_all(db, enabled_only=False)
    return {"tariffs": [_tariff_payload(t, None) for t in rows]}


@router.put("/admin/tariffs/{code}")
async def admin_update_tariff(
    code: str,
    body: TariffUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    fields = body.dict(exclude_unset=True)
    price_rub = fields.pop("price_rub_per_min", None)
    if price_rub is not None:
        fields["price_kopeks_per_min"] = int(round(float(price_rub) * 100))
    t = TariffService.update(db, code.lower(), **fields)
    if not t:
        raise HTTPException(status_code=404, detail="tariff_not_found")
    logger.info(f"[WALLET] Tariff {code} updated by {current_user.email}: {fields}")
    return {"tariff": _tariff_payload(t, None)}


@router.post("/admin/adjust")
async def admin_adjust(
    body: AdjustRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    user = None
    if body.user_id:
        try:
            user = db.query(User).filter(User.id == uuid.UUID(body.user_id)).first()
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_user_id")
    elif body.email:
        user = db.query(User).filter(User.email == body.email.strip().lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_found")

    tx = WalletService.manual_adjust(
        db, user.id, int(round(body.amount_rub * 100)),
        notes=f"{body.notes} (by {current_user.email})",
    )
    return {"transaction": tx.to_dict(), "balance_rub": round(tx.balance_after / 100.0, 2)}


@router.get("/admin/usage")
async def admin_usage(
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    return {"days": days, "usage": WalletService.usage_by_model(db, days)}


@router.get("/admin/users/{user_id}")
async def admin_user_wallet(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid_user_id")
    user = db.query(User).filter(User.id == uid).first()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_found")
    rows, total = WalletService.get_transactions(db, uid, limit, 0)
    return {
        "user_id": str(uid),
        "email": user.email,
        "balance_rub": round((user.wallet_balance or 0) / 100.0, 2),
        "transactions": [r.to_dict() for r in rows],
        "total": total,
    }
