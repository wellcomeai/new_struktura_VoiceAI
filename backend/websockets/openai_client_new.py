# backend/websockets/openai_client_new.py
"""
🚀 PRODUCTION VERSION 3.0 - OpenAI Realtime API Client
Model: gpt-realtime-mini

Critical fixes v3.0:
✅ Auto response.create after function result (fixes silence bug)
✅ Fixed double JSON serialization bug
✅ Enhanced error handling
✅ Performance monitoring
✅ Production-ready stability
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
    """Convert UI function list to full definitions with parameters."""
    if not assistant_functions:
        return []
    
    enabled_names = []
    
    if isinstance(assistant_functions, dict) and "enabled_functions" in assistant_functions:
        enabled_names = [normalize_function_name(name) for name in assistant_functions.get("enabled_functions", [])]
    else:
        enabled_names = [normalize_function_name(func.get("name")) for func in assistant_functions if func.get("name")]
        
    return get_enabled_functions(enabled_names)


def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """Extract webhook URL from assistant system prompt."""
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
    """Generate short unique identifier (max 32 chars)."""
    raw_id = str(uuid.uuid4()).replace("-", "")
    max_id_len = 32 - len(prefix)
    return f"{prefix}{raw_id[:max_id_len]}"


def get_device_vad_settings(user_agent: str = "") -> Dict[str, Any]:
    """Return optimal VAD settings based on device."""
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
    """Return optimized session config for iOS devices."""
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
        
        logger.info(f"[REALTIME-CLIENT] Applied iOS optimizations")
        return ios_config
    
    return base_config


class OpenAIRealtimeClientNew:
    """
    🚀 PRODUCTION v3.0 - Client for OpenAI Realtime GA API (gpt-realtime-mini)
    
    Key features:
    - Auto response.create after function result (NEW in v3.0)
    - Fixed double JSON serialization bug
    - Async function calling support (GA API)
    - Reliable error handling
    - Performance monitoring
    """
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session: Any = None,
        user_agent: str = ""
    ):
        """Initialize the OpenAI Realtime GA client."""
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.user_agent = user_agent
        self.ws = None
        self.is_connected = False
        
        # GA API URL with model parameter
        self.openai_url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini"
        
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.webhook_url = None
        self.last_function_name = None
        self.enabled_functions = []
        
        # Interruption states
        self.is_assistant_speaking = False
        self.current_response_id: Optional[str] = None
        self.current_audio_samples = 0
        self.interruption_occurred = False
        self.last_interruption_time = 0
        
        # VAD settings
        self.vad_settings = get_device_vad_settings(user_agent)
        logger.info(f"[REALTIME-CLIENT] VAD settings: {self.vad_settings}")
        
        # Device detection
        self.is_ios = "iphone" in user_agent.lower() or "ipad" in user_agent.lower()
        self.is_android = "android" in user_agent.lower()
        self.is_mobile = self.is_ios or self.is_android
        
        if self.is_ios:
            logger.info(f"[REALTIME-CLIENT] iOS device detected, applying optimizations")
        
        # Extract functions
        if hasattr(assistant_config, "functions"):
            functions = assistant_config.functions
            if isinstance(functions, list):
                self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
            elif isinstance(functions, dict) and "enabled_functions" in functions:
                self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
            logger.info(f"[REALTIME-CLIENT] Enabled functions: {self.enabled_functions}")
        
        # Webhook URL
        if "send_webhook" in self.enabled_functions and hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            self.webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if self.webhook_url:
                logger.info(f"[REALTIME-CLIENT] Webhook configured")

    async def connect(self) -> bool:
        """Establish WebSocket connection to OpenAI Realtime GA API."""
        if not self.api_key:
            logger.error("[REALTIME-CLIENT] OpenAI API key not provided")
            return False

        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI-Production/3.0")
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
            logger.info(f"[REALTIME-CLIENT] ✅ Connected to OpenAI GA API (model: gpt-realtime-mini)")

            # Get settings
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            # Update functions
            if functions:
                if isinstance(functions, list):
                    self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
                elif isinstance(functions, dict) and "enabled_functions" in functions:
                    self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
                
                logger.info(f"[REALTIME-CLIENT] Functions loaded: {self.enabled_functions}")

            # Webhook URL
            if "send_webhook" in self.enabled_functions:
                self.webhook_url = extract_webhook_url_from_prompt(system_message)

            # Send session.update
            if not await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                logger.error("[REALTIME-CLIENT] Failed to update session settings")
                await self.close()
                return False

            logger.info(f"[REALTIME-CLIENT] Session initialized successfully")
            return True
        except asyncio.TimeoutError:
            logger.error(f"[REALTIME-CLIENT] Connection timeout")
            return False
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Failed to connect: {e}")
            return False

    async def reconnect(self) -> bool:
        """Reconnect to OpenAI Realtime GA API."""
        logger.info(f"[REALTIME-CLIENT] Attempting reconnection...")
        try:
            if self.ws:
                try:
                    await self.ws.close()
                except:
                    pass
            
            self.is_connected = False
            self.ws = None
            
            # Reset states
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            self.interruption_occurred = False
            
            result = await self.connect()
            if result:
                logger.info(f"[REALTIME-CLIENT] ✅ Reconnection successful")
            return result
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Reconnection error: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        """Update session settings for GA API."""
        if not self.is_connected or not self.ws:
            logger.error("[REALTIME-CLIENT] Cannot update session: not connected")
            return False
            
        # VAD settings
        turn_detection = {
            "type": "server_vad",
            "threshold": self.vad_settings["threshold"],
            "prefix_padding_ms": self.vad_settings["prefix_padding_ms"],
            "silence_duration_ms": self.vad_settings["silence_duration_ms"],
            "create_response": True,
        }
        
        # Functions
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
        logger.info(f"[REALTIME-CLIENT] Functions activated: {self.enabled_functions}")
        
        tool_choice = "auto" if tools else "none"
        
        # Transcription
        input_audio_transcription = {
            "model": "whisper-1"
        }
        
        # Session payload (type NOT included - set via URL)
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
        
        # iOS optimizations
        payload["session"] = get_ios_optimized_session_config(payload["session"], self.user_agent)
        
        try:
            await self.ws.send(json.dumps(payload))
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[REALTIME-CLIENT] ✅ Session configured for {device_info} (tools: {len(tools)})")
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error sending session.update: {e}")
            return False

        # Create conversation record
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
                logger.info(f"[REALTIME-CLIENT] Conversation record created: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"[REALTIME-CLIENT] Error creating conversation: {e}")

        return True

    async def handle_interruption(self) -> bool:
        """Handle interruption events."""
        try:
            current_time = time.time()
            
            protection_time = 0.15 if self.is_ios else 0.2
            
            if current_time - self.last_interruption_time < protection_time:
                logger.info(f"[REALTIME-CLIENT] Ignoring duplicate interruption (debounce: {protection_time}s)")
                return True
                
            self.last_interruption_time = current_time
            self.interruption_occurred = True
            
            logger.info(f"[REALTIME-CLIENT] Handling interruption")
            
            if self.is_assistant_speaking and self.current_response_id:
                await self.cancel_current_response(self.current_response_id, self.current_audio_samples)
            
            self.is_assistant_speaking = False
            self.current_response_id = None
            self.current_audio_samples = 0
            
            logger.info("[REALTIME-CLIENT] Interruption handled successfully")
            return True
            
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error handling interruption: {e}")
            return False

    async def cancel_current_response(self, item_id: str = None, sample_count: int = 0) -> bool:
        """Cancel current assistant response."""
        if not self.is_connected or not self.ws:
            logger.error("[REALTIME-CLIENT] Cannot cancel response: not connected")
            return False
            
        try:
            logger.info(f"[REALTIME-CLIENT] Cancelling response")
            
            cancel_payload = {
                "type": "response.cancel",
                "event_id": f"cancel_{int(time.time() * 1000)}"
            }
            
            if item_id:
                cancel_payload["item_id"] = item_id
            if sample_count > 0:
                cancel_payload["sample_count"] = sample_count
                
            await self.ws.send(json.dumps(cancel_payload))
            logger.info("[REALTIME-CLIENT] Cancel command sent")
            
            return True
            
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error cancelling response: {e}")
            return False

    async def clear_audio_buffer_on_interruption(self) -> bool:
        """Clear audio buffer on interruption."""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_interrupt_{int(time.time() * 1000)}"
            }))
            logger.info("[REALTIME-CLIENT] Audio buffer cleared after interruption")
            return True
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error clearing buffer: {e}")
            return False

    def set_assistant_speaking(self, speaking: bool, response_id: str = None) -> None:
        """Set assistant speaking state."""
        self.is_assistant_speaking = speaking
        if speaking:
            self.current_response_id = response_id
            self.current_audio_samples = 0
        else:
            self.current_response_id = None
            self.current_audio_samples = 0

    def increment_audio_samples(self, sample_count: int) -> None:
        """Increment audio sample count."""
        self.current_audio_samples += sample_count

    async def handle_function_call(self, function_call_data: Dict[str, Any]) -> Dict[str, Any]:
        """Process a function call from OpenAI."""
        try:
            function_name = function_call_data.get("function", {}).get("name")
            arguments = function_call_data.get("function", {}).get("arguments", {})
            
            self.last_function_name = function_name
            
            normalized_function_name = normalize_function_name(function_name) or function_name
            logger.info(f"[REALTIME-CLIENT] Function normalization: {function_name} -> {normalized_function_name}")
            
            if normalized_function_name not in self.enabled_functions:
                error_msg = f"Unauthorized function: {normalized_function_name}"
                logger.warning(error_msg)
                return {
                    "error": error_msg,
                    "status": "error",
                    "message": f"Function {normalized_function_name} not activated"
                }
            
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    logger.warning(f"[REALTIME-CLIENT] Failed to parse arguments: {arguments}")
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
            logger.error(f"[REALTIME-CLIENT] Error processing function call: {e}")
            return {"error": str(e)}

    async def send_function_result(self, function_call_id: str, result: Dict[str, Any]) -> Dict[str, bool]:
        """
        🚀 PRODUCTION v3.0: Send function result + AUTO CREATE RESPONSE
        
        CRITICAL FIX v3.0: After sending function result, automatically trigger response.create
        This fixes the "assistant silence" bug where model doesn't continue after function execution.
        
        Returns:
            Dict with success status
        """
        if not self.is_connected or not self.ws:
            error_msg = "Cannot send function result: not connected"
            logger.error(f"[REALTIME-CLIENT] {error_msg}")
            return {
                "success": False,
                "error": error_msg
            }
        
        try:
            logger.info(f"[REALTIME-CLIENT] Sending function result: {function_call_id}")
            
            short_item_id = generate_short_id("func_")
            
            # Step 1: Send function result
            result_payload = {
                "type": "conversation.item.create",
                "event_id": f"funcres_{int(time.time() * 1000)}",
                "item": {
                    "id": short_item_id,
                    "type": "function_call_output",
                    "call_id": function_call_id,
                    "output": json.dumps(result)  # ✅ Single serialization
                }
            }
            
            logger.info(f"[REALTIME-CLIENT] Sending function_call_output...")
            await self.ws.send(json.dumps(result_payload))
            logger.info(f"[REALTIME-CLIENT] ✅ Function result sent")
            
            # 🆕 Step 2: IMMEDIATELY create response (v3.0 FIX)
            # This is the critical fix that makes assistant respond after function execution
            logger.info(f"[REALTIME-CLIENT] Creating automatic response after function...")
            
            max_tokens = 200 if self.is_ios else 300
            temperature = 0.6 if self.is_ios else 0.7
            
            response_payload = {
                "type": "response.create",
                "event_id": f"resp_auto_{int(time.time() * 1000)}",
                "response": {
                    "modalities": ["text", "audio"],
                    "voice": self.assistant_config.voice or DEFAULT_VOICE,
                    "instructions": getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE,
                    "temperature": temperature,
                    "max_output_tokens": max_tokens
                }
            }
            
            await self.ws.send(json.dumps(response_payload))
            logger.info(f"[REALTIME-CLIENT] ✅ Auto response.create sent (v3.0 fix)")
            
            return {
                "success": True,
                "error": None
            }
            
        except Exception as e:
            error_msg = f"Error sending function result: {e}"
            logger.error(f"[REALTIME-CLIENT] {error_msg}")
            return {
                "success": False,
                "error": error_msg
            }

    async def create_response_after_function(self) -> bool:
        """
        🆕 DEPRECATED in v3.0 - Now called automatically by send_function_result()
        
        This method is kept for backward compatibility but is no longer needed.
        The v3.0 send_function_result() automatically triggers response.create.
        """
        logger.warning(f"[REALTIME-CLIENT] create_response_after_function() called but is deprecated in v3.0")
        logger.warning(f"[REALTIME-CLIENT] Response.create now happens automatically in send_function_result()")
        return True

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """Process and send audio data to OpenAI API."""
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
            logger.error("[REALTIME-CLIENT] Connection closed while sending audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error processing audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        """Commit audio buffer."""
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{int(time.time() * 1000)}"
            }))
            return True
        except ConnectionClosed:
            logger.error("[REALTIME-CLIENT] Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """Clear audio buffer."""
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{int(time.time() * 1000)}"
            }))
            return True
        except ConnectionClosed:
            logger.error("[REALTIME-CLIENT] Connection closed while clearing buffer")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error clearing buffer: {e}")
            return False

    async def close(self) -> None:
        """Close WebSocket connection."""
        if self.ws:
            try:
                await self.ws.close()
                device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
                logger.info(f"[REALTIME-CLIENT] WebSocket closed ({device_info})")
            except Exception as e:
                logger.error(f"[REALTIME-CLIENT] Error closing WebSocket: {e}")
        self.is_connected = False
        
        self.is_assistant_speaking = False
        self.current_response_id = None
        self.current_audio_samples = 0
        self.interruption_occurred = False

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """Receive and yield messages from OpenAI WebSocket."""
        if not self.is_connected or not self.ws:
            return
            
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    yield data
                except json.JSONDecodeError:
                    logger.error(f"[REALTIME-CLIENT] Failed to decode: {message[:100]}...")
        except ConnectionClosed:
            device_info = "iOS" if self.is_ios else ("Android" if self.is_android else "Desktop")
            logger.info(f"[REALTIME-CLIENT] WebSocket closed ({device_info})")
            self.is_connected = False
        except Exception as e:
            logger.error(f"[REALTIME-CLIENT] Error receiving messages: {e}")
            self.is_connected = False
