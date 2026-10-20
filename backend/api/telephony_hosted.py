"""
API верификации физлиц и номеров на аккаунте администратора.

Voximplant больше не верифицирует физлиц: физлицо проходит нашу проверку
(анкета по паспорту + скан + селфи), после одобрения покупает номера на
аккаунте администратора и платит с телефонного кошелька.
Логика — services/telephony_verification_service.py и services/hosted_numbers.py.

Префикс: /api/telephony

Пользователь:
  GET    /verification                   — статус заявки (+ данные для правки при доработке)
  POST   /verification                   — отправить заявку (multipart: поля, 2 фото паспорта, видео, consent)
  GET    /verification/example-video     — пример видео (редирект на свежую ссылку S3, без авторизации)
  GET    /hosted/status                  — режим физлица: баланс, номера, готовность
  GET    /hosted/regions                 — регионы номеров
  GET    /hosted/available-numbers       — номера Voximplant + запас администратора с нашими ценами
  POST   /hosted/buy                     — {phone_number, region_id, category} | {stock_id}
  DELETE /hosted/numbers/{id}            — отказаться от номера (уходит в запас администратора)
  GET    /telephony-wallet               — баланс и журнал телефонного кошелька
  POST   /telephony-wallet/topup         — пополнение через Robokassa {amount_rub}

Администратор (is_admin):
  GET    /admin/verifications                       — заявки (?status=)
  GET    /admin/verifications/{id}                  — анкета и ссылки на файлы
  GET    /admin/verifications/by-user/{user_id}     — то же по пользователю
  POST   /admin/verifications/{id}/decision         — {action: approve|revision|reject, comment}
  GET    /admin/hosted-numbers                      — номера физлиц и запас
  POST   /admin/hosted-numbers/{id}/release         — забрать номер у физлица в запас
  POST   /admin/hosted-numbers/{id}/deactivate      — отключить номер из запаса в Voximplant
  PUT    /admin/hosted-stock/{id}                   — свой номер в запас / из запаса {in_stock}
  POST   /admin/telephony-wallet/adjust             — ручная коррекция {email, amount_rub, notes}

Telegram-бот модерации:
  POST   /verification/telegram/{secret}            — webhook (callback_query + ответы-комментарии)
"""

import asyncio
import hmac
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.core.config import settings
from backend.core.dependencies import get_current_user, check_admin_access
from backend.core.logging import get_logger
from backend.db.session import get_db, SessionLocal
from backend.models.user import User
from backend.models.subscription import PaymentTransaction
from backend.models.telephony_verification import TelephonyVerification, VerificationStatus
from backend.models.voximplant_child import VoximplantPhoneNumber, VoximplantChildAccount
from backend.services import hosted_numbers, telephony_wallet, verification_bot
from backend.services import telephony_verification_service as verification
from backend.services.hosted_numbers import HostedError
from backend.services.telephony_verification_service import VerificationError

logger = get_logger(__name__)

router = APIRouter()


def _http(e: Exception, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=str(e),
                         headers={"X-Error-Code": getattr(e, "code", "error")})


def _client_ip(request: Request) -> Optional[str]:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


# =============================================================================
# ВЕРИФИКАЦИЯ — ПОЛЬЗОВАТЕЛЬ
# =============================================================================

