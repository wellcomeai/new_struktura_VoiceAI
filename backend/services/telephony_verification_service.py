"""
Верификация физлица для телефонии: приём анкеты, решение проверяющего,
удаление данных по сроку.

Анкета — паспорт РФ (поля FIELDS) и три файла (FILE_KINDS): разворот с фото,
страница с регистрацией и видео 5–30 с, где человек держит лист с рукописной
надписью «Верификация Voicyfy» и текущей датой и говорит «Это видео записано
для верификации Voicyfy» (раньше — селфи; старые заявки с селфи открываются). Всё уходит в приватный бакет Timeweb
(services/verification_storage.py), проверяющему — в Telegram
(services/verification_bot.py). Решение: approve → номера на аккаунте
администратора (services/hosted_numbers.py), revision → пользователь
исправляет и отправляет снова, reject → окончательно, данные удаляются через
RETENTION_DAYS дней.
"""

import re
import uuid
from datetime import datetime, timezone, timedelta, date
from typing import Dict, Any, Optional, List, Tuple

from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.telephony_verification import TelephonyVerification, VerificationStatus
from backend.services import verification_storage as storage

logger = get_logger(__name__)

# Редакция согласия на обработку паспортных данных (static/verification-consent.html)
CONSENT_VERSION = "2026-10-20.2"
RETENTION_DAYS = 30
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 50 * 1024 * 1024   # предел Telegram для файлов бота
VIDEO_MIN_SECONDS = 5
VIDEO_MAX_SECONDS = 30
VIDEO_PHRASE = "Это видео записано для верификации Voicyfy"

FIELDS: Dict[str, str] = {
    "last_name": "Фамилия",
    "first_name": "Имя",
    "middle_name": "Отчество",
    "birth_date": "Дата рождения",
    "birth_place": "Место рождения",
    "passport_series": "Серия паспорта",
    "passport_number": "Номер паспорта",
    "issued_by": "Кем выдан",
    "issue_date": "Дата выдачи",
    "division_code": "Код подразделения",
    "registration_address": "Адрес регистрации",
    "phone": "Контактный телефон",
}
OPTIONAL_FIELDS = {"middle_name"}

FILE_KINDS: Dict[str, str] = {
    "passport_main": "Разворот паспорта с фото",
    "passport_registration": "Страница с регистрацией",
    "video": "Видео с листом «Верификация Voicyfy» и датой",
}
VIDEO_KINDS = {"video"}
# Подписи файлов прежних заявок
LEGACY_FILE_KINDS: Dict[str, str] = {
    "selfie": "Селфи с паспортом и листом «Верификация Voicyfy» и датой",
}


def max_bytes(kind: str) -> int:
    return MAX_VIDEO_BYTES if kind in VIDEO_KINDS else MAX_FILE_BYTES


class VerificationError(Exception):
    def __init__(self, message: str, code: str = "invalid"):
        self.code = code
        super().__init__(message)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_date(value: str, label: str) -> date:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise VerificationError(f"Поле «{label}»: укажите дату в формате ДД.ММ.ГГГГ")


def validate_fields(raw: Dict[str, Any]) -> Dict[str, str]:
    data: Dict[str, str] = {}
    for key, label in FIELDS.items():
        value = re.sub(r"\s+", " ", str(raw.get(key) or "")).strip()
        if not value and key not in OPTIONAL_FIELDS:
            raise VerificationError(f"Заполните поле «{label}»")
        if len(value) > 300:
            raise VerificationError(f"Поле «{label}» слишком длинное")
        data[key] = value

    if not re.fullmatch(r"\d{4}", data["passport_series"].replace(" ", "")):
        raise VerificationError("Серия паспорта — 4 цифры")
    data["passport_series"] = data["passport_series"].replace(" ", "")
    if not re.fullmatch(r"\d{6}", data["passport_number"]):
        raise VerificationError("Номер паспорта — 6 цифр")
    if not re.fullmatch(r"\d{3}-?\d{3}", data["division_code"]):
        raise VerificationError("Код подразделения — в формате 123-456")
    digits = re.sub(r"\D", "", data["division_code"])
    data["division_code"] = f"{digits[:3]}-{digits[3:]}"
    phone_digits = re.sub(r"\D", "", data["phone"])
    if len(phone_digits) < 10 or len(phone_digits) > 15:
        raise VerificationError("Укажите контактный телефон полностью")

    birth = _parse_date(data["birth_date"], FIELDS["birth_date"])
    issued = _parse_date(data["issue_date"], FIELDS["issue_date"])
    today = _now().date()
    age = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    if age < 18 or age > 110:
        raise VerificationError("Верификация доступна только совершеннолетним")
    if issued > today or issued < birth:
        raise VerificationError("Проверьте дату выдачи паспорта")
    data["birth_date"] = birth.strftime("%d.%m.%Y")
    data["issue_date"] = issued.strftime("%d.%m.%Y")
    return data


