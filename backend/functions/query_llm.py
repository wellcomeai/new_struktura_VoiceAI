# backend/functions/query_llm.py
"""
Функция для отправки запросов к ChatGPT API через голосового агента.
Реализована как класс FunctionBase для корректной регистрации в системе.
"""

import openai
import asyncio
import time  # 🆕 НОВОЕ
from typing import Dict, Any

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)


@register_function
class QueryLLMFunction(FunctionBase):
    """Функция для отправки запросов к текстовой LLM модели"""
    
    @classmethod
    def get_name(cls) -> str:
        return "query_llm"
    
    @classmethod
    def get_description(cls) -> str:
        return "Отправляет сложные запросы к текстовой LLM модели для получения развернутых ответов"
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Текст запроса или задачи для LLM модели"
                },
                "model": {
                    "type": "string", 
                    "description": "Модель для использования (gpt-4, gpt-3.5-turbo)",
                    "default": "gpt-4o-mini"
                }
            },
            "required": ["prompt"]
        }
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Prepare LLM query for client-side HTTP streaming.

        НОВАЯ ЛОГИКА:
        - Не вызываем OpenAI напрямую (экономим время)
        - Отправляем trigger событие клиенту через WebSocket
        - Клиент делает HTTP запрос к /api/llm/stream с историей из localStorage
        - История управляется клиентом, сервер её НЕ хранит

        Args:
            arguments: Function arguments with 'prompt'
            context: Execution context with websocket and session_id

        Returns:
            Success status (actual LLM response goes via HTTP streaming)
        """
        try:
            prompt = arguments.get("prompt")

            if not prompt:
                error_msg = "Prompt is required"
                logger.error(f"[QUERY_LLM] {error_msg}")
                return {"error": error_msg, "status": "error"}

            logger.info(f"[QUERY_LLM] 🚀 Preparing LLM query: {prompt[:100]}...")

            # Получаем session_id из контекста
            session_id = context.get("session_id") if context else None

            if not session_id:
                logger.warning("[QUERY_LLM] ⚠️ No session_id in context")
            else:
                logger.info(f"[QUERY_LLM] Session ID: {session_id}")

            # Получаем WebSocket из контекста
            websocket = context.get("websocket") if context else None

            if websocket:
                # 🆕 Отправляем trigger событие клиенту
                await websocket.send_json({
                    "type": "llm_query.trigger",
                    "query": prompt,
                    "session_id": session_id,
                    "timestamp": time.time()
                })

                logger.info(f"[QUERY_LLM] ✅ Trigger event sent to client")
                logger.info(f"[QUERY_LLM] 📱 Client will handle HTTP streaming with localStorage history")
            else:
                logger.error("[QUERY_LLM] ❌ No WebSocket in context")
                return {
                    "error": "WebSocket not available",
                    "status": "error"
                }

            # Возвращаем успех
            # Реальный ответ LLM придет через отдельный HTTP streaming endpoint
            return {
                "status": "triggered",
                "result": "LLM query triggered. Client will stream response via HTTP.",
                "session_id": session_id,
                "query": prompt[:50] + "..." if len(prompt) > 50 else prompt
            }

        except Exception as e:
            error_msg = f"Error preparing LLM query: {str(e)}"
            logger.error(f"[QUERY_LLM] ❌ {error_msg}")
            return {
                "error": error_msg,
                "status": "error"
            }
