"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.
"""

from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient
# ✅ ДОБАВИТЬ эти две строки:
from .voximplant_adapter import VoximplantAdapter, handle_voximplant_websocket

# ✅ ОБНОВИТЬ __all__ (заменить полностью):
__all__ = [
    "handle_websocket_connection", 
    "OpenAIRealtimeClient",
    "VoximplantAdapter",
    "handle_voximplant_websocket"
]
