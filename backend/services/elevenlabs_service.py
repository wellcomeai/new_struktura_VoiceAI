"""
ElevenLabs service for WellcomeAI application.
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
    
    # ✅ ДОБАВЛЕНО: Проверка админа (как в dashboard.html)
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
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents",
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json"
                    },
                    json=agent_data
                )
                
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Failed to create agent in ElevenLabs"
                    )
                
                result = response.json()
                return result.get("agent_id")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error creating ElevenLabs agent: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create agent in ElevenLabs"
            )
    
    @staticmethod
    async def update_elevenlabs_agent(api_key: str, agent_id: str, agent_data: Dict[str, Any]) -> bool:
        """
        Update agent in ElevenLabs
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.patch(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents/{agent_id}",
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json"
                    },
                    json=agent_data
                )
                
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
            async with httpx.AsyncClient() as client:
                response = await client.delete(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/agents/{agent_id}",
                    headers={"xi-api-key": api_key}
                )
                
                return response.status_code == 200
        except Exception as e:
            logger.error(f"Error deleting ElevenLabs agent: {str(e)}")
            return False
    
    @staticmethod
    async def get_signed_url(api_key: str, agent_id: str) -> str:
        """
        Get signed URL for WebSocket connection
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{ElevenLabsService.ELEVENLABS_API_BASE}/convai/conversation/get-signed-url",
                    headers={"xi-api-key": api_key},
                    params={"agent_id": agent_id}
                )
                
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Failed to get signed URL"
                    )
                
                result = response.json()
                return result.get("signed_url")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error getting signed URL: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to get signed URL"
            )
    
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
        """
        Create new agent
        """
        try:
            # ✅ ИСПРАВЛЕНО: Добавлена проверка админа (как в dashboard.html)
            from backend.models.user import User
            
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Проверяем админа - админу разрешаем всё
            if not ElevenLabsService.is_admin(user.email):
                # Для обычных пользователей проверяем подписку
                if not user.has_active_subscription():
                    raise HTTPException(
                        status_code=status.HTTP_402_PAYMENT_REQUIRED,
                        detail={
                            "error": "subscription_required",
                            "message": "Active subscription required to create ElevenLabs agents",
                            "code": "SUBSCRIPTION_REQUIRED"
                        }
                    )
            
            # Создаем агента в ElevenLabs
            elevenlabs_agent_data = {
                "name": agent_data.name,
                "conversation_config": {
                    "agent": {
                        "prompt": {
                            "prompt": agent_data.system_prompt or "You are a helpful assistant."
                        }
                    },
                    "tts": {
                        "voice_id": agent_data.voice_id
                    }
                }
            }
            
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
    async def update_agent(
        db: Session, 
        agent_id: str, 
        user_id: str, 
        api_key: str, 
        agent_data: ElevenLabsAgentUpdate
    ) -> ElevenLabsAgentResponse:
        """
        Update agent
        """
        try:
            # ✅ ИСПРАВЛЕНО: Добавлена проверка админа
            from backend.models.user import User
            
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Проверяем админа - админу разрешаем всё
            if not ElevenLabsService.is_admin(user.email):
                # Для обычных пользователей проверяем подписку
                if not user.has_active_subscription():
                    raise HTTPException(
                        status_code=status.HTTP_402_PAYMENT_REQUIRED,
                        detail={
                            "error": "subscription_required",
                            "message": "Active subscription required to update ElevenLabs agents",
                            "code": "SUBSCRIPTION_REQUIRED"
                        }
                    )
            
            # Получаем агента
            agent = db.query(ElevenLabsAgent).filter(
                ElevenLabsAgent.id == agent_id,
                ElevenLabsAgent.user_id == user_id
            ).first()
            
            if not agent:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Agent not found"
                )
            
            # Обновляем в ElevenLabs если есть изменения
            if agent.elevenlabs_agent_id:
                elevenlabs_agent_data = {}
                
                if agent_data.name:
                    elevenlabs_agent_data["name"] = agent_data.name
                
                if agent_data.system_prompt or agent_data.voice_id:
                    elevenlabs_agent_data["conversation_config"] = {}
                    
                    if agent_data.system_prompt:
                        elevenlabs_agent_data["conversation_config"]["agent"] = {
                            "prompt": {
                                "prompt": agent_data.system_prompt
                            }
                        }
                    
                    if agent_data.voice_id:
                        elevenlabs_agent_data["conversation_config"]["tts"] = {
                            "voice_id": agent_data.voice_id
                        }
                
                if elevenlabs_agent_data:
                    await ElevenLabsService.update_elevenlabs_agent(
                        api_key, agent.elevenlabs_agent_id, elevenlabs_agent_data
                    )
            
            # Обновляем в нашей БД
            update_data = agent_data.dict(exclude_unset=True)
            for key, value in update_data.items():
                setattr(agent, key, value)
            
            db.commit()
            db.refresh(agent)
            
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
            logger.error(f"Error updating agent: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update agent"
            )
    
    @staticmethod
    async def delete_agent(db: Session, agent_id: str, user_id: str, api_key: str) -> bool:
        """
        Delete agent
        """
        try:
            # ✅ ИСПРАВЛЕНО: Добавлена проверка админа
            from backend.models.user import User
            
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Проверяем админа - админу разрешаем всё
            if not ElevenLabsService.is_admin(user.email):
                # Для обычных пользователей проверяем подписку
                if not user.has_active_subscription():
                    raise HTTPException(
                        status_code=status.HTTP_402_PAYMENT_REQUIRED,
                        detail={
                            "error": "subscription_required",
                            "message": "Active subscription required to delete ElevenLabs agents",
                            "code": "SUBSCRIPTION_REQUIRED"
                        }
                    )
            
            # Получаем агента
            agent = db.query(ElevenLabsAgent).filter(
                ElevenLabsAgent.id == agent_id,
                ElevenLabsAgent.user_id == user_id
            ).first()
            
            if not agent:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Agent not found"
                )
            
            # Удаляем из ElevenLabs
            if agent.elevenlabs_agent_id:
                await ElevenLabsService.delete_elevenlabs_agent(api_key, agent.elevenlabs_agent_id)
            
            # Удаляем из нашей БД
            db.delete(agent)
            db.commit()
            
            return True
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting agent: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete agent"
            )
    
    @staticmethod
    async def get_embed_code(db: Session, agent_id: str, user_id: str) -> ElevenLabsEmbedResponse:
        """
        Get embed code for agent
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
