"""
OpenAI Realtime client for WellcomeAI application.
Handles WebSocket connections to OpenAI Realtime API.
"""

import asyncio
import json
import uuid
import base64
from typing import Dict, Any, Optional, List
import websockets
from websockets.exceptions import ConnectionClosed

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation

logger = get_logger(__name__)

class OpenAIRealtimeClient:
    """Client for OpenAI Realtime API"""
    
    def __init__(self, api_key: str, assistant_config: AssistantConfig, client_id: str, db_session=None):
        """
        Initialize OpenAI Realtime client
        
        Args:
            api_key: OpenAI API key
            assistant_config: Assistant configuration
            client_id: Client identifier
            db_session: Database session
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_id = None
        
    async def connect(self):
    try:
        # Create headers for authorization
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "openai-beta": "realtime=v1"  # Добавляем обязательный заголовок для Realtime API
        }
        
        logger.info(f"Connecting to OpenAI Realtime API: {self.openai_url}")
        
        # Далее остальной код без изменений...
            
            # Establish connection to OpenAI
            self.ws = await websockets.connect(
                self.openai_url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=60,
                close_timeout=30
            )
            
            self.is_connected = True
            logger.info(f"Connected to OpenAI Realtime API for client {self.client_id}")
            
            # Initialize conversation with system prompt
            await self._init_conversation()
            
            return True
        except Exception as e:
            logger.error(f"Failed to connect to OpenAI Realtime API: {str(e)}")
            self.is_connected = False
            return False
    
    async def _init_conversation(self):
        """Initialize conversation with system prompt"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            # Send system prompt
            init_message = {
                "type": "message",
                "message": {
                    "role": "system",
                    "content": self.assistant_config.system_prompt or "You are a helpful voice assistant."
                }
            }
            
            await self.ws.send(json.dumps(init_message))
            logger.debug(f"Sent system prompt to OpenAI")
            
            # Create new conversation record in database, if session exists
            if self.db_session:
                try:
                    conversation = Conversation(
                        assistant_id=self.assistant_config.id,
                        session_id=self.session_id,
                        user_message="",
                        assistant_message="",
                    )
                    self.db_session.add(conversation)
                    self.db_session.commit()
                    self.db_session.refresh(conversation)
                    self.conversation_id = str(conversation.id)
                    logger.info(f"Created new conversation record: {self.conversation_id}")
                except Exception as db_error:
                    logger.error(f"Error creating conversation record: {str(db_error)}")
            
            return True
        except Exception as e:
            logger.error(f"Error initializing conversation: {str(e)}")
            return False
    
    async def process_audio(self, audio_buffer: bytes) -> bool:
        """
        Send audio for processing to OpenAI
        
        Args:
            audio_buffer: Audio data as bytes
            
        Returns:
            True if successful
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot process audio: not connected to OpenAI")
            return False
            
        try:
            # Convert audio to base64
            audio_base64 = base64.b64encode(audio_buffer).decode('utf-8')
            
            # Create message for sending
            audio_message = {
                "type": "audio",
                "audio": audio_base64,
                "audio_format": "pcm_s16le",  # 16-bit signed PCM, little-endian
                "sample_rate": 24000,
                "model": "gpt-4o"  # or another model supporting audio
            }
            
            # Send audio to OpenAI
            await self.ws.send(json.dumps(audio_message))
            logger.debug(f"Sent audio to OpenAI ({len(audio_buffer)} bytes)")
            
            # Update conversation in database
            if self.db_session and self.conversation_id:
                try:
                    conversation = self.db_session.query(Conversation).filter(
                        Conversation.id == uuid.UUID(self.conversation_id)
                    ).first()
                    
                    if conversation:
                        # We mark that user sent a message, content will be updated later with transcription
                        conversation.user_message = "[Audio message]"
                        self.db_session.commit()
                except Exception as db_error:
                    logger.error(f"Error updating conversation: {str(db_error)}")
            
            return True
        except Exception as e:
            logger.error(f"Error sending audio to OpenAI: {str(e)}")
            return False
    
    async def close(self):
        """Close connection to OpenAI"""
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"Closed connection to OpenAI for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI connection: {str(e)}")
        
        self.is_connected = False
