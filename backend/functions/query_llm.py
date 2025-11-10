# backend/functions/query_llm.py
"""
Функция для отправки запросов к ChatGPT API через голосового агента.
Реализована как класс FunctionBase для корректной регистрации в системе.

🆕 v3.0: Переход на OpenAI Assistants API с Threads и WebSocket streaming
"""

import asyncio
from typing import Dict, Any

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function
from backend.services.openai_assistant import (
    create_thread,
    add_message_to_thread,
    stream_assistant_response,
    get_or_create_assistant
)

logger = get_logger(__name__)


@register_function
class QueryLLMFunction(FunctionBase):
    """Функция для отправки запросов к текстовой LLM модели через OpenAI Assistants API"""

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
                }
            },
            "required": ["prompt"]
        }

    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Streaming LLM через OpenAI Assistants API с Thread management.

        НОВАЯ ЛОГИКА (v3.0):
        - Используем OpenAI Assistants API вместо Chat Completions
        - Thread хранится на стороне OpenAI (не в localStorage)
        - thread_id передается через WebSocket и сохраняется в sessionStorage
        - Streaming идет напрямую через WebSocket (не через HTTP)
        - История контекста управляется OpenAI Threads

        Args:
            arguments: Function arguments with 'prompt'
            context: Execution context with websocket and thread_id

        Returns:
            Success status with thread_id
        """
        try:
            prompt = arguments.get("prompt")

            if not prompt:
                error_msg = "Prompt is required"
                logger.error(f"[QUERY_LLM] {error_msg}")
                return {"error": error_msg, "status": "error"}

            logger.info(f"[QUERY_LLM] 🚀 Processing LLM query: {prompt[:100]}...")

            # Получаем WebSocket из контекста
            websocket = context.get("websocket") if context else None

            if not websocket:
                logger.error("[QUERY_LLM] ❌ No WebSocket in context")
                return {
                    "error": "WebSocket not available",
                    "status": "error"
                }

            # Получаем thread_id из контекста (если есть)
            thread_id = context.get("thread_id") if context else None

            # 🆕 Получаем Assistant ID
            assistant_id = await get_or_create_assistant()

            # 🆕 Создаем Thread если нет
            if not thread_id:
                logger.info("[QUERY_LLM] 🆕 Creating new thread...")
                thread_id = await create_thread()

                # Отправляем thread_id на frontend для сохранения в sessionStorage
                await websocket.send_json({
                    "type": "thread_created",
                    "thread_id": thread_id
                })

                # Обновляем context для следующих вызовов
                if context:
                    context["thread_id"] = thread_id

                logger.info(f"[QUERY_LLM] ✅ New thread created: {thread_id}")
            else:
                logger.info(f"[QUERY_LLM] ♻️  Using existing thread: {thread_id}")

            # 🆕 Добавляем сообщение пользователя в Thread
            logger.info(f"[QUERY_LLM] 💬 Adding message to thread {thread_id}: {prompt[:50]}...")
            await add_message_to_thread(thread_id, prompt)

            # 🆕 Streaming ответа через WebSocket
            logger.info("[QUERY_LLM] 🌊 Starting streaming response...")
            full_response = ""
            chunk_count = 0

            async for chunk in stream_assistant_response(thread_id, assistant_id):
                full_response += chunk
                chunk_count += 1

                # Отправляем chunk через WebSocket
                await websocket.send_json({
                    "type": "llm_response_chunk",
                    "chunk": chunk
                })

            # 🆕 Завершение streaming
            await websocket.send_json({
                "type": "llm_response_complete",
                "thread_id": thread_id
            })

            logger.success(
                f"[QUERY_LLM] ✅ Streaming complete. "
                f"Chunks: {chunk_count}, Length: {len(full_response)} chars"
            )

            return {
                "status": "success",
                "thread_id": thread_id,
                "response_length": len(full_response),
                "chunks_sent": chunk_count,
                "result": f"Streaming response sent ({len(full_response)} chars)"
            }

        except Exception as e:
            error_msg = f"Error in LLM query: {str(e)}"
            logger.error(f"[QUERY_LLM] ❌ {error_msg}")

            # Отправляем ошибку на frontend
            if context and context.get("websocket"):
                try:
                    await context["websocket"].send_json({
                        "type": "llm_error",
                        "error": str(e)
                    })
                except Exception as ws_error:
                    logger.error(f"[QUERY_LLM] Failed to send error to WebSocket: {ws_error}")

            return {
                "error": error_msg,
                "status": "error"
            }
