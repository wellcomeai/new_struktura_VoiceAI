"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients.
"""

from .handler import handle_websocket_connection

__all__ = ["handle_websocket_connection"]
