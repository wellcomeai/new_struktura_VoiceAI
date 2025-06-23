"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.
"""

from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient
from .voximplant_adapter import VoximplantAdapter, handle_voximplant_websocket

# ✅ ИСПРАВЛЕНО: Импортируем новые классы из обновленного обработчика
try:
    from .voximplant_handler import VoximplantProtocolHandler, handle_voximplant_websocket_with_protocol
except ImportError:
    # Fallback на старые имена если новый файл еще не обновлен
    VoximplantProtocolHandler = None
    handle_voximplant_websocket_with_protocol = None

__all__ = [
    "handle_websocket_connection", 
    "OpenAIRealtimeClient",
    "VoximplantAdapter",
    "handle_voximplant_websocket",
    "VoximplantProtocolHandler", 
    "handle_voximplant_websocket_with_protocol"
]
