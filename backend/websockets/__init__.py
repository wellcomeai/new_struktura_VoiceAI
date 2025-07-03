"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.
"""

from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient
from .voximplant_adapter import VoximplantAdapter, handle_voximplant_websocket
from .voximplant_handler import (
    VoximplantProtocolHandler, 
    SimpleVoximplantHandler,
    handle_voximplant_websocket_with_protocol,
    handle_voximplant_websocket_simple
)

__all__ = [
    "handle_websocket_connection", 
    "OpenAIRealtimeClient",
    "VoximplantAdapter",
    "handle_voximplant_websocket",
    "VoximplantProtocolHandler", 
    "SimpleVoximplantHandler",
    "handle_voximplant_websocket_with_protocol",
    "handle_voximplant_websocket_simple"
]
