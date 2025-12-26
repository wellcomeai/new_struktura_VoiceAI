"""
API endpoints для управления настройками Voximplant.
Позволяет пользователям сохранять и получать свои учетные данные Voximplant.
✅ v2.9: БЕЗ маскирования API Key - показываем полный ключ для простоты
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional

from backend.db.session import get_db
from backend.models.user import User
from backend.services.auth_service import AuthService
from backend.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ============================================================================
# SCHEMAS
# ============================================================================

class VoximplantConfigUpdate(BaseModel):
    """Схема для обновления настроек Voximplant"""
    account_id: str = Field(..., min_length=1, max_length=100, description="Voximplant Account ID")
    api_key: str = Field(..., min_length=1, max_length=500, description="Voximplant API Key")
    rule_id: str = Field(..., min_length=1, max_length=100, description="Voximplant Rule ID")
    caller_id: str = Field(..., min_length=1, max_length=50, description="Caller ID (phone number)")
    
    class Config:
        json_schema_extra = {
            "example": {
                "account_id": "12345678",
                "api_key": "your_api_key_here",
                "rule_id": "123456",
                "caller_id": "+1234567890"
            }
        }


class VoximplantConfigResponse(BaseModel):
    """Схема ответа с настройками Voximplant"""
    account_id: Optional[str] = None
    api_key: Optional[str] = None  # ✅ Полный API Key (БЕЗ маскирования)
    rule_id: Optional[str] = None
    caller_id: Optional[str] = None
    is_configured: bool = False
    
    class Config:
        json_schema_extra = {
            "example": {
                "account_id": "12345678",
                "api_key": "b52d81e6-862a-4882-8165-c78c3452d076",
                "rule_id": "123456",
                "caller_id": "+1234567890",
                "is_configured": True
            }
        }


class VoximplantConfigDeleteResponse(BaseModel):
    """Схема ответа при удалении настроек"""
    success: bool
    message: str


# ============================================================================
# API ENDPOINTS
# ============================================================================

@router.get("/voximplant-settings", response_model=VoximplantConfigResponse)
async def get_voximplant_settings(
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить настройки Voximplant текущего пользователя.
    ✅ API Key возвращается ПОЛНОСТЬЮ (без маскирования).
    
    **Использование:**
    - GET /api/users/voximplant-settings
    
    **Ответ:**
    - account_id: Voximplant Account ID
    - api_key: Полный API Key
    - rule_id: Rule ID для маршрутизации
    - caller_id: Номер телефона для исходящих звонков
    - is_configured: true если все поля заполнены
    """
    try:
        logger.info(f"[VOXIMPLANT-SETTINGS] Getting settings for user {current_user.id}")
        
        # Проверяем наличие настроек
        is_configured = current_user.has_voximplant_config()
        
        return VoximplantConfigResponse(
            account_id=current_user.voximplant_account_id,
            api_key=current_user.voximplant_api_key,  # ✅ Полный ключ
            rule_id=current_user.voximplant_rule_id,
            caller_id=current_user.voximplant_caller_id,
            is_configured=is_configured
        )
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT-SETTINGS] Error getting settings: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка получения настроек: {str(e)}")


@router.put("/voximplant-settings", response_model=VoximplantConfigResponse)
async def update_voximplant_settings(
    config: VoximplantConfigUpdate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Обновить настройки Voximplant для текущего пользователя.
    
    **Использование:**
    - PUT /api/users/voximplant-settings
    
    **Body:**
    ```json
    {
        "account_id": "12345678",
        "api_key": "your_api_key",
        "rule_id": "123456",
        "caller_id": "+1234567890"
    }
    ```
    
    **Примечание:**
    - Все поля обязательны
    - Caller ID должен быть в международном формате (+...)
    - Эти настройки используются Task Scheduler для автоматических звонков
    """
    try:
        logger.info(f"[VOXIMPLANT-SETTINGS] Updating settings for user {current_user.id}")
        
        # Обновляем настройки
        current_user.voximplant_account_id = config.account_id.strip()
        current_user.voximplant_api_key = config.api_key.strip()
        current_user.voximplant_rule_id = config.rule_id.strip()
        current_user.voximplant_caller_id = config.caller_id.strip()
        
        db.commit()
        db.refresh(current_user)
        
        logger.info(f"[VOXIMPLANT-SETTINGS] ✅ Settings updated for user {current_user.id}")
        
        return VoximplantConfigResponse(
            account_id=current_user.voximplant_account_id,
            api_key=current_user.voximplant_api_key,  # ✅ Полный ключ
            rule_id=current_user.voximplant_rule_id,
            caller_id=current_user.voximplant_caller_id,
            is_configured=True
        )
        
    except Exception as e:
        db.rollback()
        logger.error(f"[VOXIMPLANT-SETTINGS] Error updating settings: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка обновления настроек: {str(e)}")


@router.delete("/voximplant-settings", response_model=VoximplantConfigDeleteResponse)
async def delete_voximplant_settings(
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Удалить настройки Voximplant для текущего пользователя.
    
    **Использование:**
    - DELETE /api/users/voximplant-settings
    
    **Примечание:**
    - Удаляет все сохраненные данные Voximplant
    - После удаления автоматические звонки через Task Scheduler работать не будут
    """
    try:
        logger.info(f"[VOXIMPLANT-SETTINGS] Deleting settings for user {current_user.id}")
        
        # Удаляем настройки
        current_user.voximplant_account_id = None
        current_user.voximplant_api_key = None
        current_user.voximplant_rule_id = None
        current_user.voximplant_caller_id = None
        
        db.commit()
        
        logger.info(f"[VOXIMPLANT-SETTINGS] ✅ Settings deleted for user {current_user.id}")
        
        return VoximplantConfigDeleteResponse(
            success=True,
            message="Настройки Voximplant успешно удалены"
        )
        
    except Exception as e:
        db.rollback()
        logger.error(f"[VOXIMPLANT-SETTINGS] Error deleting settings: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка удаления настроек: {str(e)}")


@router.post("/voximplant-settings/test")
async def test_voximplant_settings(
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Проверить настройки Voximplant (опционально).
    
    **Использование:**
    - POST /api/users/voximplant-settings/test
    
    **Ответ:**
    - success: true/false
    - message: Результат проверки
    
    **Примечание:**
    - Пока просто проверяет наличие всех полей
    - В будущем можно добавить реальную проверку через Voximplant API
    """
    try:
        logger.info(f"[VOXIMPLANT-SETTINGS] Testing settings for user {current_user.id}")
        
        if not current_user.has_voximplant_config():
            return {
                "success": False,
                "message": "Настройки Voximplant не заполнены. Заполните все поля в разделе Настройки."
            }
        
        # TODO: Здесь можно добавить реальную проверку через Voximplant API
        # Например, попробовать получить список правил или сделать тестовый запрос
        
        logger.info(f"[VOXIMPLANT-SETTINGS] ✅ Settings test passed for user {current_user.id}")
        
        return {
            "success": True,
            "message": "Настройки Voximplant заполнены корректно",
            "config": {
                "account_id": current_user.voximplant_account_id,
                "rule_id": current_user.voximplant_rule_id,
                "caller_id": current_user.voximplant_caller_id
            }
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT-SETTINGS] Error testing settings: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка проверки настроек: {str(e)}")
