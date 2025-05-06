"""
Integration API endpoints for WellcomeAI application.
Handles webhooks and external service integrations.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

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

# Pydantic models for request validation
class IntegrationCreate(BaseModel):
    name: str = Field(..., description="Name of the integration")
    type: str = Field(..., description="Type of integration (e.g., 'n8n')")
    webhook_url: str = Field(..., description="URL of the webhook")
    is_active: bool = Field(True, description="Whether the integration is active")

class IntegrationUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    webhook_url: Optional[str] = None
    is_active: Optional[bool] = None

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

@router.post("/{assistant_id}/integrations", response_model=dict)
async def create_integration(
    integration_data: IntegrationCreate,
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create a new integration for an assistant.
    
    Args:
        integration_data: Integration creation data
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        New integration object
    """
    try:
        # Verify assistant belongs to user
        from backend.services.assistant_service import AssistantService
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Create integration
        integration = await IntegrationService.create_integration(db, assistant_id, integration_data.dict())
        return integration
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in create_integration: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create integration"
        )

@router.put("/{assistant_id}/integrations/{integration_id}", response_model=dict)
async def update_integration(
    integration_data: IntegrationUpdate,
    assistant_id: str = Path(..., description="The ID of the assistant"),
    integration_id: str = Path(..., description="The ID of the integration"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update an integration.
    
    Args:
        integration_data: Integration update data
        assistant_id: Assistant ID
        integration_id: Integration ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Updated integration object
    """
    try:
        # Verify assistant belongs to user
        from backend.services.assistant_service import AssistantService
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Update integration
        integration = await IntegrationService.update_integration(
            db, assistant_id, integration_id, integration_data.dict(exclude_unset=True)
        )
        return integration
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in update_integration: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update integration"
        )

@router.delete("/{assistant_id}/integrations/{integration_id}", response_model=dict)
async def delete_integration(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    integration_id: str = Path(..., description="The ID of the integration"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete an integration.
    
    Args:
        assistant_id: Assistant ID
        integration_id: Integration ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Confirmation message
    """
    try:
        # Verify assistant belongs to user
        from backend.services.assistant_service import AssistantService
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Delete integration
        await IntegrationService.delete_integration(db, assistant_id, integration_id)
        return {"success": True, "message": "Integration deleted successfully", "id": integration_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_integration: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete integration"
        )
