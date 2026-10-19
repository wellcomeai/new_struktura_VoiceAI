"""
Agent Telegram Account API — подключение ЛИЧНОГО Telegram-аккаунта агента.

Префикс: /api/agent/telegram-account

НЕ путать с /api/agent/telegram (agent_telegram.py) — там Telegram-БОТ агента
(Bot API, фронтенд чата владельца). Здесь — личный аккаунт владельца через
MTProto (Telethon): агент пишет клиентам от имени владельца и отвечает на
входящие сообщения (поллер backend/core/telegram_user_poller.py).

Авторизация по QR-коду (в UI единственный способ):
  POST /qr/start        → окно входа на QR_WINDOW_SECONDS (2 мин), статус pending_qr;
                          в ответе qr.qr_svg — картинка, токен внутри Telegram
                          меняет каждые ~30 с, фоновая задача обновляет его сама
  GET  /qr/status       → UI опрашивает раз в 2 с: waiting (+ свежий QR) |
                          connected | password_needed | duplicate | expired | error
  POST /qr/cancel       → закрыть окно
  POST /verify-password {password} → connected (аккаунты с 2FA)

Старый вход по номеру (POST /start {phone} → POST /verify-code {code}) оставлен
для отката, из UI убран: Telegram перестал доставлять коды входа, запрошенные
сторонним приложением с IP дата-центра (ответ «код отправлен», а сообщения нет).

Один Telegram-аккаунт — один агент: дубль (тот же tg_user_id уже connected у
другого агента) отклоняется, новая сессия разлогинивается. Иначе два поллера
читают одни диалоги и клиенту отвечают дважды.

Промежуточное состояние (частичная сессия) живёт в строке AgentTelegramAccount
между шагами. Сессии шифруются (TELEGRAM_SESSION_KEY).
"""

import asyncio
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db, SessionLocal
from backend.core.dependencies import get_current_user
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.agent_telegram_account import (
    AgentTelegramAccount,
    AgentTelegramDialog,
)
from backend.services import telegram_user_service as tg_user

logger = get_logger(__name__)

router = APIRouter()

REPLY_SCOPES = {"contacts", "all"}


# ============================================================================
# SCHEMAS
# ============================================================================

class StartRequest(BaseModel):
    phone: str = Field(..., min_length=5, max_length=32)


class CodeRequest(BaseModel):
    code: str = Field(..., min_length=3, max_length=10)


class PasswordRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class SettingsRequest(BaseModel):
    auto_reply_enabled: Optional[bool] = None
    reply_scope: Optional[str] = None


# ============================================================================
# HELPERS
# ============================================================================

def _get_agent(current_user: User, db: Session, agent_id: Optional[str] = None) -> AgentConfig:
    """Резолв агента пользователя (как в agent_telegram._get_agent)."""
    q = db.query(AgentConfig).filter(AgentConfig.user_id == current_user.id)
    if agent_id:
        agent = q.filter(AgentConfig.id == agent_id).first()
    else:
        agent = q.order_by(AgentConfig.created_at.asc()).first()
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


def _get_row(db: Session, agent: AgentConfig) -> Optional[AgentTelegramAccount]:
    return db.query(AgentTelegramAccount).filter(
        AgentTelegramAccount.agent_config_id == agent.id
    ).first()


def _status_dict(row: Optional[AgentTelegramAccount]) -> dict:
    base = {"configured": tg_user.is_configured()}
    if row is None:
        base.update({
            "status": "not_connected",
            "phone_masked": None,
            "tg_username": None,
            "tg_first_name": None,
            "auto_reply_enabled": False,
            "reply_scope": "contacts",
            "last_error": None,
        })
        return base
    base.update(row.to_dict())
    return base


def _require_configured():
    if not tg_user.is_configured():
        raise HTTPException(status_code=400, detail="not_configured")


BASELINE_TIMEOUT_SECONDS = 60


