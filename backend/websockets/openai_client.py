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
from websockets.client import WebSocketClientProtocol
from websockets.exceptions import ConnectionClosed
import time

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation

logger = get_logger(__name__)

# Константы по умолчанию
DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."


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
        
    async def connect(self) -> bool:
        """
        Establish WebSocket connection to OpenAI Realtime API
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            # Проверка API ключа
            if not self.api_key:
                logger.error("API ключ OpenAI не предоставлен")
                return False

            # Формирование HTTP-заголовков
            headers = [
                ("Authorization", f"Bearer {self.api_key}"),
                ("OpenAI-Beta", "realtime=v1"),
                ("User-Agent", "WellcomeAI/1.0")
            ]
            
            logger.info(f"Connecting to OpenAI Realtime API: {self.openai_url}")
            
            # Add timeout for connection
            connect_timeout = 30  # Seconds
            
            # Используем нативный websockets.connect, который создаст WebSocketClientProtocol
            self.ws = await asyncio.wait_for(
                websockets.connect(
                    self.openai_url,
                    extra_headers=headers,
                    max_size=15 * 1024 * 1024,  # 15 MB максимальный размер сообщения
                    ping_interval=30,  # Отправка ping каждые 30 секунд
                    ping_timeout=120,  # Ожидание pong до 120 секунд
                    close_timeout=15   # Таймаут на закрытие соединения
                ),
                timeout=connect_timeout
            )
            
            self.is_connected = True
            logger.info(f"Connected to OpenAI for client {self.client_id}")
            
            # Update session settings
            system_message = self.assistant_config.system_prompt or DEFAULT_SYSTEM_MESSAGE
            voice = self.assistant_config.voice or DEFAULT_VOICE
            
            # Вызов функции обновления сессии
            success = await self.update_session(
                voice=voice, 
                system_message=system_message
            )
            
            if not success:
                logger.error(f"Failed to update session settings for client {self.client_id}")
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

    async def update_session(
        self, 
        voice=DEFAULT_VOICE, 
        system_message=DEFAULT_SYSTEM_MESSAGE, 
        functions=None
    ) -> bool:
        """
        Обновляет настройки сессии с правильными параметрами
        
        Args:
            voice: Голос для синтеза речи
            system_message: Системное сообщение для ассистента
            functions: Описание доступных функций
            
        Returns:
            True если обновление успешно, иначе False
        """
        if not self.is_connected or not self.ws:
            return False
            
        try:
            # Подготовка turn_detection для автоматического обнаружения речи
            turn_detection = {
                "type": "server_vad",
                "threshold": 0.25,           # Чувствительность обнаружения голоса
                "prefix_padding_ms": 200,    # Начальное время записи до речи
                "silence_duration_ms": 300,  # Длительность тишины для определения окончания речи
                "create_response": True,     # Автоматически создавать ответ при обнаружении конца речи
            }
            
            # Подготовка инструментов (функций)
            tools = []
            if functions:
                for func in functions:
                    tools.append({
                        "type": "function",
                        "name": func.get("name"),
                        "description": func.get("description"),
                        "parameters": func.get("parameters")
                    })
            
            # Собираем payload с нужными настройками
            session_update = {
                "type": "session.update",
                "session": {
                    "turn_detection": turn_detection,
                    "input_audio_format": "pcm16",     # Формат входящего аудио
                    "output_audio_format": "pcm16",    # Формат исходящего аудио
                    "voice": voice,                    # Голос ассистента
                    "instructions": system_message,    # Системное сообщение из БД
                    "modalities": ["text", "audio"],   # Поддерживаемые модальности
                    "temperature": 0.7,                # Температура генерации
                    "max_response_output_tokens": 500, # Лимит токенов для ответа
                    "tools": tools,                    # Инструменты (функции)
                    "tool_choice": "auto" if tools else "none"  # Метод выбора инструментов
                }
            }

            # Отправляем обновлённые настройки сессии
            await self.ws.send(json.dumps(session_update))
            logger.info(f"Настройки сессии с голосом {voice} отправлены")
            
            # Создаем запись о разговоре в БД, если сессия доступна
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
            
            return True
        except Exception as e:
            logger.error(f"Error updating session settings: {str(e)}")
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
            
            # Подготавливаем аудио сообщение согласно документации
            audio_payload = {
                "type": "input_audio_buffer.append",
                "audio": audio_base64,
                "event_id": f"audio_{time.time()}"
            }
            
            # Send audio data
            await self.ws.send(json.dumps(audio_payload))
            logger.debug(f"Sent audio buffer ({len(audio_buffer)} bytes)")
                    
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
            # Send commit command согласно документации
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
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
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{time.time()}"
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

    async def close(self) -> None:
        """Close WebSocket connection"""
        # Close WebSocket connection
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"Closed connection to OpenAI for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing connection: {str(e)}")
                
        self.is_connected = False
