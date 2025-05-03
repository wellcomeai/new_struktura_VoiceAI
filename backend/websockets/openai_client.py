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
import time

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation

logger = get_logger(__name__)


class OpenAIRealtimeClient:
    """Client for OpenAI Realtime API"""
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session=None
    ):
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
        self.conversation_record_id = None
        self.ping_interval = 20  # Seconds
        self.ping_task = None
        self.last_pong_time = 0
        self.pong_timeout = 60  # Seconds
        
    async def connect(self) -> bool:
        """
        Establish WebSocket connection to OpenAI Realtime API
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "openai-beta": "realtime=v1"
            }
            logger.info(f"Connecting to OpenAI Realtime API: {self.openai_url}")
            
            # Add timeout for connection
            connect_timeout = 30  # Seconds
            
            self.ws = await asyncio.wait_for(
                websockets.connect(
                    self.openai_url,
                    extra_headers=headers,
                    ping_interval=None,  # We'll handle ping/pong ourselves
                    ping_timeout=None,
                    close_timeout=30
                ),
                timeout=connect_timeout
            )
            
            self.is_connected = True
            self.last_pong_time = time.time()
            logger.info(f"Connected to OpenAI for client {self.client_id}")
            
            # Start ping/pong monitoring
            self.ping_task = asyncio.create_task(self._ping_manager())
            
            # Initialize conversation with system prompt
            success = await self._init_conversation()
            if not success:
                logger.error(f"Failed to initialize conversation for client {self.client_id}")
                await self.close()
                return False
                
            return True
        except asyncio.TimeoutError:
            logger.error(f"Connection timeout to OpenAI for client {self.client_id}")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Failed to connect to OpenAI: {str(e)}")
            self.is_connected = False
            return False

    async def _ping_manager(self):
        """Manage ping/pong to keep connection alive"""
        try:
            while self.is_connected and self.ws:
                try:
                    # Send ping
                    await self.ws.send(json.dumps({"type": "ping"}))
                    
                    # Check if we've received a pong recently
                    if time.time() - self.last_pong_time > self.pong_timeout:
                        logger.warning(f"No pong received in {self.pong_timeout}s, closing connection")
                        await self.close()
                        break
                        
                    # Wait for next ping
                    await asyncio.sleep(self.ping_interval)
                except Exception as e:
                    logger.error(f"Error in ping manager: {str(e)}")
                    await self.close()
                    break
        except asyncio.CancelledError:
            logger.debug(f"Ping manager cancelled for client {self.client_id}")
        except Exception as e:
            logger.error(f"Unexpected error in ping manager: {str(e)}")

    async def _init_conversation(self) -> bool:
        """
        Initialize conversation with system prompt
        
        Returns:
            True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            # Получаем системный промпт
            system_prompt = self.assistant_config.system_prompt or "You are a helpful voice assistant."
            
            # Исправлено: content теперь массив объектов вместо строки
            init_payload = {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": system_prompt
                        }
                    ]
                }
            }
            await self.ws.send(json.dumps(init_payload))
            logger.debug(f"Sent system prompt for client {self.client_id}")

            # Create conversation record in database if session is available
            if self.db_session:
                try:
                    conv = Conversation(
                        assistant_id=self.assistant_config.id,
                        session_id=self.session_id,
                        user_message="",
                        assistant_message="",
                    )
                    self.db_session.add(conv)
                    self.db_session.commit()
                    self.db_session.refresh(conv)
                    self.conversation_record_id = str(conv.id)
                    logger.info(f"Created conversation record: {self.conversation_record_id}")
                except Exception as db_error:
                    logger.error(f"Error creating conversation record: {str(db_error)}")
                    # Continue anyway, as this is not critical
            
            return True
        except Exception as e:
            logger.error(f"Error initializing conversation: {str(e)}")
            return False

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """
        Send audio buffer to OpenAI Realtime API
        
        Args:
            audio_buffer: Audio data as bytes
            
        Returns:
            True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot send audio: not connected to OpenAI")
            return False
            
        if not audio_buffer or len(audio_buffer) == 0:
            logger.warning("Empty audio buffer, skipping")
            return False
            
        try:
            # Convert audio to base64
            audio_base64 = base64.b64encode(audio_buffer).decode('utf-8')
            
            # Prepare audio payload
            audio_payload = {
                "type": "input_audio_buffer.append",
                "audio_format": "pcm_s16le",   # 16-bit signed little-endian PCM
                "sample_rate": 24000,          # 24 kHz sample rate
                "audio": audio_base64
            }
            
            # Send audio data
            await self.ws.send(json.dumps(audio_payload))
            logger.debug(f"Sent audio buffer ({len(audio_buffer)} bytes)")
            
            # Update conversation record if available
            if self.db_session and self.conversation_record_id:
                try:
                    conv = self.db_session.query(Conversation).get(uuid.UUID(self.conversation_record_id))
                    if conv:
                        if not conv.user_message:
                            conv.user_message = "[Audio message]"
                        self.db_session.commit()
                except Exception as db_error:
                    logger.error(f"Error updating conversation record: {str(db_error)}")
                    
            return True
        except ConnectionClosed:
            logger.error("Connection closed while sending audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error sending audio: {str(e)}")
            return False

    async def commit_audio(self) -> bool:
        """
        Commit the appended audio buffers
        
        Returns:
            True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot commit audio: not connected to OpenAI")
            return False
            
        try:
            # Send commit command
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit"
            }))
            logger.debug(f"Committed audio buffer for client {self.client_id}")
            return True
        except ConnectionClosed:
            logger.error("Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error committing audio: {str(e)}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Clear any buffered audio data
        
        Returns:
            True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot clear audio buffer: not connected to OpenAI")
            return False
            
        try:
            # Send clear command
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear"
            }))
            logger.debug(f"Cleared audio buffer for client {self.client_id}")
            return True
        except ConnectionClosed:
            logger.error("Connection closed while clearing audio buffer")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error clearing audio buffer: {str(e)}")
            return False

    async def process_message(self, message: str) -> Any:
        """
        Process a message from OpenAI
        
        Args:
            message: JSON message string
            
        Returns:
            Parsed message or None if parsing failed
        """
        try:
            # Update last pong time if this is a pong message
            if message == "pong" or message == '{"type":"pong"}':
                self.last_pong_time = time.time()
                return {"type": "pong"}
                
            # Parse JSON message
            data = json.loads(message)
            
            # Handle pong message
            if data.get("type") == "pong":
                self.last_pong_time = time.time()
                
            return data
        except json.JSONDecodeError:
            logger.warning(f"Invalid JSON received from OpenAI: {message[:100]}...")
            return None
        except Exception as e:
            logger.error(f"Error processing message: {str(e)}")
            return None

    async def close(self) -> None:
        """Close WebSocket connection"""
        # Cancel ping manager task
        if self.ping_task and not self.ping_task.done():
            self.ping_task.cancel()
            try:
                await self.ping_task
            except asyncio.CancelledError:
                pass
                
        # Close WebSocket connection
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"Closed connection to OpenAI for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing connection: {str(e)}")
                
        self.is_connected = False
