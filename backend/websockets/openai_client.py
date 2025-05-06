# backend/websockets/openai_client.py
import asyncio
import json
import uuid
import base64
import time
from typing import Optional, Dict, Any
import websockets
from websockets.exceptions import ConnectionClosed

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.conversation import Conversation
from backend.functions.registry import get_all_functions, get_function

logger = get_logger(__name__)

DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

class OpenAIRealtimeClient:
    def __init__(self, api_key: str, assistant_config: Any, client_id: str, db_session=None):
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        logger.info(f"🚀 Инициализация OpenAI клиента: {client_id}")

    async def connect(self) -> bool:
        if not self.api_key:
            logger.error("❌ API ключ не предоставлен")
            return False
        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI/1.0")
        ]
        try:
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
            logger.info(f"✅ Подключено к OpenAI: {self.client_id}")

            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = self.assistant_config.system_prompt or DEFAULT_SYSTEM_MESSAGE
            functions_cfg = getattr(self.assistant_config, "functions", None)

            success = await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions_cfg
            )
            if not success:
                await self.close()
                return False
            return True

        except Exception as e:
            logger.error(f"❌ Ошибка подключения к OpenAI: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Dict[str, Any]] = None
    ) -> bool:
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
        if functions and isinstance(functions, dict) and "enabled_functions" in functions:
            enabled = functions.get("enabled_functions", [])
            registry = get_all_functions()
            for fid in enabled:
                if fid in registry:
                    finfo = registry[fid]
                    tools.append({
                        "type": "function",
                        "name": fid,
                        "description": finfo["description"],
                        "parameters": finfo["parameters"]
                    })
                    logger.info(f"🛠 Добавлена функция: {fid}")

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
            logger.info(f"✅ session.update отправлен (voice={voice}, tools={len(tools)})")
        except Exception as e:
            logger.error(f"❌ Ошибка отправки session.update: {e}")
            return False

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
                logger.info(f"📝 Разговор в БД создан: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка сохранения Conversation: {e}")

        return True

    async def process_audio(self, audio_buffer: bytes) -> bool:
        if not (self.is_connected and self.ws and audio_buffer):
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
        if not (self.is_connected and self.ws):
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
        if not (self.is_connected and self.ws):
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
        logger.info(f"🔔 Вызов функции {function_name}, args={arguments}")
        try:
            info = get_function(function_name)
            if not info:
                logger.warning(f"⚠️ Функция {function_name} не найдена в реестре")
                return {"error": f"Function '{function_name}' not found"}
            func = info["function"]
            result = await func(**arguments)
            logger.info(f"📤 Результат функции {function_name} отправлен: {result}")
            return result
        except Exception as e:
            logger.error(f"❌ Ошибка в handle_function_call: {e}")
            return {"error": str(e)}

    async def close(self) -> None:
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"🔒 WebSocket закрыт: {self.client_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка при закрытии WebSocket: {e}")
        self.is_connected = False
