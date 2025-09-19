import asyncio
import json
import uuid
import base64
import time
import websockets
import re
from websockets.exceptions import ConnectionClosed

from typing import Optional, List, Dict, Any, Union, AsyncGenerator

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.functions import get_function_definitions, get_enabled_functions, normalize_function_name, execute_function

logger = get_logger(__name__)

DEFAULT_VOICE = "marin"  # ✅ ИЗМЕНЕНО: новый голос по умолчанию
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

def normalize_functions(assistant_functions):
    """
    Преобразует список функций из UI в полные определения с параметрами.
    """
    if not assistant_functions:
        return []
    
    enabled_names = []
    
    if isinstance(assistant_functions, dict) and "enabled_functions" in assistant_functions:
        enabled_names = [normalize_function_name(name) for name in assistant_functions.get("enabled_functions", [])]
    else:
        enabled_names = [normalize_function_name(func.get("name")) for func in assistant_functions if func.get("name")]
        
    return get_enabled_functions(enabled_names)

def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает URL вебхука из системного промпта ассистента.
    """
    if not prompt:
        return None
        
    pattern1 = r'URL\s+(?:вебхука|webhook):\s*(https?://[^\s"\'<>]+)'
    pattern2 = r'(?:вебхука|webhook)\s+URL:\s*(https?://[^\s"\'<>]+)'
    pattern3 = r'https?://[^\s"\'<>]+'
    
    for pattern in [pattern1, pattern2, pattern3]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

def generate_short_id(prefix: str = "") -> str:
    """
    Генерирует короткий уникальный идентификатор длиной до 32 символов.
    """
    raw_id = str(uuid.uuid4()).replace("-", "")
    max_id_len = 32 - len(prefix)
    return f"{prefix}{raw_id[:max_id_len]}"

def get_device_vad_settings(user_agent: str = "") -> Dict[str, Any]:
    """
    Возвращает оптимальные настройки VAD в зависимости от устройства.
    """
    user_agent_lower = user_agent.lower()
    
    if "iphone" in user_agent_lower or "ipad" in user_agent_lower:
        return {
            "threshold": 0.35,
            "prefix_padding_ms": 250,
            "silence_duration_ms": 400
        }
    elif "android" in user_agent_lower:
        return {
            "threshold": 0.25,
            "prefix_padding_ms": 150,
            "silence_duration_ms": 250
        }
    else:
        return {
            "threshold": 0.2,
            "prefix_padding_ms": 100,
            "silence_duration_ms": 200
        }

class OpenAIRealtimeClientNew:
    """
    ✅ NEW GA VERSION: Client for OpenAI Realtime API GA version.
    Updated for production-ready gpt-realtime model with improved capabilities.
    """
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session: Any = None,
        user_agent: str = ""
    ):
        """
        Initialize the OpenAI Realtime client with GA settings.
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.user_agent = user_agent
        self.ws = None
        self.is_connected = False
        
        # ✅ НОВЫЙ GA URL
        self.openai_url = settings.REALTIME_WS_URL_GA
        
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.webhook_url = None
        self.last_function_name = None
        self.enabled_functions = []
        
        # Состояния для обработки перебивания
        self.is_assistant_speaking = False
        self.current_response_id: Optional[str] = None
        self.current_audio_samples = 0
        self.interruption_occurred = False
        self.last_interruption_time = 0
        
        # VAD настройки
        self.vad_settings = get_device_vad_settings(user_agent)
        logger.info(f"[GA-VAD] Настройки для устройства ({user_agent[:50]}): {self.vad_settings}")
        
        # Определяем тип устройства
        self.is_ios = "iphone" in user_agent.lower() or "ipad" in user_agent.lower()
        self.is_android = "android" in user_agent.lower()
        self.is_mobile = self.is_ios or self.is_android
        
        # Извлекаем список разрешенных функций
        if hasattr(assistant_config, "functions"):
            functions = assistant_config.functions
            if isinstance(functions, list):
                self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
            elif isinstance(functions, dict) and "enabled_functions" in functions:
                self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
            logger.info(f"[GA] Извлечены разрешенные функции: {self.enabled_functions}")
        
        # Извлекаем URL вебхука из промпта только если функция send_webhook разрешена
        if "send_webhook" in self.enabled_functions and hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            self.webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if self.webhook_url:
                logger.info(f"[GA] Извлечен URL вебхука: {self.webhook_url}")

    async def connect(self) -> bool:
        """
        ✅ GA VERSION: Establish WebSocket connection to OpenAI Realtime API GA.
        """
        if not self.api_key:
            logger.error("[GA] OpenAI API key not provided")
            return False

        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI/2.1-GA-Version")
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
            logger.info(f"[GA] Connected to OpenAI GA for client {self.client_id}")

            # Получаем свежие настройки
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            # Обновляем список разрешенных функций
            if functions:
                if isinstance(functions, list):
                    self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
                elif isinstance(functions, dict) and "enabled_functions" in functions:
                    self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
                
                logger.info(f"[GA] Обновлены разрешенные функции: {self.enabled_functions}")

            # Проверяем URL вебхука в промпте
            if "send_webhook" in self.enabled_functions:
                self.webhook_url = extract_webhook_url_from_prompt(system_message)
                if self.webhook_url:
                    logger.info(f"[GA] Извлечен URL вебхука: {self.webhook_url}")

            # ✅ НОВЫЕ GA настройки сессии
            if not await self.update_session_ga(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                logger.error("[GA] Failed to update GA session settings")
                await self.close()
                return False

            return True
        except asyncio.TimeoutError:
            logger.error(f"[GA] Connection timeout for client {self.client_id}")
            return False
        except Exception as e:
            logger.error(f"[GA] Failed to connect: {e}")
            return False

    async def update_session_ga(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        """
        ✅ GA VERSION: Update session settings using new GA interface.
        """
        if not self.is_connected or not self.ws:
            logger.error("[GA] Cannot update session: not connected")
            return False
            
        # VAD настройки для быстрого перебивания
        turn_detection = {
            "type": "server_vad",
            "threshold": self.vad_settings["threshold"],
            "prefix_padding_ms": self.vad_settings["prefix_padding_ms"],
            "silence_duration_ms": self.vad_settings["silence_duration_ms"],
            "create_response": True,
            # ✅ НОВОЕ: idle timeout для "Are you still there?"
            "idle_timeout_ms": 10000  # 10 секунд
        }
        
        logger.info(f"[GA] VAD настройки: {turn_detection}")
        
        # Получаем нормализованные определения функций
        normalized_functions = normalize_functions(functions)
        
        # Формируем tools для API
        tools = []
        for func_def in normalized_functions:
            tools.append({
                "type": "function",
                "name": func_def["name"],
                "description": func_def["description"],
                "parameters": func_def["parameters"]
            })
        
        # Обновляем список разрешенных функций
        self.enabled_functions = [normalize_function_name(tool["name"]) for tool in tools]
        logger.info(f"[GA] Активированные функции: {self.enabled_functions}")
        
        tool_choice = "auto" if tools else "none"
        
        # Включение транскрипции аудио
        input_audio_transcription = {
            "model": "whisper-1"
        }
        
        # ✅ НОВЫЙ GA формат payload
        payload = {
            "type": "session.update",
            "session": {
                "type": "realtime",  # ✅ ОБЯЗАТЕЛЬНОЕ НОВОЕ ПОЛЕ!
                "turn_detection": turn_detection,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "voice": voice,
                "instructions": system_message,
                "modalities": ["text", "audio"],
                # ❌ УБИРАЕМ temperature полностью (GA не поддерживает!)
                "max_response_output_tokens": 500,
                "tools": tools,
                "tool_choice": tool_choice,
                "input_audio_transcription": input_audio_transcription,
                # ✅ НОВЫЕ GA параметры
                "truncation": "enabled"  # Автообрезка старых сообщений
            }
        }
        
        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"[GA] Session settings sent (voice={voice}, tools={len(tools)}, GA format)")
            
            if tools:
                for tool in tools:
                    logger.info(f"[GA] Enabled function: {tool['name']}")
        except Exception as e:
            logger.error(f"[GA] Error sending session.update: {e}")
            return False

        # Создаем запись в БД
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
                logger.info(f"[GA] Created conversation record: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"[GA] Error creating Conversation in DB: {e}")

        return True

    # ✅ ВСЕ ОСТАЛЬНЫЕ МЕТОДЫ ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ
    # Просто меняем логи с [DEBUG] на [GA] для отличия
    
    async def handle_interruption(self) -> bool:
        """Обработка событий перебивания."""
        try:
            current_time = time.time()
            protection_time = 0.15 if self.is_ios else 0.2
            
            if current_time - self.last_interruption_time < protection_time:
                logger.info(f"[GA] Игнорируем повторное перебивание")
                return True
                
            self.last_interruption_time = current_time
            self.interruption_occurred = True
            
            logger.info(f"[GA] Обработка перебивания для клиента {self.client_id}")
            
            if self.is_assistant_speaking and self.current_response_id:
                await self.cancel_current_response(self.current_response_id, self.current_audio_samples)
            
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            
            logger.info("[GA] Перебивание обработано успешно")
            return True
            
        except Exception as e:
            logger.error(f"[GA] Ошибка при обработке перебивания: {e}")
            return False

    async def cancel_current_response(self, item_id: str = None, sample_count: int = 0) -> bool:
        """Отмена текущего ответа ассистента."""
        if not self.is_connected or not self.ws:
            logger.error("[GA] Нельзя отменить ответ: нет соединения")
            return False
            
        try:
            logger.info(f"[GA] Отмена ответа: item_id={item_id}, samples={sample_count}")
            
            cancel_payload = {
                "type": "response.cancel",
                "event_id": f"cancel_{int(time.time() * 1000)}"
            }
            
            if item_id:
                cancel_payload["item_id"] = item_id
            if sample_count > 0:
                cancel_payload["sample_count"] = sample_count
                
            await self.ws.send(json.dumps(cancel_payload))
            logger.info("[GA] Команда отмены отправлена")
            
            return True
            
        except Exception as e:
            logger.error(f"[GA] Ошибка при отмене ответа: {e}")
            return False

    def set_assistant_speaking(self, speaking: bool, response_id: str = None) -> None:
        """Устанавливает состояние говорения ассистента."""
        self.is_assistant_speaking = speaking
        if speaking:
            self.current_response_id = response_id
            self.current_audio_samples = 0
            logger.info(f"[GA] Ассистент начал говорить: response_id={response_id}")
        else:
            self.current_response_id = None
            self.current_audio_samples = 0
            logger.info(f"[GA] Ассистент закончил говорить")

    def increment_audio_samples(self, sample_count: int) -> None:
        """Увеличивает счетчик аудио-семплов."""
        self.current_audio_samples += sample_count

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """Process and send audio data to the OpenAI API."""
        if not self.is_connected or not self.ws or not audio_buffer:
            return False
        try:
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": f"audio_{int(time.time() * 1000)}"
            }))
            return True
        except ConnectionClosed:
            logger.error("[GA] Connection closed while sending audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[GA] Error processing audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        """Commit the audio buffer."""
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{int(time.time() * 1000)}"
            }))
            return True
        except ConnectionClosed:
            logger.error("[GA] Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[GA] Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """Clear the audio buffer."""
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{int(time.time() * 1000)}"
            }))
            return True
        except ConnectionClosed:
            logger.error("[GA] Connection closed while clearing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[GA] Error clearing audio buffer: {e}")
            return False

    async def send_function_result(self, function_call_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """Send function execution result back to OpenAI."""
        if not self.is_connected or not self.ws:
            error_msg = "[GA] Cannot send function result: not connected"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "payload": None}
        
        try:
            logger.info(f"[GA] Отправка результата функции: {function_call_id}")
            
            short_item_id = generate_short_id("func_")
            result_json = json.dumps(result)
            
            payload = {
                "type": "conversation.item.create",
                "event_id": f"funcres_{int(time.time() * 1000)}",
                "item": {
                    "id": short_item_id,
                    "type": "function_call_output",
                    "call_id": function_call_id,
                    "output": result_json
                }
            }
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"[GA] Результат функции отправлен: {function_call_id}")
            
            delay = 0.2 if self.is_ios else 0.3
            await asyncio.sleep(delay)
            
            await self.create_response_after_function()
            logger.info(f"[GA] Запрос нового ответа выполнен")
            
            return {"success": True, "error": None, "payload": payload}
            
        except Exception as e:
            error_msg = f"[GA] Error sending function result: {e}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "payload": None}

    async def create_response_after_function(self) -> bool:
        """Запрашивает новый ответ от модели после выполнения функции."""
        if not self.is_connected or not self.ws:
            logger.error("[GA] Cannot create response: not connected")
            return False
            
        try:
            logger.info(f"[GA] Создание ответа после выполнения функции")
            
            max_tokens = 200 if self.is_ios else 300
            
            response_payload = {
                "type": "response.create",
                "event_id": f"resp_after_func_{int(time.time() * 1000)}",
                "response": {
                    "modalities": ["text", "audio"],
                    "voice": self.assistant_config.voice or DEFAULT_VOICE,
                    "instructions": getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE,
                    # ❌ НЕ добавляем temperature в GA!
                    "max_output_tokens": max_tokens
                }
            }
            
            await self.ws.send(json.dumps(response_payload))
            logger.info(f"[GA] Запрошен новый ответ")
            
            return True
            
        except Exception as e:
            logger.error(f"[GA] Error creating response: {e}")
            return False

    async def close(self) -> None:
        """Close the WebSocket connection."""
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"[GA] WebSocket connection closed for client {self.client_id}")
            except Exception as e:
                logger.error(f"[GA] Error closing WebSocket: {e}")
        self.is_connected = False
        
        # Сбрасываем состояния
        self.is_assistant_speaking = False
        self.current_response_id = None
        self.current_audio_samples = 0
        self.interruption_occurred = False

    async def reconnect(self) -> bool:
        """Переподключение к OpenAI Realtime API."""
        logger.info(f"[GA] Попытка переподключения для клиента {self.client_id}")
        try:
            if self.ws:
                try:
                    await self.ws.close()
                except:
                    pass
            
            self.is_connected = False
            self.ws = None
            
            # Сбрасываем состояния
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            self.interruption_occurred = False
            
            return await self.connect()
        except Exception as e:
            logger.error(f"[GA] Ошибка переподключения: {e}")
            return False

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """Receive and yield messages from the OpenAI WebSocket."""
        if not self.is_connected or not self.ws:
            return
            
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    yield data
                except json.JSONDecodeError:
                    logger.error(f"[GA] Failed to decode message: {message[:100]}...")
        except ConnectionClosed:
            logger.info(f"[GA] WebSocket connection closed for client {self.client_id}")
            self.is_connected = False
        except Exception as e:
            logger.error(f"[GA] Error receiving messages: {e}")
            self.is_connected = False
