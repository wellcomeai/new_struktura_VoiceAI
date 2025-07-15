"""
ElevenLabs API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Dict, Any
import httpx
import json

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_subscription_active_for_assistants
from backend.db.session import get_db
from backend.models.user import User
from backend.models.elevenlabs import ElevenLabsAgent
from backend.services.elevenlabs_service import ElevenLabsService
from backend.schemas.elevenlabs import (
    ElevenLabsAgentCreate, 
    ElevenLabsAgentUpdate, 
    ElevenLabsAgentResponse,
    ElevenLabsApiKeyRequest,
    ElevenLabsVoiceResponse,
    ElevenLabsEmbedResponse
)

logger = get_logger(__name__)
router = APIRouter()

@router.post("/api-key")
async def save_api_key(
    request: ElevenLabsApiKeyRequest,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Save and validate ElevenLabs API key
    """
    try:
        # Валидируем API ключ через ElevenLabs API
        is_valid = await ElevenLabsService.validate_api_key(request.api_key)
        
        if not is_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid ElevenLabs API key"
            )
        
        # Сохраняем API ключ в профиль пользователя
        current_user.elevenlabs_api_key = request.api_key
        db.commit()
        
        # Получаем доступные голоса
        voices = await ElevenLabsService.get_available_voices(request.api_key)
        
        return {
            "success": True,
            "message": "API key saved successfully",
            "voices": voices
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving API key: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save API key"
        )

@router.get("/voices", response_model=List[ElevenLabsVoiceResponse])
async def get_voices(
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Get available ElevenLabs voices
    """
    try:
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        voices = await ElevenLabsService.get_available_voices(current_user.elevenlabs_api_key)
        return voices
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting voices: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get voices"
        )

@router.get("/", response_model=List[ElevenLabsAgentResponse])
async def get_agents(
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Get all ElevenLabs agents for the current user
    """
    try:
        return await ElevenLabsService.get_agents(db, str(current_user.id))
    except Exception as e:
        logger.error(f"Error getting agents: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve agents"
        )

@router.post("/", response_model=ElevenLabsAgentResponse)
async def create_agent(
    agent_data: ElevenLabsAgentCreate,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Create a new ElevenLabs agent
    """
    try:
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        return await ElevenLabsService.create_agent(
            db, 
            str(current_user.id), 
            current_user.elevenlabs_api_key,
            agent_data
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating agent: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create agent"
        )

@router.get("/{agent_id}", response_model=ElevenLabsAgentResponse)
async def get_agent(
    agent_id: str,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Get ElevenLabs agent by ID
    """
    try:
        return await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting agent: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve agent"
        )

@router.put("/{agent_id}", response_model=ElevenLabsAgentResponse)
async def update_agent(
    agent_id: str,
    agent_data: ElevenLabsAgentUpdate,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Update ElevenLabs agent
    """
    try:
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        return await ElevenLabsService.update_agent(
            db, 
            agent_id, 
            str(current_user.id),
            current_user.elevenlabs_api_key,
            agent_data
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating agent: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update agent"
        )

@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: str,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Delete ElevenLabs agent
    """
    try:
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        await ElevenLabsService.delete_agent(
            db, 
            agent_id, 
            str(current_user.id),
            current_user.elevenlabs_api_key
        )
        
        return {"success": True, "message": "Agent deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting agent: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete agent"
        )

@router.get("/{agent_id}/embed", response_model=ElevenLabsEmbedResponse)
async def get_embed_code(
    agent_id: str,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Get embed code for ElevenLabs agent
    """
    try:
        return await ElevenLabsService.get_embed_code(db, agent_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting embed code: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embed code"
        )

@router.get("/{agent_id}/signed-url")
async def get_signed_url(
    agent_id: str,
    current_user: User = Depends(check_subscription_active_for_assistants),
    db: Session = Depends(get_db)
):
    """
    Get signed URL for WebSocket connection
    """
    try:
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        # Получаем агента
        agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
        
        if not agent.elevenlabs_agent_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Agent not created in ElevenLabs yet"
            )
        
        # Получаем signed URL
        signed_url = await ElevenLabsService.get_signed_url(
            current_user.elevenlabs_api_key,
            agent.elevenlabs_agent_id
        )
        
        return {
            "signed_url": signed_url,
            "agent_id": agent.elevenlabs_agent_id,
            "fallback_url": f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent.elevenlabs_agent_id}"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting signed URL: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get signed URL"
        )
