"""
WebSocket module for WellcomeAI application.
Handles real-time communication with clients including voice interruption.
"""

from .handler import handle_websocket_connection
from .openai_client import OpenAIRealtimeClient

__all__ = ["handle_websocket_connection", "OpenAIRealtimeClient"]

# Версия модуля с поддержкой прерывания
__version__ = "1.3.3"

# Константы для прерывания
INTERRUPTION_CONFIG = {
    "MIN_INTERRUPTION_GAP_MS": 500,
    "MAX_CANCEL_RETRIES": 3,
    "CANCEL_TIMEOUT_MS": 5000,
    "DEFAULT_SAMPLE_RATE": 24000,
    "TRUNCATE_DELAY_MS": 100,
    "OUTPUT_CLEAR_DELAY_MS": 50,
}

# Поддерживаемые команды прерывания
INTERRUPTION_COMMANDS = [
    "response.cancel",
    "output_audio_buffer.clear", 
    "conversation.item.truncate",
    "emergency_stop"
]

# Статусы прерывания
INTERRUPTION_STATUS = {
    "NONE": "none",
    "PENDING": "pending", 
    "IN_PROGRESS": "in_progress",
    "COMPLETED": "completed",
    "FAILED": "failed"
}