def _store_baseline(account_id, agent_config_id, dialogs: list) -> None:
    """Записать снимок диалогов (своя сессия БД — вызывается через to_thread)."""
    from backend.models.agent_contact import AgentContact
    from backend.services.sms_history import phone_suffix

    db = SessionLocal()
    try:
        known = {
            int(r[0]) for r in db.query(AgentTelegramDialog.tg_peer_id).filter(
                AgentTelegramDialog.account_id == account_id
            ).all()
        }
        for d in dialogs:
            if int(d["peer_id"]) in known:
                continue
            contact_id = None
            suf = phone_suffix(d.get("phone") or "")
            if suf:
                contact = db.query(AgentContact).filter(
                    AgentContact.agent_config_id == agent_config_id,
                    AgentContact.phone.like(f"%{suf}"),
                ).order_by(AgentContact.created_at.desc()).first()
                if contact:
                    contact_id = contact.id
            db.add(AgentTelegramDialog(
                account_id=account_id,
                agent_contact_id=contact_id,
                tg_peer_id=d["peer_id"],
                tg_username=d.get("username"),
                tg_name=d.get("name"),
                last_processed_msg_id=d.get("top_id") or 0,
                created_via="baseline",
            ))
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def _baseline_dialogs(account_id, agent_config_id, session_str: str) -> None:
    """
    Снимок диалогов при подключении: записываем текущие top_message_id, чтобы
    поллер не начал отвечать на старую переписку. Заодно связываем диалоги с
    контактами агента по видимому номеру телефона. Best-effort.
    """
    try:
        snap = await asyncio.wait_for(
            tg_user.poll_dialogs(session_str, known_last_ids={}),
            timeout=BASELINE_TIMEOUT_SECONDS,
        )
        if not snap.get("ok"):
            logger.warning(f"[TG-ACCOUNT] baseline poll failed: {snap.get('error')}")
            return
        dialogs = snap.get("dialogs", [])
        await asyncio.to_thread(_store_baseline, account_id, agent_config_id, dialogs)
        logger.info(f"[TG-ACCOUNT] baseline: {len(dialogs)} dialogs for account {account_id}")
    except Exception as e:
        logger.warning(f"[TG-ACCOUNT] baseline failed: {type(e).__name__}: {e}")


def _find_duplicate(db: Session, tg_user_id, row: AgentTelegramAccount):
    """
    Тот же Telegram-аккаунт, уже подключённый к другому агенту → (строка, имя
    агента для показа). Имя отдаём только для агента того же пользователя.
    """
    if not tg_user_id:
        return None, None
    dup = db.query(AgentTelegramAccount).filter(
        AgentTelegramAccount.tg_user_id == tg_user_id,
        AgentTelegramAccount.status == "connected",
        AgentTelegramAccount.id != row.id,
    ).first()
    if dup is None:
        return None, None
    name = None
    if dup.user_id == row.user_id:
        agent = db.query(AgentConfig).filter(AgentConfig.id == dup.agent_config_id).first()
        name = agent.name if agent else None
    return dup, name


def _duplicate_error(name: Optional[str]) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "duplicate_account", "agent_name": name})


async def _reject_duplicate(db: Session, row: AgentTelegramAccount, result: dict) -> None:
    """Дубль после входа (код / пароль): разлогинить новую сессию, убрать строку, 400."""
    dup, name = _find_duplicate(db, result.get("tg_user_id"), row)
    if dup is None:
        return
    await tg_user.logout(result["session"])
    db.delete(row)
    db.commit()
    logger.info(f"[TG-ACCOUNT] duplicate tg_user {result.get('tg_user_id')} for agent {row.agent_config_id}")
    raise _duplicate_error(name)


def _finalize_connected(db: Session, row: AgentTelegramAccount, result: dict) -> None:
    """Общая финализация после успешного входа (QR, код без 2FA или пароль 2FA)."""
    row.session_encrypted = tg_user.encrypt_session(result["session"])
    if result.get("phone"):
        row.phone = "+" + str(result["phone"]).lstrip("+")
    row.status = "connected"
    row.phone_code_hash = None
    row.tg_user_id = result.get("tg_user_id")
    row.tg_username = result.get("tg_username")
    row.tg_first_name = result.get("tg_first_name")
    row.last_error = None
    db.commit()


