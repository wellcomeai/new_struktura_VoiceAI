# backend/api/assistants.py

"""
Assistant API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query, Path
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_assistant_limit
from backend.db.session import get_db
from backend.models.user import User
from backend.schemas.assistant import (
    AssistantCreate,
    AssistantUpdate,
    AssistantResponse,
    EmbedCodeResponse,
)
from backend.schemas.conversation import ConversationResponse, ConversationStats
from backend.services.assistant_service import AssistantService
from backend.services.conversation_service import ConversationService
from backend.functions.registry import get_function, get_all_functions, get_tools_for_openai

logger = get_logger(__name__)

# Create router
router = APIRouter()

class FunctionTestRequest(BaseModel):
    function_name: str
    arguments: Dict[str, Any] = {}

@router.get("/", response_model=List[AssistantResponse])
async def get_assistants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get all assistants for the current user.
    """
    try:
        return await AssistantService.get_assistants(db, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistants: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistants",
        )

@router.post("/", response_model=AssistantResponse, status_code=status.HTTP_201_CREATED)
async def create_assistant(
    assistant_data: AssistantCreate,
    current_user: User = Depends(check_assistant_limit),
    db: Session = Depends(get_db),
):
    """
    Create a new assistant.
    """
    try:
        return await AssistantService.create_assistant(
            db, str(current_user.id), assistant_data
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in create_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create assistant",
        )

@router.get("/{assistant_id}", response_model=AssistantResponse)
async def get_assistant(
    assistant_id: str = Path(..., description="The ID of the assistant to retrieve"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get assistant by ID.
    """
    try:
        assistant = await AssistantService.get_assistant_by_id(
            db, assistant_id, str(current_user.id)
        )
        return AssistantResponse.from_orm(assistant)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistant",
        )

@router.put("/{assistant_id}", response_model=AssistantResponse)
async def update_assistant(
    assistant_data: AssistantUpdate,
    assistant_id: str = Path(..., description="The ID of the assistant to update"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update an assistant.
    """
    try:
        return await AssistantService.update_assistant(
            db, assistant_id, str(current_user.id), assistant_data
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in update_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update assistant",
        )

@router.delete("/{assistant_id}", response_model=dict)
async def delete_assistant(
    assistant_id: str = Path(..., description="The ID of the assistant to delete"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete an assistant.
    """
    try:
        await AssistantService.delete_assistant(db, assistant_id, str(current_user.id))
        return {"success": True, "message": "Assistant deleted successfully", "id": assistant_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete assistant",
        )

@router.get("/{assistant_id}/embed-code", response_model=EmbedCodeResponse)
async def get_embed_code(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get embed code for an assistant.
    """
    try:
        return await AssistantService.get_embed_code(db, assistant_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_embed_code: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embed code",
        )

@router.get("/{assistant_id}/conversations", response_model=List[ConversationResponse])
async def get_conversations(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    skip: int = Query(0, ge=0, description="Number of conversations to skip"),
    limit: int = Query(50, ge=1, le=100, description="Maximum number of conversations"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get conversations for an assistant.
    """
    try:
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        return await ConversationService.get_conversations(db, assistant_id, skip, limit)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversations",
        )

@router.get("/{assistant_id}/stats", response_model=ConversationStats)
async def get_conversation_stats(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get conversation statistics for an assistant.
    """
    try:
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        return await ConversationService.get_conversation_stats(db, assistant_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversation_stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversation statistics",
        )

@router.get("/{assistant_id}/functions", response_model=List[Dict[str, Any]])
async def get_available_functions(
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get available functions for the assistant.
    """
    try:
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        registered_functions = get_all_functions()

        enabled = []
        if assistant.functions and isinstance(assistant.functions, dict):
            enabled = assistant.functions.get("enabled_functions", [])

        result = []
        for fn, info in registered_functions.items():
            result.append({
                "id": fn,
                "name": fn,
                "description": info["description"],
                "parameters": info["parameters"],
                "enabled": fn in enabled,
            })
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_available_functions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve available functions",
        )

@router.post("/{assistant_id}/test-function", response_model=Dict[str, Any])
async def test_function(
    function_data: FunctionTestRequest,
    assistant_id: str = Path(..., description="The ID of the assistant"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Test a function with the assistant.
    """
    try:
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        from backend.websockets.openai_client import OpenAIRealtimeClient

        client = OpenAIRealtimeClient(
            api_key=current_user.openai_api_key or "",
            assistant_config=assistant,
            client_id="test_function",
            db_session=db,
        )
        result = await client.handle_function_call(
            function_data.function_name, function_data.arguments
        )
        return {
            "function": function_data.function_name,
            "arguments": function_data.arguments,
            "result": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in test_function: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to test function: {e}",
        )
