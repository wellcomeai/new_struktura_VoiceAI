# backend/api/integrations.py

from fastapi import APIRouter, Depends, HTTPException, status, Path
from sqlalchemy.orm import Session
from typing import List

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.services.assistant_service import AssistantService
from backend.services.integration_service import IntegrationService
from backend.schemas.integration import IntegrationResponse

router = APIRouter()
logger = get_logger(__name__)

@router.get(
    "/{assistant_id}/integrations",
    response_model=List[IntegrationResponse],
)
async def get_integrations(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Получить список интеграций для данного ассистента.
    """
    try:
        # Сначала убеждаемся, что ассистент существует и принадлежит текущему пользователю
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))

        # Дальше уже возвращаем из своего сервиса интеграций
        return await IntegrationService.get_integrations(db, assistant_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_integrations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve integrations",
        )
