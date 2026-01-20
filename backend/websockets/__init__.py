# backend/websockets/__init__.py
"""
WebSocket module for Voicyfy application.
Handles real-time communication with clients.

🆕 Now includes GA Realtime API support (gpt-realtime model)
🆕 Now includes Google Gemini Live API support (gemini-2.5-flash-native-audio)
🆕 Now includes Browser Agent support (gemini-2.0-flash + DOM control)
🆕 Now includes xAI Grok Voice Agent API support
🧪 Experimental: Streaming TTS with sentence detection + ElevenLabs
"""

# 📌 OpenAI - Старые обработчики (Beta API)
from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient

# 🆕 OpenAI - НОВЫЕ обработчики (GA API)
from .handler_realtime_new import handle_websocket_connection_new
from .openai_client_new import OpenAIRealtimeClientNew

# 🆕 Google Gemini - Live API обработчики
from .gemini_client import GeminiLiveClient
from .handler_gemini import handle_gemini_websocket_connection

# 🤖 Google Gemini + Browser Agent (v2.0)
from .browser_handler_gemini import handle_gemini_websocket_connection as handle_gemini_browser_websocket_connection

# 🆕 xAI Grok Voice Agent API
from .grok_client import GrokVoiceClient, map_voice_to_grok
from .handler_grok import handle_grok_websocket_connection

# 📞 Voximplant интеграция
from .voximplant_adapter import VoximplantAdapter, handle_voximplant_websocket
from .voximplant_handler import (
    VoximplantProtocolHandler, 
    SimpleVoximplantHandler,
    handle_voximplant_websocket_with_protocol,
    handle_voximplant_websocket_simple
)

__all__ = [
    # OpenAI Beta API (старая версия)
    "handle_websocket_connection", 
    "OpenAIRealtimeClient",
    
    # 🆕 OpenAI GA API (новая версия)
    "handle_websocket_connection_new",
    "OpenAIRealtimeClientNew",
    
    # 🆕 Google Gemini Live API (без Browser Agent)
    "GeminiLiveClient",
    "handle_gemini_websocket_connection",
    
    # 🤖 Google Gemini + Browser Agent (v2.0)
    "handle_gemini_browser_websocket_connection",
    
    # 🆕 xAI Grok Voice Agent API
    "GrokVoiceClient",
    "handle_grok_websocket_connection",
    "map_voice_to_grok",
    
    # 🧪 Streaming TTS (экспериментальная версия)
    "handle_websocket_connection_streaming",
    "handle_websocket_connection_streaming_openai_tts",
    "handle_websocket_connection_streaming_elevenlabs_tts",
    "OpenAIRealtimeClientStreaming",
    "StreamingSentenceDetector",
    
    # Voximplant
    "VoximplantAdapter",
    "handle_voximplant_websocket",
    "VoximplantProtocolHandler", 
    "SimpleVoximplantHandler",
    "handle_voximplant_websocket_with_protocol",
    "handle_voximplant_websocket_simple"
]
