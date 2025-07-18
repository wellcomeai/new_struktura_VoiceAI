"""
ПОЛНЫЙ ИСПРАВЛЕННЫЙ файл ElevenLabs API endpoints для WellcomeAI application.
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

@router.get("/api-key/status")
async def check_api_key_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Check if user has ElevenLabs API key configured
    """
    try:
        logger.info(f"Checking API key status for user {current_user.id}")
        
        has_api_key = bool(current_user.elevenlabs_api_key)
        logger.info(f"User {current_user.id} has ElevenLabs API key: {has_api_key}")
        
        if has_api_key:
            # Проверяем валидность ключа
            logger.info("Validating ElevenLabs API key...")
            is_valid = await ElevenLabsService.validate_api_key(current_user.elevenlabs_api_key)
            logger.info(f"API key validation result: {is_valid}")
            
            return {
                "has_api_key": True,
                "is_valid": is_valid,
                "message": "API key is configured and valid" if is_valid else "API key is configured but invalid"
            }
        else:
            return {
                "has_api_key": False,
                "is_valid": False,
                "message": "ElevenLabs API key not found. Please add your API key first."
            }
    except Exception as e:
        logger.error(f"Error checking API key status: {str(e)}")
        return {
            "has_api_key": False,
            "is_valid": False,
            "message": "Error checking API key status"
        }

