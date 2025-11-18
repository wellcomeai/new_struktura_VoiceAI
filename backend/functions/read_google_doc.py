# backend/functions/read_google_doc.py
"""
Функция для чтения текста из Google Документа по ссылке.
"""
import re
import aiohttp
from typing import Dict, Any, Optional

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

def extract_document_id(url: str) -> Optional[str]:
    """
    Извлекает ID документа из URL Google Docs.
    
    Примеры URL:
    - https://docs.google.com/document/d/DOCUMENT_ID/edit
    - https://docs.google.com/document/d/DOCUMENT_ID/
    """
    patterns = [
        r'docs\.google\.com/document/d/([a-zA-Z0-9-_]+)',
        r'drive\.google\.com/file/d/([a-zA-Z0-9-_]+)',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    
    return None

@register_function
class ReadGoogleDocFunction(FunctionBase):
    """Функция для чтения текста из Google Документа"""
    
    @classmethod
    def get_name(cls) -> str:
        return "read_google_doc"
    
    @classmethod
    def get_description(cls) -> str:
        return "Читает текст из публичного Google Документа по ссылке"
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Ссылка на Google Документ (должен быть публичным или доступным по ссылке)"
                }
            },
            "required": ["url"]
        }
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Читает текст из Google Документа.
        
        Args:
            arguments: {"url": "https://docs.google.com/document/d/..."}
            context: Контекст выполнения
            
        Returns:
            Dict с текстом документа или ошибкой
        """
        try:
            url = arguments.get("url")
            
            if not url:
                return {"error": "URL is required"}
            
            # Извлекаем ID документа
            doc_id = extract_document_id(url)
            
            if not doc_id:
                return {"error": "Invalid Google Docs URL"}
            
            logger.info(f"[READ_GOOGLE_DOC] Извлечен document ID: {doc_id}")
            
            # Формируем URL для экспорта документа в текстовом формате
            export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
            
            logger.info(f"[READ_GOOGLE_DOC] Запрашиваем текст документа...")
            
            # Загружаем текст документа
            async with aiohttp.ClientSession() as session:
                async with session.get(export_url, timeout=30) as response:
                    if response.status == 200:
                        text = await response.text()
                        
                        # Убираем лишние пустые строки
                        lines = [line for line in text.split('\n') if line.strip()]
                        cleaned_text = '\n'.join(lines)
                        
                        logger.info(f"[READ_GOOGLE_DOC] Успешно получен текст: {len(cleaned_text)} символов")
                        
                        return {
                            "success": True,
                            "text": cleaned_text,
                            "length": len(cleaned_text),
                            "document_id": doc_id
                        }
                    
                    elif response.status == 403:
                        return {
                            "error": "Доступ запрещен. Документ должен быть публичным или доступным по ссылке"
                        }
                    
                    elif response.status == 404:
                        return {
                            "error": "Документ не найден. Проверьте корректность ссылки"
                        }
                    
                    else:
                        return {
                            "error": f"Ошибка при получении документа: HTTP {response.status}"
                        }
            
        except Exception as e:
            logger.error(f"[READ_GOOGLE_DOC] Ошибка: {str(e)}")
            return {
                "error": f"Failed to read document: {str(e)}"
            }
