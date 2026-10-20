"""
Номера физлиц на аккаунте администратора («hosted»).

Физлицо после нашей верификации своего аккаунта Voximplant не получает:
номера покупаются на верифицированный дочерний аккаунт пользователя
HOSTED_NUMBERS_OWNER_EMAIL (ИП). Для физлица заводится запись
VoximplantChildAccount с is_hosted=True — копия ключей, приложения,
сценариев и правил аккаунта администратора, к которой привязаны только его
номера. Поэтому исходящие, SMS, планировщик, записи и /config работают по
прежним путям без доработок.

Деньги — с телефонного кошелька (services/telephony_wallet.py):
  * покупка: установка + месяц Voximplant + HOSTED_NUMBER_MARKUP_RUB;
  * продление раз в месяц (renew_due): месяц Voximplant + наценка; не хватило —
    номер приостановлен (is_active=False, звонки не идут), через
    HOSTED_GRACE_DAYS дней без оплаты уходит в запас администратора;
  * минуты связи — по себестоимости из GetCallHistory (bill_call).

Запас (hosted_stock) — свободные номера администратора для физлиц: номер,
от которого отказался пользователь или не оплатил, остаётся на аккаунте
администратора и предлагается следующим (без платы за установку).
"""

import calendar
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List

from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.voximplant_child import (
    VoximplantChildAccount, VoximplantPhoneNumber, VoximplantVerificationStatus,
)
from backend.services import telephony_wallet
from backend.services.telephony_wallet import InsufficientTelephonyBalance, rub_to_kopeks

logger = get_logger(__name__)

# Поля аккаунта администратора, которые копируются в hosted-запись
SYNC_FIELDS = (
    "vox_account_id", "vox_account_name", "vox_account_email", "vox_api_key",
    "vox_service_account_id", "vox_service_account_key",
    "vox_application_id", "vox_application_name",
)
SYNC_JSON_FIELDS = ("vox_scenario_ids", "vox_rule_ids")
# Что сохраняем от собственного неверифицированного аккаунта при переходе
BACKUP_FIELDS = SYNC_FIELDS + SYNC_JSON_FIELDS + (
    "vox_subuser_login", "vox_subuser_password", "vox_rule_id",
)

DEFAULT_INBOUND_SCENARIO = "inbound_gemini"
QUOTE_TTL_SECONDS = 3600


class HostedError(Exception):
    """Ошибка с текстом для пользователя."""
    def __init__(self, message: str, code: str = "error"):
        self.code = code
        super().__init__(message)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def add_month(dt: datetime) -> datetime:
    """Тот же день следующего месяца (31 января → 28/29 февраля)."""
    year = dt.year + (1 if dt.month == 12 else 0)
    month = 1 if dt.month == 12 else dt.month + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def digits(phone: str) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit())


def markup_kopeks() -> int:
    return int(settings.HOSTED_NUMBER_MARKUP_RUB) * 100


def monthly_kopeks(vox_monthly_rub) -> int:
    return rub_to_kopeks(vox_monthly_rub or 0) + markup_kopeks()


def first_payment_kopeks(vox_monthly_rub, installation_rub) -> int:
    return rub_to_kopeks(installation_rub or 0) + monthly_kopeks(vox_monthly_rub)


def min_call_balance_kopeks() -> int:
    return int(settings.TELEPHONY_MIN_BALANCE_RUB) * 100


# =============================================================================
# АККАУНТ АДМИНИСТРАТОРА И HOSTED-ЗАПИСИ
# =============================================================================

def get_host_account(db: Session) -> Optional[VoximplantChildAccount]:
    """Дочерний аккаунт владельца номеров физлиц (настоящий, не hosted)."""
    email = (settings.HOSTED_NUMBERS_OWNER_EMAIL or "").strip().lower()
    if not email:
        return None
    owner = db.query(User).filter(func.lower(User.email) == email).first()
    if not owner:
        return None
    return db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == owner.id,
        VoximplantChildAccount.is_hosted.is_(False),
    ).first()


