"""
Assistant API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query, Path
from sqlalchemy.orm import Session
from typing import List, Optional

from core.logging import get_logger
from core.security import get_current_user
from db.session import get_db
from models.user import User
from schemas.assistant import AssistantCreate, AssistantUpdate, AssistantResponse, EmbedCodeResponse
from schemas.conversation import ConversationResponse, ConversationStats
from services.assistant_service import AssistantService
from services.conversation_service import ConversationService

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.get("", response_model=List[AssistantResponse])
async def get_assistants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get all assistants for the current user.
    
    Args:
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        List of AssistantResponse objects
    """
    try:
        return await AssistantService.get_assistants(db, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistants: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistants"
        )

@router.post("", response_model=AssistantResponse, status_code=status.HTTP_201_CREATED)
async def create_assistant(
    assistant_data: AssistantCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create a new assistant.
    
    Args:
        assistant_data: Assistant creation data
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        AssistantResponse with the new assistant information
    """
    try:
        return await AssistantService.create_assistant(db, str(current_user.id), assistant_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in create_assistant: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create assistant"
        )

@router.get("/{assistant_id}", response_model=AssistantResponse)
async def get_assistant(
    assistant_id: str = Path(..., description="The ID of the assistant to retrieve"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get assistant by ID.
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        AssistantResponse with the assistant information
    """
    try:
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        return AssistantResponse(
            id=str(assistant.id),
            user_id=str(assistant.user_id),
            name=assistant.name,
            description=assistant.description,
            system_prompt=assistant.system_prompt,
            voice=assistant.voice,
            language=assistant.language,
            google_sheet_id=assistant.google_sheet_id,
            functions=assistant.functions,
            is_active=assistant.is_active,
            is_public=assistant.is_public,
            created_at=assistant.created_at,
            updated_at=assistant.updated_at,
            total_conversations=assistant.total_conversations,
            temperature=assistant.temperature,
            max_tokens=assistant.max_tokens
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistant: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistant"
        )

@router.put("/{assistant_id}", response_model=AssistantResponse)
async def update_assistant(
    assistant_data: AssistantUpdate,
    assistant_id: str = Path(..., description="The ID of the assistant to update"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update an assistant.
    
    Args:
        assistant_data: Assistant update data
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        AssistantResponse with the updated assistant information
    """
    try:
        return await AssistantService.update_assistant(db, assistant_id, str(current_user.id), assistant_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in update_assistant: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update assistant"
        )

@router.delete("/{assistant_id}", response_model=dict)
async def delete_assistant(
    assistant_id: str = Path(..., description="The ID of the assistant to delete"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete an assistant.
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Confirmation message
    """
    try:
        await AssistantService.delete_assistant(db, assistant_id, str(current_user.id))
        return {"success": True, "message": "Assistant deleted successfully", "id": assistant_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_assistant: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete assistant"
        )

@router.get("/{assistant_id}/embed-code", response_model=EmbedCodeResponse)
async def get_embed_code(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get embed code for an assistant.
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        EmbedCodeResponse with the embed code
    """
    try:
        return await AssistantService.get_embed_code(db, assistant_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_embed_code: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embed code"
        )

@router.get("/{assistant_id}/conversations", response_model=List[ConversationResponse])
async def get_conversations(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    skip: int = Query(0, ge=0, description="Number of conversations to skip"),
    limit: int = Query(50, ge=1, le=100, description="Maximum number of conversations to return"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get conversations for an assistant.
    
    Args:
        assistant_id: Assistant ID
        skip: Number of conversations to skip
        limit: Maximum number of conversations to return
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        List of ConversationResponse objects
    """
    try:
        # Verify assistant belongs to user
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        return await ConversationService.get_conversations(db, assistant_id, skip, limit)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversations: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversations"
        )

@router.get("/{assistant_id}/stats", response_model=ConversationStats)
async def get_conversation_stats(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get conversation statistics for an assistant.
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        ConversationStats with statistics information
    """
    try:
        # Verify assistant belongs to user
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        return await ConversationService.get_conversation_stats(db, assistant_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversation_stats: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversation statistics"
        )
