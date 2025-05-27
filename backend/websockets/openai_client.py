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

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        """
        Update session settings on the OpenAI Realtime API side.
        
        Args:
            voice: Voice ID to use for speech synthesis
            system_message: System instructions for the assistant
            functions: List of functions or dictionary with enabled_functions key
            
        Returns:
            bool: True if update was successful, False otherwise
        """
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
        
        # Обновляем список разрешенных функций на основе tools
        self.enabled_functions = [normalize_function_name(tool["name"]) for tool in tools]
        logger.info(f"[DEBUG-FUNCTION] Активированные функции для сессии: {self.enabled_functions}")
        
        # Устанавливаем tool_choice на основе наличия tools
        tool_choice = "auto" if tools else "none"
        
        logger.info(f"Setting up session with {len(tools)} tools, tool_choice={tool_choice}")
        
        # Включение транскрипции аудио в соответствии с документацией OpenAI
        input_audio_transcription = {
            "model": "whisper-1"
        }
            
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
            
            # Вывод подробной информации о функциях в лог
            if tools:
                for tool in tools:
                    logger.info(f"[DEBUG-FUNCTION] Enabled function: {tool['name']}, params: {json.dumps(tool['parameters'], ensure_ascii=False)[:100]}...")
        except Exception as e:
            logger.error(f"Error sending session.update: {e}")
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
                logger.info(f"Created conversation record: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"Error creating Conversation in DB: {e}")

        return True

    async def handle_function_call(self, function_call_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process a function call from OpenAI.
        
        Args:
            function_call_data: Function call data from OpenAI
            
        Returns:
            Dict: Result of the function execution
        """
        try:
            function_name = function_call_data.get("function", {}).get("name")
            arguments = function_call_data.get("function", {}).get("arguments", {})
            
            # Сохраняем имя функции для последующего использования
            self.last_function_name = function_name
            
            # Нормализуем имя функции из любого формата
            normalized_function_name = normalize_function_name(function_name) or function_name
            logger.info(f"[DEBUG-FUNCTION] Нормализация имени функции: {function_name} -> {normalized_function_name}")
            
            # Проверяем, разрешена ли функция
            if normalized_function_name not in self.enabled_functions:
                error_msg = f"Попытка вызвать неразрешенную функцию: {normalized_function_name}. Разрешены только: {self.enabled_functions}"
                logger.warning(error_msg)
                return {
                    "error": error_msg,
                    "status": "error",
                    "message": f"Функция {normalized_function_name} не активирована для этого ассистента"
                }
            
            # Если arguments - строка, парсим JSON
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse function arguments as JSON: {arguments}")
                    arguments = {}
            
            # Подготавливаем контекст выполнения
            context = {
                "assistant_config": self.assistant_config,
                "client_id": self.client_id,
                "db_session": self.db_session
            }
            
            # Выполняем функцию через новую систему
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
        """
        Send the result of a function execution back to OpenAI as a conversation.item.create event.
        
        Args:
            function_call_id: ID of the function call
            result: Result of the function execution
            
        Returns:
            Dict: Status information about the result delivery
                {
                    "success": bool,
                    "error": str or None,
                    "payload": dict - payload that was sent 
                }
        """
        if not self.is_connected or not self.ws:
            error_msg = "Cannot send function result: not connected"
            logger.error(error_msg)
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }
        
        try:
            logger.info(f"[DEBUG-FUNCTION] Начало отправки результата функции: {function_call_id}")
            
            # Генерируем короткий ID длиной до 32 символов
            short_item_id = generate_short_id("func_")
            
            # Преобразуем результат в строку JSON
            # OpenAI ожидает, что поле output будет строкой, а не объектом
            result_json = json.dumps(result)
            
            # Исправленная структура для отправки результата функции
            payload = {
                "type": "conversation.item.create",
                "event_id": f"funcres_{time.time()}",
                "item": {
                    "id": short_item_id,  # Максимум 32 символа
                    "type": "function_call_output",
                    "call_id": function_call_id,
                    "output": result_json  # Строка вместо объекта
                }
            }
            
            logger.info(f"Отправка результата функции: {function_call_id}")
            logger.info(f"Payload: {json.dumps(payload, ensure_ascii=False)[:200]}...")
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"Результат функции отправлен как item.create: {function_call_id}")
            
            # Добавляем небольшую задержку перед запросом нового ответа
            logger.info(f"[DEBUG-FUNCTION] Ожидание перед созданием нового ответа (500мс)")
            await asyncio.sleep(0.5)  # 500 мс должно быть достаточно
            
            # После отправки результата, явно запрашиваем новый ответ от модели
            await self.create_response_after_function()
            
            logger.info(f"[DEBUG-FUNCTION] Результат функции отправлен и запрос на новый ответ выполнен")
            
            return {
                "success": True,
                "error": None,
                "payload": payload
            }
            
        except Exception as e:
            error_msg = f"Error sending function result: {e}"
            logger.error(error_msg)
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }

    async def create_response_after_function(self) -> bool:
        """
        Явно запрашивает новый ответ от модели после выполнения функции.
        Это обеспечит генерацию аудио-ответа.
        
        Returns:
            bool: True если успешно, False иначе
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot create response: not connected")
            return False
            
        try:
            logger.info(f"[DEBUG-FUNCTION] Создание нового ответа после выполнения функции")
            
            # Запрашиваем новый ответ от модели с более полным набором параметров
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
        """
        Process and send audio data to the OpenAI API.
        
        Args:
            audio_buffer: Binary audio data in PCM16 format
            
        Returns:
            bool: True if successful, False otherwise
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
            logger.error("Connection closed while sending audio data")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error processing audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        """
        Commit the audio buffer, indicating that the user has finished speaking.
        
        Returns:
            bool: True if successful, False otherwise
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
            logger.error("Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Clear the audio buffer, removing any pending audio data.
        
        Returns:
            bool: True if successful, False otherwise
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
            logger.error("Connection closed while clearing audio buffer")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error clearing audio buffer: {e}")
            return False

    async def close(self) -> None:
        """
        Close the WebSocket connection.
        """
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"WebSocket connection closed for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI WebSocket: {e}")
        self.is_connected = False

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Receive and yield messages from the OpenAI WebSocket.
        
        Yields:
            Dict: Message received from the OpenAI WebSocket
        """
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