def _apply_qr_result(agent_id: str, result: dict) -> dict:
    """
    Итог окна входа по QR → БД (своя сессия, вызывается через to_thread).
    Может переписать result["status"] на duplicate / cancelled. Возвращает
    {keep, account_id, agent_config_id}: keep=False — сессию разлогинить.
    """
    db = SessionLocal()
    try:
        row = db.query(AgentTelegramAccount).filter(
            AgentTelegramAccount.agent_config_id == uuid.UUID(agent_id)
        ).first()
        status = result.get("status")
        if row is None or row.status != "pending_qr":
            # Окно закрыли (отмена / отключение / удаление агента) раньше итога.
            if result.get("session"):
                result["status"] = "cancelled"
            return {"keep": False}

        if status == "password_needed":
            row.session_encrypted = tg_user.encrypt_session(result["session"])
            row.status = "pending_password"
            row.last_error = None
            db.commit()
            return {"keep": True}

        if status == "connected":
            dup, name = _find_duplicate(db, result.get("tg_user_id"), row)
            if dup is not None:
                db.delete(row)
                db.commit()
                result["status"] = "duplicate"
                result["duplicate_agent_name"] = name
                logger.info(f"[TG-ACCOUNT] QR: duplicate tg_user {result.get('tg_user_id')} for agent {agent_id}")
                return {"keep": False}
            _finalize_connected(db, row, result)
            logger.info(f"[TG-ACCOUNT] connected @{row.tg_username} via QR for agent {agent_id}")
            return {"keep": True, "account_id": row.id, "agent_config_id": row.agent_config_id}

        # expired / error: незавершённую строку убираем — UI снова покажет «Подключить».
        db.delete(row)
        db.commit()
        return {"keep": False}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def _on_qr_done(agent_id: str, result: dict) -> bool:
    if result.get("status") == "cancelled":
        return False
    applied = await asyncio.to_thread(_apply_qr_result, agent_id, result)
    if applied.get("account_id") is not None:
        await _baseline_dialogs(applied["account_id"], applied["agent_config_id"], result["session"])
    return bool(applied.get("keep"))


# ============================================================================
# ENDPOINTS
# ============================================================================

@router.get("")
@router.get("/")
def get_status(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Статус подключения личного Telegram у агента."""
    agent = _get_agent(current_user, db, agent_id)
    return _status_dict(_get_row(db, agent))


@router.post("/qr/start")
async def start_qr(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Открыть окно входа по QR (2 мин). Прежнее окно этого агента закрывается."""
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if row and row.status == "connected":
        raise HTTPException(status_code=400, detail="already_connected")

    # Сначала закрыть прежнее окно: его итог не должен лечь на новую строку.
    await tg_user.qr_cancel(str(agent.id))

    if row is None:
        row = AgentTelegramAccount(agent_config_id=agent.id, user_id=current_user.id)
        db.add(row)
    row.status = "pending_qr"
    row.session_encrypted = None
    row.phone_code_hash = None
    row.last_error = None
    db.commit()

    state = await tg_user.qr_start(str(agent.id), _on_qr_done)
    if state.get("status") == "error":
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail=state.get("error") or "telegram_error")

    logger.info(f"[TG-ACCOUNT] QR window opened for agent {agent.id}")
    return {**_status_dict(row), "qr": state}


