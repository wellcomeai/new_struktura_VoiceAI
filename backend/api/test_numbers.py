"""
API тестовых номеров телефонии.

Пользователь (без подключения телефонии и верификации) один раз включает
свободный тестовый номер администратора на несколько минут, привязывает к нему
своего голосового ассистента и звонит на него сам — только входящие.

Префикс: /api/telephony/test-numbers

  GET  /status            — состояние для ЛК (моя аренда, свободные номера, таймер)
  POST /start             — включить: {assistant_type, assistant_id}
  POST /release           — досрочно отключить (попытка считается использованной)

Админка (is_admin):
  GET  /admin/pool                      — номера админов с флагом пула и арендой
  PUT  /admin/pool/{phone_number_id}    — {is_test_pool: bool}
  GET  /admin/leases                    — журнал аренд
  POST /admin/leases/{lease_id}/release — принудительно освободить
"""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.db.session import get_db
from backend.core.dependencies import get_current_user, check_admin_access
from backend.core.logging import get_logger
from backend.models.user import User
from backend.services.test_number_service import TestNumberService, TestNumberError

logger = get_logger(__name__)

router = APIRouter(prefix="/api/telephony/test-numbers", tags=["Test Numbers"])


class StartTestNumberRequest(BaseModel):
    assistant_type: str = Field(..., description="openai | gemini | cascade | fish | yandex")
    assistant_id: str = Field(..., description="UUID голосового ассистента пользователя")


class PoolFlagRequest(BaseModel):
    is_test_pool: bool


def _bad_request(e: TestNumberError):
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                         detail=e.message, headers={"X-Error-Code": e.code})


# ============================================================================
# Пользователь
# ============================================================================

@router.get("/status")
async def get_test_number_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Ленивая уборка: истёкшие аренды освобождаем и здесь, не дожидаясь планировщика
    try:
        TestNumberService.expire_due(db)
    except Exception as e:
        logger.warning(f"[TEST-NUMBER] expire_due in status failed: {e}")
        db.rollback()
    return TestNumberService.status(db, current_user)


@router.post("/start")
async def start_test_number(
    request: StartTestNumberRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        assistant_uuid = uuid.UUID(request.assistant_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный ID ассистента")
    try:
        TestNumberService.expire_due(db)
        lease = await TestNumberService.start(db, current_user, request.assistant_type, assistant_uuid)
    except TestNumberError as e:
        db.rollback()
        raise _bad_request(e)
    except Exception as e:
        db.rollback()
        logger.error(f"[TEST-NUMBER] start failed for {current_user.email}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Не удалось включить тестовый номер")
    return {
        "success": True,
        "message": f"Тестовый номер включён на {TestNumberService.lease_minutes()} минут",
        "lease": lease.to_dict(),
        "status": TestNumberService.status(db, current_user),
    }


@router.post("/release")
async def release_test_number(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    lease = TestNumberService.release(db, current_user, reason="user")
    if not lease:
        raise HTTPException(status_code=404, detail="Активного тестового номера нет")
    return {
        "success": True,
        "message": "Тестовый номер отключён",
        "status": TestNumberService.status(db, current_user),
    }


# ============================================================================
# Админка
# ============================================================================

@router.get("/admin/pool")
async def admin_get_pool(
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    TestNumberService.expire_due(db)
    return {
        "lease_minutes": TestNumberService.lease_minutes(),
        "numbers": TestNumberService.admin_pool(db),
    }


@router.put("/admin/pool/{phone_number_id}")
async def admin_set_pool_flag(
    phone_number_id: str,
    request: PoolFlagRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    try:
        pid = uuid.UUID(phone_number_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный ID номера")
    try:
        phone = TestNumberService.set_pool_flag(db, pid, request.is_test_pool)
    except TestNumberError as e:
        db.rollback()
        raise _bad_request(e)
    logger.info(f"[TEST-NUMBER] admin {admin.email}: {phone.phone_number} is_test_pool={phone.is_test_pool}")
    return {"success": True, "id": str(phone.id), "is_test_pool": bool(phone.is_test_pool)}


@router.get("/admin/leases")
async def admin_get_leases(
    limit: int = 50,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    return {"leases": TestNumberService.admin_leases(db, limit=max(1, min(limit, 500)))}


@router.post("/admin/leases/{lease_id}/release")
async def admin_release_lease(
    lease_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(check_admin_access),
):
    try:
        lid = uuid.UUID(lease_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный ID аренды")
    lease = TestNumberService.release_by_id(db, lid, reason="admin")
    if not lease:
        raise HTTPException(status_code=404, detail="Активная аренда не найдена")
    return {"success": True, "lease": lease.to_dict()}
