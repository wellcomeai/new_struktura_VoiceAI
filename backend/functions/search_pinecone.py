"""
Функция для поиска в векторной базе данных Pinecone.
"""
import os
import json
import re
import requests
from typing import Dict, Any, Optional, List

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

def extract_namespace_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает namespace Pinecone из системного промпта ассистента.
    """
    if not prompt:
        return None
        
    # Ищем namespace с помощью регулярного выражения
    # Паттерн 1: "Pinecone namespace: my_namespace"
    pattern1 = r'Pinecone\s+namespace:\s*([a-zA-Z0-9_-]+)'
    # Паттерн 2: "namespace: my_namespace"
    pattern2 = r'namespace:\s*([a-zA-Z0-9_-]+)'
    
    # Проверяем шаблоны по убыванию специфичности
    for pattern in [pattern1, pattern2]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

@register_function
class PineconeSearchFunction(FunctionBase):
    """Функция для поиска в векторной базе данных Pinecone"""
    
    @classmethod
    def get_name(cls) -> str:
        return "search_pinecone"
        
    @classmethod
    def get_description(cls) -> str:
        return "Ищет похожие документы в Pinecone векторной базе данных"
        
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "namespace": {
                    "type": "string",
                    "description": "Namespace в Pinecone для поиска документов"
                },
                "query": {
                    "type": "string",
                    "description": "Поисковый запрос для векторного поиска"
                },
                "top_k": {
                    "type": "integer",
                    "description": "Количество результатов для возврата",
                    "default": 3
                }
            },
            "required": ["namespace", "query"]
        }
        
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Выполняет векторный поиск в Pinecone.
        """
        context = context or {}
        assistant_config = context.get("assistant_config")
        
        try:
            namespace = arguments.get("namespace")
            query = arguments.get("query")
            top_k = arguments.get("top_k", 3)
            
            # Проверка обязательных параметров
            if not query:
                return {"error": "Query is required"}
            
            # Если нет namespace, попробуем извлечь из промпта
            if not namespace and assistant_config:
                if hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
                    namespace = extract_namespace_from_prompt(assistant_config.system_prompt)
                    logger.info(f"Извлечен namespace из промпта: {namespace}")
            
            # Проверка на наличие namespace
            if not namespace:
                return {"error": "Namespace is required"}
            
            # Получение ключа Pinecone из переменных окружения
            pinecone_api_key = os.environ.get("PINECONE_API_KEY")
            if not pinecone_api_key:
                logger.error("PINECONE_API_KEY not found in environment variables")
                return {"error": "Pinecone API key not configured"}
            
            # Создаем эмбеддинг через OpenAI API
            openai_api_key = None
            if assistant_config and hasattr(assistant_config, "user_id"):
                # Импортируем здесь, чтобы избежать циклических импортов
                from backend.models.user import User
                
                # Получаем сессию базы данных
                db_session = None
                if hasattr(assistant_config, 'db_session'):
                    db_session = assistant_config.db_session
                else:
                    # Создаем новую сессию если нет в объекте
                    from backend.db.session import get_db
                    db_session = next(get_db())
                    
                # Получаем пользователя и его API ключ
                user = db_session.query(User).get(assistant_config.user_id)
                if user and user.openai_api_key:
                    openai_api_key = user.openai_api_key
            
            if not openai_api_key:
                # Попытка использовать ключ из переменных окружения
                openai_api_key = os.environ.get("OPENAI_API_KEY")
                if not openai_api_key:
                    return {"error": "OpenAI API key not available"}
            
            # Создаем эмбеддинг через OpenAI API
            embed_response = requests.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {openai_api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "input": query,
                    "model": "text-embedding-ada-002"
                }
            )
            
            if embed_response.status_code != 200:
                logger.error(f"Error creating embedding: {embed_response.text}")
                return {"error": f"Failed to create embedding: {embed_response.status_code}"}
            
            # Извлекаем эмбеддинг из ответа
            embedding = embed_response.json().get("data", [{}])[0].get("embedding", [])
            
            if not embedding:
                return {"error": "Failed to generate embedding for query"}
            
            # Создаем запрос к Pinecone
            pinecone_url = "https://voicufi-gpr1sqd.svc.aped-4627-b74a.pinecone.io/query"
            
            pinecone_request = {
                "vector": embedding,
                "namespace": namespace,
                "topK": top_k,
                "includeMetadata": True
            }
            
            # Отправляем запрос к Pinecone
            pinecone_response = requests.post(
                pinecone_url,
                headers={
                    "Api-Key": pinecone_api_key,
                    "Content-Type": "application/json"
                },
                json=pinecone_request
            )
            
            if pinecone_response.status_code != 200:
                logger.error(f"Error from Pinecone: {pinecone_response.text}")
                return {"error": f"Pinecone query failed: {pinecone_response.status_code}"}
            
            # Обрабатываем результаты
            results = pinecone_response.json()
            
            # Форматируем результаты в более читаемый вид
            formatted_results = []
            for match in results.get("matches", []):
                formatted_match = {
                    "id": match.get("id"),
                    "score": match.get("score"),
                    "metadata": match.get("metadata", {})
                }
                formatted_results.append(formatted_match)
            
            return {
                "success": True,
                "query": query,
                "namespace": namespace,
                "results": formatted_results,
                "total": len(formatted_results)
            }
            
        except Exception as e:
            logger.error(f"Error in search_pinecone: {str(e)}")
            return {"error": f"Search failed: {str(e)}"}