@router.get("/qr/status")
def get_qr_status(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Состояние окна входа + статус аккаунта. qr=null — окна нет (истекло давно / рестарт)."""
    agent = _get_agent(current_user, db, agent_id)
    return {**_status_dict(_get_row(db, agent)), "qr": tg_user.qr_state(str(agent.id))}


@router.post("/qr/cancel")
async def cancel_qr(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Закрыть окно входа по QR (незавершённая строка удаляется)."""
    agent = _get_agent(current_user, db, agent_id)
    await tg_user.qr_cancel(str(agent.id))
    row = _get_row(db, agent)
    if row and row.status == "pending_qr":
        db.delete(row)
        db.commit()
        row = None
    return _status_dict(row)


@router.post("/start")
async def start_auth(
    body: StartRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Легаси (из UI убран): отправить код подтверждения на номер."""
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if row and row.status == "connected":
        raise HTTPException(status_code=400, detail="already_connected")

    phone = body.phone.strip()
    result = await tg_user.start_login(phone)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "telegram_error")

    if row is None:
        row = AgentTelegramAccount(agent_config_id=agent.id, user_id=current_user.id)
        db.add(row)

    row.phone = phone
    row.session_encrypted = tg_user.encrypt_session(result["session"])
    row.phone_code_hash = result["phone_code_hash"]
    row.status = "pending_code"
    row.last_error = None
    db.commit()

    logger.info(f"[TG-ACCOUNT] code sent for agent {agent.id} (•••{phone[-4:]})")
    return _status_dict(row)


@router.post("/verify-code")
async def verify_code(
    body: CodeRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Легаси (из UI убран): подтвердить код. Может потребоваться пароль 2FA."""
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if not row or row.status not in ("pending_code",) or not row.session_encrypted:
        raise HTTPException(status_code=400, detail="auth_not_started")

    session_str = tg_user.decrypt_session(row.session_encrypted)
    result = await tg_user.confirm_code(
        session_str, row.phone, body.code.strip(), row.phone_code_hash or ""
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "telegram_error")

    if result.get("needs_password"):
        row.session_encrypted = tg_user.encrypt_session(result["session"])
        row.status = "pending_password"
        db.commit()
        return _status_dict(row)

    await _reject_duplicate(db, row, result)
    _finalize_connected(db, row, result)
    await _baseline_dialogs(row.id, row.agent_config_id, result["session"])
    logger.info(f"[TG-ACCOUNT] connected @{row.tg_username} for agent {agent.id}")
    return _status_dict(row)


@router.post("/verify-password")
async def verify_password(
    body: PasswordRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Облачный пароль для аккаунтов с 2FA (после QR или кода)."""
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if not row or row.status != "pending_password" or not row.session_encrypted:
        raise HTTPException(status_code=400, detail="password_not_expected")

    session_str = tg_user.decrypt_session(row.session_encrypted)
    result = await tg_user.confirm_password(session_str, body.password)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "telegram_error")

    await _reject_duplicate(db, row, result)
    _finalize_connected(db, row, result)
    await _baseline_dialogs(row.id, row.agent_config_id, result["session"])
    logger.info(f"[TG-ACCOUNT] connected @{row.tg_username} (2FA) for agent {agent.id}")
    return _status_dict(row)


@router.patch("/settings")
def update_settings(
    body: SettingsRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Настройки: тумблер автоответа и охват (contacts / all)."""
    agent = _get_agent(current_user, db, agent_id)
    row = _get_row(db, agent)
    if not row:
        raise HTTPException(status_code=404, detail="not_connected")

    if body.reply_scope is not None:
        if body.reply_scope not in REPLY_SCOPES:
            raise HTTPException(status_code=400, detail="invalid_reply_scope")
        row.reply_scope = body.reply_scope
    if body.auto_reply_enabled is not None:
        if body.auto_reply_enabled and row.status != "connected":
            raise HTTPException(status_code=400, detail="not_connected")
        row.auto_reply_enabled = bool(body.auto_reply_enabled)

    db.commit()
    return _status_dict(row)


@router.delete("")
@router.delete("/")
async def disconnect(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Отключить личный Telegram: разлогинить сессию на стороне Telegram
    (best-effort) и удалить строку аккаунта (диалоги уйдут каскадом,
    переписка в agent_telegram_messages остаётся для истории).
    """
    agent = _get_agent(current_user, db, agent_id)
    await tg_user.qr_cancel(str(agent.id))
    row = _get_row(db, agent)
    if not row:
        return _status_dict(None)

    if row.session_encrypted and row.status in ("connected", "pending_password"):
        try:
            await tg_user.logout(tg_user.decrypt_session(row.session_encrypted))
        except Exception as e:
            logger.warning(f"[TG-ACCOUNT] logout failed (ignored): {e}")

    db.delete(row)
    db.commit()
    logger.info(f"[TG-ACCOUNT] disconnected for agent {agent.id}")
    return _status_dict(None)