@router.get("/verification")
def get_my_verification(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    v = verification.get_for_user(db, current_user.id)
    result = {
        "verification": v.to_public() if v else None,
        "consent_version": verification.CONSENT_VERSION,
        "storage_ready": verification.storage.is_configured(),
        "fields": verification.FIELDS,
        "file_kinds": verification.FILE_KINDS,
        "video": {
            "max_mb": verification.MAX_VIDEO_BYTES // (1024 * 1024),
            "min_seconds": verification.VIDEO_MIN_SECONDS,
            "max_seconds": verification.VIDEO_MAX_SECONDS,
            "phrase": verification.VIDEO_PHRASE,
            "example_url": "/api/telephony/verification/example-video",
        },
        "prefill": None,
    }
    # На доработке форма открывается заполненной — пользователь правит только нужное
    if v and v.status == VerificationStatus.NEEDS_REVISION and v.data_key:
        data = verification.storage.get_json(v.data_key) or {}
        result["prefill"] = {k: data.get(k) for k in verification.FIELDS}
    return result


@router.get("/verification/example-video")
def verification_example_video():
    """
    Пример видео для анкеты. Бакет приватный, поэтому каждый раз выдаём свежую
    подписанную ссылку на один заранее заданный объект (VERIFICATION_EXAMPLE_VIDEO_KEY).
    Без авторизации: ссылку открывают в новой вкладке, где нет токена кабинета.
    """
    key = (settings.VERIFICATION_EXAMPLE_VIDEO_KEY or "").strip()
    if not key or not verification.storage.is_configured():
        raise HTTPException(status_code=404, detail="Пример видео пока не загружен")
    return RedirectResponse(verification.storage.presigned_url(key, ttl=3600), status_code=302)


@router.post("/verification")
async def submit_verification(
    request: Request,
    last_name: str = Form(""),
    first_name: str = Form(""),
    middle_name: str = Form(""),
    birth_date: str = Form(""),
    birth_place: str = Form(""),
    passport_series: str = Form(""),
    passport_number: str = Form(""),
    issued_by: str = Form(""),
    issue_date: str = Form(""),
    division_code: str = Form(""),
    registration_address: str = Form(""),
    phone: str = Form(""),
    consent: bool = Form(False),
    passport_main: UploadFile = File(...),
    passport_registration: UploadFile = File(...),
    video: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    fields = {
        "last_name": last_name, "first_name": first_name, "middle_name": middle_name,
        "birth_date": birth_date, "birth_place": birth_place,
        "passport_series": passport_series, "passport_number": passport_number,
        "issued_by": issued_by, "issue_date": issue_date, "division_code": division_code,
        "registration_address": registration_address, "phone": phone,
    }
    files = {}
    for kind, upload in (("passport_main", passport_main),
                         ("passport_registration", passport_registration), ("video", video)):
        content = await upload.read(verification.max_bytes(kind) + 1)
        files[kind] = (content, upload.content_type or "")
    ip = _client_ip(request)
    user_id = current_user.id

    def _store():
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == user_id).first()
            v, data, bot_files, resubmission = verification.store_submission(db, user, fields, files, consent, ip)
            return str(v.id), v.attempt, user.email, data, bot_files, resubmission
        finally:
            db.close()

    try:
        vid, attempt, email, data, bot_files, resubmission = await asyncio.to_thread(_store)
    except VerificationError as e:
        raise _http(e)
    except Exception as e:
        logger.error(f"[VERIFY] submit failed for {current_user.email}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Не удалось сохранить документы, попробуйте ещё раз")

    message_ids = await verification_bot.send_application(
        vid, email, data, attempt, verification.FIELDS, bot_files, resubmission=resubmission,
    )
    if message_ids:
        def _save_ids():
            db = SessionLocal()
            try:
                v = db.query(TelephonyVerification).filter(TelephonyVerification.id == uuid.UUID(vid)).first()
                if v:
                    v.tg_message_ids = message_ids
                    db.commit()
            finally:
                db.close()
        await asyncio.to_thread(_save_ids)
    return {"success": True, "status": VerificationStatus.SUBMITTED,
            "message": "Заявка отправлена на проверку. Обычно это занимает до одного рабочего дня."}


# =============================================================================
# НОМЕРА ФИЗЛИЦА
# =============================================================================

def _require_approved(db: Session, user: User) -> None:
    if not verification.is_approved(db, user.id):
        raise HTTPException(status_code=403, detail="Сначала пройдите верификацию физлица",
                            headers={"X-Error-Code": "not_verified"})


@router.get("/hosted/status")
def hosted_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    v = verification.get_for_user(db, current_user.id)
    child = hosted_numbers.hosted_account_for(db, current_user.id)
    host = hosted_numbers.get_host_account(db)
    if not child and v and v.status == VerificationStatus.APPROVED:
        # Одобрили, когда аккаунт номеров был не готов, — заводим запись сейчас
        try:
            child = hosted_numbers.ensure_hosted_account(db, current_user)
        except HostedError as e:
            logger.info(f"[HOSTED] account for {current_user.email} not ready: {e}")
    elif child and host:
        # Копия сценариев/правил могла устареть после раскатки — освежаем
        hosted_numbers.sync_from_host(child, host)
        db.commit()
    numbers = list(child.phone_numbers or []) if child else []
    return {
        "verification": v.to_public() if v else None,
        "is_hosted": bool(child),
        "approved": bool(v and v.status == VerificationStatus.APPROVED),
        "host_ready": bool(host and host.is_verified and host.vox_application_id),
        "balance_rub": round(telephony_wallet.balance(db, current_user.id) / 100, 2),
        "min_call_balance_rub": settings.TELEPHONY_MIN_BALANCE_RUB,
        "min_topup_rub": settings.TELEPHONY_MIN_TOPUP_RUB,
        "markup_rub": settings.HOSTED_NUMBER_MARKUP_RUB,
        "grace_days": settings.HOSTED_GRACE_DAYS,
        "numbers": [{
            "id": str(p.id),
            "phone_number": p.phone_number,
            "status": p.hosted_status or "active",
            "paid_until": p.paid_until.isoformat() if p.paid_until else None,
            "monthly_rub": round((p.hosted_price_kopeks or 0) / 100, 2),
        } for p in numbers],
    }


@router.get("/hosted/regions")
async def hosted_regions(
    category: str = Query("GEOGRAPHIC"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_approved(db, current_user)
    try:
        result = await hosted_numbers.list_regions(db, category)
    except HostedError as e:
        raise _http(e)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Не удалось получить регионы")
    return {"success": True, "regions": result["regions"], "total": result["total"]}


@router.get("/hosted/available-numbers")
async def hosted_available_numbers(
    region_id: Optional[int] = Query(None),
    category: Optional[str] = Query(None),
    count: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_approved(db, current_user)
    try:
        result = await hosted_numbers.list_available(db, current_user, region_id, category, count, offset)
    except HostedError as e:
        raise _http(e)
    return {"success": True, **result,
            "balance_rub": round(telephony_wallet.balance(db, current_user.id) / 100, 2)}


class HostedBuyRequest(BaseModel):
    phone_number: Optional[str] = None
    region_id: Optional[int] = None
    category: Optional[str] = None
    stock_id: Optional[str] = None


@router.post("/hosted/buy")
async def hosted_buy(
    body: HostedBuyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_approved(db, current_user)
    try:
        if body.stock_id:
            phone = await hosted_numbers.take_from_stock(db, current_user, uuid.UUID(body.stock_id))
        elif body.phone_number:
            phone = await hosted_numbers.buy_number(
                db, current_user, body.phone_number, body.region_id, body.category,
            )
        else:
            raise HTTPException(status_code=400, detail="Выберите номер")
    except HostedError as e:
        raise _http(e)
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный номер")
    return {"success": True, "phone_id": str(phone.id), "phone_number": phone.phone_number,
            "message": f"Номер {phone.phone_number} подключён"}


@router.delete("/hosted/numbers/{phone_id}")
def hosted_release(
    phone_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    child = hosted_numbers.hosted_account_for(db, current_user.id)
    try:
        pid = uuid.UUID(phone_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Номер не найден")
    phone = db.query(VoximplantPhoneNumber).filter(
        VoximplantPhoneNumber.id == pid,
        VoximplantPhoneNumber.child_account_id == (child.id if child else None),
    ).first() if child else None
    if not phone:
        raise HTTPException(status_code=404, detail="Номер не найден")
    number = phone.phone_number
    try:
        hosted_numbers.release_to_stock(db, phone, "user")
    except HostedError as e:
        raise _http(e)
    verification_bot.notify_admin_soon(
        f"↩️ {verification_bot.esc(current_user.email)} отказался от номера {number} — номер в запасе"
    )
    return {"success": True, "message": f"Номер {number} отключён"}


# =============================================================================
# ТЕЛЕФОННЫЙ КОШЕЛЁК
# =============================================================================

@router.get("/telephony-wallet")
def get_telephony_wallet(
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return {
        "balance_rub": round(telephony_wallet.balance(db, current_user.id) / 100, 2),
        "transactions": telephony_wallet.history(db, current_user.id, limit, offset),
    }


class TelephonyTopupRequest(BaseModel):
    amount_rub: int = Field(..., ge=1, le=100000)


@router.post("/telephony-wallet/topup")
def telephony_wallet_topup(
    body: TelephonyTopupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.amount_rub < settings.TELEPHONY_MIN_TOPUP_RUB:
        raise HTTPException(status_code=400,
                            detail=f"Минимальная сумма пополнения — {settings.TELEPHONY_MIN_TOPUP_RUB} ₽")
    _require_approved(db, current_user)
    from backend.api.credits import _build_robokassa_payment
    payment = _build_robokassa_payment(
        user=current_user,
        amount=float(body.amount_rub),
        description=f"Пополнение телефонного баланса Voicyfy на {body.amount_rub} ₽",
        extra_shp={"Shp_telephony_topup": str(body.amount_rub)},
    )
    tx = PaymentTransaction(
        user_id=current_user.id, plan_id=None, external_payment_id=payment["inv_id"],
        payment_system="robokassa", amount=float(body.amount_rub), currency="RUB",
        status="pending", payment_details=f"Shp_telephony_topup={body.amount_rub}",
    )
    db.add(tx)
    db.commit()
    logger.info(f"[TEL-WALLET] topup created user={current_user.id} amount={body.amount_rub} inv={payment['inv_id']}")
    return {**payment, "transaction_id": str(tx.id)}


# =============================================================================
# АДМИНИСТРАТОР: ЗАЯВКИ
# =============================================================================

@router.get("/admin/verifications")
def admin_list_verifications(
    status_filter: Optional[str] = Query(None, alias="status"),
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    q = db.query(TelephonyVerification, User).join(User, TelephonyVerification.user_id == User.id)
    if status_filter:
        q = q.filter(TelephonyVerification.status == status_filter)
    rows = q.order_by(TelephonyVerification.submitted_at.desc().nullslast()).limit(300).all()
    return {"items": [{**v.to_public(), "user_id": str(u.id), "email": u.email,
                       "has_documents": bool(v.data_key)} for v, u in rows]}


def _details(db: Session, v: TelephonyVerification) -> dict:
    user = db.query(User).filter(User.id == v.user_id).first()
    details = verification.load_details(v) if v.data_key else {"fields": {}, "files": {}}
    return {**v.to_public(), "user_id": str(v.user_id), "email": user.email if user else None,
            "consent_at": v.consent_at.isoformat() if v.consent_at else None,
            "consent_version": v.consent_version, "reviewed_by": v.reviewed_by,
            "purge_after": v.purge_after.isoformat() if v.purge_after else None,
            "history": list(v.history or []),
            "documents_available": bool(v.data_key), **details}


@router.get("/admin/verifications/by-user/{user_id}")
def admin_verification_by_user(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    v = verification.get_for_user(db, uid)
    if not v:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    return _details(db, v)


@router.get("/admin/verifications/{verification_id}")
def admin_verification_details(
    verification_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    try:
        vid = uuid.UUID(verification_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    v = db.query(TelephonyVerification).filter(TelephonyVerification.id == vid).first()
    if not v:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    return _details(db, v)


class DecisionRequest(BaseModel):
    action: str = Field(..., description="approve | revision | reject")
    comment: Optional[str] = None


async def apply_decision(verification_id: uuid.UUID, action: str, comment: Optional[str],
                         reviewer: str) -> TelephonyVerification:
    """Решение из кабинета или Telegram: запись, письмо пользователю, отметка в боте."""
    def _decide():
        db = SessionLocal()
        try:
            v = db.query(TelephonyVerification).filter(TelephonyVerification.id == verification_id).first()
            if not v:
                raise VerificationError("Заявка не найдена", "not_found")
            v = verification.decide(db, v, action, comment, reviewer)
            verification.notify_user(db, v)
            user = db.query(User).filter(User.id == v.user_id).first()
            db.expunge(v)
            return v, (user.email if user else "")
        finally:
            db.close()

    v, email = await asyncio.to_thread(_decide)
    text = f"{verification.STATUS_TEXT.get(v.status, v.status)}: {verification_bot.esc(email)}"
    if v.reviewer_comment:
        text += f"\nКомментарий: {verification_bot.esc(v.reviewer_comment)}"
    text += f"\nРешение: {verification_bot.esc(reviewer)}"
    await verification_bot.mark_decided(list(v.tg_message_ids or []), text)
    return v


@router.post("/admin/verifications/{verification_id}/decision")
async def admin_verification_decision(
    verification_id: str,
    body: DecisionRequest,
    admin: User = Depends(check_admin_access),
):
    try:
        vid = uuid.UUID(verification_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    try:
        v = await apply_decision(vid, body.action, body.comment, admin.email)
    except VerificationError as e:
        raise _http(e)
    return {"success": True, "verification": v.to_public()}


# =============================================================================
# АДМИНИСТРАТОР: НОМЕРА ФИЗЛИЦ
# =============================================================================

@router.get("/admin/hosted-numbers")
async def admin_hosted_numbers(
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    host = hosted_numbers.get_host_account(db)
    if host:
        await hosted_numbers.fill_stock_prices(db, host)
    return hosted_numbers.admin_overview(db)


def _admin_phone(db: Session, phone_id: str) -> VoximplantPhoneNumber:
    try:
        pid = uuid.UUID(phone_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Номер не найден")
    phone = db.query(VoximplantPhoneNumber).filter(VoximplantPhoneNumber.id == pid).first()
    if not phone:
        raise HTTPException(status_code=404, detail="Номер не найден")
    return phone


@router.post("/admin/hosted-numbers/{phone_id}/release")
def admin_release_hosted(
    phone_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    phone = _admin_phone(db, phone_id)
    if not hosted_numbers.is_hosted_phone(phone):
        raise HTTPException(status_code=400, detail="Это не номер физлица")
    hosted_numbers.release_to_stock(db, phone, f"admin {admin.email}")
    return {"success": True}


@router.post("/admin/hosted-numbers/{phone_id}/deactivate")
async def admin_deactivate_stock(
    phone_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    """Отключить номер из запаса в Voximplant (аренда прекращается, необратимо)."""
    from backend.services.voximplant_partner import get_voximplant_partner_service
    phone = _admin_phone(db, phone_id)
    host = hosted_numbers.get_host_account(db)
    if not phone.hosted_stock or not host or phone.child_account_id != host.id:
        raise HTTPException(status_code=400, detail="Отключить можно только номер из запаса")
    service = get_voximplant_partner_service()
    if phone.vox_rule_id:
        await service.delete_rule(child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
                                  rule_id=phone.vox_rule_id)
    result = await service.deactivate_phone_number(
        child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
        phone_id=phone.phone_number_id,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Voximplant отказал")
    number = phone.phone_number
    db.delete(phone)
    db.commit()
    return {"success": True, "message": f"Номер {number} отключён в Voximplant"}


class StockFlagRequest(BaseModel):
    in_stock: bool


@router.put("/admin/hosted-stock/{phone_id}")
def admin_set_stock(
    phone_id: str,
    body: StockFlagRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    """Свой номер администратора-владельца — в запас для физлиц или обратно."""
    phone = _admin_phone(db, phone_id)
    host = hosted_numbers.get_host_account(db)
    if not host or phone.child_account_id != host.id:
        raise HTTPException(status_code=400, detail="В запас можно отдать только номер аккаунта номеров физлиц")
    if phone.is_test_pool and body.in_stock:
        raise HTTPException(status_code=400, detail="Номер в тестовом пуле — сначала уберите его из пула")
    phone.hosted_stock = bool(body.in_stock)
    if body.in_stock:
        hosted_numbers._clear_binding(phone)
    db.commit()
    return {"success": True}


class WalletAdjustRequest(BaseModel):
    email: str
    amount_rub: float = Field(..., ge=-1_000_000, le=1_000_000, description="+ начислить, - списать")
    notes: Optional[str] = None


@router.post("/admin/telephony-wallet/adjust")
def admin_telephony_wallet_adjust(
    body: WalletAdjustRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    user = db.query(User).filter(func.lower(User.email) == body.email.strip().lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    amount = int(round(body.amount_rub * 100))
    if amount == 0:
        raise HTTPException(status_code=400, detail="Укажите сумму")
    if amount > 0:
        telephony_wallet.credit(db, user.id, amount, "manual_adjust",
                                notes=f"{body.notes or 'Начисление администратором'} ({admin.email})")
    else:
        telephony_wallet.debit(db, user.id, -amount, "manual_adjust", allow_partial=True,
                               notes=f"{body.notes or 'Списание администратором'} ({admin.email})")
    balance_rub = round(telephony_wallet.balance(db, user.id) / 100, 2)
    action = "Начислено" if amount > 0 else "Списано"
    logger.info(f"[TEL-WALLET] admin {admin.email}: {action} {abs(amount)} kop → {user.email}, balance {balance_rub}")
    return {"success": True, "balance_rub": balance_rub,
            "message": f"{action} {abs(amount) / 100:.2f} ₽. Телефонный баланс {user.email}: {balance_rub:.2f} ₽"}


# =============================================================================
# TELEGRAM-БОТ МОДЕРАЦИИ
# =============================================================================

@router.post("/verification/telegram/{secret}")
async def verification_bot_webhook(secret: str, request: Request):
    expected = verification_bot.webhook_secret()
    header = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not settings.VERIFICATION_BOT_TOKEN or not (
        hmac.compare_digest(secret, expected) and hmac.compare_digest(header, expected)
    ):
        raise HTTPException(status_code=404)
    try:
        update = await request.json()
        await _handle_bot_update(update)
    except Exception as e:
        logger.error(f"[VERIFY-BOT] update failed: {e}", exc_info=True)
    return {"ok": True}


def _is_admin_chat(chat_id) -> bool:
    return str(chat_id) == str(settings.VERIFICATION_ADMIN_CHAT_ID).strip()


async def _handle_bot_update(update: dict) -> None:
    cq = update.get("callback_query")
    if cq:
        chat_id = ((cq.get("message") or {}).get("chat") or {}).get("id")
        if not _is_admin_chat(chat_id):
            await verification_bot.call("answerCallbackQuery", {"callback_query_id": cq["id"]})
            return
        await _handle_callback(cq)
        return

    msg = update.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    text = (msg.get("text") or "").strip()
    if text in ("/start", "/id"):
        # Помогает узнать chat_id для VERIFICATION_ADMIN_CHAT_ID
        await verification_bot.call("sendMessage", {
            "chat_id": chat_id,
            "text": f"Chat ID этого чата: {chat_id}" + (
                "\nЭтот чат получает заявки на верификацию." if _is_admin_chat(chat_id) else ""),
        })
        return
    if not _is_admin_chat(chat_id):
        return
    reply_to = (msg.get("reply_to_message") or {}).get("message_id")
    if reply_to and text:
        await _handle_comment(reply_to, text, msg.get("from") or {})


def _reviewer(tg_user: dict) -> str:
    name = tg_user.get("username") or tg_user.get("first_name") or ""
    return f"telegram:{name or tg_user.get('id')}"


async def _handle_callback(cq: dict) -> None:
    data = cq.get("data") or ""
    prefix, _, raw_id = data.partition(":")
    answer = {"callback_query_id": cq["id"]}
    try:
        vid = uuid.UUID(raw_id)
    except ValueError:
        await verification_bot.call("answerCallbackQuery", answer)
        return

    def _load():
        db = SessionLocal()
        try:
            v = db.query(TelephonyVerification).filter(TelephonyVerification.id == vid).first()
            if not v:
                return None, None, None
            user = db.query(User).filter(User.id == v.user_id).first()
            return v.status, (user.email if user else ""), v.id
        finally:
            db.close()

    status_value, email, _ = await asyncio.to_thread(_load)
    if status_value is None:
        await verification_bot.call("answerCallbackQuery", {**answer, "text": "Заявка не найдена"})
        return
    if status_value != VerificationStatus.SUBMITTED:
        await verification_bot.call("answerCallbackQuery", {**answer, "text": "Решение уже принято"})
        return

    if prefix == verification_bot.CB_APPROVE:
        await verification_bot.call("answerCallbackQuery", {**answer, "text": "Одобряю…"})
        try:
            await apply_decision(vid, "approve", None, _reviewer(cq.get("from") or {}))
        except VerificationError as e:
            await verification_bot.send_text(f"⚠️ {verification_bot.esc(str(e))}")
        return

    action = "revision" if prefix == verification_bot.CB_REVISION else "reject"
    await verification_bot.call("answerCallbackQuery", answer)
    prompt_id = await verification_bot.ask_comment(str(vid), action, email)
    if not prompt_id:
        return

    def _save_pending():
        db = SessionLocal()
        try:
            v = db.query(TelephonyVerification).filter(TelephonyVerification.id == vid).first()
            if v:
                v.tg_pending = {"prompt_message_id": prompt_id, "action": action}
                db.commit()
        finally:
            db.close()
    await asyncio.to_thread(_save_pending)


async def _handle_comment(reply_to: int, text: str, tg_user: dict) -> None:
    def _find():
        db = SessionLocal()
        try:
            rows = db.query(TelephonyVerification).filter(
                TelephonyVerification.status == VerificationStatus.SUBMITTED,
                TelephonyVerification.tg_pending.isnot(None),
            ).all()
            for v in rows:
                pending = v.tg_pending or {}
                if pending.get("prompt_message_id") == reply_to:
                    return v.id, pending.get("action")
            return None, None
        finally:
            db.close()

    vid, action = await asyncio.to_thread(_find)
    if not vid:
        return
    try:
        await apply_decision(vid, action, text, _reviewer(tg_user))
    except VerificationError as e:
        await verification_bot.send_text(f"⚠️ {verification_bot.esc(str(e))}", reply_to=reply_to)
