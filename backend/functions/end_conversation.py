"""
Функция для завершения диалога с ассистентом.
"""
import asyncio
from typing import Dict, Any

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

@register_function
class EndConversationFunction(FunctionBase):
    """Функция для завершения текущего диалога"""
    
    @classmethod
    def get_name(cls) -> str:
        return "end_conversation"
        
    @classmethod
    def get_description(cls) -> str:
        return "Завершает текущий диалог с пользователем и закрывает соединение"
        
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "farewell_message": {
                    "type": "string",
                    "description": "Прощальное сообщение перед завершением диалога",
                    "default": "До свидания! Хорошего дня!"
                },
                "reason": {
                    "type": "string",
                    "description": "Причина завершения диалога (для логирования)",
                    "default": "assistant_initiated"
                }
            },
            "required": []
        }
        
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Завершает диалог с пользователем.
        """
        context = context or {}
        client_id = context.get("client_id")
        websocket = context.get("websocket")
        assistant_config = context.get("assistant_config")
        
        try:
            farewell_message = arguments.get("farewell_message", "До свидания! Хорошего дня!")
            reason = arguments.get("reason", "assistant_initiated")
            
            logger.info(f"[END_CONVERSATION] Завершение диалога для client_id={client_id}, причина: {reason}")
            
            if not websocket:
                logger.error(f"[END_CONVERSATION] WebSocket не найден в контексте для client_id={client_id}")
                return {
                    "error": "WebSocket соединение не найдено",
                    "status": "error"
                }
            
            # Отправляем прощальное сообщение
            try:
                await websocket.send_json({
                    "type": "conversation.ending",
                    "message": farewell_message,
                    "reason": reason,
                    "timestamp": asyncio.get_event_loop().time()
                })
                
                logger.info(f"[END_CONVERSATION] Отправлено прощальное сообщение: '{farewell_message}'")
                
                # Небольшая пауза, чтобы сообщение успело дойти до клиента
                await asyncio.sleep(1)
                
            except Exception as send_error:
                logger.warning(f"[END_CONVERSATION] Ошибка отправки прощального сообщения: {send_error}")
            
            # Закрываем WebSocket соединение
            try:
                await websocket.close(code=1000, reason="Conversation ended by assistant")
                logger.info(f"[END_CONVERSATION] WebSocket соединение закрыто для client_id={client_id}")
                
                return {
                    "success": True,
                    "message": f"Диалог завершен. {farewell_message}",
                    "status": "conversation_ended",
                    "client_id": client_id,
                    "reason": reason
                }
                
            except Exception as close_error:
                logger.error(f"[END_CONVERSATION] Ошибка закрытия WebSocket: {close_error}")
                return {
                    "error": f"Ошибка закрытия соединения: {str(close_error)}",
                    "status": "error",
                    "partial_success": True  # Сообщение отправлено, но закрытие не удалось
                }
                
        except Exception as e:
            logger.error(f"[END_CONVERSATION] Общая ошибка завершения диалога: {e}")
            return {
                "error": f"Ошибка завершения диалога: {str(e)}",
                "status": "error"
            }
