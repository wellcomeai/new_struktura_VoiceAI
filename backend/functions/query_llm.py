# backend/functions/query_llm.py
"""
Функция для отправки запросов к ChatGPT API через голосового агента
"""

import openai
import json
import asyncio
from typing import Dict, Any
from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

async def query_llm(prompt: str, model: str = "gpt-4", context: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Отправляет запрос к ChatGPT API и возвращает результат
    
    Args:
        prompt: Текст запроса для LLM
        model: Модель для использования (по умолчанию gpt-4)
        context: Контекст с websocket и другими данными
    
    Returns:
        Dict с результатом выполнения
    """
    try:
        logger.info(f"[QUERY_LLM] Executing query: {prompt[:100]}...")
        
        # Получаем API ключ из контекста или настроек
        if context and "assistant_config" in context:
            assistant_config = context["assistant_config"]
            if hasattr(assistant_config, "user_id") and assistant_config.user_id:
                from backend.models.user import User
                db_session = context.get("db_session")
                if db_session:
                    user = db_session.query(User).get(assistant_config.user_id)
                    if user and user.openai_api_key:
                        api_key = user.openai_api_key
                    else:
                        api_key = settings.OPENAI_API_KEY
                else:
                    api_key = settings.OPENAI_API_KEY
            else:
                api_key = settings.OPENAI_API_KEY
        else:
            api_key = settings.OPENAI_API_KEY
        
        if not api_key:
            error_msg = "OpenAI API key not found"
            logger.error(f"[QUERY_LLM] {error_msg}")
            return {"error": error_msg, "status": "error"}
        
        # Создаем клиент OpenAI
        client = openai.AsyncOpenAI(api_key=api_key)
        
        # Формируем запрос к ChatGPT
        messages = [
            {
                "role": "system", 
                "content": "Ты профессиональный ассистент. Отвечай подробно и структурированно. Используй markdown для форматирования."
            },
            {
                "role": "user", 
                "content": prompt
            }
        ]
        
        # Отправляем запрос
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=2000,
            temperature=0.7
        )
        
        llm_result = response.choices[0].message.content
        
        logger.info(f"[QUERY_LLM] LLM response received: {len(llm_result)} characters")
        
        # Отправляем результат на фронтенд через WebSocket
        websocket = context.get("websocket") if context else None
        if websocket:
            try:
                await websocket.send_json({
                    "type": "llm_result",
                    "content": llm_result,
                    "prompt": prompt,
                    "model": model,
                    "timestamp": asyncio.get_event_loop().time()
                })
                logger.info(f"[QUERY_LLM] Result sent to frontend via WebSocket")
            except Exception as ws_error:
                logger.error(f"[QUERY_LLM] WebSocket send error: {ws_error}")
        
        # Возвращаем краткий ответ для голосового агента
        return {
            "result": f"Запрос выполнен! Развернутый ответ выведен на экран слева. Обработано {len(llm_result)} символов.",
            "status": "success",
            "model_used": model,
            "response_length": len(llm_result)
        }
        
    except Exception as e:
        error_msg = f"Error executing LLM query: {str(e)}"
        logger.error(f"[QUERY_LLM] {error_msg}")
        return {
            "error": error_msg,
            "status": "error"
        }


# Метаданные функции для системы
FUNCTION_METADATA = {
    "name": "query_llm",
    "description": "Отправляет сложные запросы к текстовой LLM модели для получения развернутых ответов",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Текст запроса или задачи для LLM модели"
            },
            "model": {
                "type": "string", 
                "description": "Модель для использования (gpt-4, gpt-3.5-turbo)",
                "default": "gpt-4"
            }
        },
        "required": ["prompt"]
    }
}
