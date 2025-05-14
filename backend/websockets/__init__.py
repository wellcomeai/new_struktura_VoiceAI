"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.
"""

from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient

__all__ = ["handle_websocket_connection", "OpenAIRealtimeClient"]
