# backend/websockets/openai_client_new.py
"""
🆕 OpenAI Realtime API Client - GA Version
Model: gpt-realtime-mini
Production-ready client for new Realtime API with updated events format.

🔄 MIGRATED TO GA: Async function calling support
🔍 DEBUG VERSION: Enhanced logging for diagnostics
"""

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
DEFAULT_SYSTEM_MESSAGE = "ТЫ мой умный помошник по имени Джон Маккарти.Ты веселый и приятный парень.Стендапер и мотиватор , хочу слышать эмоции от тебя"


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
    
    # iOS
    if "iphone" in user_agent_lower or "ipad" in user_agent_lower:
        return {
            "threshold": 0.35,
            "prefix_padding_ms": 250,
            "silence_duration_ms": 400
        }
    
    # Android
    elif "android" in user_agent_lower:
        return {
            "threshold": 0.25,
            "prefix_padding_ms": 150,
            "silence_duration_ms": 250
        }
    
    # Desktop
    else:
        return {
            "threshold": 0.2,
            "prefix_padding_ms": 100,
            "silence_duration_ms": 200
        }


def get_ios_optimized_session_config(base_config: Dict[str, Any], user_agent: str = "") -> Dict[str, Any]:
    """
    Возвращает оптимизированную конфигурацию сессии для iOS устройств.
    """
    user_agent_lower = user_agent.lower()
    
    if "iphone" in user_agent_lower or "ipad" in user_agent_lower:
        ios_config = base_config.copy()
        
        ios_config["turn_detection"]["threshold"] = 0.4
        ios_config["turn_detection"]["prefix_padding_ms"] = 300
        ios_config["turn_detection"]["silence_duration_ms"] = 500
        
        ios_config["input_audio_format"] = "pcm16"
        ios_config["output_audio_format"] = "pcm16"
        
        ios_config["max_response_output_tokens"] = 300
        ios_config["temperature"] = 0.6
        
        logger.info(f"[NEW-API-iOS] Applied iOS optimizations")
        return ios_config
    
    return base_config


