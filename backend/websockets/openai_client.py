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
        and immediately send up-to-date session settings,
        including the system_prompt from the database.
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

            # Fetch fresh settings from assistant_config
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            logger.info(f"📋 Данные ассистента: ID={self.assistant_config.id}, имя={self.assistant_config.name}")
            if functions:
                logger.info(f"🔧 Настроенные функции: {json.dumps(functions)}")
            else:
                logger.info("⚠️ Функции не настроены для этого ассистента")

            # Send updated session settings with actual system_prompt
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
        functions: Optional[List[Dict[str, Any]]] = None
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
        if functions:
            for f in functions:
                tools.append({
                    "type": "function",
                    "name": f["name"],
                    "description": f["description"],
                    "parameters": f["parameters"]
                })
                logger.info(f"🛠️ Добавлена функция: {f['name']} - {f['description']}")

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

        # Create a conversation record in the database if available
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
        if not self.is_connected or not self.ws:
            return False
        try:
            logger.info("🎤 Отправка аудио для обработки")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False

    async def clear_audio_buffer(self) -> bool:
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
        Обработка вызова функции.
        
        Args:
            function_name: Название функции
            arguments: Аргументы функции
            
        Returns:
            Результат вызова функции
        """
        logger.info(f"🔔 ФУНКЦИЯ ВЫЗВАНА: {function_name} с аргументами: {json.dumps(arguments)}")
        try:
            # Проверяем, является ли функция интеграцией
            if function_name.startswith("integration_"):
                integration_id = function_name.split("_")[1]
                logger.info(f"🔌 Вызов интеграции ID={integration_id}")
                result = await self.call_integration(integration_id, arguments)
                logger.info(f"📊 Результат вызова интеграции: {json.dumps(result)}")
                return result
            
            # Здесь можно добавить обработку других функций
            logger.warning(f"⚠️ Неизвестная функция: {function_name}")
            return {"error": "Неизвестная функция"}
        except Exception as e:
            logger.error(f"❌ ОШИБКА при вызове функции {function_name}: {str(e)}")
            return {"error": f"Ошибка при вызове функции: {str(e)}"}

    async def call_integration(self, integration_id: str, arguments: dict) -> dict:
        """
        Вызов функции интеграции.
        
        Args:
            integration_id: ID интеграции
            arguments: Аргументы функции
            
        Returns:
            Результат вызова интеграции
        """
        logger.info(f"🔌 ИНТЕГРАЦИЯ: Вызов ID={integration_id}, аргументы={json.dumps(arguments)}")
        if not self.db_session:
            logger.error("❌ ИНТЕГРАЦИЯ: Нет доступа к базе данных")
            return {"error": "Нет доступа к базе данных"}
        
        # Получаем интеграцию из базы данных
        from backend.models.integration import Integration
        integration = self.db_session.query(Integration).filter(Integration.id == integration_id).first()
        
        if not integration:
            logger.warning(f"⚠️ ИНТЕГРАЦИЯ: Не найдена ID={integration_id}")
            return {"error": "Интеграция не найдена"}
        
        logger.info(f"📌 ИНТЕГРАЦИЯ: Найдена {integration.name}, URL={integration.webhook_url}")
        
        if not integration.is_active:
            logger.warning(f"⚠️ ИНТЕГРАЦИЯ: Не активна ID={integration_id}")
            return {"error": "Интеграция не активна"}
        
        # Отправляем данные в вебхук
        import httpx
        
        try:
            text = arguments.get("text", "")
            logger.info(f"📤 ИНТЕГРАЦИЯ: Отправка на вебхук, текст: {text}")
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    integration.webhook_url,
                    json={"text": text, "source": "wellcomeai", "integration_id": str(integration.id)}
                )
                
                logger.info(f"📥 ИНТЕГРАЦИЯ: Ответ от вебхука: статус={response.status_code}")
                
                if response.status_code >= 200 and response.status_code < 300:
                    logger.info(f"✅ ИНТЕГРАЦИЯ: Успешная отправка на вебхук {integration.webhook_url}")
                    return {"success": True, "message": "Данные успешно отправлены"}
                else:
                    logger.warning(f"⚠️ ИНТЕГРАЦИЯ: Ошибка от вебхука: {response.text}")
                    return {"error": f"Ошибка при отправке данных: {response.status_code} {response.text}"}
        except Exception as e:
            logger.error(f"❌ ИНТЕГРАЦИЯ: Ошибка при вызове вебхука {integration.webhook_url}: {str(e)}")
            return {"error": f"Ошибка при вызове вебхука: {str(e)}"}

    async def close(self) -> None:
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"🔒 Закрыто соединение с OpenAI для клиента {self.client_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка закрытия соединения с OpenAI: {e}")
        self.is_connected = False