def require_host_account(db: Session) -> VoximplantChildAccount:
    host = get_host_account(db)
    if not host or not host.is_verified or not host.vox_application_id:
        raise HostedError(
            "Номера для физлиц временно недоступны: аккаунт телефонии платформы не настроен",
            "host_not_ready",
        )
    return host


def sync_from_host(row: VoximplantChildAccount, host: VoximplantChildAccount) -> None:
    for field in SYNC_FIELDS:
        setattr(row, field, getattr(host, field))
    for field in SYNC_JSON_FIELDS:
        setattr(row, field, dict(getattr(host, field) or {}))
    row.host_child_account_id = host.id
    row.vox_subuser_login = None
    row.vox_subuser_password = None
    row.vox_rule_id = None
    row.verification_status = VoximplantVerificationStatus.verified
    row.verified_at = row.verified_at or _now()
    row.is_active = bool(host.is_active)


def hosted_account_for(db: Session, user_id) -> Optional[VoximplantChildAccount]:
    return db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == user_id,
        VoximplantChildAccount.is_hosted.is_(True),
    ).first()


def ensure_hosted_account(db: Session, user: User) -> VoximplantChildAccount:
    """
    Завести (или обновить) hosted-запись физлица. Если у пользователя уже был
    собственный неверифицированный аккаунт без номеров — запись переводится в
    hosted, его поля сохраняются в hosted_backup. Собственный верифицированный
    аккаунт не трогаем: такому пользователю номера на аккаунте админа не нужны.
    """
    host = require_host_account(db)
    row = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == user.id
    ).first()
    if row and not row.is_hosted:
        if row.is_verified:
            raise HostedError("У вас уже есть свой верифицированный аккаунт телефонии", "own_verified")
        if row.phone_numbers:
            raise HostedError("На вашем аккаунте телефонии уже есть номера — обратитесь в поддержку",
                              "own_has_numbers")
        row.hosted_backup = {
            f: (dict(getattr(row, f) or {}) if f in SYNC_JSON_FIELDS else getattr(row, f))
            for f in BACKUP_FIELDS
        }
        row.hosted_backup["verification_status"] = row.verification_status.value \
            if row.verification_status else None
        row.is_hosted = True
    elif not row:
        row = VoximplantChildAccount(user_id=user.id, is_hosted=True)
        db.add(row)
    sync_from_host(row, host)
    db.commit()
    db.refresh(row)
    logger.info(f"[HOSTED] account ready for {user.email} on host {host.vox_account_id}")
    return row


def sync_all_hosted(db: Session) -> int:
    """Обновить копии ключей/сценариев/правил во всех hosted-записях."""
    host = get_host_account(db)
    if not host:
        return 0
    rows = db.query(VoximplantChildAccount).filter(VoximplantChildAccount.is_hosted.is_(True)).all()
    for row in rows:
        sync_from_host(row, host)
    if rows:
        db.commit()
    return len(rows)


def is_hosted_user(db: Session, user_id) -> bool:
    return hosted_account_for(db, user_id) is not None


# =============================================================================
# ВЫБОР И ПОКУПКА НОМЕРА
# =============================================================================

# Котировки, которые пользователь видел в списке: {user_id: {digits: {...}}}.
# Цену при покупке берём отсюда, а не из запроса клиента.
_QUOTES: Dict[str, Dict[str, Dict[str, Any]]] = {}


def _remember_quotes(user_id, numbers: List[dict]) -> None:
    now = time.time()
    bucket = _QUOTES.setdefault(str(user_id), {})
    for key in [k for k, v in bucket.items() if now - v["ts"] > QUOTE_TTL_SECONDS]:
        bucket.pop(key, None)
    for n in numbers:
        bucket[digits(n["phone_number"])] = {**n, "ts": now}


