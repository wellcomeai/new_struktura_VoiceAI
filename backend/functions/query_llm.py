# backend/functions/query_llm.py
"""
Функция для отправки запросов к ChatGPT API через голосового агента.
Реализована как класс FunctionBase для корректной регистрации в системе.
"""

import openai
import asyncio
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
        Отправляет запрос к ChatGPT API и возвращает результат
        
        Args:
            arguments: Словарь с параметрами функции (prompt, model)
            context: Контекст с websocket и другими данными
        
        Returns:
            Dict с результатом выполнения
        """
        try:
            prompt = arguments.get("prompt")
            model = arguments.get("model", "gpt-4o-mini")
            
            if not prompt:
                error_msg = "Prompt is required"
                logger.error(f"[QUERY_LLM] {error_msg}")
                return {"error": error_msg, "status": "error"}
            
            logger.info(f"[QUERY_LLM] Executing query: {prompt[:100]}...")
            
            # Получаем API ключ из контекста или настроек
            api_key = None
            
            if context and "assistant_config" in context:
                assistant_config = context["assistant_config"]
                
                # Пытаемся получить API ключ пользователя
                if hasattr(assistant_config, "user_id") and assistant_config.user_id:
                    from backend.models.user import User
                    db_session = context.get("db_session")
                    
                    if db_session:
                        try:
                            user = db_session.query(User).get(assistant_config.user_id)
                            if user and user.openai_api_key:
                                api_key = user.openai_api_key
                                logger.info(f"[QUERY_LLM] Using user's OpenAI API key")
                            else:
                                api_key = settings.OPENAI_API_KEY
                                logger.info(f"[QUERY_LLM] Using system OpenAI API key")
                        except Exception as e:
                            logger.error(f"[QUERY_LLM] Error getting user API key: {e}")
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
            
            logger.info(f"[QUERY_LLM] Sending request to {model}...")
            
            # Отправляем запрос
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=2000,
                temperature=0.7
            )
            
            llm_result = response.choices[0].message.content
            
            logger.info(f"[QUERY_LLM] LLM response received: {len(llm_result)} characters")
            logger.info(f"[QUERY_LLM] Preparing result for handler (no direct WebSocket send)")
            
            # Возвращаем результат для обработки в handler_realtime_new.py
            # WebSocket отправку делает handler, а не функция (избегаем дублирования)
            return {
                "result": f"Запрос выполнен! Развернутый ответ выведен на экран слева. Обработано {len(llm_result)} символов.",
                "status": "success",
                "model_used": model,
                "response_length": len(llm_result),
                "full_response": llm_result  # handler_realtime_new.py будет отправлять это на фронтенд
            }
            
        except Exception as e:
            error_msg = f"Error executing LLM query: {str(e)}"
            logger.error(f"[QUERY_LLM] {error_msg}")
            return {
                "error": error_msg,
                "status": "error"
            }
