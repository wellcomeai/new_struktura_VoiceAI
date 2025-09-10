"""
Функция для принудительного завершения диалога с ассистентом.
"""
import asyncio
from typing import Dict, Any

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

@register_function
class EndConversationFunction(FunctionBase):
    """Функция для принудительного завершения диалога"""
    
    @classmethod
    def get_name(cls) -> str:
        return "end_conversation"
        
    @classmethod
    def get_description(cls) -> str:
        return "Принудительно завершает текущий диалог и обрывает все соединения"
        
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
        ПРИНУДИТЕЛЬНО завершает диалог - обрывает все соединения.
        """
        context = context or {}
        client_id = context.get("client_id")
        websocket = context.get("websocket")
        openai_client = context.get("openai_client")  # ✅ НОВОЕ: получаем OpenAI клиент
        
        try:
            farewell_message = arguments.get("farewell_message", "До свидания! Хорошего дня!")
            reason = arguments.get("reason", "assistant_initiated")
            
            logger.info(f"[END_CONVERSATION] 🔪 ЖЕСТКОЕ завершение диалога для client_id={client_id}, причина: {reason}")
            
            # ✅ ШАГ 1: Отправляем прощальное сообщение (если возможно)
            if websocket:
                try:
                    await websocket.send_json({
                        "type": "conversation.ending",
                        "message": farewell_message,
                        "reason": reason,
                        "timestamp": asyncio.get_event_loop().time()
                    })
                    logger.info(f"[END_CONVERSATION] 📤 Отправлено прощальное сообщение: '{farewell_message}'")
                    
                    # Короткая пауза чтобы сообщение дошло
                    await asyncio.sleep(0.5)
                    
                except Exception as send_error:
                    logger.warning(f"[END_CONVERSATION] ⚠️ Ошибка отправки сообщения: {send_error}")
            
            # ✅ ШАГ 2: ЖЕСТКО закрываем OpenAI клиент (самое важное!)
            if openai_client:
                try:
                    logger.info(f"[END_CONVERSATION] 🔪 ОБРЫВАЕМ соединение с OpenAI...")
                    await openai_client.close()
                    logger.info(f"[END_CONVERSATION] ✅ OpenAI клиент закрыт")
                except Exception as openai_error:
                    logger.error(f"[END_CONVERSATION] ❌ Ошибка закрытия OpenAI клиента: {openai_error}")
            else:
                logger.warning(f"[END_CONVERSATION] ⚠️ OpenAI клиент не найден в контексте")
            
            # ✅ ШАГ 3: Закрываем WebSocket к пользователю
            if websocket:
                try:
                    logger.info(f"[END_CONVERSATION] 🔪 ЗАКРЫВАЕМ WebSocket...")
                    await websocket.close(code=1000, reason="Conversation ended by assistant")
                    logger.info(f"[END_CONVERSATION] ✅ WebSocket закрыт")
                except Exception as close_error:
                    logger.error(f"[END_CONVERSATION] ❌ Ошибка закрытия WebSocket: {close_error}")
            
            # ✅ ШАГ 4: Устанавливаем флаг завершения в контексте (для дополнительной защиты)
            if context:
                context["conversation_ended"] = True
                context["end_reason"] = reason
            
            logger.info(f"[END_CONVERSATION] 🎯 Диалог ЖЕСТКО завершен для client_id={client_id}")
            
            return {
                "success": True,
                "message": f"Диалог принудительно завершен. {farewell_message}",
                "status": "conversation_forcefully_ended",
                "client_id": client_id,
                "reason": reason,
                "openai_closed": openai_client is not None,
                "websocket_closed": websocket is not None
            }
                
        except Exception as e:
            logger.error(f"[END_CONVERSATION] ❌ Критическая ошибка завершения диалога: {e}")
            return {
                "error": f"Критическая ошибка завершения диалога: {str(e)}",
                "status": "error"
            }
