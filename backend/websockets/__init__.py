"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.

🆕 Now includes GA Realtime API support (gpt-realtime model)
"""

# 📌 Старые обработчики (Beta API)
from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient

# 🆕 НОВЫЕ обработчики (GA API)
from .handler_realtime_new import handle_websocket_connection_new
from .openai_client_new import OpenAIRealtimeClientNew

# 📞 Voximplant интеграция
from .voximplant_adapter import VoximplantAdapter, handle_voximplant_websocket
from .voximplant_handler import (
    VoximplantProtocolHandler, 
    SimpleVoximplantHandler,
    handle_voximplant_websocket_with_protocol,
    handle_voximplant_websocket_simple
)

__all__ = [
    # Beta API (старая версия)
    "handle_websocket_connection", 
    "OpenAIRealtimeClient",
    
    # 🆕 GA API (новая версия для тестирования)
    "handle_websocket_connection_new",
    "OpenAIRealtimeClientNew",
    
    # Voximplant
    "VoximplantAdapter",
    "handle_voximplant_websocket",
    "VoximplantProtocolHandler", 
    "SimpleVoximplantHandler",
    "handle_voximplant_websocket_with_protocol",
    "handle_voximplant_websocket_simple"
]