class OpenAIRealtimeClientNew:
    """
    🆕 Client for OpenAI Realtime GA API (gpt-realtime model).
    
    Key differences from beta:
    - Model: gpt-realtime-mini
    - Session type set via URL, not in session.update
    - New event names: output_text, output_audio, output_audio_transcript
    - New events: conversation.item.added/done
    - 🔄 GA MIGRATION: Async function calling - no manual response.create needed
    - 🔍 DEBUG: Enhanced logging
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
        Initialize the OpenAI Realtime GA client.
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.user_agent = user_agent
        self.ws = None
        self.is_connected = False
        
        # 🆕 NEW: GA API URL with model parameter
        self.openai_url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini"
        
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.webhook_url = None
        self.last_function_name = None
        self.enabled_functions = []
        
        # Состояния для перебивания
        self.is_assistant_speaking = False
        self.current_response_id: Optional[str] = None
        self.current_audio_samples = 0
        self.interruption_occurred = False
        self.last_interruption_time = 0
        
        # VAD настройки
        self.vad_settings = get_device_vad_settings(user_agent)
        logger.info(f"[NEW-API] VAD settings for device: {self.vad_settings}")
        logger.info(f"[DEBUG-CLIENT] 🎛️ VAD configured: {self.vad_settings}")
        
        # Определяем тип устройства
        self.is_ios = "iphone" in user_agent.lower() or "ipad" in user_agent.lower()
        self.is_android = "android" in user_agent.lower()
        self.is_mobile = self.is_ios or self.is_android
        
        if self.is_ios:
            logger.info(f"[NEW-API] iOS device detected, applying optimizations")
            logger.info(f"[DEBUG-CLIENT] 📱 iOS mode activated")
        
        # Извлекаем функции
        if hasattr(assistant_config, "functions"):
            functions = assistant_config.functions
            if isinstance(functions, list):
                self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
            elif isinstance(functions, dict) and "enabled_functions" in functions:
                self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
            logger.info(f"[NEW-API] Enabled functions: {self.enabled_functions}")
            logger.info(f"[DEBUG-CLIENT] 🔧 Functions loaded: {len(self.enabled_functions)} total")
        
        # Webhook URL
        if "send_webhook" in self.enabled_functions and hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            self.webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if self.webhook_url:
                logger.info(f"[NEW-API] Webhook URL extracted: {self.webhook_url}")
                logger.info(f"[DEBUG-CLIENT] 🪝 Webhook configured: {self.webhook_url[:30]}...")

    async def connect(self) -> bool:
        """
        🆕 Establish WebSocket connection to OpenAI Realtime GA API.
        """
        if not self.api_key:
            logger.error("[NEW-API] OpenAI API key not provided")
            logger.error("[DEBUG-CLIENT] ❌ No API key!")
            return False

        # 🆕 NEW: Updated headers for GA API
        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI-GA/1.0")
        ]
        
        logger.info(f"[DEBUG-CLIENT] 🔌 Connecting to: {self.openai_url}")
        logger.info(f"[DEBUG-CLIENT] 🔑 API key: {self.api_key[:20]}...")
        
        try:
            logger.info(f"[DEBUG-CLIENT] ⏱️ Connection timeout: 30s")
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
            logger.info(f"[NEW-API] ✅ Connected to OpenAI GA API for {self.client_id} (model: gpt-realtime-mini)")
            logger.info(f"[DEBUG-CLIENT] ✅ WebSocket connected successfully")
            logger.info(f"[DEBUG-CLIENT] 📊 Connection params: max_size=15MB, ping_interval=30s")

            # Получаем настройки
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            logger.info(f"[DEBUG-CLIENT] 🎤 Voice: {voice}")
            logger.info(f"[DEBUG-CLIENT] 📝 System message length: {len(system_message)} chars")
            
            # Обновляем функции
            if functions:
                if isinstance(functions, list):
                    self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
                elif isinstance(functions, dict) and "enabled_functions" in functions:
                    self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
                
                logger.info(f"[NEW-API] Updated functions: {self.enabled_functions}")
                logger.info(f"[DEBUG-CLIENT] 🔄 Functions reloaded: {self.enabled_functions}")

            # Webhook URL
            if "send_webhook" in self.enabled_functions:
                self.webhook_url = extract_webhook_url_from_prompt(system_message)
                if self.webhook_url:
                    logger.info(f"[NEW-API] Webhook URL: {self.webhook_url}")

            # 🆕 Отправляем session.update БЕЗ type (тип уже установлен через URL)
            logger.info(f"[DEBUG-CLIENT] 📤 Sending session.update...")
            if not await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                logger.error("[NEW-API] Failed to update session settings")
                logger.error("[DEBUG-CLIENT] ❌ session.update failed!")
                await self.close()
                return False

            logger.info(f"[DEBUG-CLIENT] ✅ Session initialized successfully")
            return True
        except asyncio.TimeoutError:
            logger.error(f"[NEW-API] Connection timeout for {self.client_id}")
            logger.error(f"[DEBUG-CLIENT] ⏱️ Connection timeout after 30s")
            return False
        except Exception as e:
            logger.error(f"[NEW-API] Failed to connect: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Connection error: {type(e).__name__}: {str(e)}")
            return False

    async def reconnect(self) -> bool:
        """
        Reconnect to OpenAI Realtime GA API.
        """
        logger.info(f"[NEW-API] Attempting reconnection for {self.client_id}")
        logger.info(f"[DEBUG-CLIENT] 🔄 Starting reconnection...")
        try:
            if self.ws:
                try:
                    await self.ws.close()
                    logger.info(f"[DEBUG-CLIENT] 🔌 Old connection closed")
                except:
                    pass
            
            self.is_connected = False
            self.ws = None
            
            # Сбрасываем состояния
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            self.interruption_occurred = False
            
            logger.info(f"[DEBUG-CLIENT] 🧹 State reset complete")
            
            result = await self.connect()
            if result:
                logger.info(f"[DEBUG-CLIENT] ✅ Reconnection successful")
            else:
                logger.error(f"[DEBUG-CLIENT] ❌ Reconnection failed")
            return result
        except Exception as e:
            logger.error(f"[NEW-API] Reconnection error: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Reconnection exception: {str(e)}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        """
        🆕 Update session settings for GA API.
        
        ВАЖНО: Параметр "type" НЕ отправляется в session.update,
        так как тип сессии уже установлен через URL при подключении.
        """
        if not self.is_connected or not self.ws:
            logger.error("[NEW-API] Cannot update session: not connected")
            logger.error("[DEBUG-CLIENT] ❌ update_session called but not connected!")
            return False
        
        logger.info(f"[DEBUG-CLIENT] 🔧 Building session configuration...")
            
        # VAD настройки
        turn_detection = {
            "type": "server_vad",
            "threshold": self.vad_settings["threshold"],
            "prefix_padding_ms": self.vad_settings["prefix_padding_ms"],
            "silence_duration_ms": self.vad_settings["silence_duration_ms"],
            "create_response": True,
        }
        
        logger.info(f"[NEW-API] VAD for fast interruption: {turn_detection}")
        logger.info(f"[DEBUG-CLIENT] 🎙️ VAD config: {turn_detection}")
        
        # Функции
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
        logger.info(f"[NEW-API] Activated functions: {self.enabled_functions}")
        logger.info(f"[DEBUG-CLIENT] 🔧 Tools prepared: {len(tools)} functions")
        
        for i, tool in enumerate(tools):
            logger.info(f"[DEBUG-CLIENT]   {i+1}. {tool['name']}: {tool['description'][:50]}...")
        
        tool_choice = "auto" if tools else "none"
        logger.info(f"[DEBUG-CLIENT] 🎯 Tool choice: {tool_choice}")
        
        # Транскрипция
        input_audio_transcription = {
            "model": "whisper-1"
        }
        
        # 🆕 ИСПРАВЛЕНИЕ: Убран параметр "type": "realtime"
        # Тип сессии уже установлен через URL подключения
        payload = {
            "type": "session.update",
            "session": {
                "model": "gpt-realtime-mini",
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
        
        # iOS оптимизации
        payload["session"] = get_ios_optimized_session_config(payload["session"], self.user_agent)
        
        logger.info(f"[DEBUG-CLIENT] 📦 Payload size: {len(json.dumps(payload))} bytes")
        logger.info(f"[DEBUG-CLIENT] 📋 Session config: model={payload['session']['model']}, temp={payload['session']['temperature']}")
        
        try:
            await self.ws.send(json.dumps(payload))
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[NEW-API] ✅ Session settings sent for {device_info} (model: gpt-realtime-mini, tools: {len(tools)})")
            logger.info(f"[DEBUG-CLIENT] ✅ session.update sent successfully")
            
            if tools:
                for tool in tools:
                    logger.info(f"[NEW-API] Function enabled: {tool['name']}")
        except Exception as e:
            logger.error(f"[NEW-API] Error sending session.update: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Failed to send session.update: {str(e)}")
            return False

        # Создаем запись в БД
        if self.db_session:
            try:
                logger.info(f"[DEBUG-CLIENT] 💾 Creating conversation record...")
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
                logger.info(f"[NEW-API] Created conversation record: {self.conversation_record_id}")
                logger.info(f"[DEBUG-CLIENT] ✅ Conversation record created: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"[NEW-API] Error creating conversation: {e}")
                logger.error(f"[DEBUG-CLIENT] ❌ DB error: {str(e)}")

        return True

    async def handle_interruption(self) -> bool:
        """
        Handle interruption events.
        """
        try:
            current_time = time.time()
            
            protection_time = 0.15 if self.is_ios else 0.2
            
            if current_time - self.last_interruption_time < protection_time:
                logger.info(f"[NEW-API] Ignoring duplicate interruption (debounce: {protection_time}s)")
                logger.info(f"[DEBUG-CLIENT] ⚠️ Duplicate interruption ignored (debounce)")
                return True
                
            self.last_interruption_time = current_time
            self.interruption_occurred = True
            
            logger.info(f"[NEW-API] Handling interruption for {self.client_id}")
            logger.info(f"[DEBUG-CLIENT] ⚡ Interruption triggered")
            
            if self.is_assistant_speaking and self.current_response_id:
                logger.info(f"[DEBUG-CLIENT] 🛑 Cancelling current response: {self.current_response_id}")
                await self.cancel_current_response(self.current_response_id, self.current_audio_samples)
            
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            
            logger.info("[NEW-API] Interruption handled successfully")
            logger.info(f"[DEBUG-CLIENT] ✅ Interruption handled, state reset")
            return True
            
        except Exception as e:
            logger.error(f"[NEW-API] Error handling interruption: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Interruption handling error: {str(e)}")
            return False

    async def cancel_current_response(self, item_id: str = None, sample_count: int = 0) -> bool:
        """
        Cancel current assistant response.
        """
        if not self.is_connected or not self.ws:
            logger.error("[NEW-API] Cannot cancel response: not connected")
            logger.error("[DEBUG-CLIENT] ❌ cancel_current_response: not connected")
            return False
            
        try:
            logger.info(f"[NEW-API] Cancelling response: item_id={item_id}, samples={sample_count}")
            logger.info(f"[DEBUG-CLIENT] 📤 Sending response.cancel")
            
            cancel_payload = {
                "type": "response.cancel",
                "event_id": f"cancel_{int(time.time() * 1000)}"
            }
            
            if item_id:
                cancel_payload["item_id"] = item_id
            if sample_count > 0:
                cancel_payload["sample_count"] = sample_count
            
            logger.info(f"[DEBUG-CLIENT] 📋 Cancel payload: {cancel_payload}")
                
            await self.ws.send(json.dumps(cancel_payload))
            logger.info("[NEW-API] Cancel command sent")
            logger.info(f"[DEBUG-CLIENT] ✅ response.cancel sent")
            
            return True
            
        except Exception as e:
            logger.error(f"[NEW-API] Error cancelling response: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Cancel error: {str(e)}")
            return False

    async def clear_audio_buffer_on_interruption(self) -> bool:
        """
        Clear audio buffer on interruption.
        """
        if not self.is_connected or not self.ws:
            return False
            
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_interrupt_{int(time.time() * 1000)}"
            }))
            logger.info("[NEW-API] Audio buffer cleared after interruption")
            logger.info(f"[DEBUG-CLIENT] 🗑️ Audio buffer cleared")
            return True
        except Exception as e:
            logger.error(f"[NEW-API] Error clearing buffer: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Clear buffer error: {str(e)}")
            return False

    def set_assistant_speaking(self, speaking: bool, response_id: str = None) -> None:
        """
        Set assistant speaking state.
        """
        self.is_assistant_speaking = speaking
        if speaking:
            self.current_response_id = response_id
            self.current_audio_samples = 0
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[NEW-API {device_info}] Assistant started speaking: response_id={response_id}")
            logger.info(f"[DEBUG-CLIENT] 🔊 Assistant speaking: TRUE, response_id={response_id}")
        else:
            self.current_response_id = None
            self.current_audio_samples = 0
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[NEW-API {device_info}] Assistant stopped speaking")
            logger.info(f"[DEBUG-CLIENT] 🔇 Assistant speaking: FALSE")

    def increment_audio_samples(self, sample_count: int) -> None:
        """
        Increment audio sample count.
        """
        self.current_audio_samples += sample_count
        logger.debug(f"[DEBUG-CLIENT] 🎵 Audio samples: {self.current_audio_samples} (+{sample_count})")

    async def handle_function_call(self, function_call_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process a function call from OpenAI.
        """
        try:
            function_name = function_call_data.get("function", {}).get("name")
            arguments = function_call_data.get("function", {}).get("arguments", {})
            
            logger.info(f"[DEBUG-CLIENT] 🔧 handle_function_call: {function_name}")
            
            self.last_function_name = function_name
            
            normalized_function_name = normalize_function_name(function_name) or function_name
            logger.info(f"[NEW-API] Function normalization: {function_name} -> {normalized_function_name}")
            logger.info(f"[DEBUG-CLIENT] 🔄 Normalized: {normalized_function_name}")
            
            if normalized_function_name not in self.enabled_functions:
                error_msg = f"Unauthorized function: {normalized_function_name}. Allowed: {self.enabled_functions}"
                logger.warning(error_msg)
                logger.warning(f"[DEBUG-CLIENT] ⚠️ Function not enabled!")
                return {
                    "error": error_msg,
                    "status": "error",
                    "message": f"Function {normalized_function_name} not activated"
                }
            
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    logger.warning(f"[NEW-API] Failed to parse arguments: {arguments}")
                    logger.warning(f"[DEBUG-CLIENT] ⚠️ JSON parse failed")
                    arguments = {}
            
            context = {
                "assistant_config": self.assistant_config,
                "client_id": self.client_id,
                "db_session": self.db_session
            }
            
            logger.info(f"[DEBUG-CLIENT] 🚀 Executing function with context...")
            result = await execute_function(
                name=normalized_function_name,
                arguments=arguments,
                context=context
            )
            
            logger.info(f"[DEBUG-CLIENT] ✅ Function executed, result: {json.dumps(result, ensure_ascii=False)[:100]}...")
            return result
        except Exception as e:
            logger.error(f"[NEW-API] Error processing function call: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Function call error: {str(e)}")
            return {"error": str(e)}

    async def send_function_result(self, function_call_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        🔄 GA MIGRATED: Send function execution result back to OpenAI.
        
        В GA API модель автоматически продолжает после получения результата функции.
        НЕ НУЖНО вызывать response.create вручную!
        
        Returns:
            Dict with success status and payload
        """
        if not self.is_connected or not self.ws:
            error_msg = "Cannot send function result: not connected"
            logger.error(f"[NEW-API] {error_msg}")
            logger.error(f"[DEBUG-CLIENT] ❌ send_function_result: not connected!")
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }
        
        try:
            logger.info(f"[NEW-API] Sending function result: {function_call_id}")
            logger.info(f"[DEBUG-CLIENT] 📤 send_function_result called")
            logger.info(f"[DEBUG-CLIENT] 🆔 call_id: {function_call_id}")
            logger.info(f"[DEBUG-CLIENT] 📊 result type: {type(result)}")
            logger.info(f"[DEBUG-CLIENT] 📊 result keys: {list(result.keys()) if isinstance(result, dict) else 'not dict'}")
            
            short_item_id = generate_short_id("func_")
            logger.info(f"[DEBUG-CLIENT] 🎲 Generated item_id: {short_item_id}")
            
            result_json = json.dumps(result)
            logger.info(f"[DEBUG-CLIENT] 📝 Result JSON length: {len(result_json)} chars")
            logger.info(f"[DEBUG-CLIENT] 📝 Result JSON preview: {result_json[:200]}...")
            
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
            
            logger.info(f"[DEBUG-CLIENT] 📦 Full payload:")
            logger.info(f"[DEBUG-CLIENT]    type: {payload['type']}")
            logger.info(f"[DEBUG-CLIENT]    event_id: {payload['event_id']}")
            logger.info(f"[DEBUG-CLIENT]    item.id: {payload['item']['id']}")
            logger.info(f"[DEBUG-CLIENT]    item.type: {payload['item']['type']}")
            logger.info(f"[DEBUG-CLIENT]    item.call_id: {payload['item']['call_id']}")
            logger.info(f"[DEBUG-CLIENT]    item.output length: {len(payload['item']['output'])} chars")
            
            logger.info(f"[DEBUG-CLIENT] 🚀 Sending to OpenAI WebSocket...")
            await self.ws.send(json.dumps(payload))
            logger.info(f"[NEW-API] ✅ Function result sent: {function_call_id}")
            logger.info(f"[DEBUG-CLIENT] ✅ Payload sent successfully!")
            
            # 🔄 GA MIGRATION: Модель автоматически продолжит работу!
            # В Beta API здесь был вызов create_response_after_function()
            # В GA API это НЕ НУЖНО - модель сама генерирует следующий response
            logger.info(f"[NEW-API-GA] 🚀 Waiting for model to continue automatically (async function calling)")
            logger.info(f"[DEBUG-CLIENT] ⏳ GA MODE: Waiting for automatic model continuation...")
            logger.info(f"[DEBUG-CLIENT] ⏳ Expected next event: response.content_part.added or similar")
            logger.info(f"[DEBUG-CLIENT] ⏳ NO manual response.create will be called (GA behavior)")
            
            return {
                "success": True,
                "error": None,
                "payload": payload
            }
            
        except Exception as e:
            error_msg = f"Error sending function result: {e}"
            logger.error(f"[NEW-API] {error_msg}")
            logger.error(f"[DEBUG-CLIENT] ❌ Exception in send_function_result: {str(e)}")
            logger.error(f"[DEBUG-CLIENT] ❌ Exception type: {type(e).__name__}")
            import traceback
            logger.error(f"[DEBUG-CLIENT] 📋 Traceback: {traceback.format_exc()}")
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }

    async def create_response_after_function(self) -> bool:
        """
        ⚠️ LEGACY METHOD - Для обратной совместимости и edge cases
        
        Request new response from model after function execution.
        
        🔄 GA API ВАЖНО: 
        В GA API (gpt-realtime-mini) этот метод НЕ НУЖЕН для обычного flow!
        Модель автоматически продолжает после получения результата функции.
        
        Используйте ТОЛЬКО для специальных случаев:
        - Ручное управление диалогом
        - Out-of-band responses
        - Дебаг и тестирование
        - Принудительная генерация ответа в нестандартных ситуациях
        
        ❌ НЕ вызывайте автоматически после send_function_result()!
        Это создаст дублирующие ответы и нарушит GA flow.
        
        Returns:
            bool: Success status
        """
        if not self.is_connected or not self.ws:
            logger.error("[NEW-API] Cannot create response: not connected")
            logger.error("[DEBUG-CLIENT] ❌ create_response_after_function: not connected")
            return False
            
        try:
            logger.warning(f"[NEW-API] ⚠️ Manual response.create called (should be RARE in GA API!)")
            logger.warning(f"[NEW-API] ⚠️ This may cause duplicate responses if called after function execution")
            logger.warning(f"[DEBUG-CLIENT] ⚠️⚠️⚠️ MANUAL response.create CALLED!")
            logger.warning(f"[DEBUG-CLIENT] ⚠️ This should NOT happen in normal GA flow!")
            logger.warning(f"[DEBUG-CLIENT] ⚠️ Check who called this method!")
            
            max_tokens = 200 if self.is_ios else 300
            temperature = 0.6 if self.is_ios else 0.7
            
            response_payload = {
                "type": "response.create",
                "event_id": f"resp_manual_{int(time.time() * 1000)}",
                "response": {
                    "modalities": ["text", "audio"],
                    "voice": self.assistant_config.voice or DEFAULT_VOICE,
                    "instructions": getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE,
                    "temperature": temperature,
                    "max_output_tokens": max_tokens
                }
            }
            
            logger.info(f"[DEBUG-CLIENT] 📤 Sending manual response.create...")
            await self.ws.send(json.dumps(response_payload))
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[NEW-API] Manual response requested ({device_info})")
            logger.info(f"[DEBUG-CLIENT] ✅ Manual response.create sent")
            
            return True
            
        except Exception as e:
            logger.error(f"[NEW-API] Error creating manual response: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Manual response.create error: {str(e)}")
            return False

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """
        Process and send audio data to OpenAI API.
        """
        if not self.is_connected or not self.ws or not audio_buffer:
            return False
        try:
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": f"audio_{int(time.time() * 1000)}"
            }))
            logger.debug(f"[DEBUG-CLIENT] 🎤 Audio chunk sent: {len(audio_buffer)} bytes")
            return True
        except ConnectionClosed:
            logger.error("[NEW-API] Connection closed while sending audio")
            logger.error("[DEBUG-CLIENT] ❌ Audio send failed: connection closed")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[NEW-API] Error processing audio: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Audio processing error: {str(e)}")
            return False

    async def commit_audio(self) -> bool:
        """
        Commit audio buffer.
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{int(time.time() * 1000)}"
            }))
            logger.info(f"[DEBUG-CLIENT] ✅ Audio committed")
            return True
        except ConnectionClosed:
            logger.error("[NEW-API] Connection closed while committing audio")
            logger.error("[DEBUG-CLIENT] ❌ Commit failed: connection closed")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[NEW-API] Error committing audio: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Commit error: {str(e)}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Clear audio buffer.
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{int(time.time() * 1000)}"
            }))
            logger.info(f"[DEBUG-CLIENT] 🗑️ Audio buffer cleared")
            return True
        except ConnectionClosed:
            logger.error("[NEW-API] Connection closed while clearing buffer")
            logger.error("[DEBUG-CLIENT] ❌ Clear failed: connection closed")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[NEW-API] Error clearing buffer: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Clear buffer error: {str(e)}")
            return False

    async def close(self) -> None:
        """
        Close WebSocket connection.
        """
        if self.ws:
            try:
                await self.ws.close()
                device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
                logger.info(f"[NEW-API] WebSocket closed for {self.client_id} ({device_info})")
                logger.info(f"[DEBUG-CLIENT] 🔒 Connection closed")
            except Exception as e:
                logger.error(f"[NEW-API] Error closing WebSocket: {e}")
                logger.error(f"[DEBUG-CLIENT] ❌ Close error: {str(e)}")
        self.is_connected = False
        
        self.is_assistant_speaking = False
        self.current_response_id = None
        self.current_audio_samples = 0
        self.interruption_occurred = False
        logger.info(f"[DEBUG-CLIENT] 🧹 State cleaned up")

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Receive and yield messages from OpenAI WebSocket.
        """
        if not self.is_connected or not self.ws:
            logger.error("[DEBUG-CLIENT] ❌ receive_messages: not connected")
            return
            
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    yield data
                except json.JSONDecodeError:
                    logger.error(f"[NEW-API] Failed to decode: {message[:100]}...")
                    logger.error(f"[DEBUG-CLIENT] ❌ JSON decode failed")
        except ConnectionClosed:
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[NEW-API] WebSocket closed for {self.client_id} ({device_info})")
            logger.info(f"[DEBUG-CLIENT] 🔌 WebSocket closed in receive_messages")
            self.is_connected = False
        except Exception as e:
            logger.error(f"[NEW-API] Error receiving messages: {e}")
            logger.error(f"[DEBUG-CLIENT] ❌ Receive error: {str(e)}")
            self.is_connected = False