def _quote(user_id, phone_number: str) -> Optional[dict]:
    q = _QUOTES.get(str(user_id), {}).get(digits(phone_number))
    if q and time.time() - q["ts"] <= QUOTE_TTL_SECONDS:
        return q
    return None


def _price_view(vox_monthly, installation) -> dict:
    return {
        "monthly_rub": round(monthly_kopeks(vox_monthly) / 100, 2),
        "first_payment_rub": round(first_payment_kopeks(vox_monthly, installation) / 100, 2),
    }


def stock_numbers(db: Session, host: VoximplantChildAccount) -> List[VoximplantPhoneNumber]:
    return db.query(VoximplantPhoneNumber).filter(
        VoximplantPhoneNumber.child_account_id == host.id,
        VoximplantPhoneNumber.hosted_stock.is_(True),
        VoximplantPhoneNumber.is_test_pool.is_(False),
    ).order_by(VoximplantPhoneNumber.purchased_at).all()


async def list_regions(db: Session, category: str) -> dict:
    from backend.services.voximplant_partner import get_voximplant_partner_service
    host = require_host_account(db)
    return await get_voximplant_partner_service().get_phone_regions(
        child_account_id=host.vox_account_id, child_api_key=host.vox_api_key, category=category,
    )


async def list_available(db: Session, user: User, region_id: Optional[int],
                         category: Optional[str], count: int, offset: int) -> dict:
    from backend.services.voximplant_partner import get_voximplant_partner_service
    host = require_host_account(db)
    result = await get_voximplant_partner_service().get_available_numbers(
        child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
        region_id=region_id if region_id and region_id > 0 else None,
        category=category, count=count, offset=offset,
    )
    if not result.get("success"):
        raise HostedError(result.get("error") or "Не удалось получить список номеров")
    numbers = []
    for n in result["numbers"]:
        numbers.append({
            "phone_number": n["phone_number"],
            "region": n.get("phone_region_name"),
            "vox_monthly_rub": n.get("phone_price"),
            "vox_installation_rub": n.get("phone_installation_price"),
            **_price_view(n.get("phone_price"), n.get("phone_installation_price")),
        })
    _remember_quotes(user.id, numbers)

    stock = []
    if offset == 0:
        for p in stock_numbers(db, host):
            vox_monthly = float(p.vox_monthly_price) if p.vox_monthly_price else None
            stock.append({
                "id": str(p.id),
                "phone_number": p.phone_number,
                "region": p.phone_region,
                "vox_monthly_rub": vox_monthly,
                **_price_view(vox_monthly, 0),
            })
    return {"numbers": numbers, "stock": stock, "total": result.get("total", len(numbers))}


