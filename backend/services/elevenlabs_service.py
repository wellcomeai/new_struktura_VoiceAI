"""
ИСПРАВЛЕННЫЙ ElevenLabs service для WellcomeAI application.
Основные изменения:
1. Исправлен endpoint для получения signed URL
2. Исправлена обработка ответа
3. Добавлены дополнительные проверки
"""

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any
import json

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.elevenlabs import ElevenLabsAgent
from backend.schemas.elevenlabs import (
    ElevenLabsAgentCreate, 
    ElevenLabsAgentUpdate, 
    ElevenLabsAgentResponse,
    ElevenLabsVoiceResponse,
    ElevenLabsEmbedResponse
)

logger = get_logger(__name__)

class ElevenLabsService:
    """Service for ElevenLabs operations"""
    
    ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1"
    
    @staticmethod
    def is_admin(user_email: str) -> bool:
        """Проверить, является ли пользователь админом"""
        return user_email == "well96well@gmail.com"
    
    @staticmethod
    async def validate_api_key(api_key: str) -> bool:
        """
        Validate ElevenLabs API key
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/user",
                    headers={"xi-api-key": api_key}
                )
                logger.info(f"API key validation response: {response.status_code}")
                return response.status_code == 200
        except Exception as e:
            logger.error(f"Error validating API key: {str(e)}")
            return False
    
    @staticmethod
    async def get_available_voices(api_key: str) -> List[ElevenLabsVoiceResponse]:
        """
        Get available voices from ElevenLabs
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/voices",
                    headers={"xi-api-key": api_key}
                )
                
                if response.status_code != 200:
                    logger.error(f"Failed to get voices: {response.status_code} - {response.text}")
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Failed to get voices from ElevenLabs"
                    )
                
                voices_data = response.json()
                voices = []
                
                # Берем первые 10 голосов
                for voice in voices_data.get("voices", [])[:10]:
                    voices.append(ElevenLabsVoiceResponse(
                        voice_id=voice["voice_id"],
                        name=voice["name"],
                        preview_url=voice.get("preview_url"),
                        category=voice.get("category")
                    ))
                
                return voices
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error getting voices: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to get voices"
            )
    
    @staticmethod
    async def create_elevenlabs_agent(api_key: str, agent_data: Dict[str, Any]) -> str:
        """
        Create agent in ElevenLabs
        """
        try:
            url = f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents/create"
            
            logger.info(f"Creating agent at URL: {url}")
            logger.info(f"Agent data: {json.dumps(agent_data, indent=2)}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json"
                    },
                    json=agent_data
                )
                
                logger.info(f"ElevenLabs response status: {response.status_code}")
                logger.info(f"ElevenLabs response headers: {dict(response.headers)}")
                
                if response.status_code != 200:
                    logger.error(f"ElevenLabs API error: {response.status_code} - {response.text}")
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Failed to create agent in ElevenLabs: {response.text}"
                    )
                
                result = response.json()
                logger.info(f"Agent created successfully: {result}")
                return result.get("agent_id")
                
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error creating ElevenLabs agent: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to create agent in ElevenLabs: {str(e)}"
            )
    
    @staticmethod
    async def update_elevenlabs_agent(api_key: str, agent_id: str, agent_data: Dict[str, Any]) -> bool:
        """
        Update agent in ElevenLabs
        """
        try:
            url = f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents/{agent_id}"
            
            logger.info(f"Updating agent at URL: {url}")
            logger.info(f"Update data: {json.dumps(agent_data, indent=2)}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.patch(
                    url,
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json"
                    },
                    json=agent_data
                )
                
                logger.info(f"Update response status: {response.status_code}")
                if response.status_code != 200:
                    logger.error(f"Update failed: {response.text}")
                
                return response.status_code == 200
                
        except Exception as e:
            logger.error(f"Error updating ElevenLabs agent: {str(e)}")
            return False
    
    @staticmethod
    async def delete_elevenlabs_agent(api_key: str, agent_id: str) -> bool:
        """
        Delete agent from ElevenLabs
        """
        try:
            url = f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents/{agent_id}"
            
            logger.info(f"Deleting agent at URL: {url}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.delete(
                    url,
                    headers={"xi-api-key": api_key}
                )
                
                logger.info(f"Delete response status: {response.status_code}")
                if response.status_code != 200:
                    logger.error(f"Delete failed: {response.text}")
                
                return response.status_code == 200
                
        except Exception as e:
            logger.error(f"Error deleting ElevenLabs agent: {str(e)}")
            return False
    
    @staticmethod
    async def get_signed_url(api_key: str, agent_id: str) -> str:
        """
        Get signed URL for WebSocket connection
        ✅ ИСПРАВЛЕНО: Правильный endpoint и обработка ответа
        """
        try:
            # ✅ ИСПРАВЛЕНО: Используем get_signed_url (с underscore) вместо get-signed-url
            url = f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/conversation/get_signed_url"
            
            logger.info(f"Getting signed URL at: {url}")
            logger.info(f"Agent ID: {agent_id}")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    headers={"xi-api-key": api_key},
                    params={"agent_id": agent_id}
                )
                
                logger.info(f"Signed URL response status: {response.status_code}")
                logger.info(f"Signed URL response body: {response.text}")
                
                if response.status_code != 200:
                    logger.error(f"Failed to get signed URL: {response.status_code} - {response.text}")
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Failed to get signed URL: {response.text}"
                    )
                
                result = response.json()
                signed_url = result.get("signed_url")
                
                if not signed_url:
                    logger.error(f"No signed_url in response: {result}")
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="No signed URL returned from ElevenLabs"
                    )
                
                logger.info(f"✅ Got signed URL: {signed_url}")
                return signed_url
                
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error getting signed URL: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to get signed URL: {str(e)}"
            )
    
    # ... остальные методы остаются без изменений ...
    
    @staticmethod
    async def get_agents(db: Session, user_id: str) -> List[ElevenLabsAgentResponse]:
        """
        Get all agents for user
        """
        agents = db.query(ElevenLabsAgent).filter(ElevenLabsAgent.user_id == user_id).all()
        
        return [
            ElevenLabsAgentResponse(
                id=str(agent.id),
                user_id=str(agent.user_id),
                elevenlabs_agent_id=agent.elevenlabs_agent_id,
                name=agent.name,
                system_prompt=agent.system_prompt,
                voice_id=agent.voice_id,
                voice_name=agent.voice_name,
                is_active=agent.is_active,
                created_at=agent.created_at,
                updated_at=agent.updated_at
            )
            for agent in agents
        ]
    
    @staticmethod
    async def get_agent_by_id(db: Session, agent_id: str, user_id: str) -> ElevenLabsAgentResponse:
        """
        Get agent by ID
        """
        agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == agent_id,
            ElevenLabsAgent.user_id == user_id
        ).first()
        
        if not agent:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Agent not found"
            )
        
        return ElevenLabsAgentResponse(
            id=str(agent.id),
            user_id=str(agent.user_id),
            elevenlabs_agent_id=agent.elevenlabs_agent_id,
            name=agent.name,
            system_prompt=agent.system_prompt,
            voice_id=agent.voice_id,
            voice_name=agent.voice_name,
            is_active=agent.is_active,
            created_at=agent.created_at,
            updated_at=agent.updated_at
        )
    
    @staticmethod
    async def create_agent(
        db: Session, 
        user_id: str, 
        api_key: str, 
        agent_data: ElevenLabsAgentCreate
    ) -> ElevenLabsAgentResponse:
        """Create new agent"""
        try:
            from backend.models.user import User
            from backend.services.user_service import UserService
            
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Проверка подписки
            if not ElevenLabsService.is_admin(user.email):
                subscription_status = await UserService.check_subscription_status(db, str(user.id))
                if not subscription_status["active"]:
                    raise HTTPException(
                        status_code=status.HTTP_402_PAYMENT_REQUIRED,
                        detail={
                            "error": "subscription_required",
                            "message": "Active subscription required to create ElevenLabs agents",
                            "code": "SUBSCRIPTION_REQUIRED"
                        }
                    )
            
            # Структура данных для ElevenLabs
            elevenlabs_agent_data = {
                "conversation_config": {
                    "agent": {
                        "prompt": {
                            "prompt": agent_data.system_prompt or "You are a helpful assistant."
                        }
                    },
                    "tts": {
                        "voice_id": agent_data.voice_id
                    }
                },
                "name": agent_data.name
            }
            
            logger.info(f"Creating ElevenLabs agent with data: {json.dumps(elevenlabs_agent_data, indent=2)}")
            
            # Создаем агента в ElevenLabs
            elevenlabs_agent_id = await ElevenLabsService.create_elevenlabs_agent(
                api_key, elevenlabs_agent_data
            )
            
            # Создаем запись в нашей БД
            agent = ElevenLabsAgent(
                user_id=user_id,
                elevenlabs_agent_id=elevenlabs_agent_id,
                name=agent_data.name,
                system_prompt=agent_data.system_prompt,
                voice_id=agent_data.voice_id,
                voice_name=agent_data.voice_name,
                is_active=True
            )
            
            db.add(agent)
            db.commit()
            db.refresh(agent)
            
            logger.info(f"✅ ElevenLabs agent created successfully: {agent.id} for user {user_id}")
            
            return ElevenLabsAgentResponse(
                id=str(agent.id),
                user_id=str(agent.user_id),
                elevenlabs_agent_id=agent.elevenlabs_agent_id,
                name=agent.name,
                system_prompt=agent.system_prompt,
                voice_id=agent.voice_id,
                voice_name=agent.voice_name,
                is_active=agent.is_active,
                created_at=agent.created_at,
                updated_at=agent.updated_at
            )
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error creating agent: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create agent"
            )
    
    @staticmethod
    async def get_embed_code(db: Session, agent_id: str, user_id: str) -> ElevenLabsEmbedResponse:
        """Get embed code for agent"""
        agent = db.query(ElevenLabsAgent).filter(
            ElevenLabsAgent.id == agent_id,
            ElevenLabsAgent.user_id == user_id
        ).first()
        
        if not agent:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Agent not found"
            )
        
        if not agent.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Agent is not active"
            )
        
        embed_code = f"""<!-- ElevenLabs Voice Assistant -->
<script>
    (function() {{
        var script = document.createElement('script');
        script.src = '{settings.HOST_URL}/static/js/elevenlabs-widget.js';
        script.dataset.agentId = '{agent_id}';
        script.dataset.server = '{settings.HOST_URL}';
        script.dataset.position = 'bottom-right';
        script.async = true;
        document.head.appendChild(script);
    }})();
</script>
<!-- End ElevenLabs Voice Assistant -->"""
        
        return ElevenLabsEmbedResponse(
            embed_code=embed_code,
            agent_id=agent_id
        )
