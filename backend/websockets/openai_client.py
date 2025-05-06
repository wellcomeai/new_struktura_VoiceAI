import asyncio
import json
import uuid
import base64
import time
from typing import Optional, List, Dict, Any
import websockets
from websockets.exceptions import ConnectionClosed

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.functions.registry import get_function, get_all_functions, get_tools_for_openai

logger = get_logger(__name__)

DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

class OpenAIRealtimeClient:
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session=None
    ):
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        logger.info(f"🚀 Инициализация OpenAI клиента с идентификатором {client_id}")

    async def connect(self) -> bool:
        """
        Establish WebSocket connection to OpenAI Realtime API
        and immediately send up-to-date session settings.
        """
        if not self.api_key:
            logger.error("❌ API ключ OpenAI не предоставлен")
            return False

        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI/1.0")
        ]
        try:
            logger.info(f"🔄 Подключение к OpenAI для клиента {self.client_id}...")
            self.ws = await asyncio.wait_for(
                websockets.connect(
                    self.openai_url,
                    extra_headers=headers,
                    max_size=15*1024*1024,
                    ping_interval=30,
                    ping_timeout=120,
                    close_timeout=15
                ),
                timeout=30
            )
            self.is_connected = True
            logger.info(f"✅ Подключено к OpenAI для клиента {self.client_id}")

            # Fetch fresh settings
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            # Send session update
            if not await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                await self.close()
                return False

            return True
        except Exception as e:
            logger.error(f"❌ Не удалось подключиться к OpenAI: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Update session settings on the OpenAI Realtime API side.
        """
        if not self.is_connected or not self.ws:
            return False

        turn_detection = {
            "type": "server_vad",
            "threshold": 0.25,
            "prefix_padding_ms": 200,
            "silence_duration_ms": 300,
            "create_response": True,
        }

        tools = []
        if functions and "enabled_functions" in functions:
            enabled_functions = functions.get("enabled_functions", [])
            registered_functions = get_all_functions()
            for func_id in enabled_functions:
                if func_id in registered_functions:
                    func_info = registered_functions[func_id]
                    tools.append({
                        "type": "function",
                        "function": {
                            "name": func_id,
                            "description": func_info["description"],
                            "parameters": func_info["parameters"]
                        }
                    })
                    logger.info(f"🛠️ Добавлена функция из реестра: {func_id}")

        payload = {
            "type": "session.update",
            "session": {
                "turn_detection": turn_detection,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "voice": voice,
                "instructions": system_message,
                "modalities": ["text", "audio"],
                "temperature": 0.7,
                "max_response_output_tokens": 500,
                "tools": tools,
                "tool_choice": "auto" if tools else "none"
            }
        }

        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"✅ Настройки сессии отправлены (voice={voice}, tools={len(tools)})")
        except Exception as e:
            logger.error(f"❌ Ошибка отправки session.update: {e}")
            return False

        # Create a conversation record if DB session is provided
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
                logger.info(f"📝 Создана запись диалога: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка создания Conversation в БД: {e}")

        return True

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """
        Append audio data to the stream.
        """
        if not self.is_connected or not self.ws or not audio_buffer:
            return False
        try:
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": f"audio_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False

    async def commit_audio(self) -> bool:
        """
        Signal end of audio chunk.
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Clear buffered audio.
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False

    async def handle_function_call(self, function_name: str, arguments: dict) -> dict:
        """
        Выполняет зарегистрированную функцию через OpenAI.
        """
        logger.info(f"🔔 ФУНКЦИЯ ВЫЗВАНА: {function_name} с аргументами: {json.dumps(arguments)}")
        try:
            func_info = get_function(function_name)
            if not func_info:
                return {"error": f"Функция '{function_name}' не найдена"}

            function_configs = {}
            if hasattr(self.assistant_config, 'functions') and isinstance(self.assistant_config.functions, dict):
                function_configs = self.assistant_config.functions.get("function_configs", {}).get(function_name, {})
            merged_args = {**function_configs, **arguments}

            result = await func_info["function"](**merged_args)
            logger.info(f"📊 Результат вызова функции: {json.dumps(result)}")
            return result
        except Exception as e:
            logger.error(f"❌ ОШИБКА при вызове функции: {str(e)}")
            return {"error": f"Ошибка при вызове функции: {str(e)}"}

    async def close(self) -> None:
        """
        Закрывает WebSocket-соединение.
        """
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"🔒 Закрыто соединение с OpenAI для клиента {self.client_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка закрытия соединения с OpenAI: {e}")
        self.is_connected = False
