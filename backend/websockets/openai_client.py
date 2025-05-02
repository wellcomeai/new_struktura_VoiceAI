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
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session=None
    ):
        """
        Initialize OpenAI Realtime client
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())  # Сохраняем для внутреннего использования
        self.conversation_record_id = None  # DB record
        
    async def connect(self) -> bool:
        """Establish WebSocket connection to OpenAI Realtime API"""
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "openai-beta": "realtime=v1"
            }
            logger.info(f"Connecting to OpenAI Realtime API: {self.openai_url}")
            self.ws = await websockets.connect(
                self.openai_url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=60,
                close_timeout=30
            )
            self.is_connected = True
            logger.info(f"Connected for client {self.client_id}")
            await self._init_conversation()
            return True
        except Exception as e:
            logger.error(f"Failed to connect: {e}")
            self.is_connected = False
            return False

    async def _init_conversation(self) -> bool:
        """Initialize conversation with system prompt"""
        if not self.is_connected or not self.ws:
            return False
        try:
            # Добавлено поле type в объект item
            init_payload = {
                "type": "conversation.item.create",
                "item": {
                    "type": "text",  # Добавленное поле
                    "role": "system",
                    "content": self.assistant_config.system_prompt
                                or "You are a helpful voice assistant."
                }
            }
            await self.ws.send(json.dumps(init_payload))
            logger.debug("Sent system prompt payload")

            if self.db_session:
                conv = Conversation(
                    assistant_id=self.assistant_config.id,
                    session_id=self.session_id,  # Для БД используем внутренний session_id
                    user_message="",
                    assistant_message="",
                )
                self.db_session.add(conv)
                self.db_session.commit()
                self.db_session.refresh(conv)
                self.conversation_record_id = str(conv.id)
                logger.info(f"Created conversation record: {self.conversation_record_id}")
            return True
        except Exception as e:
            logger.error(f"Error initializing conversation: {e}")
            return False

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """Send audio buffer to OpenAI Realtime API"""
        if not self.is_connected or not self.ws:
            logger.error("Not connected: cannot send audio")
            return False
        try:
            audio_base64 = base64.b64encode(audio_buffer).decode('utf-8')
            # Тут параметр type не нужен, так как он уже указан в корне сообщения
            audio_payload = {
                "type": "input_audio_buffer.append",
                "audio_format": "pcm_s16le",
                "sample_rate": 24000,
                "audio": audio_base64
            }
            await self.ws.send(json.dumps(audio_payload))
            logger.debug(f"Appended audio buffer ({len(audio_buffer)} bytes)")

            if self.db_session and self.conversation_record_id:
                conv = self.db_session.query(Conversation).get(uuid.UUID(self.conversation_record_id))
                if conv:
                    conv.user_message = "[Audio message]"
                    self.db_session.commit()
            return True
        except Exception as e:
            logger.error(f"Error sending audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        """Commit the appended audio buffers"""
        if not self.is_connected or not self.ws:
            logger.error("Not connected: cannot commit audio")
            return False
        try:
            # Тут параметр type не требуется в дополнительных полях
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit"
            }))
            logger.debug("Committed audio buffer")
            return True
        except Exception as e:
            logger.error(f"Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """Clear any buffered audio data"""
        if not self.is_connected or not self.ws:
            logger.error("Not connected: cannot clear audio buffer")
            return False
        try:
            # Тут параметр type не требуется в дополнительных полях
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear"
            }))
            logger.debug("Cleared audio buffer")
            return True
        except Exception as e:
            logger.error(f"Error clearing audio buffer: {e}")
            return False

    async def send_response(self, content: str) -> bool:
        """Send a text response via Realtime API"""
        if not self.is_connected or not self.ws:
            logger.error("Not connected: cannot send response")
            return False
        try:
            # Добавлено поле type в объект response
            payload = {
                "type": "response.create",
                "response": {
                    "type": "text",  # Добавленное поле
                    "content": content
                }
            }
            await self.ws.send(json.dumps(payload))
            logger.debug("Sent response payload")
            return True
        except Exception as e:
            logger.error(f"Error sending response: {e}")
            return False

    async def close(self) -> None:
        """Close WebSocket connection"""
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"Connection closed for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing connection: {e}")
        self.is_connected = False
