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

DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

def normalize_functions(assistant_functions):
    """
    Преобразует список функций из UI в полные определения с параметрами.
    
    Args:
        assistant_functions: Список функций ассистента в любом формате
            
    Returns:
        List: Список полных определений функций с параметрами
    """
    if not assistant_functions:
        return []
    
    # Извлекаем имена функций
    enabled_names = []
    
    # Обработка формата {"enabled_functions": [...]}
    if isinstance(assistant_functions, dict) and "enabled_functions" in assistant_functions:
        enabled_names = [normalize_function_name(name) for name in assistant_functions.get("enabled_functions", [])]
    # Обработка списка объектов из UI
    else:
        enabled_names = [normalize_function_name(func.get("name")) for func in assistant_functions if func.get("name")]
        
    # Получаем определения для включенных функций
    return get_enabled_functions(enabled_names)

def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает URL вебхука из системного промпта ассистента.
    
    Args:
        prompt: Системный промпт ассистента
        
    Returns:
        Найденный URL или None
    """
    if not prompt:
        return None
        
    # Ищем URL с помощью регулярного выражения
    # Паттерн 1: "URL вебхука: https://example.com"
    pattern1 = r'URL\s+(?:вебхука|webhook):\s*(https?://[^\s"\'<>]+)'
    # Паттерн 2: "webhook URL: https://example.com"
    pattern2 = r'(?:вебхука|webhook)\s+URL:\s*(https?://[^\s"\'<>]+)'
    # Паттерн 3: просто URL в тексте (менее точный)
    pattern3 = r'https?://[^\s"\'<>]+'
    
    # Проверяем шаблоны по убыванию специфичности
    for pattern in [pattern1, pattern2, pattern3]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

def generate_short_id(prefix: str = "") -> str:
    """
    Генерирует короткий уникальный идентификатор длиной до 32 символов.
    
    Args:
        prefix: Опциональный префикс для ID
        
    Returns:
        str: Короткий уникальный ID
    """
    # Создаем UUID без дефисов и обрезаем до нужной длины
    raw_id = str(uuid.uuid4()).replace("-", "")
    
    # Если есть префикс, учитываем его в общей длине
    max_id_len = 32 - len(prefix)
    
    # Возвращаем ID с префиксом, общей длиной не более 32 символов
    return f"{prefix}{raw_id[:max_id_len]}"

class OpenAIRealtimeClient:
    """
    Client for interacting with OpenAI's Realtime API through WebSockets.
    Handles voice interactions, function calling, and conversation tracking.
    """
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session: Any = None
    ):
        """
        Initialize the OpenAI Realtime client.
        
        Args:
            api_key: OpenAI API key
            assistant_config: Configuration for the assistant
            client_id: Unique identifier for the client
            db_session: Database session for persistence (optional)
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.webhook_url = None  # Сохраняем URL вебхука из промпта
        self.last_function_name = None  # Сохраняем имя последней вызванной функции
        self.enabled_functions = []  # Список разрешенных функций
        
        # Извлекаем список разрешенных функций
        if hasattr(assistant_config, "functions"):
            functions = assistant_config.functions
            if isinstance(functions, list):
                self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
            elif isinstance(functions, dict) and "enabled_functions" in functions:
                self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
            logger.info(f"Извлечены разрешенные функции: {self.enabled_functions}")
        
        # Извлекаем URL вебхука из промпта только если функция send_webhook разрешена
        if "send_webhook" in self.enabled_functions and hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            self.webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if self.webhook_url:
                logger.info(f"Извлечен URL вебхука из промпта: {self.webhook_url}")

    async def connect(self) -> bool:
        """
        Establish WebSocket connection to OpenAI Realtime API
        and immediately send up-to-date session settings,
        including the system_prompt from the database.
        
        Returns:
            bool: True if connection was successful, False otherwise
        """
        if not self.api_key:
            logger.error("OpenAI API key not provided")
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
                    max_size=15*1024*1024,  # 15 MB max message size
                    ping_interval=30,
                    ping_timeout=120,
                    close_timeout=15
                ),
                timeout=30
            )
            self.is_connected = True
            logger.info(f"Connected to OpenAI for client {self.client_id}")

            # Fetch fresh settings from assistant_config
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            # Обновляем список разрешенных функций
            if functions:
                if isinstance(functions, list):
                    self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
                elif isinstance(functions, dict) and "enabled_functions" in functions:
                    self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
                
                logger.info(f"Обновлены разрешенные функции: {self.enabled_functions}")

            # Проверяем, есть ли URL вебхука в промпте, только если функция send_webhook разрешена
            if "send_webhook" in self.enabled_functions:
                self.webhook_url = extract_webhook_url_from_prompt(system_message)
                if self.webhook_url:
                    logger.info(f"Извлечен URL вебхука из промпта: {self.webhook_url}")

            # Send updated session settings with actual system_prompt
            if not await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                logger.error("Failed to update session settings")
                await self.close()
                return False

            return True
        except asyncio.TimeoutError:
            logger.error(f"Connection timeout to OpenAI for client {self.client_id}")
            return False
        except Exception as e:
            logger.error(f"Failed to connect to OpenAI: {e}")
            return False

    async def reconnect(self) -> bool:
        """
        Пытается переподключиться к OpenAI Realtime API после потери соединения.
        
        Returns:
            bool: True если переподключение успешно, False иначе
        """
        logger.info(f"Попытка переподключения к OpenAI для клиента {self.client_id}")
        try:
            # Закрываем старое соединение, если оно ещё существует
            if self.ws:
                try:
                    await self.ws.close()
                except:
                    pass
            
            self.is_connected = False
            self.ws = None
            
            # Подключаемся заново
            return await self.connect()
        except Exception as e:
            logger.error(f"Ошибка при переподключении к OpenAI: {e}")
            return False

    async def cancel_response(self, item_id: str = None, sample_count: int = 0) -> bool:
        """
        Отменяет текущий ответ ассистента.
        OpenAI API Reference: https://platform.openai.com/docs/api-reference/realtime-client-events/response/cancel
        
        Args:
            item_id: ID элемента (ответа), который нужно отменить.
            sample_count: Количество аудио семплов, которые уже были воспроизведены клиентом 
                          из этого item_id перед отправкой запроса на отмену.
        
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot send response.cancel: not connected")
            return False
            
        try:
            event_id = f"cancel_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
            payload = {
                "type": "response.cancel",
                "event_id": event_id
            }
            
            # item_id и sample_count являются опциональными согласно документации
            if item_id:
                payload["item_id"] = item_id
            if sample_count > 0:
                payload["sample_count"] = sample_count
            # Если item_id и sample_count не предоставлены, OpenAI отменит самый последний активный ответ.
                
            await self.ws.send(json.dumps(payload))
            logger.info(f"[INTERRUPTION] Sent 'response.cancel' to OpenAI: {payload}")
            
            # Небольшая задержка может быть полезна, но не всегда обязательна.
            # Зависит от того, как быстро сервер обрабатывает и как быстро мы хотим получить ACK.
            await asyncio.sleep(0.05) # Уменьшена до 50мс
            
            return True
            
        except Exception as e:
            logger.error(f"Error sending response.cancel: {e}")
            return False

    async def clear_output_audio_buffer(self) -> bool:
        """
        Очищает буфер вывода аудио на стороне OpenAI.
        OpenAI API Reference: https://platform.openai.com/docs/api-reference/realtime-client-events/output-audio-buffer/clear
        
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot clear output audio buffer: not connected")
            return False
            
        try:
            event_id = f"clear_output_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
            payload = {
                "type": "output_audio_buffer.clear",
                "event_id": event_id
            }
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"[INTERRUPTION] Sent 'output_audio_buffer.clear': {payload}")
            return True
            
        except Exception as e:
            logger.error(f"Error clearing output audio buffer: {e}")
            return False

    async def truncate_conversation_item(self, item_id: str, content_index: int = 0, audio_end_ms: int = 0) -> bool:
        """
        Обрезает элемент диалога (обычно ответ ассистента) для синхронизации транскрипта и аудио.
        OpenAI API Reference: https://platform.openai.com/docs/api-reference/realtime-client-events/conversation-item/truncate

        Args:
            item_id: ID элемента диалога (item), который нужно обрезать.
            content_index: Индекс контентного блока внутри item (обычно 0 для основного текста/аудио).
            audio_end_ms: Время в миллисекундах, до которого должно быть обрезано аудио этого item.
            
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot truncate conversation item: not connected")
            return False
        
        if not item_id or audio_end_ms <= 0: # Проверка валидности параметров
             logger.warning(f"[INTERRUPTION] Skipped conversation.item.truncate: invalid params (item_id: {item_id}, audio_end_ms: {audio_end_ms})")
             return False
            
        try:
            event_id = f"truncate_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
            payload = {
                "type": "conversation.item.truncate",
                "event_id": event_id,
                "item_id": item_id,
                "content_index": content_index,
                "audio_end_ms": audio_end_ms
            }
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"[INTERRUPTION] Sent 'conversation.item.truncate': {payload}")
            return True
            
        except Exception as e:
            logger.error(f"Error truncating conversation item: {e}")
            return False

    async def emergency_stop_all(self) -> bool:
        """
        Экстренная остановка всех активных процессов OpenAI.
        Последовательно отправляет команды:
        1. response.cancel (без item_id, чтобы отменить любой текущий ответ)
        2. output_audio_buffer.clear
        3. input_audio_buffer.clear
        
        Returns:
            bool: True если все команды отправлены успешно
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot perform emergency stop: not connected")
            return False
            
        all_sent_successfully = True
        try:
            logger.info("[INTERRUPTION] Initiating emergency stop sequence...")
            
            # 1. Отменяем любой текущий ответ (без item_id и sample_count)
            if not await self.cancel_response(): 
                all_sent_successfully = False
                logger.warning("[INTERRUPTION] Failed to send cancel_response during emergency stop.")
            await asyncio.sleep(0.05) # Небольшая пауза между командами

            # 2. Очищаем буфер вывода аудио
            if not await self.clear_output_audio_buffer():
                all_sent_successfully = False
                logger.warning("[INTERRUPTION] Failed to send clear_output_audio_buffer during emergency stop.")
            await asyncio.sleep(0.05)

            # 3. Очищаем входной буфер аудио
            if not await self.clear_audio_buffer(): 
                all_sent_successfully = False
                logger.warning("[INTERRUPTION] Failed to send clear_audio_buffer during emergency stop.")
            
            if all_sent_successfully:
                logger.info("[INTERRUPTION] Emergency stop sequence completed successfully.")
            else:
                logger.warning("[INTERRUPTION] Emergency stop sequence completed with some failures.")
            return all_sent_successfully
            
        except Exception as e:
            logger.error(f"Error during emergency_stop_all: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        if not self.is_connected or not self.ws:
            logger.error("Cannot update session: not connected")
            return False
            
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.25,
            "prefix_padding_ms": 200,
            "silence_duration_ms": 300,
            "create_response": True,
        }
        
        normalized_functions = normalize_functions(functions)
        tools = []
        for func_def in normalized_functions:
            tools.append({
                "type": "function",
                "name": func_def["name"],
                "description": func_def["description"],
                "parameters": func_def["parameters"]
            })
        
        self.enabled_functions = [normalize_function_name(tool["name"]) for tool in tools]
        logger.info(f"[DEBUG-FUNCTION] Активированные функции для сессии: {self.enabled_functions}")
        
        tool_choice = "auto" if tools else "none"
        logger.info(f"Setting up session with {len(tools)} tools, tool_choice={tool_choice}")
        
        input_audio_transcription = { "model": "whisper-1" }
            
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
                "tool_choice": tool_choice,
                "input_audio_transcription": input_audio_transcription
            }
        }
        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"Session settings sent (voice={voice}, tools={len(tools)}, tool_choice={tool_choice})")
            if tools:
                for tool in tools:
                    logger.info(f"[DEBUG-FUNCTION] Enabled function: {tool['name']}, params: {json.dumps(tool['parameters'], ensure_ascii=False)[:100]}...")
        except Exception as e:
            logger.error(f"Error sending session.update: {e}")
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
                logger.info(f"Created conversation record: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"Error creating Conversation in DB: {e}")
        return True

    async def handle_function_call(self, function_call_data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            function_name = function_call_data.get("function", {}).get("name")
            arguments = function_call_data.get("function", {}).get("arguments", {})
            
            self.last_function_name = function_name
            normalized_function_name = normalize_function_name(function_name) or function_name
            logger.info(f"[DEBUG-FUNCTION] Нормализация имени функции: {function_name} -> {normalized_function_name}")
            
            if normalized_function_name not in self.enabled_functions:
                error_msg = f"Попытка вызвать неразрешенную функцию: {normalized_function_name}. Разрешены только: {self.enabled_functions}"
                logger.warning(error_msg)
                return {
                    "error": error_msg,
                    "status": "error",
                    "message": f"Функция {normalized_function_name} не активирована для этого ассистента"
                }
            
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse function arguments as JSON: {arguments}")
                    arguments = {}
            
            context = {
                "assistant_config": self.assistant_config,
                "client_id": self.client_id,
                "db_session": self.db_session
            }
            
            result = await execute_function(
                name=normalized_function_name,
                arguments=arguments,
                context=context
            )
            return result
        except Exception as e:
            logger.error(f"Error processing function call: {e}")
            return {"error": str(e)}

    async def send_function_result(self, function_call_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_connected or not self.ws:
            error_msg = "Cannot send function result: not connected"
            logger.error(error_msg)
            return { "success": False, "error": error_msg, "payload": None }
        
        try:
            logger.info(f"[DEBUG-FUNCTION] Начало отправки результата функции: {function_call_id}")
            short_item_id = generate_short_id("func_")
            result_json = json.dumps(result)
            payload = {
                "type": "conversation.item.create",
                "event_id": f"funcres_{time.time()}",
                "item": {
                    "id": short_item_id, 
                    "type": "function_call_output",
                    "call_id": function_call_id,
                    "output": result_json 
                }
            }
            logger.info(f"Отправка результата функции: {function_call_id}")
            logger.info(f"Payload: {json.dumps(payload, ensure_ascii=False)[:200]}...")
            await self.ws.send(json.dumps(payload))
            logger.info(f"Результат функции отправлен как item.create: {function_call_id}")
            logger.info(f"[DEBUG-FUNCTION] Ожидание перед созданием нового ответа (500мс)")
            await asyncio.sleep(0.5) 
            await self.create_response_after_function()
            logger.info(f"[DEBUG-FUNCTION] Результат функции отправлен и запрос на новый ответ выполнен")
            return { "success": True, "error": None, "payload": payload }
        except Exception as e:
            error_msg = f"Error sending function result: {e}"
            logger.error(error_msg)
            return { "success": False, "error": error_msg, "payload": None }

    async def create_response_after_function(self) -> bool:
        if not self.is_connected or not self.ws:
            logger.error("Cannot create response: not connected")
            return False
        try:
            logger.info(f"[DEBUG-FUNCTION] Создание нового ответа после выполнения функции")
            response_payload = {
                "type": "response.create",
                "event_id": f"resp_after_func_{time.time()}",
                "response": {
                    "modalities": ["text", "audio"],
                    "voice": self.assistant_config.voice or DEFAULT_VOICE,
                    "instructions": getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE,
                    "temperature": 0.7,
                    "max_output_tokens": 200
                }
            }
            await self.ws.send(json.dumps(response_payload))
            logger.info("Запрошен новый ответ после выполнения функции")
            logger.info(f"[DEBUG-FUNCTION] Запрос на создание нового ответа отправлен успешно")
            return True
        except Exception as e:
            logger.error(f"Error creating response after function: {e}")
            return False

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
            logger.error("Connection closed while sending audio data")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error processing audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            logger.error("Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        if not self.is_connected or not self.ws:
            logger.warning("Cannot clear input audio buffer: not connected") 
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{time.time()}"
            }))
            logger.info("[INTERRUPTION] Input audio buffer clear sent") 
            return True
        except ConnectionClosed:
            logger.error("Connection closed while clearing audio buffer")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error clearing audio buffer: {e}")
            return False

    async def close(self) -> None:
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"WebSocket connection closed for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI WebSocket: {e}")
        self.is_connected = False

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        if not self.is_connected or not self.ws:
            return
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    yield data
                except json.JSONDecodeError:
                    logger.error(f"Failed to decode message: {message[:100]}...")
        except ConnectionClosed:
            logger.info(f"WebSocket connection closed for client {self.client_id}")
            self.is_connected = False
        except Exception as e:
            logger.error(f"Error receiving messages: {e}")
            self.is_connected = False