@router.post("/api-key")
async def save_api_key(
    request: ElevenLabsApiKeyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Save and validate ElevenLabs API key
    """
    try:
        logger.info(f"Saving API key for user {current_user.id}")
        
        # Валидируем API ключ через ElevenLabs API
        is_valid = await ElevenLabsService.validate_api_key(request.api_key)
        
        if not is_valid:
            logger.warning(f"Invalid API key provided by user {current_user.id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid ElevenLabs API key"
            )
        
        # Сохраняем API ключ в профиль пользователя
        current_user.elevenlabs_api_key = request.api_key
        db.commit()
        
        logger.info(f"API key saved successfully for user {current_user.id}")
        
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get available ElevenLabs voices
    """
    try:
        logger.info(f"Getting voices for user {current_user.id}")
        logger.info(f"User has ElevenLabs API key: {bool(current_user.elevenlabs_api_key)}")
        
        if not current_user.elevenlabs_api_key:
            logger.warning(f"User {current_user.id} tried to get voices without API key")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        logger.info("Fetching voices from ElevenLabs API...")
        voices = await ElevenLabsService.get_available_voices(current_user.elevenlabs_api_key)
        logger.info(f"Retrieved {len(voices)} voices from ElevenLabs")
        
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get all ElevenLabs agents for the current user
    """
    try:
        logger.info(f"Getting agents for user {current_user.id}")
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create a new ElevenLabs agent
    """
    try:
        logger.info(f"Creating agent for user {current_user.id}")
        logger.info(f"Agent data: {agent_data.dict()}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        result = await ElevenLabsService.create_agent(
            db, 
            str(current_user.id), 
            current_user.elevenlabs_api_key,
            agent_data
        )
        
        logger.info(f"✅ Agent created successfully: {result.id}")
        return result
        
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get ElevenLabs agent by ID
    """
    try:
        logger.info(f"Getting agent {agent_id} for user {current_user.id}")
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update ElevenLabs agent
    """
    try:
        logger.info(f"Updating agent {agent_id} for user {current_user.id}")
        
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete ElevenLabs agent
    """
    try:
        logger.info(f"Deleting agent {agent_id} for user {current_user.id}")
        
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get embed code for ElevenLabs agent
    """
    try:
        logger.info(f"Getting embed code for agent {agent_id} for user {current_user.id}")
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get signed URL for WebSocket connection
    ✅ ИСПРАВЛЕНО: Улучшена обработка ошибок и логирование
    """
    try:
        logger.info(f"Getting signed URL for agent {agent_id} for user {current_user.id}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        # Получаем агента
        agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
        
        if not agent.elevenlabs_agent_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Agent not created in ElevenLabs yet. Please recreate the agent."
            )
        
        logger.info(f"🔍 Getting signed URL for ElevenLabs agent: {agent.elevenlabs_agent_id}")
        
        # ✅ ИСПРАВЛЕНО: Получаем signed URL с правильным методом
        signed_url = await ElevenLabsService.get_signed_url(
            current_user.elevenlabs_api_key,
            agent.elevenlabs_agent_id
        )
        
        logger.info(f"✅ Successfully got signed URL")
        
        # ✅ ДОБАВЛЕНО: Fallback URL для прямого подключения (для публичных агентов)
        fallback_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent.elevenlabs_agent_id}"
        
        return {
            "signed_url": signed_url,
            "agent_id": agent.elevenlabs_agent_id,
            "fallback_url": fallback_url,
            "message": "Signed URL generated successfully. Valid for 15 minutes."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting signed URL: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get signed URL: {str(e)}"
        )

# ✅ НОВЫЙ ENDPOINT: Для тестирования WebSocket соединения
@router.get("/{agent_id}/test-connection")
async def test_websocket_connection(
    agent_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Test WebSocket connection to ElevenLabs agent
    """
    try:
        logger.info(f"Testing connection for agent {agent_id}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        # Получаем агента
        agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
        
        if not agent.elevenlabs_agent_id:
            return {
                "success": False,
                "message": "Agent not created in ElevenLabs yet",
                "details": {
                    "agent_id": agent_id,
                    "elevenlabs_agent_id": None
                }
            }
        
        # Проверяем API ключ
        api_key_valid = await ElevenLabsService.validate_api_key(current_user.elevenlabs_api_key)
        
        if not api_key_valid:
            return {
                "success": False,
                "message": "Invalid ElevenLabs API key",
                "details": {
                    "agent_id": agent_id,
                    "elevenlabs_agent_id": agent.elevenlabs_agent_id,
                    "api_key_valid": False
                }
            }
        
        # Пытаемся получить signed URL
        try:
            signed_url = await ElevenLabsService.get_signed_url(
                current_user.elevenlabs_api_key,
                agent.elevenlabs_agent_id
            )
            
            return {
                "success": True,
                "message": "Connection test successful",
                "details": {
                    "agent_id": agent_id,
                    "elevenlabs_agent_id": agent.elevenlabs_agent_id,
                    "api_key_valid": True,
                    "signed_url_obtained": True,
                    "signed_url": signed_url
                }
            }
            
        except Exception as e:
            logger.error(f"Failed to get signed URL during test: {str(e)}")
            return {
                "success": False,
                "message": f"Failed to get signed URL: {str(e)}",
                "details": {
                    "agent_id": agent_id,
                    "elevenlabs_agent_id": agent.elevenlabs_agent_id,
                    "api_key_valid": True,
                    "signed_url_obtained": False,
                    "error": str(e)
                }
            }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error during connection test: {str(e)}")
        return {
            "success": False,
            "message": f"Connection test failed: {str(e)}",
            "details": {
                "agent_id": agent_id,
                "error": str(e)
            }
        }

# ✅ СУЩЕСТВУЮЩИЙ ENDPOINT: Тестовый эндпоинт для проверки создания агента
@router.post("/test-create")
async def test_create_agent(
    test_data: Dict[str, Any],
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Test endpoint for creating agent with custom data
    """
    try:
        logger.info(f"Test creating agent for user {current_user.id}")
        logger.info(f"Test data: {json.dumps(test_data, indent=2)}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        # Создаем агента напрямую с переданными данными
        elevenlabs_agent_id = await ElevenLabsService.create_elevenlabs_agent(
            current_user.elevenlabs_api_key, 
            test_data
        )
        
        return {
            "success": True,
            "elevenlabs_agent_id": elevenlabs_agent_id,
            "message": "Test agent created successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in test create: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Test creation failed: {str(e)}"
        )
