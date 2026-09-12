"""
Agent MAX Account API — подключение ЛИЧНОГО аккаунта мессенджера MAX агента.

Префикс: /api/agent/max-account

Зеркалит /api/agent/telegram-account (личный Telegram), но поверх PyMax. У MAX
нет официального userbot-API — используется реверснутая библиотека maxapi-python.

Отличие от Telegram-флоу: у PyMax авторизация проходит ВНУТРИ client.start(),
а не отдельными запросами. Поэтому:
  POST /start           {phone}    → запускает фоновую задачу авторизации
                                      (max_user_service.run_auth); MAX присылает
                                      SMS-код, статус → pending_code
  POST /verify-code     {code}     → кладёт код в транзитную колонку, фоновая
                                      задача его подхватывает; при 2FA статус
                                      станет pending_password
  POST /verify-password {password} → кладёт пароль; по успеху статус → connected

UI опрашивает GET /status, чтобы увидеть переход pending_code →
pending_password → connected (или error).

Сессия шифруется (MAX_SESSION_KEY).
"""

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.core.dependencies import get_current_user
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.agent_max_account import AgentMaxAccount
from backend.services import max_user_service as max_user

logger = get_logger(__name__)

router = APIRouter()

REPLY_SCOPES = {"contacts", "all"}


# ============================================================================
# SCHEMAS
# ============================================================================

class StartRequest(BaseModel):
    phone: str = Field(..., min_length=5, max_length=32)


class CodeRequest(BaseModel):
    code: str = Field(..., min_length=3, max_length=16)


class PasswordRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class SettingsRequest(BaseModel):
    auto_reply_enabled: Optional[bool] = None
    reply_scope: Optional[str] = None


# ============================================================================
# HELPERS
# ============================================================================

def _get_agent(current_user: User, db: Session, agent_id: Optional[str] = None) -> AgentConfig:
    """Резолв агента пользователя (как в agent_telegram_account._get_agent)."""
    q = db.query(AgentConfig).filter(AgentConfig.user_id == current_user.id)
    if agent_id:
        agent = q.filter(AgentConfig.id == agent_id).first()
    else:
        agent = q.order_by(AgentConfig.created_at.asc()).first()
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


def _get_row(db: Session, agent: AgentConfig) -> Optional[AgentMaxAccount]:
    return db.query(AgentMaxAccount).filter(
        AgentMaxAccount.agent_config_id == agent.id
    ).first()


def _status_dict(row: Optional[AgentMaxAccount]) -> dict:
    base = {"configured": max_user.is_configured()}
    if row is None:
        base.update({
            "status": "not_connected",
            "phone_masked": None,
            "max_name": None,
            "auto_reply_enabled": False,
            "reply_scope": "contacts",
            "last_error": None,
        })
        return base
    base.update(row.to_dict())
    return base


def _require_configured():
    if not max_user.is_configured():
        raise HTTPException(status_code=400, detail="not_configured")


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
    """Статус подключения личного MAX у агента."""
    agent = _get_agent(current_user, db, agent_id)
    return _status_dict(_get_row(db, agent))


@router.post("/start")
async def start_auth(
    body: StartRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Шаг 1: запустить авторизацию. Создаёт/обновляет строку аккаунта в статусе
    pending_code и запускает фоновую задачу run_auth (она инициирует SMS у MAX
    и будет ждать код/пароль из транзитных колонок).
    """
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if row and row.status == "connected":
        raise HTTPException(status_code=400, detail="already_connected")

    phone = body.phone.strip()
    if row is None:
        row = AgentMaxAccount(agent_config_id=agent.id, user_id=current_user.id)
        db.add(row)

    from datetime import datetime
    row.phone = phone
    row.status = "pending_code"
    row.sms_code = None
    row.password_2fa = None
    row.session_encrypted = None
    row.last_error = None
    row.auth_started_at = datetime.utcnow()
    db.commit()
    account_id = str(row.id)

    # Фоновая задача авторизации: живёт в этом воркере. Если воркер
    # рециклится посреди флоу — пользователь нажмёт «Начать заново».
    asyncio.create_task(max_user.run_auth(account_id))

    logger.info(f"[MAX-ACCOUNT] auth started for agent {agent.id} (•••{phone[-4:]})")
    return _status_dict(row)


@router.post("/verify-code")
def verify_code(
    body: CodeRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Шаг 2: передать SMS-код фоновой задаче авторизации (транзитная колонка).
    Дальше статус сам станет pending_password (если 2FA) или connected.
    """
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if not row or row.status != "pending_code":
        raise HTTPException(status_code=400, detail="auth_not_started")

    row.sms_code = body.code.strip()
    db.commit()
    logger.info(f"[MAX-ACCOUNT] code submitted for agent {agent.id}")
    return _status_dict(row)


@router.post("/verify-password")
async def verify_password(
    body: PasswordRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Шаг 3 (только для аккаунтов с 2FA): передать пароль фоновой задаче."""
    _require_configured()
    agent = _get_agent(current_user, db, agent_id)

    row = _get_row(db, agent)
    if not row or row.status != "pending_password":
        raise HTTPException(status_code=400, detail="password_not_expected")

    row.password_2fa = body.password
    db.commit()
    logger.info(f"[MAX-ACCOUNT] password submitted for agent {agent.id}")
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
def disconnect(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Отключить личный MAX: удалить строку аккаунта (диалоги уйдут каскадом,
    переписка в agent_max_messages остаётся для истории). Также используется
    кнопкой «Начать заново» на незавершённой авторизации.
    """
    agent = _get_agent(current_user, db, agent_id)
    row = _get_row(db, agent)
    if not row:
        return _status_dict(None)

    db.delete(row)
    db.commit()
    logger.info(f"[MAX-ACCOUNT] disconnected for agent {agent.id}")
    return _status_dict(None)