async def _enable_sms(account_id: str, api_key: str, phone_number: str) -> None:
    """Включить SMS на номере, если оператор поддерживает (как в /buy-number)."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            info = (await client.get(
                "https://api.voximplant.com/platform_api/GetPhoneNumbers/",
                params={"account_id": account_id, "api_key": api_key,
                        "phone_number": digits(phone_number)},
            )).json().get("result") or []
            if info and info[0].get("is_sms_supported") and not info[0].get("is_sms_enabled"):
                await client.get(
                    "https://api.voximplant.com/platform_api/ControlSms/",
                    params={"account_id": account_id, "api_key": api_key,
                            "phone_number": digits(phone_number), "command": "enable"},
                )
    except Exception as e:
        logger.warning(f"[HOSTED] SMS enable failed for {phone_number}: {e}")


async def _fetch_vox_monthly(host: VoximplantChildAccount, phone_number: str) -> Optional[float]:
    from backend.services.voximplant_partner import get_voximplant_partner_service
    try:
        res = await get_voximplant_partner_service().get_phone_numbers(
            child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
        )
        for n in res.get("numbers", []) if res.get("success") else []:
            if digits(n.get("phone_number"))[-10:] == digits(phone_number)[-10:]:
                return float(n["phone_price"]) if n.get("phone_price") is not None else None
    except Exception as e:
        logger.warning(f"[HOSTED] price lookup failed for {phone_number}: {e}")
    return None


def _activate_rental(phone: VoximplantPhoneNumber, vox_monthly: Optional[float]) -> None:
    phone.hosted_stock = False
    phone.hosted_status = "active"
    phone.hosted_suspended_at = None
    phone.is_active = True
    phone.vox_monthly_price = None if vox_monthly is None else str(vox_monthly)
    phone.hosted_price_kopeks = monthly_kopeks(vox_monthly)
    phone.paid_until = add_month(_now())


async def buy_number(db: Session, user: User, phone_number: str,
                     region_id: Optional[int] = None, category: Optional[str] = None) -> VoximplantPhoneNumber:
    """Купить номер с рынка Voximplant на аккаунт администратора для физлица."""
    from backend.services.voximplant_partner import get_voximplant_partner_service
    from backend.api.telephony import validate_phone_id

    row = ensure_hosted_account(db, user)
    host = require_host_account(db)
    quote = _quote(user.id, phone_number)
    if not quote and (region_id or category):
        await list_available(db, user, region_id, category, 100, 0)
        quote = _quote(user.id, phone_number)
    if not quote:
        raise HostedError("Цена номера устарела — обновите список и выберите номер ещё раз", "quote_expired")

    vox_monthly = quote.get("vox_monthly_rub")
    first = first_payment_kopeks(vox_monthly, quote.get("vox_installation_rub"))
    current = telephony_wallet.balance(db, user.id)
    if current < first:
        raise HostedError(
            f"Недостаточно средств на телефонном балансе: нужно {first / 100:.2f} ₽, "
            f"на балансе {current / 100:.2f} ₽", "insufficient_funds",
        )

    service = get_voximplant_partner_service()
    bought = await service.buy_phone_number(
        child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
        phone_number=phone_number,
    )
    if not bought.get("success"):
        raise HostedError(bought.get("error") or "Voximplant отказал в покупке номера")
    phone_id = validate_phone_id(bought.get("phone_id"))
    if not phone_id:
        raise HostedError("Номер куплен, но Voximplant не вернул его ID — напишите в поддержку")

    rule_id = None
    await service.bind_phone_to_application(
        child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
        phone_id=phone_id, application_id=host.vox_application_id,
    )
    scenario_id = host.get_scenario_id(DEFAULT_INBOUND_SCENARIO)
    if scenario_id:
        pattern = digits(phone_number)
        rule = await service.add_rule(
            child_account_id=host.vox_account_id, child_api_key=host.vox_api_key,
            application_id=host.vox_application_id, rule_name=f"inbound_{pattern}",
            rule_pattern=pattern, scenario_id=scenario_id,
        )
        if rule.get("success"):
            rule_id = str(rule.get("rule_id"))

    phone = VoximplantPhoneNumber(
        child_account_id=row.id, phone_number=phone_number, phone_number_id=phone_id,
        phone_region=quote.get("region"), vox_rule_id=rule_id, caller_id=phone_number,
    )
    actual_monthly = await _fetch_vox_monthly(host, phone_number)
    _activate_rental(phone, actual_monthly if actual_monthly is not None else vox_monthly)
    db.add(phone)
    db.flush()
    try:
        telephony_wallet.debit(
            db, user.id, first, "number", ref_key=f"hosted_buy:{phone.id}",
            phone_number=phone_number,
            notes=f"Покупка номера {phone_number}: установка и первый месяц", commit=False,
        )
        db.commit()
    except InsufficientTelephonyBalance:
        # Баланс успели потратить между проверкой и покупкой — номер в запас админа
        db.rollback()
        stock = VoximplantPhoneNumber(
            child_account_id=host.id, phone_number=phone_number, phone_number_id=phone_id,
            phone_region=quote.get("region"), vox_rule_id=rule_id, caller_id=phone_number,
            hosted_stock=True, vox_monthly_price=None if actual_monthly is None else str(actual_monthly),
        )
        db.add(stock)
        db.commit()
        raise HostedError("Недостаточно средств на телефонном балансе", "insufficient_funds")

    await _enable_sms(host.vox_account_id, host.vox_api_key, phone_number)
    from backend.services import verification_bot
    verification_bot.notify_admin_soon(
        f"📞 {verification_bot.esc(user.email)} купил номер {verification_bot.esc(phone_number)} "
        f"(физлицо, списано {first / 100:.2f} ₽)"
    )
    logger.info(f"[HOSTED] {user.email} bought {phone_number}, charged {first} kop")
    return phone


async def take_from_stock(db: Session, user: User, phone_id) -> VoximplantPhoneNumber:
    """Взять номер из запаса администратора (без платы за установку)."""
    row = ensure_hosted_account(db, user)
    host = require_host_account(db)
    phone = db.query(VoximplantPhoneNumber).filter(
        VoximplantPhoneNumber.id == phone_id,
        VoximplantPhoneNumber.child_account_id == host.id,
        VoximplantPhoneNumber.hosted_stock.is_(True),
    ).with_for_update().first()
    if not phone or phone.is_test_pool:
        raise HostedError("Номер уже занят — выберите другой", "not_available")

    vox_monthly = await _fetch_vox_monthly(host, phone.phone_number)
    if vox_monthly is None and phone.vox_monthly_price:
        vox_monthly = float(phone.vox_monthly_price)
    price = monthly_kopeks(vox_monthly)
    try:
        telephony_wallet.debit(
            db, user.id, price, "number", ref_key=f"hosted_stock:{phone.id}:{int(time.time())}",
            phone_number=phone.phone_number, notes=f"Номер {phone.phone_number}: первый месяц",
            commit=False,
        )
    except InsufficientTelephonyBalance as e:
        db.rollback()
        raise HostedError(
            f"Недостаточно средств на телефонном балансе: нужно {price / 100:.2f} ₽, "
            f"на балансе {e.balance / 100:.2f} ₽", "insufficient_funds",
        )
    _clear_binding(phone)
    phone.child_account = row
    _activate_rental(phone, vox_monthly)
    db.commit()
    from backend.services import verification_bot
    verification_bot.notify_admin_soon(
        f"📞 {verification_bot.esc(user.email)} взял из запаса номер "
        f"{verification_bot.esc(phone.phone_number)} (списано {price / 100:.2f} ₽)"
    )
    return phone


def _clear_binding(phone: VoximplantPhoneNumber) -> None:
    phone.assistant_type = None
    phone.assistant_id = None
    phone.agent_config_id = None
    phone.first_phrase = None


def release_to_stock(db: Session, phone: VoximplantPhoneNumber, reason: str) -> None:
    """Вернуть номер физлица в запас администратора (номер остаётся у Voximplant)."""
    host = get_host_account(db)
    if not host:
        raise HostedError("Аккаунт администратора не найден", "host_not_ready")
    _clear_binding(phone)
    phone.child_account = host
    phone.hosted_stock = True
    phone.hosted_status = None
    phone.hosted_suspended_at = None
    phone.paid_until = None
    phone.hosted_price_kopeks = None
    phone.is_active = True
    db.commit()
    logger.info(f"[HOSTED] {phone.phone_number} returned to stock ({reason})")


def is_hosted_phone(phone: VoximplantPhoneNumber) -> bool:
    child = phone.child_account
    return bool(child and child.is_hosted)


# =============================================================================
# ПРОДЛЕНИЕ И ПРИОСТАНОВКА
# =============================================================================

def _notify_user(user: User, subject: str, text: str) -> None:
    try:
        from backend.services.email_service import EmailService
        EmailService._send_email_smtp(
            user.email, subject,
            f"<div style='font-family:Arial,sans-serif;font-size:15px;line-height:1.5'>{text}</div>",
        )
    except Exception as e:
        logger.warning(f"[HOSTED] email to {user.email} failed: {e}")


def renew_due(db: Session) -> dict:
    """
    Продлить номера физлиц, у которых закончился оплаченный месяц.
    Синхронная функция: вызывать через asyncio.to_thread.
    """
    from backend.services import verification_bot
    now = _now()
    stats = {"renewed": 0, "suspended": 0, "released": 0}
    phones = db.query(VoximplantPhoneNumber).join(
        VoximplantChildAccount, VoximplantPhoneNumber.child_account_id == VoximplantChildAccount.id
    ).filter(
        VoximplantChildAccount.is_hosted.is_(True),
        VoximplantPhoneNumber.paid_until.isnot(None),
        VoximplantPhoneNumber.paid_until <= now,
    ).all()
    for phone in phones:
        user = db.query(User).filter(User.id == phone.child_account.user_id).first()
        if not user:
            continue
        due = _aware(phone.paid_until)
        price = int(phone.hosted_price_kopeks or monthly_kopeks(phone.vox_monthly_price))
        try:
            telephony_wallet.debit(
                db, user.id, price, "renewal",
                ref_key=f"hosted_renew:{phone.id}:{due.date().isoformat()}",
                phone_number=phone.phone_number,
                notes=f"Продление номера {phone.phone_number} до {add_month(due).date().isoformat()}",
                commit=False,
            )
            was_suspended = phone.hosted_status == "suspended"
            phone.paid_until = add_month(due)
            phone.hosted_status = "active"
            phone.hosted_suspended_at = None
            phone.is_active = True
            db.commit()
            stats["renewed"] += 1
            if was_suspended:
                verification_bot.notify_admin_soon(
                    f"✅ Номер {phone.phone_number} ({verification_bot.esc(user.email)}) оплачен и снова работает"
                )
            continue
        except InsufficientTelephonyBalance:
            db.rollback()

        if phone.hosted_status != "suspended":
            phone.hosted_status = "suspended"
            phone.hosted_suspended_at = now
            phone.is_active = False
            db.commit()
            stats["suspended"] += 1
            _notify_user(
                user, "Номер приостановлен: пополните телефонный баланс",
                f"Не хватило средств на продление номера {phone.phone_number} "
                f"({price / 100:.2f} ₽ в месяц). Звонки на номер приостановлены. "
                f"Пополните телефонный баланс в разделе «Телефония» в течение "
                f"{settings.HOSTED_GRACE_DAYS} дней, иначе номер будет освобождён.",
            )
            verification_bot.notify_admin_soon(
                f"⏸ Номер {phone.phone_number} ({verification_bot.esc(user.email)}) приостановлен: "
                f"не хватило {price / 100:.2f} ₽ на продление"
            )
        elif now - _aware(phone.hosted_suspended_at or now) >= timedelta(days=settings.HOSTED_GRACE_DAYS):
            number = phone.phone_number
            release_to_stock(db, phone, "unpaid")
            stats["released"] += 1
            _notify_user(
                user, "Номер освобождён",
                f"Номер {number} освобождён: продление не было оплачено "
                f"{settings.HOSTED_GRACE_DAYS} дней.",
            )
            verification_bot.notify_admin_soon(
                f"🔓 Номер {number} ({verification_bot.esc(user.email)}) не оплачен "
                f"{settings.HOSTED_GRACE_DAYS} дн. и возвращён в запас. "
                f"Отключите его в Voximplant, если он больше не нужен."
            )
    return stats


# =============================================================================
# ЗВОНКИ
# =============================================================================

def call_allowed(db: Session, child: VoximplantChildAccount, user_id) -> bool:
    """Шлагбаум звонка физлица: минимум на телефонном кошельке."""
    if not child or not child.is_hosted:
        return True
    return telephony_wallet.balance(db, user_id) >= min_call_balance_kopeks()


def bill_call(db: Session, user_id, conversation_id: str, cost_rub: float,
              rule_name: Optional[str]) -> Optional[int]:
    """
    Списать себестоимость звонка Voximplant с телефонного кошелька физлица.
    Входящие на чужие номера (тестовый пул: правило inbound_<номер> не из
    номеров пользователя) бесплатны. Повторный вызов по тому же диалогу не
    спишет второй раз.
    """
    child = hosted_account_for(db, user_id)
    if not child or not cost_rub or float(cost_rub) <= 0:
        return None
    if rule_name and rule_name.startswith("inbound_"):
        own = {digits(p.phone_number) for p in child.phone_numbers or []}
        if digits(rule_name[len("inbound_"):]) not in own:
            return None
    amount = rub_to_kopeks(cost_rub)
    telephony_wallet.debit(
        db, user_id, amount, "call", ref_key=f"hosted_call:{conversation_id}",
        allow_partial=True, notes=f"Связь Voximplant, диалог {conversation_id}",
    )
    return amount


def bill_call_by_conversation(conversation_id: str, cost_result: Dict[str, Any]) -> None:
    """bill_call по диалогу из отложенного пересчёта (своя сессия, вызывать в потоке)."""
    from backend.db.session import SessionLocal
    from backend.models.conversation import Conversation
    import uuid as _uuid
    db = SessionLocal()
    try:
        conv = db.query(Conversation).filter(Conversation.id == _uuid.UUID(str(conversation_id))).first()
        if not conv or not conv.assistant_id:
            return
        from backend.api.telephony import find_assistant_by_id
        _, _, user_id = find_assistant_by_id(db, conv.assistant_id)
        if not user_id:
            return
        cost = conv.call_cost if conv.call_cost is not None else cost_result.get("total_cost")
        rule_name = (cost_result.get("details") or {}).get("rule_name")
        bill_call(db, user_id, str(conversation_id), float(cost or 0), rule_name)
    except Exception as e:
        logger.error(f"[HOSTED] bill call {conversation_id} failed: {e}")
        db.rollback()
    finally:
        db.close()


# =============================================================================
# ОБЗОР ДЛЯ АДМИНИСТРАТОРА
# =============================================================================

def admin_overview(db: Session) -> dict:
    from backend.models.telephony_verification import TelephonyVerification
    host = get_host_account(db)
    rented = []
    rows = db.query(VoximplantPhoneNumber, VoximplantChildAccount, User).join(
        VoximplantChildAccount, VoximplantPhoneNumber.child_account_id == VoximplantChildAccount.id
    ).join(User, VoximplantChildAccount.user_id == User.id).filter(
        VoximplantChildAccount.is_hosted.is_(True)
    ).order_by(VoximplantPhoneNumber.purchased_at.desc()).all()
    verif = {
        v.user_id: v for v in db.query(TelephonyVerification).filter(
            TelephonyVerification.user_id.in_([u.id for _, _, u in rows] or [None])
        ).all()
    }
    for phone, _child, user in rows:
        v = verif.get(user.id)
        rented.append({
            "id": str(phone.id),
            "phone_number": phone.phone_number,
            "user_id": str(user.id),
            "email": user.email,
            "verification_id": str(v.id) if v else None,
            "status": phone.hosted_status or "active",
            "paid_until": phone.paid_until.isoformat() if phone.paid_until else None,
            "monthly_rub": round((phone.hosted_price_kopeks or 0) / 100, 2),
            "assistant_type": phone.assistant_type,
            "telephony_balance_rub": round((user.telephony_balance or 0) / 100, 2),
        })
    stock = [{
        "id": str(p.id),
        "phone_number": p.phone_number,
        "region": p.phone_region,
        "vox_monthly_rub": float(p.vox_monthly_price) if p.vox_monthly_price else None,
    } for p in (stock_numbers(db, host) if host else [])]
    return {
        "host_ready": bool(host and host.is_verified and host.vox_application_id),
        "host_account_id": host.vox_account_id if host else None,
        "rented": rented,
        "stock": stock,
    }