def _video_ext(content: bytes) -> Optional[str]:
    """mp4 / mov / webm по сигнатуре контейнера."""
    if content[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if content[4:8] == b"ftyp":
        return "mov" if content[8:10] == b"qt" else "mp4"
    if content[4:8] in (b"moov", b"wide", b"mdat", b"free", b"skip"):
        return "mov"  # старый QuickTime без ftyp
    return None


def mp4_duration_seconds(content: bytes) -> Optional[float]:
    """Длительность MP4/MOV из атома mvhd; None, если не нашли (тогда не проверяем)."""
    pos = content.find(b"mvhd")
    if pos < 4 or pos + 32 > len(content):
        return None
    try:
        version = content[pos + 4]
        if version == 1:
            timescale = int.from_bytes(content[pos + 24:pos + 28], "big")
            duration = int.from_bytes(content[pos + 28:pos + 36], "big")
        else:
            timescale = int.from_bytes(content[pos + 16:pos + 20], "big")
            duration = int.from_bytes(content[pos + 20:pos + 24], "big")
        if timescale <= 0:
            return None
        return duration / timescale
    except Exception:
        return None


def validate_file(kind: str, content: bytes, content_type: str) -> str:
    """Возвращает расширение файла. Тип определяется по содержимому, а не по заголовку браузера."""
    label = FILE_KINDS[kind]
    if not content:
        raise VerificationError(f"Загрузите файл: {label}")
    limit = max_bytes(kind)
    if len(content) > limit:
        raise VerificationError(f"«{label}»: файл больше {limit // (1024 * 1024)} МБ")

    if kind in VIDEO_KINDS:
        ext = _video_ext(content)
        if not ext:
            raise VerificationError(f"«{label}»: допустимы видео MP4, MOV или WEBM")
        seconds = mp4_duration_seconds(content) if ext in ("mp4", "mov") else None
        if seconds is not None and not (VIDEO_MIN_SECONDS - 1 <= seconds <= VIDEO_MAX_SECONDS + 2):
            raise VerificationError(
                f"Видео должно длиться от {VIDEO_MIN_SECONDS} до {VIDEO_MAX_SECONDS} секунд "
                f"(сейчас {seconds:.0f} с)"
            )
        return ext

    if content[:3] == b"\xff\xd8\xff":
        return "jpg"
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if content[:5] == b"%PDF-":
        return "pdf"
    raise VerificationError(f"«{label}»: допустимы JPG, PNG или PDF")


def get_for_user(db: Session, user_id) -> Optional[TelephonyVerification]:
    return db.query(TelephonyVerification).filter(TelephonyVerification.user_id == user_id).first()


def is_approved(db: Session, user_id) -> bool:
    v = get_for_user(db, user_id)
    return bool(v and v.status == VerificationStatus.APPROVED)


CONTENT_TYPES = {
    "jpg": "image/jpeg", "png": "image/png", "pdf": "application/pdf",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}


def store_submission(db: Session, user: User, raw_fields: Dict[str, Any],
                     files: Dict[str, Tuple[bytes, str]], consent: bool,
                     ip: Optional[str]) -> Tuple[TelephonyVerification, Dict[str, str], List[tuple]]:
    """
    Проверить и сохранить заявку (синхронно, вызывать в потоке).
    Возвращает (заявка, анкета, файлы для бота [(подпись, имя, байты, тип)]).
    """
    if not storage.is_configured():
        raise VerificationError("Хранилище документов не настроено, попробуйте позже", "storage")
    if not consent:
        raise VerificationError("Нужно согласие на обработку паспортных данных")

    existing = get_for_user(db, user.id)
    if existing and existing.status in (VerificationStatus.SUBMITTED, VerificationStatus.APPROVED):
        raise VerificationError("Заявка уже отправлена", "already_submitted")
    if existing and existing.status == VerificationStatus.REJECTED:
        raise VerificationError("Заявка отклонена. Для повторной проверки напишите в поддержку", "rejected")

    data = validate_fields(raw_fields)
    checked = {}
    for kind in FILE_KINDS:
        content, ctype = files.get(kind) or (b"", "")
        checked[kind] = (content, validate_file(kind, content, ctype))

    attempt = (existing.attempt + 1) if existing else 1
    if existing:
        # Прошлая подача больше не нужна — храним только актуальные документы
        try:
            storage.delete_prefix(f"verifications/{user.id}/")
        except Exception as e:
            logger.warning(f"[VERIFY] old files cleanup failed for {user.id}: {e}")

    file_keys = {}
    bot_files = []
    for kind, (content, ext) in checked.items():
        key = storage.object_key(user.id, attempt, f"{kind}.{ext}")
        storage.put_bytes(key, content, CONTENT_TYPES[ext])
        file_keys[kind] = key
        bot_files.append((FILE_KINDS[kind], f"{kind}.{ext}", content, CONTENT_TYPES[ext]))
    data_key = storage.object_key(user.id, attempt, "form.json")
    storage.put_json(data_key, {**data, "email": user.email, "submitted_at": _now().isoformat()})

    v = existing or TelephonyVerification(id=uuid.uuid4(), user_id=user.id)
    v.status = VerificationStatus.SUBMITTED
    v.attempt = attempt
    v.data_key = data_key
    v.files = file_keys
    v.reviewer_comment = None
    v.reviewed_at = None
    v.reviewed_by = None
    v.consent_at = _now()
    v.consent_version = CONSENT_VERSION
    v.consent_ip = (ip or "")[:64] or None
    v.submitted_at = _now()
    v.purge_after = None
    v.tg_message_ids = []
    v.tg_pending = None
    if not existing:
        db.add(v)
    db.commit()
    db.refresh(v)
    logger.info(f"[VERIFY] submission #{attempt} stored for {user.email}")
    return v, data, bot_files


def load_details(v: TelephonyVerification) -> Dict[str, Any]:
    """Анкета и временные ссылки на файлы (синхронно, вызывать в потоке)."""
    data = storage.get_json(v.data_key) or {}
    files = {}
    for kind, key in (v.files or {}).items():
        try:
            ext = key.rsplit(".", 1)[-1].lower()
            files[kind] = {"label": FILE_KINDS.get(kind) or LEGACY_FILE_KINDS.get(kind, kind),
                           "url": storage.presigned_url(key),
                           "is_pdf": ext == "pdf", "is_video": ext in ("mp4", "mov", "webm")}
        except Exception as e:
            logger.warning(f"[VERIFY] presign {key} failed: {e}")
    return {"fields": {FIELDS[k]: data.get(k) for k in FIELDS if data.get(k)},
            "raw": {k: data.get(k) for k in FIELDS}, "files": files}


STATUS_TEXT = {
    VerificationStatus.APPROVED: "✅ Одобрена",
    VerificationStatus.NEEDS_REVISION: "✍️ Возвращена на доработку",
    VerificationStatus.REJECTED: "❌ Отклонена",
}


def decide(db: Session, v: TelephonyVerification, action: str, comment: Optional[str],
           reviewer: str) -> TelephonyVerification:
    """
    Применить решение. action: approve | revision | reject. Синхронно.
    Уведомления (email пользователю, отметка в Telegram) — notify_decision.
    """
    if v.status != VerificationStatus.SUBMITTED:
        raise VerificationError("Решение по заявке уже принято", "already_decided")
    comment = (comment or "").strip()
    if comment == "-":
        comment = ""
    if action == "revision" and not comment:
        raise VerificationError("Напишите, что нужно исправить")
    status_map = {
        "approve": VerificationStatus.APPROVED,
        "revision": VerificationStatus.NEEDS_REVISION,
        "reject": VerificationStatus.REJECTED,
    }
    if action not in status_map:
        raise VerificationError("Неизвестное действие")

    user = db.query(User).filter(User.id == v.user_id).first()
    if action == "approve" and user:
        from backend.services.hosted_numbers import ensure_hosted_account, HostedError
        try:
            ensure_hosted_account(db, user)
        except HostedError as e:
            # Аккаунт администратора не готов — заявку всё равно одобряем,
            # запись заведётся при первой покупке номера.
            logger.warning(f"[VERIFY] hosted account for {user.email} postponed: {e}")

    v.status = status_map[action]
    v.reviewer_comment = comment[:2000] or None
    v.reviewed_at = _now()
    v.reviewed_by = reviewer[:255]
    v.tg_pending = None
    v.purge_after = _now() + timedelta(days=RETENTION_DAYS) if action == "reject" else None
    db.commit()
    db.refresh(v)
    logger.info(f"[VERIFY] {v.id} → {v.status} by {reviewer}")
    return v


def notify_user(db: Session, v: TelephonyVerification) -> None:
    """Письмо пользователю о решении (синхронно, best-effort)."""
    user = db.query(User).filter(User.id == v.user_id).first()
    if not user:
        return
    from backend.core.config import settings
    link = f"{(settings.HOST_URL or '').rstrip('/')}/static/telephony.html"
    if v.status == VerificationStatus.APPROVED:
        subject = "Верификация пройдена — можно подключать номер"
        body = ("Ваша верификация для телефонии Voicyfy одобрена. Пополните телефонный баланс "
                f"и выберите номер в разделе <a href='{link}'>«Телефония»</a>.")
    elif v.status == VerificationStatus.NEEDS_REVISION:
        subject = "Верификация: нужно исправить данные"
        body = (f"Проверяющий вернул заявку на доработку: <b>{v.reviewer_comment or ''}</b><br>"
                f"Исправьте данные и отправьте заявку снова в разделе <a href='{link}'>«Телефония»</a>.")
    elif v.status == VerificationStatus.REJECTED:
        subject = "Верификация отклонена"
        body = ("Заявка на верификацию отклонена"
                + (f": <b>{v.reviewer_comment}</b>" if v.reviewer_comment else "")
                + ". Если считаете это ошибкой — напишите на info@voicyfy.ru.")
    else:
        return
    from backend.services.hosted_numbers import _notify_user
    _notify_user(user, subject, body)


def purge_due(db: Session) -> int:
    """Удалить анкеты и файлы, срок хранения которых истёк (синхронно)."""
    rows = db.query(TelephonyVerification).filter(
        TelephonyVerification.purge_after.isnot(None),
        TelephonyVerification.purge_after <= _now(),
        TelephonyVerification.data_key.isnot(None),
    ).all()
    for v in rows:
        try:
            storage.delete_prefix(f"verifications/{v.user_id}/")
            v.data_key = None
            v.files = None
            db.commit()
            logger.info(f"[VERIFY] purged documents of {v.user_id}")
        except Exception as e:
            db.rollback()
            logger.warning(f"[VERIFY] purge {v.user_id} failed: {e}")
    return len(rows)


def schedule_purge_for_user(db: Session, user_id) -> None:
    """Аккаунт удаляется или согласие отозвано: удалить документы через 30 дней."""
    v = get_for_user(db, user_id)
    if v and v.data_key and not v.purge_after:
        v.purge_after = _now() + timedelta(days=RETENTION_DAYS)
        db.commit()
