"""
Сервис тестовых номеров телефонии.

Пул — номера из voximplant_phone_numbers с is_test_pool = true (номера
дочернего аккаунта администратора). Пользователь один раз включает
свободный номер на settings.TEST_NUMBER_LEASE_MINUTES минут:

  start()    — выбрать свободный номер, пересоздать inbound-правило Voximplant
               под тип ассистента пользователя, привязать ассистента к номеру,
               записать аренду;
  release()  — снять привязку и вернуть номер в пул (досрочно или по сроку);
  expire_due() — фоновая уборка истёкших аренд (планировщик, раз в 30 с);
  status()   — состояние для ЛК: моя аренда, свободные номера, ближайшее
               освобождение, «уже использовал».

Лимит: одна базовая попытка на пользователя + дополнительные попытки,
выданные админом (TestNumberGrant, каждая со своей длительностью).
Попытки тратятся по порядку: сначала базовая, затем гранты от старых к новым.

Ключи и списание: при входящем звонке /api/telephony/config берёт
пользователя из активной аренды (а не владельца номера), поэтому звонок
идёт на ключах арендатора или на серверных ключах с его кошелька.
Исходящие с тестового номера невозможны: все точки выбора caller_id
берут номера только из дочернего аккаунта владельца ассистента.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.voximplant_child import VoximplantPhoneNumber, VoximplantChildAccount
from backend.models.test_number_lease import TestNumberLease, TestNumberGrant

logger = get_logger(__name__)

# Голосовые ассистенты, которых можно посадить на тестовый номер
# (без агентов обзвора и без скрытой Cartesia).
ALLOWED_ASSISTANT_TYPES = ("openai", "gemini", "cascade", "fish", "yandex")


class TestNumberError(Exception):
    """Ошибка бизнес-логики с человекочитаемым текстом для 400."""

    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.message = message
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def load_voice_assistant(db: Session, assistant_type: str, assistant_id: uuid.UUID,
                         user_id: Optional[uuid.UUID] = None):
    """
    Найти голосового ассистента по типу. Если передан user_id — только
    принадлежащего этому пользователю. Возвращает ORM-объект или None.
    """
    assistant_type = (assistant_type or "").lower()
    if assistant_type == "openai":
        from backend.models.assistant import AssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id)
    elif assistant_type == "gemini":
        from backend.models.gemini_assistant import GeminiAssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id)
    elif assistant_type == "cascade":
        from backend.models.grok_assistant import GrokAssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id, M.assistant_type == "cascade")
    elif assistant_type == "fish":
        from backend.models.fish_assistant import FishAssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id)
    elif assistant_type == "yandex":
        from backend.models.yandex_assistant import YandexAssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id)
    elif assistant_type == "cartesia":
        from backend.models.cartesia_assistant import CartesiaAssistantConfig as M
        q = db.query(M).filter(M.id == assistant_id)
    else:
        return None
    if user_id is not None:
        q = q.filter(M.user_id == user_id)
    return q.first()


class TestNumberService:

    # ------------------------------------------------------------------
    # Запросы
    # ------------------------------------------------------------------

    @staticmethod
    def lease_minutes() -> int:
        try:
            return max(1, int(settings.TEST_NUMBER_LEASE_MINUTES))
        except Exception:
            return 10

    @staticmethod
    def pool_query(db: Session):
        return db.query(VoximplantPhoneNumber).filter(
            VoximplantPhoneNumber.is_test_pool == True,  # noqa: E712
            VoximplantPhoneNumber.is_active == True,     # noqa: E712
        )

    @classmethod
    def active_leases(cls, db: Session) -> List[TestNumberLease]:
        return db.query(TestNumberLease).filter(
            TestNumberLease.released_at.is_(None),
            TestNumberLease.expires_at > _now(),
        ).all()

    @classmethod
    def active_lease_for_phone(cls, db: Session, phone_number_id: uuid.UUID) -> Optional[TestNumberLease]:
        return db.query(TestNumberLease).filter(
            TestNumberLease.phone_number_id == phone_number_id,
            TestNumberLease.released_at.is_(None),
            TestNumberLease.expires_at > _now(),
        ).order_by(TestNumberLease.started_at.desc()).first()

    @classmethod
    def active_lease_for_user(cls, db: Session, user_id: uuid.UUID) -> Optional[TestNumberLease]:
        return db.query(TestNumberLease).filter(
            TestNumberLease.user_id == user_id,
            TestNumberLease.released_at.is_(None),
            TestNumberLease.expires_at > _now(),
        ).order_by(TestNumberLease.started_at.desc()).first()

    @classmethod
    def last_lease_for_user(cls, db: Session, user_id: uuid.UUID) -> Optional[TestNumberLease]:
        return db.query(TestNumberLease).filter(
            TestNumberLease.user_id == user_id,
        ).order_by(TestNumberLease.started_at.desc()).first()

    @classmethod
    def unused_grants(cls, db: Session, user_id: uuid.UUID) -> List[TestNumberGrant]:
        return db.query(TestNumberGrant).filter(
            TestNumberGrant.user_id == user_id,
            TestNumberGrant.lease_id.is_(None),
        ).order_by(TestNumberGrant.created_at.asc()).all()

    @classmethod
    def attempts(cls, db: Session, user: User) -> Dict[str, Any]:
        """
        Попытки пользователя: базовая (одна) + гранты админа.

        Возвращает total, used, can_start, next_minutes и грант, который
        будет потрачен следующим включением (None — базовая попытка).
        """
        leases_count = db.query(TestNumberLease).filter(TestNumberLease.user_id == user.id).count()
        grants_total = db.query(TestNumberGrant).filter(TestNumberGrant.user_id == user.id).count()
        unused = cls.unused_grants(db, user.id)
        is_admin = bool(getattr(user, "is_admin", False))
        if leases_count == 0:
            next_grant, next_minutes = None, cls.lease_minutes()
        elif unused:
            next_grant, next_minutes = unused[0], max(1, int(unused[0].minutes or cls.lease_minutes()))
        else:
            next_grant, next_minutes = None, cls.lease_minutes()
        can_start = is_admin or leases_count == 0 or bool(unused)
        return {
            "total": 1 + grants_total,
            "used": leases_count,
            "can_start": can_start,
            "next_minutes": next_minutes,
            "next_grant": next_grant,
        }

    @classmethod
    def user_can_start(cls, db: Session, user: User) -> bool:
        """Базовая попытка + гранты админа. Админы — без ограничений."""
        return cls.attempts(db, user)["can_start"]

    @classmethod
    def status(cls, db: Session, user: User) -> Dict[str, Any]:
        """
        Состояние для ЛК пользователя.

        state:
          'active'    — у пользователя идёт аренда (lease)
          'used'      — попытка уже потрачена (last_lease)
          'available' — можно включить, есть свободный номер
          'busy'      — свободных номеров нет, next_free_in_seconds
          'no_pool'   — пул пуст (фича не настроена) — карточку не показывать
        """
        pool = cls.pool_query(db).all()
        leases = cls.active_leases(db)
        busy_ids = {l.phone_number_id for l in leases}
        free = [p for p in pool if p.id not in busy_ids]

        my = cls.active_lease_for_user(db, user.id)
        last = cls.last_lease_for_user(db, user.id)
        att = cls.attempts(db, user)
        can_start = att["can_start"]

        next_free_in = None
        if pool and not free:
            soonest = min((_aware(l.expires_at) for l in leases if l.phone_number_id in {p.id for p in pool}),
                          default=None)
            if soonest:
                next_free_in = max(0, int((soonest - _now()).total_seconds()))

        if my:
            state = "active"
        elif not pool:
            state = "no_pool"
        elif not can_start:
            state = "used"
        elif free:
            state = "available"
        else:
            state = "busy"

        return {
            "state": state,
            "lease_minutes": cls.lease_minutes(),
            # Сколько минут даст СЛЕДУЮЩЕЕ включение (грант админа может отличаться)
            "next_attempt_minutes": att["next_minutes"],
            "attempts_total": att["total"],
            "attempts_used": att["used"],
            "pool_total": len(pool),
            "pool_free": len(free),
            "next_free_in_seconds": next_free_in,
            "can_start": can_start and state in ("available", "busy"),
            "allowed_assistant_types": list(ALLOWED_ASSISTANT_TYPES),
            "lease": my.to_dict() if my else None,
            "last_lease": last.to_dict() if (last and not my) else None,
        }

    # ------------------------------------------------------------------
    # Действия
    # ------------------------------------------------------------------

    @classmethod
    async def start(cls, db: Session, user: User, assistant_type: str,
                    assistant_id: uuid.UUID) -> TestNumberLease:
        assistant_type = (assistant_type or "").lower()
        if assistant_type not in ALLOWED_ASSISTANT_TYPES:
            raise TestNumberError(
                "На тестовый номер можно посадить только голосового ассистента "
                "(OpenAI, Gemini, Каскад, Fish Audio, Яндекс)", "bad_type")

        if cls.active_lease_for_user(db, user.id):
            raise TestNumberError("Тестовый номер уже включён", "already_active")
        att = cls.attempts(db, user)
        if not att["can_start"]:
            raise TestNumberError("Тестовый номер можно включить только один раз", "used")
        grant: Optional[TestNumberGrant] = att["next_grant"]

        assistant = load_voice_assistant(db, assistant_type, assistant_id, user.id)
        if not assistant:
            raise TestNumberError("Ассистент не найден", "assistant_not_found")

        # Шлагбаум кошелька — как при обычном входящем звонке: свой ключ →
        # бесплатно, серверный ключ → на кошельке должен быть минимум на старт.
        from backend.api.telephony import resolve_scenario_keys
        keys, allowed, billing_mode = resolve_scenario_keys(db, user, assistant_type, "[TEST-NUMBER]")
        if not keys.available:
            raise TestNumberError(
                "Для этой модели нет ключа: добавьте свой API-ключ в настройках", "no_key")
        if not allowed:
            from backend.services.wallet_service import WalletService, TELEPHONY_START_MINUTES
            _, balance, required = WalletService.precheck(db, user.id, assistant_type, TELEPHONY_START_MINUTES)
            raise TestNumberError(
                f"Пополните кошелёк: для старта нужно {required / 100:.0f} ₽, "
                f"на балансе {balance / 100:.2f} ₽", "wallet")

        # Свободный номер из пула
        pool = cls.pool_query(db).order_by(VoximplantPhoneNumber.purchased_at.asc()).all()
        busy_ids = {l.phone_number_id for l in cls.active_leases(db)}
        phone = next((p for p in pool if p.id not in busy_ids), None)
        if not phone:
            raise TestNumberError("Все тестовые номера сейчас заняты, попробуйте позже", "busy")

        # Пересоздаём inbound-правило на аккаунте владельца номера (админа)
        from backend.api.telephony import rebind_inbound_rule
        child_account: VoximplantChildAccount = phone.child_account
        rule_ok = await rebind_inbound_rule(child_account, phone, assistant_type, "[TEST-NUMBER]")
        if not rule_ok:
            raise TestNumberError(
                "Не удалось настроить маршрутизацию номера, попробуйте позже", "rule_failed")

        minutes = att["next_minutes"]
        now = _now()
        lease = TestNumberLease(
            user_id=user.id,
            phone_number_id=phone.id,
            phone_number=phone.phone_number,
            assistant_type=assistant_type,
            assistant_id=assistant.id,
            assistant_name=getattr(assistant, "name", None),
            started_at=now,
            expires_at=now + timedelta(minutes=minutes),
        )
        phone.assistant_type = assistant_type
        phone.assistant_id = assistant.id
        phone.agent_config_id = None
        phone.first_phrase = None
        db.add(lease)
        db.add(phone)
        db.flush()
        if grant is not None:
            grant.lease_id = lease.id
            grant.used_at = now
            db.add(grant)
        db.commit()
        db.refresh(lease)
        logger.info(
            f"[TEST-NUMBER] ▶️ Lease started: {phone.phone_number} → user {user.email} "
            f"({assistant_type}:{assistant.id}) for {minutes} min, billing={billing_mode}"
            + (f", grant={grant.id}" if grant is not None else "")
        )
        return lease

    @classmethod
    def _release_lease(cls, db: Session, lease: TestNumberLease, reason: str) -> None:
        lease.released_at = _now()
        lease.release_reason = reason
        db.add(lease)
        if lease.phone_number_id:
            phone = db.query(VoximplantPhoneNumber).filter(
                VoximplantPhoneNumber.id == lease.phone_number_id
            ).first()
            # Снимаем привязку, только если номер всё ещё держит этого ассистента
            if phone and phone.assistant_id == lease.assistant_id:
                phone.assistant_type = None
                phone.assistant_id = None
                phone.agent_config_id = None
                phone.first_phrase = None
                db.add(phone)
        logger.info(f"[TEST-NUMBER] ⏹ Lease released ({reason}): {lease.phone_number} user={lease.user_id}")

    @classmethod
    def release(cls, db: Session, user: User, reason: str = "user") -> Optional[TestNumberLease]:
        lease = cls.active_lease_for_user(db, user.id)
        if not lease:
            return None
        cls._release_lease(db, lease, reason)
        db.commit()
        return lease

    @classmethod
    def release_by_id(cls, db: Session, lease_id: uuid.UUID, reason: str = "admin") -> Optional[TestNumberLease]:
        lease = db.query(TestNumberLease).filter(TestNumberLease.id == lease_id).first()
        if not lease or not lease.is_active:
            return None
        cls._release_lease(db, lease, reason)
        db.commit()
        return lease

    @classmethod
    def expire_due(cls, db: Session) -> int:
        """Освободить все аренды, у которых вышел срок. Возвращает число освобождённых."""
        due = db.query(TestNumberLease).filter(
            TestNumberLease.released_at.is_(None),
            TestNumberLease.expires_at <= _now(),
        ).all()
        for lease in due:
            cls._release_lease(db, lease, "expired")
        if due:
            db.commit()
        return len(due)

    # ------------------------------------------------------------------
    # Админка
    # ------------------------------------------------------------------

    @classmethod
    def admin_pool(cls, db: Session) -> List[Dict[str, Any]]:
        """
        Все номера дочерних аккаунтов администраторов с флагом пула и
        текущей арендой. Именно из них собирается тестовый пул.
        """
        rows = (
            db.query(VoximplantPhoneNumber, VoximplantChildAccount, User)
            .join(VoximplantChildAccount, VoximplantPhoneNumber.child_account_id == VoximplantChildAccount.id)
            .join(User, VoximplantChildAccount.user_id == User.id)
            .filter(or_(User.is_admin == True, VoximplantPhoneNumber.is_test_pool == True))  # noqa: E712
            .order_by(User.email.asc(), VoximplantPhoneNumber.purchased_at.asc())
            .all()
        )
        leases = {l.phone_number_id: l for l in cls.active_leases(db)}
        out = []
        for phone, child, owner in rows:
            lease = leases.get(phone.id)
            lease_user = None
            if lease:
                lu = db.query(User).filter(User.id == lease.user_id).first()
                lease_user = lu.email if lu else str(lease.user_id)
            out.append({
                "id": str(phone.id),
                "phone_number": phone.phone_number,
                "owner_email": owner.email,
                "owner_is_admin": bool(owner.is_admin),
                "is_active": bool(phone.is_active),
                "is_test_pool": bool(phone.is_test_pool),
                "phone_source": phone.phone_source,
                "assistant_type": phone.assistant_type,
                "assistant_id": str(phone.assistant_id) if phone.assistant_id else None,
                "lease": (dict(lease.to_dict(), user_email=lease_user) if lease else None),
            })
        return out

    @classmethod
    def set_pool_flag(cls, db: Session, phone_number_id: uuid.UUID, enabled: bool) -> VoximplantPhoneNumber:
        phone = db.query(VoximplantPhoneNumber).filter(VoximplantPhoneNumber.id == phone_number_id).first()
        if not phone:
            raise TestNumberError("Номер не найден", "not_found")
        if phone.phone_source != "voximplant":
            raise TestNumberError("В тестовый пул можно добавить только номер, купленный в Voximplant", "bad_source")
        if enabled and not phone.is_test_pool:
            child = phone.child_account
            owner = db.query(User).filter(User.id == child.user_id).first() if child else None
            if not owner or not owner.is_admin:
                raise TestNumberError("В тестовый пул можно добавить только номер администратора", "not_admin")
            if not child.vox_scenario_ids:
                raise TestNumberError("У аккаунта владельца не настроены сценарии телефонии", "no_scenarios")
            # Пул живёт по арендам: собственную привязку админа снимаем,
            # чтобы /config не отвечал по ней без аренды.
            phone.assistant_type = None
            phone.assistant_id = None
            phone.agent_config_id = None
            phone.first_phrase = None
            phone.is_test_pool = True
        elif not enabled and phone.is_test_pool:
            lease = cls.active_lease_for_phone(db, phone.id)
            if lease:
                cls._release_lease(db, lease, "admin")
            phone.is_test_pool = False
        db.add(phone)
        db.commit()
        db.refresh(phone)
        return phone

    @classmethod
    def admin_leases(cls, db: Session, limit: int = 50) -> List[Dict[str, Any]]:
        rows = (
            db.query(TestNumberLease, User)
            .join(User, TestNumberLease.user_id == User.id)
            .order_by(TestNumberLease.started_at.desc())
            .limit(limit)
            .all()
        )
        return [dict(l.to_dict(), user_email=u.email) for l, u in rows]

    # ------------------------------------------------------------------
    # Дополнительные попытки (гранты админа)
    # ------------------------------------------------------------------

    @classmethod
    def grant_attempt(cls, db: Session, admin: User, email: str, minutes: int,
                      note: Optional[str] = None) -> TestNumberGrant:
        email = (email or "").strip().lower()
        user = db.query(User).filter(User.email.ilike(email)).first() if email else None
        if not user:
            raise TestNumberError("Пользователь с таким email не найден", "user_not_found")
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            minutes = 0
        if minutes < 1 or minutes > 24 * 60:
            raise TestNumberError("Длительность должна быть от 1 до 1440 минут", "bad_minutes")
        grant = TestNumberGrant(
            user_id=user.id,
            minutes=minutes,
            granted_by_id=admin.id,
            note=(note or "").strip()[:500] or None,
        )
        db.add(grant)
        db.commit()
        db.refresh(grant)
        logger.info(f"[TEST-NUMBER] 🎁 Grant: admin {admin.email} → {user.email}, {minutes} min")
        return grant

    @classmethod
    def revoke_grant(cls, db: Session, grant_id: uuid.UUID) -> bool:
        grant = db.query(TestNumberGrant).filter(TestNumberGrant.id == grant_id).first()
        if not grant:
            raise TestNumberError("Попытка не найдена", "not_found")
        if grant.is_used:
            raise TestNumberError("Попытка уже использована, отозвать нельзя", "used")
        db.delete(grant)
        db.commit()
        return True

    @classmethod
    def admin_grants(cls, db: Session, limit: int = 100) -> List[Dict[str, Any]]:
        rows = (
            db.query(TestNumberGrant, User)
            .join(User, TestNumberGrant.user_id == User.id)
            .order_by(TestNumberGrant.created_at.desc())
            .limit(limit)
            .all()
        )
        admins = {}
        out = []
        for g, u in rows:
            if g.granted_by_id and g.granted_by_id not in admins:
                a = db.query(User).filter(User.id == g.granted_by_id).first()
                admins[g.granted_by_id] = a.email if a else None
            out.append(dict(g.to_dict(), user_email=u.email,
                            granted_by_email=admins.get(g.granted_by_id)))
        return out
