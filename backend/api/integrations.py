"""
Integration API endpoints for WellcomeAI application.
Handles webhooks and external service integrations.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.models.integration import Integration
from backend.services.integration_service import IntegrationService

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.get("/{assistant_id}/integrations", response_model=List[dict])
async def get_integrations(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get all integrations for an assistant.
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        List of integration objects
    """
    try:
        # Verify assistant belongs to user
        from backend.services.assistant_service import AssistantService
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Get integrations
        integrations = await IntegrationService.get_integrations(db, assistant_id)
        return integrations
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_integrations: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve integrations"
        )

# Add more endpoints for creating, updating, and deleting integrations
