"""
ИСПРАВЛЕННЫЙ файл ElevenLabs API endpoints для WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
import httpx
import json
import traceback

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

def validate_agent_data(agent_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Валидация данных агента
    """
    errors = []
    
    # Проверка обязательных полей
    if not agent_data.get('name', '').strip():
        errors.append("Название агента обязательно")
    
    if not agent_data.get('system_prompt', '').strip():
        errors.append("Системный промпт обязателен")
    
    if not agent_data.get('voice_id', '').strip():
        errors.append("Голос обязателен")
    
    # Проверка числовых значений
    try:
        temperature = float(agent_data.get('llm_temperature', 0.7))
        if temperature < 0 or temperature > 2:
            errors.append("Температура должна быть между 0 и 2")
        agent_data['llm_temperature'] = temperature
    except (ValueError, TypeError):
        errors.append("Некорректное значение температуры")
    
    try:
        max_tokens = int(agent_data.get('max_tokens', 1000))
        if max_tokens < 100 or max_tokens > 4000:
            errors.append("Количество токенов должно быть между 100 и 4000")
        agent_data['max_tokens'] = max_tokens
    except (ValueError, TypeError):
        errors.append("Некорректное значение максимальных токенов")
    
    try:
        stability = float(agent_data.get('voice_stability', 0.5))
        if stability < 0 or stability > 1:
            errors.append("Стабильность голоса должна быть между 0 и 1")
        agent_data['voice_stability'] = stability
    except (ValueError, TypeError):
        errors.append("Некорректное значение стабильности голоса")
    
    try:
        similarity = float(agent_data.get('voice_similarity', 0.8))
        if similarity < 0 or similarity > 1:
            errors.append("Схожесть голоса должна быть между 0 и 1")
        agent_data['voice_similarity'] = similarity
    except (ValueError, TypeError):
        errors.append("Некорректное значение схожести голоса")
    
    try:
        speed = float(agent_data.get('voice_speed', 1.0))
        if speed < 0.5 or speed > 2.0:
            errors.append("Скорость голоса должна быть между 0.5 и 2.0")
        agent_data['voice_speed'] = speed
    except (ValueError, TypeError):
        errors.append("Некорректное значение скорости голоса")
    
    # Проверка встроенных инструментов
    built_in_tools = agent_data.get('built_in_tools', [])
    if not isinstance(built_in_tools, list):
        errors.append("Встроенные инструменты должны быть списком")
    else:
        valid_tools = [
            'end_call', 'language_detection', 'agent_transfer', 
            'human_transfer', 'skip_turn', 'play_dtmf'
        ]
        for tool in built_in_tools:
            if tool not in valid_tools:
                errors.append(f"Неизвестный инструмент: {tool}")
    
    if errors:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Ошибки валидации: {'; '.join(errors)}"
        )
    
    return agent_data

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
        logger.error(f"Traceback: {traceback.format_exc()}")
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
        logger.error(f"Traceback: {traceback.format_exc()}")
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
        logger.error(f"Traceback: {traceback.format_exc()}")
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
        agents = await ElevenLabsService.get_agents(db, str(current_user.id))
        logger.info(f"Retrieved {len(agents)} agents for user {current_user.id}")
        return agents
    except Exception as e:
        logger.error(f"Error getting agents: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
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
        
        # Конвертируем в dict для валидации
        agent_dict = agent_data.dict()
        logger.info(f"Agent data received: {agent_dict}")
        
        # Валидируем данные
        agent_dict = validate_agent_data(agent_dict)
        logger.info(f"Agent data validated: {agent_dict}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found. Please add your API key first."
            )
        
        # Создаем агента через сервис
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
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create agent: {str(e)}"
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
        agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
        logger.info(f"Retrieved agent {agent_id}: {agent.name}")
        return agent
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting agent {agent_id}: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve agent: {str(e)}"
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
    ✅ ИСПРАВЛЕНО: Улучшена обработка ошибок и валидация данных
    """
    try:
        logger.info(f"Updating agent {agent_id} for user {current_user.id}")
        
        # Конвертируем в dict для валидации
        agent_dict = agent_data.dict()
        logger.info(f"Agent data received: {agent_dict}")
        
        # Валидируем данные
        agent_dict = validate_agent_data(agent_dict)
        logger.info(f"Agent data validated: {agent_dict}")
        
        if not current_user.elevenlabs_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ElevenLabs API key not found"
            )
        
        # Проверяем существование агента
        try:
            existing_agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
            logger.info(f"Existing agent found: {existing_agent.name}")
        except HTTPException as e:
            if e.status_code == 404:
                logger.error(f"Agent {agent_id} not found for user {current_user.id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Agent {agent_id} not found"
                )
            raise
        
        # Обновляем агента
        result = await ElevenLabsService.update_agent(
            db, 
            agent_id, 
            str(current_user.id),
            current_user.elevenlabs_api_key,
            agent_data
        )
        
        logger.info(f"✅ Agent updated successfully: {result.id}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error updating agent {agent_id}: {str(e)}")
        logger.error(f"❌ Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update agent: {str(e)}"
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
        
        logger.info(f"✅ Agent {agent_id} deleted successfully")
        return {"success": True, "message": "Agent deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error deleting agent {agent_id}: {str(e)}")
        logger.error(f"❌ Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete agent: {str(e)}"
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
        embed_data = await ElevenLabsService.get_embed_code(db, agent_id, str(current_user.id))
        logger.info(f"Generated embed code for agent {agent_id}")
        return embed_data
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting embed code for agent {agent_id}: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate embed code: {str(e)}"
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
        
        # Получаем signed URL
        signed_url = await ElevenLabsService.get_signed_url(
            current_user.elevenlabs_api_key,
            agent.elevenlabs_agent_id
        )
        
        logger.info(f"✅ Successfully got signed URL")
        
        # Fallback URL для прямого подключения
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
        logger.error(f"❌ Error getting signed URL for agent {agent_id}: {str(e)}")
        logger.error(f"❌ Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get signed URL: {str(e)}"
        )

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
            return {
                "success": False,
                "message": "ElevenLabs API key not found",
                "details": {"agent_id": agent_id, "api_key_valid": False}
            }
        
        # Получаем агента
        try:
            agent = await ElevenLabsService.get_agent_by_id(db, agent_id, str(current_user.id))
        except HTTPException:
            return {
                "success": False,
                "message": "Agent not found",
                "details": {"agent_id": agent_id, "agent_exists": False}
            }
        
        if not agent.elevenlabs_agent_id:
            return {
                "success": False,
                "message": "Agent not created in ElevenLabs yet",
                "details": {
                    "agent_id": agent_id,
                    "elevenlabs_agent_id": None,
                    "agent_exists": True
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
        
    except Exception as e:
        logger.error(f"Error during connection test: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return {
            "success": False,
            "message": f"Connection test failed: {str(e)}",
            "details": {
                "agent_id": agent_id,
                "error": str(e)
            }
        }

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
        
        # Валидируем данные
        test_data = validate_agent_data(test_data)
        
        # Создаем агента напрямую с переданными данными
        elevenlabs_agent_id = await ElevenLabsService.create_elevenlabs_agent(
            current_user.elevenlabs_api_key, 
            test_data
        )
        
        logger.info(f"✅ Test agent created successfully: {elevenlabs_agent_id}")
        
        return {
            "success": True,
            "elevenlabs_agent_id": elevenlabs_agent_id,
            "message": "Test agent created successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in test create: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Test creation failed: {str(e)}"
        )
