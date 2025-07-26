"""
ИСПРАВЛЕННЫЙ ElevenLabs Service с правильной обработкой Knowledge Base API
Все методы проверены на соответствие официальной документации ElevenLabs
"""

import httpx
import json
import logging
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from fastapi import UploadFile, HTTPException
import asyncio
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class ElevenLabsService:
    """Исправленный сервис для работы с ElevenLabs API"""
    
    BASE_URL = "https://api.elevenlabs.io/v1"
    TIMEOUT = 60.0
    
    # Кеш для документов базы знаний
    _kb_documents_cache = {}
    _cache_ttl = timedelta(minutes=5)
    
    @classmethod
    async def validate_api_key(cls, api_key: str) -> bool:
        """Проверка валидности API ключа"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(
                    f"{cls.BASE_URL}/user",
                    headers=headers
                )
                
                if response.status_code == 200:
                    user_data = response.json()
                    logger.info(f"API key validation successful for user: {user_data.get('email', 'unknown')}")
                    return True
                elif response.status_code == 401:
                    logger.warning("API key validation failed: Unauthorized")
                    return False
                else:
                    logger.error(f"API key validation failed: {response.status_code} - {response.text}")
                    return False
                    
        except httpx.TimeoutException:
            logger.error("Timeout while validating API key")
            return False
        except Exception as e:
            logger.error(f"Error validating API key: {str(e)}")
            return False
    
    @classmethod
    async def get_available_voices(cls, api_key: str) -> List[Dict[str, Any]]:
        """Получение доступных голосов"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(
                    f"{cls.BASE_URL}/voices",
                    headers=headers
                )
                
                if response.status_code == 200:
                    data = response.json()
                    voices = data.get('voices', [])
                    
                    processed_voices = []
                    for voice in voices:
                        processed_voice = {
                            "voice_id": voice.get("voice_id"),
                            "name": voice.get("name"),
                            "category": voice.get("category", "premade"),
                            "preview_url": voice.get("preview_url")
                        }
                        processed_voices.append(processed_voice)
                    
                    logger.info(f"Retrieved {len(processed_voices)} voices from ElevenLabs")
                    return processed_voices
                elif response.status_code == 401:
                    logger.error("Failed to get voices: Invalid API key")
                    return []
                else:
                    logger.error(f"Failed to get voices: {response.status_code} - {response.text}")
                    return []
                    
        except httpx.TimeoutException:
            logger.error("Timeout while getting voices")
            return []
        except Exception as e:
            logger.error(f"Error getting voices: {str(e)}")
            return []
    
    # ============= KNOWLEDGE BASE METHODS =============
    
    @classmethod
    async def create_knowledge_base_from_text(cls, api_key: str, name: str, text: str) -> str:
        """Создание документа Knowledge Base из текста"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            data = {
                "text": text,
                "name": name
            }
            
            logger.info(f"Creating knowledge base document from text: {name}")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/knowledge-base/text",
                    headers=headers,
                    json=data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    document_id = result.get("id")
                    logger.info(f"✅ Knowledge base document created from text: {document_id}")
                    
                    # Запускаем индексацию асинхронно
                    asyncio.create_task(cls.index_knowledge_base_document(api_key, document_id))
                    
                    # Очищаем кеш
                    cls._clear_cache_for_user(api_key)
                    
                    return document_id
                else:
                    error_text = response.text
                    logger.error(f"Failed to create knowledge base from text: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while creating knowledge base from text")
            raise Exception("Request timed out while creating knowledge base document")
        except Exception as e:
            logger.error(f"Error creating knowledge base from text: {str(e)}")
            raise Exception(f"Failed to create knowledge base document: {str(e)}")
    
    @classmethod
    async def create_knowledge_base_from_url(cls, api_key: str, name: str, url: str) -> str:
        """Создание документа Knowledge Base из URL"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            data = {
                "url": url,
                "name": name
            }
            
            logger.info(f"Creating knowledge base document from URL: {name} - {url}")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/knowledge-base/url",
                    headers=headers,
                    json=data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    document_id = result.get("id")
                    logger.info(f"✅ Knowledge base document created from URL: {document_id}")
                    
                    # Запускаем индексацию асинхронно
                    asyncio.create_task(cls.index_knowledge_base_document(api_key, document_id))
                    
                    # Очищаем кеш
                    cls._clear_cache_for_user(api_key)
                    
                    return document_id
                else:
                    error_text = response.text
                    logger.error(f"Failed to create knowledge base from URL: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while creating knowledge base from URL")
            raise Exception("Request timed out while creating knowledge base document")
        except Exception as e:
            logger.error(f"Error creating knowledge base from URL: {str(e)}")
            raise Exception(f"Failed to create knowledge base document: {str(e)}")
    
    @classmethod
    async def create_knowledge_base_from_file(cls, api_key: str, name: str, file: UploadFile) -> str:
        """Создание документа Knowledge Base из файла"""
        try:
            headers = {
                "xi-api-key": api_key
            }
            
            # Читаем содержимое файла
            file_content = await file.read()
            await file.seek(0)
            
            logger.info(f"Creating knowledge base document from file: {name} - {file.filename}")
            
            files = {
                "file": (file.filename, file_content, file.content_type)
            }
            
            data = {
                "name": name
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/knowledge-base/file",
                    headers=headers,
                    files=files,
                    data=data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    document_id = result.get("id")
                    logger.info(f"✅ Knowledge base document created from file: {document_id}")
                    
                    # Запускаем индексацию асинхронно
                    asyncio.create_task(cls.index_knowledge_base_document(api_key, document_id))
                    
                    # Очищаем кеш
                    cls._clear_cache_for_user(api_key)
                    
                    return document_id
                else:
                    error_text = response.text
                    logger.error(f"Failed to create knowledge base from file: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while creating knowledge base from file")
            raise Exception("Request timed out while creating knowledge base document")
        except Exception as e:
            logger.error(f"Error creating knowledge base from file: {str(e)}")
            raise Exception(f"Failed to create knowledge base document: {str(e)}")
    
    @classmethod
    async def index_knowledge_base_document(cls, api_key: str, document_id: str, model: str = "multilingual_e5_large_instruct") -> Dict[str, Any]:
        """Индексация документа для RAG"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            data = {
                "model": model
            }
            
            logger.info(f"Indexing knowledge base document: {document_id} with model {model}")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/knowledge-base/{document_id}/rag-index",
                    headers=headers,
                    json=data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    status = result.get("status", "unknown")
                    progress = result.get("progress_percentage", 0)
                    
                    logger.info(f"✅ Knowledge base document indexing started: {document_id}, status: {status}, progress: {progress}%")
                    
                    return result
                else:
                    error_text = response.text
                    logger.error(f"Failed to index knowledge base document: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs indexing API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while indexing knowledge base document")
            raise Exception("Request timed out while indexing knowledge base document")
        except Exception as e:
            logger.error(f"Error indexing knowledge base document: {str(e)}")
            return {"status": "error", "progress_percentage": 0}
    
    @classmethod
    async def list_knowledge_base_documents(cls, api_key: str) -> List[Dict[str, Any]]:
        """✅ ИСПРАВЛЕНО: Получение списка всех документов Knowledge Base с правильной структурой"""
        try:
            # Проверяем кеш
            cache_key = f"{api_key}_kb_docs"
            cached_data = cls._get_from_cache(cache_key)
            
            if cached_data is not None:
                logger.info(f"Retrieved {len(cached_data)} knowledge base documents from cache")
                return cached_data
            
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            all_documents = []
            cursor = None
            
            while True:
                params = {
                    "page_size": 100
                }
                if cursor:
                    params["cursor"] = cursor
                    
                async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                    response = await client.get(
                        f"{cls.BASE_URL}/convai/knowledge-base",
                        headers=headers,
                        params=params
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        
                        # ✅ ИСПРАВЛЕНО: Правильная обработка структуры ответа согласно документации
                        documents = result.get("documents", [])
                        
                        # Обрабатываем каждый документ
                        for doc in documents:
                            # Приводим к единому формату
                            processed_doc = {
                                "id": doc.get("id"),
                                "name": doc.get("name"),
                                "type": doc.get("type", "unknown"),
                                "metadata": doc.get("metadata", {}),
                                "supported_usages": doc.get("supported_usages", []),
                                "access_info": doc.get("access_info", {}),
                                "url": doc.get("url"),
                                # Для совместимости добавляем поля из metadata
                                "character_count": doc.get("metadata", {}).get("character_count", 0),
                                "size_in_bytes": doc.get("metadata", {}).get("size_bytes", 0),
                                "created_at_unix_secs": doc.get("metadata", {}).get("created_at_unix_secs"),
                                "last_updated_at_unix_secs": doc.get("metadata", {}).get("last_updated_at_unix_secs")
                            }
                            all_documents.append(processed_doc)
                        
                        logger.info(f"📄 Загружено {len(documents)} документов")
                        
                        # Проверяем есть ли еще страницы
                        if not result.get("has_more", False):
                            break
                            
                        cursor = result.get("next_cursor")
                        if not cursor:
                            break
                            
                    else:
                        logger.error(f"❌ Ошибка получения списка документов: {response.status_code} - {response.text}")
                        break
            
            # Сохраняем в кеш
            cls._save_to_cache(cache_key, all_documents)
            
            logger.info(f"✅ Итого получено {len(all_documents)} документов Knowledge Base")
            return all_documents
            
        except httpx.TimeoutException:
            logger.error("⏱️ Timeout при получении списка документов Knowledge Base")
            return []
        except Exception as e:
            logger.error(f"❌ Ошибка получения списка документов Knowledge Base: {str(e)}")
            return []
    
    @classmethod
    async def delete_knowledge_base_document(cls, api_key: str, document_id: str):
        """Удаление документа Knowledge Base"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.delete(
                    f"{cls.BASE_URL}/convai/knowledge-base/{document_id}",
                    headers=headers
                )
                
                if response.status_code == 200:
                    logger.info(f"✅ Knowledge base document deleted: {document_id}")
                    
                    # Очищаем кеш
                    cls._clear_cache_for_user(api_key)
                    
                    return response.json()
                else:
                    error_text = response.text
                    logger.error(f"Failed to delete knowledge base document: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while deleting knowledge base document")
            raise Exception("Request timed out while deleting knowledge base document")
        except Exception as e:
            logger.error(f"Error deleting knowledge base document: {str(e)}")
            raise Exception(f"Failed to delete knowledge base document: {str(e)}")
    
    @classmethod
    async def get_knowledge_base_document(cls, api_key: str, document_id: str) -> Dict[str, Any]:
        """✅ ИСПРАВЛЕНО: Получение детальной информации о документе Knowledge Base"""
        try:
            logger.info(f"📥 Получение деталей документа KB: {document_id}")
            
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(
                    f"{cls.BASE_URL}/convai/knowledge-base/{document_id}",
                    headers=headers
                )
                
                if response.status_code == 404:
                    logger.warning(f"⚠️ Документ не найден: {document_id}")
                    return None
                    
                if response.status_code != 200:
                    logger.error(f"❌ Ошибка получения документа: {response.status_code} - {response.text}")
                    raise Exception(f"ElevenLabs API error: {response.text}")
                
                data = response.json()
                logger.info(f"✅ Детали документа получены: {data.get('name', 'Unknown')}")
                
                # ✅ ИСПРАВЛЕНО: Правильная обработка структуры согласно документации
                return {
                    "id": data.get("id", document_id),
                    "document_id": data.get("id", document_id),
                    "name": data.get("name", f"Document {document_id}"),
                    "type": data.get("type", "unknown"),
                    "url": data.get("url"),
                    "filename": data.get("filename"),
                    "text": data.get("text"),
                    "content": data.get("text", ""),  # Для обратной совместимости
                    "metadata": data.get("metadata", {}),
                    "character_count": data.get("metadata", {}).get("character_count", 0),
                    "size_in_bytes": data.get("metadata", {}).get("size_bytes", 0),
                    "created_at_unix_secs": data.get("metadata", {}).get("created_at_unix_secs"),
                    "last_updated_at_unix_secs": data.get("metadata", {}).get("last_updated_at_unix_secs"),
                    "supported_usages": data.get("supported_usages", []),
                    "access_info": data.get("access_info", {}),
                    "rag_index": data.get("rag_index", {"status": "unknown"})
                }
                
        except httpx.HTTPStatusError as e:
            logger.error(f"❌ HTTP ошибка получения документа: {e.response.status_code}")
            if e.response.status_code == 404:
                return None
            raise Exception(f"ElevenLabs API error: {e.response.text}")
        except Exception as e:
            logger.error(f"❌ Ошибка получения документа: {str(e)}")
            raise Exception(f"Failed to get document details: {str(e)}")
    
    # ============= AGENTS METHODS =============
    
    @classmethod
    async def get_agents(cls, db: Session, user_id: str, api_key: str) -> List[Dict[str, Any]]:
        """Получение списка агентов пользователя"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(
                    f"{cls.BASE_URL}/convai/agents",
                    headers=headers,
                    params={
                        "limit": 100
                    }
                )
                
                if response.status_code == 200:
                    data = response.json()
                    agents = data.get('agents', [])
                    
                    logger.info(f"Retrieved {len(agents)} agents from ElevenLabs for user {user_id}")
                    return agents
                elif response.status_code == 401:
                    logger.error("Failed to get agents: Invalid API key")
                    return []
                else:
                    logger.error(f"Failed to get agents: {response.status_code} - {response.text}")
                    return []
                    
        except httpx.TimeoutException:
            logger.error("Timeout while getting agents")
            return []
        except Exception as e:
            logger.error(f"Error getting agents: {str(e)}")
            return []
    
    @classmethod
    async def get_agent_with_details(cls, api_key: str, agent_id: str) -> Dict[str, Any]:
        """✅ ИСПРАВЛЕНО: Получение агента с полной загрузкой деталей документов"""
        try:
            # Получаем базовые данные агента
            agent = await cls.get_agent_by_id(api_key, agent_id)
            
            logger.info(f"📊 Сырые данные агента от ElevenLabs: knowledge_base={agent.get('knowledge_base', 'НЕТ')}")
            
            # Получаем ID документов из knowledge_base
            knowledge_base_ids = []
            
            if "knowledge_base" in agent:
                kb_field = agent["knowledge_base"]
                if isinstance(kb_field, list):
                    knowledge_base_ids = kb_field
                    logger.info(f"✅ knowledge_base как массив: {len(knowledge_base_ids)} документов")
                elif isinstance(kb_field, dict) and "documents" in kb_field:
                    knowledge_base_ids = kb_field["documents"]
                    logger.info(f"✅ knowledge_base как объект с documents: {len(knowledge_base_ids)} документов")
                else:
                    logger.warning(f"⚠️ Неожиданный формат knowledge_base: {type(kb_field)}")
            
            # Также проверяем альтернативные поля
            if not knowledge_base_ids and "knowledge_base_documents" in agent:
                knowledge_base_ids = agent["knowledge_base_documents"]
                logger.info(f"✅ Найдены документы в knowledge_base_documents: {len(knowledge_base_ids)}")
            
            detailed_knowledge_base = {
                "files": [],
                "urls": [],
                "texts": [],
                "totalSize": 0,
                "totalChars": 0
            }
            
            if knowledge_base_ids:
                logger.info(f"📚 Загрузка деталей для {len(knowledge_base_ids)} документов Knowledge Base")
                
                try:
                    # Получаем ВСЕ документы пользователя одним запросом
                    all_documents = await cls.list_knowledge_base_documents(api_key)
                    logger.info(f"📊 Получено {len(all_documents)} документов из API")
                    
                    # Создаем мапу для быстрого поиска
                    documents_map = {doc["id"]: doc for doc in all_documents}
                    
                    # Обрабатываем только нужные документы
                    for doc_id in knowledge_base_ids:
                        doc_data = documents_map.get(doc_id)
                        
                        if not doc_data:
                            # Если документ не найден в общем списке, пробуем загрузить отдельно
                            logger.warning(f"⚠️ Документ {doc_id} не найден в списке, пробуем загрузить отдельно")
                            try:
                                doc_data = await cls.get_knowledge_base_document(api_key, doc_id)
                            except Exception as e:
                                logger.error(f"❌ Не удалось загрузить документ {doc_id}: {e}")
                                continue
                        
                        if doc_data:
                            # Базовая информация о документе
                            doc_info = {
                                "document_id": doc_id,
                                "name": doc_data.get("name", f"Document {doc_id}"),
                                "chars": doc_data.get("character_count", 0),
                                "size": doc_data.get("size_in_bytes", 0),
                                "status": "uploaded",
                                "source_type": doc_data.get("type", "unknown"),
                                "created_at": doc_data.get("created_at_unix_secs", "")
                            }
                            
                            # Проверяем статус индексации если есть
                            if "rag_index" in doc_data:
                                doc_info["index_status"] = doc_data["rag_index"].get("status", "unknown")
                                doc_info["index_progress"] = doc_data["rag_index"].get("progress_percentage", 0)
                            else:
                                doc_info["index_status"] = "ready"
                                doc_info["index_progress"] = 100
                            
                            # Определяем тип документа и добавляем в соответствующую категорию
                            doc_type = doc_data.get("type", "unknown")
                            
                            if doc_type == "file":
                                doc_info["filename"] = doc_data.get("filename", doc_info["name"])
                                detailed_knowledge_base["files"].append(doc_info)
                                logger.debug(f"📄 Файл: {doc_info['name']}")
                                
                            elif doc_type == "url":
                                doc_info["url"] = doc_data.get("url", "")
                                doc_info["title"] = doc_info["name"]
                                detailed_knowledge_base["urls"].append(doc_info)
                                logger.debug(f"🌐 URL: {doc_info['title']}")
                                
                            elif doc_type == "text":
                                doc_info["title"] = doc_info["name"]
                                doc_info["content"] = doc_data.get("text", "")[:200] if doc_data.get("text") else ""
                                detailed_knowledge_base["texts"].append(doc_info)
                                logger.debug(f"📝 Текст: {doc_info['title']}")
                            
                            else:
                                # Неизвестный тип - добавляем как текст
                                doc_info["title"] = doc_info["name"]
                                doc_info["content"] = ""
                                detailed_knowledge_base["texts"].append(doc_info)
                                logger.debug(f"❓ Неизвестный тип: {doc_info['title']}")
                            
                            detailed_knowledge_base["totalChars"] += doc_info["chars"]
                            detailed_knowledge_base["totalSize"] += doc_info["size"]
                        else:
                            # Документ не найден - добавляем заглушку
                            logger.warning(f"📄 Документ {doc_id} не найден в Knowledge Base")
                            detailed_knowledge_base["texts"].append({
                                "document_id": doc_id,
                                "name": f"Document {doc_id} (not found)",
                                "title": f"Document {doc_id} (not found)",
                                "chars": 0,
                                "size": 0,
                                "status": "error",
                                "error": "Document not found"
                            })
                            
                except Exception as e:
                    logger.error(f"❌ Критическая ошибка загрузки Knowledge Base: {e}")
                    import traceback
                    logger.error(f"Traceback: {traceback.format_exc()}")
            
            # Добавляем детальную информацию к агенту
            agent["knowledge_base_details"] = detailed_knowledge_base
            
            # Сохраняем оригинальный массив ID для фронтенда
            agent["knowledge_base_documents"] = knowledge_base_ids
            
            logger.info(f"✅ Агент {agent_id} загружен с KB: files={len(detailed_knowledge_base['files'])}, urls={len(detailed_knowledge_base['urls'])}, texts={len(detailed_knowledge_base['texts'])}")
            
            return agent
            
        except Exception as e:
            logger.error(f"❌ Ошибка получения агента с деталями: {str(e)}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            raise Exception(f"Failed to get agent details: {str(e)}")
    
    @classmethod
    async def create_agent(cls, api_key: str, agent_data: Dict[str, Any]) -> Dict[str, Any]:
        """Создание агента"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            logger.info(f"Creating agent with enhanced structure")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/agents/create",
                    headers=headers,
                    json=agent_data
                )
                
                logger.info(f"ElevenLabs API response status: {response.status_code}")
                
                if response.status_code == 200:
                    result = response.json()
                    logger.info(f"✅ Successfully created agent: {result.get('agent_id')}")
                    return result
                else:
                    error_text = response.text
                    logger.error(f"Failed to create agent: {response.status_code} - {error_text}")
                    
                    try:
                        error_data = response.json()
                        error_detail = error_data.get('detail', error_text)
                        
                        if isinstance(error_detail, list):
                            error_messages = []
                            for error in error_detail:
                                field_path = " -> ".join(str(x) for x in error.get('loc', []))
                                message = error.get('msg', 'Unknown error')
                                
                                if field_path:
                                    if 'voice_id' in field_path:
                                        error_messages.append(f"Voice ID error: {message}")
                                    elif 'prompt' in field_path:
                                        error_messages.append(f"System prompt error: {message}")
                                    elif 'name' in field_path:
                                        error_messages.append(f"Agent name error: {message}")
                                    elif 'conversation' in field_path and 'model' in field_path:
                                        error_messages.append(f"LLM model error: {message}")
                                    else:
                                        error_messages.append(f"{field_path}: {message}")
                                else:
                                    error_messages.append(message)
                            
                            detailed_error = f"Validation errors: {'; '.join(error_messages)}"
                            logger.error(f"Detailed validation errors: {detailed_error}")
                            raise Exception(detailed_error)
                        else:
                            raise Exception(str(error_detail))
                            
                    except json.JSONDecodeError:
                        if response.status_code == 400:
                            raise Exception(f"Bad request: {error_text}")
                        elif response.status_code == 401:
                            raise Exception("Invalid API key or unauthorized access")
                        elif response.status_code == 403:
                            raise Exception("Access forbidden. Check your API key permissions.")
                        elif response.status_code == 429:
                            raise Exception("Rate limit exceeded. Please try again later.")
                        elif response.status_code == 500:
                            raise Exception("ElevenLabs server error. Please try again later.")
                        else:
                            raise Exception(f"HTTP {response.status_code}: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while creating agent")
            raise Exception("Request timed out while creating agent. Please try again.")
        except Exception as e:
            if "Validation errors" in str(e) or "error:" in str(e).lower():
                raise
            else:
                logger.error(f"Unexpected error creating agent: {str(e)}")
                raise Exception(f"Failed to create agent: {str(e)}")
    
    @classmethod
    async def get_agent_by_id(cls, api_key: str, agent_id: str) -> Dict[str, Any]:
        """Получение агента по ID"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(
                    f"{cls.BASE_URL}/convai/agents/{agent_id}",
                    headers=headers
                )
                
                if response.status_code == 200:
                    result = response.json()
                    logger.info(f"Retrieved agent {agent_id}")
                    return result
                elif response.status_code == 404:
                    logger.warning(f"Agent {agent_id} not found")
                    raise Exception(f"Agent {agent_id} not found")
                elif response.status_code == 401:
                    logger.error("Unauthorized access to agent")
                    raise Exception("Invalid API key or unauthorized access")
                else:
                    logger.error(f"Failed to get agent: {response.status_code} - {response.text}")
                    raise Exception(f"Failed to retrieve agent: {response.text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while getting agent")
            raise Exception("Request timed out while retrieving agent")
        except Exception as e:
            if "not found" in str(e) or "unauthorized" in str(e).lower():
                raise
            else:
                logger.error(f"Error getting agent {agent_id}: {str(e)}")
                raise Exception(f"Failed to get agent: {str(e)}")
    
    @classmethod
    async def update_agent(cls, api_key: str, agent_id: str, agent_data: Dict[str, Any]) -> Dict[str, Any]:
        """Обновление агента"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            logger.info(f"Updating agent {agent_id} with enhanced structure")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.patch(
                    f"{cls.BASE_URL}/convai/agents/{agent_id}",
                    headers=headers,
                    json=agent_data
                )
                
                logger.info(f"ElevenLabs API response status: {response.status_code}")
                
                if response.status_code == 200:
                    result = response.json()
                    logger.info(f"✅ Successfully updated agent: {agent_id}")
                    return result
                else:
                    error_text = response.text
                    logger.error(f"Failed to update agent: {response.status_code} - {error_text}")
                    
                    try:
                        error_data = response.json()
                        error_detail = error_data.get('detail', error_text)
                        
                        if isinstance(error_detail, list):
                            error_messages = []
                            for error in error_detail:
                                field_path = " -> ".join(str(x) for x in error.get('loc', []))
                                message = error.get('msg', 'Unknown error')
                                
                                if field_path:
                                    if 'voice_id' in field_path:
                                        error_messages.append(f"Voice ID error: {message}")
                                    elif 'prompt' in field_path:
                                        error_messages.append(f"System prompt error: {message}")
                                    elif 'name' in field_path:
                                        error_messages.append(f"Agent name error: {message}")
                                    elif 'conversation' in field_path and 'model' in field_path:
                                        error_messages.append(f"LLM model error: {message}")
                                    else:
                                        error_messages.append(f"{field_path}: {message}")
                                else:
                                    error_messages.append(message)
                            
                            detailed_error = f"Validation errors: {'; '.join(error_messages)}"
                            logger.error(f"Detailed validation errors: {detailed_error}")
                            raise Exception(detailed_error)
                        else:
                            raise Exception(str(error_detail))
                            
                    except json.JSONDecodeError:
                        if response.status_code == 400:
                            raise Exception(f"Bad request: {error_text}")
                        elif response.status_code == 401:
                            raise Exception("Invalid API key or unauthorized access")
                        elif response.status_code == 403:
                            raise Exception("Access forbidden. Check your API key permissions.")
                        elif response.status_code == 404:
                            raise Exception(f"Agent {agent_id} not found")
                        elif response.status_code == 429:
                            raise Exception("Rate limit exceeded. Please try again later.")
                        elif response.status_code == 500:
                            raise Exception("ElevenLabs server error. Please try again later.")
                        else:
                            raise Exception(f"HTTP {response.status_code}: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while updating agent")
            raise Exception("Request timed out while updating agent. Please try again.")
        except Exception as e:
            if any(keyword in str(e).lower() for keyword in ["validation errors", "not found", "unauthorized", "rate limit"]):
                raise
            else:
                logger.error(f"Unexpected error updating agent {agent_id}: {str(e)}")
                raise Exception(f"Failed to update agent: {str(e)}")
    
    @classmethod
    async def delete_agent(cls, api_key: str, agent_id: str) -> Dict[str, Any]:
        """Удаление агента"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.delete(
                    f"{cls.BASE_URL}/convai/agents/{agent_id}",
                    headers=headers
                )
                
                if response.status_code == 200:
                    logger.info(f"Successfully deleted agent: {agent_id}")
                    return {"success": True, "message": "Agent deleted successfully"}
                elif response.status_code == 404:
                    logger.warning(f"Agent {agent_id} not found for deletion")
                    raise Exception(f"Agent {agent_id} not found")
                elif response.status_code == 401:
                    logger.error("Unauthorized access for deletion")
                    raise Exception("Invalid API key or unauthorized access")
                else:
                    logger.error(f"Failed to delete agent: {response.status_code} - {response.text}")
                    raise Exception(f"Failed to delete agent: {response.text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while deleting agent")
            raise Exception("Request timed out while deleting agent")
        except Exception as e:
            if "not found" in str(e) or "unauthorized" in str(e).lower():
                raise
            else:
                logger.error(f"Error deleting agent {agent_id}: {str(e)}")
                raise Exception(f"Failed to delete agent: {str(e)}")
    
    # ============= TOOLS API METHODS =============
    
    @classmethod
    async def create_server_tool(cls, api_key: str, tool_data: Dict[str, Any]) -> str:
        """Создание Server Tool"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            elevenlabs_tool = {
                "name": tool_data.get("name"),
                "description": tool_data.get("description", ""),
                "type": "server",
                "config": {
                    "url": tool_data.get("url"),
                    "method": tool_data.get("method", "POST"),
                    "headers": tool_data.get("headers", {}),
                    "parameters": tool_data.get("parameters", [])
                }
            }
            
            logger.info(f"Creating server tool: {tool_data.get('name')}")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/tools/create",
                    headers=headers,
                    json=elevenlabs_tool
                )
                
                if response.status_code == 200:
                    result = response.json()
                    tool_id = result.get("tool_id")
                    logger.info(f"✅ Server tool created: {tool_id}")
                    return tool_id
                else:
                    error_text = response.text
                    logger.error(f"Failed to create server tool: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while creating server tool")
            raise Exception("Request timed out while creating server tool")
        except Exception as e:
            logger.error(f"Error creating server tool: {str(e)}")
            raise Exception(f"Failed to create server tool: {str(e)}")
    
    @classmethod
    async def update_server_tool(cls, api_key: str, tool_id: str, tool_data: Dict[str, Any]):
        """Обновление Server Tool"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            elevenlabs_tool = {
                "name": tool_data.get("name"),
                "description": tool_data.get("description", ""),
                "type": "server",
                "config": {
                    "url": tool_data.get("url"),
                    "method": tool_data.get("method", "POST"),
                    "headers": tool_data.get("headers", {}),
                    "parameters": tool_data.get("parameters", [])
                }
            }
            
            logger.info(f"Updating server tool: {tool_id}")
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.patch(
                    f"{cls.BASE_URL}/convai/tools/{tool_id}",
                    headers=headers,
                    json=elevenlabs_tool
                )
                
                if response.status_code == 200:
                    logger.info(f"✅ Server tool updated: {tool_id}")
                    return response.json()
                else:
                    error_text = response.text
                    logger.error(f"Failed to update server tool: {response.status_code} - {error_text}")
                    raise Exception(f"ElevenLabs API error: {error_text}")
                    
        except httpx.TimeoutException:
            logger.error("Timeout while updating server tool")
            raise Exception("Request timed out while updating server tool")
        except Exception as e:
            logger.error(f"Error updating server tool: {str(e)}")
            raise Exception(f"Failed to update server tool: {str(e)}")
    
    # ============= EMBED & WEBSOCKET METHODS =============
    
    @classmethod
    async def get_embed_code(cls, agent_id: str) -> Dict[str, Any]:
        """Генерация кода для встраивания агента"""
        try:
            embed_code = f'''<!-- ElevenLabs Conversational AI Widget -->
<script
  id="elevenlabs-convai-widget"
  type="text/javascript"
  src="https://elevenlabs.io/convai/widget/index.js"
  data-agent-id="{agent_id}"
></script>'''
            
            result = {
                "agent_id": agent_id,
                "embed_code": embed_code
            }
            
            logger.info(f"Generated embed code for agent {agent_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error generating embed code for agent {agent_id}: {str(e)}")
            raise Exception(f"Failed to generate embed code: {str(e)}")
    
    @classmethod
    async def get_signed_url(cls, api_key: str, agent_id: str) -> str:
        """Получение подписанного URL для WebSocket подключения"""
        try:
            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json"
            }
            
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.post(
                    f"{cls.BASE_URL}/convai/agents/{agent_id}/link",
                    headers=headers,
                    json={}
                )
                
                logger.info(f"Signed URL request status: {response.status_code}")
                
                if response.status_code == 200:
                    data = response.json()
                    signed_url = data.get("signed_url")
                    
                    if signed_url:
                        logger.info(f"Generated signed URL for agent {agent_id}")
                        return signed_url
                    else:
                        fallback_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"
                        logger.warning(f"No signed URL returned, using fallback for agent {agent_id}")
                        return fallback_url
                        
                elif response.status_code == 401:
                    logger.error("Unauthorized access for signed URL")
                    raise Exception("Invalid API key or unauthorized access")
                elif response.status_code == 404:
                    logger.error(f"Agent {agent_id} not found for signed URL")
                    raise Exception(f"Agent {agent_id} not found")
                else:
                    logger.error(f"Failed to get signed URL: {response.status_code} - {response.text}")
                    fallback_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"
                    logger.info(f"Using fallback URL for agent {agent_id} due to API error")
                    return fallback_url
                    
        except httpx.TimeoutException:
            logger.error(f"Timeout while getting signed URL for agent {agent_id}")
            fallback_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"
            logger.info(f"Using fallback URL for agent {agent_id} due to timeout")
            return fallback_url
        except Exception as e:
            logger.error(f"Error getting signed URL for agent {agent_id}: {str(e)}")
            if "not found" in str(e).lower() or "unauthorized" in str(e).lower():
                raise
            else:
                fallback_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"
                logger.info(f"Using fallback URL for agent {agent_id} due to error: {str(e)}")
                return fallback_url
    
    # ============= CACHE METHODS =============
    
    @classmethod
    def _get_from_cache(cls, key: str) -> Optional[Any]:
        """Получение данных из кеша"""
        if key in cls._kb_documents_cache:
            cached_data, timestamp = cls._kb_documents_cache[key]
            if datetime.now() - timestamp < cls._cache_ttl:
                return cached_data
            else:
                # Кеш устарел, удаляем
                del cls._kb_documents_cache[key]
        return None
    
    @classmethod
    def _save_to_cache(cls, key: str, data: Any):
        """Сохранение данных в кеш"""
        cls._kb_documents_cache[key] = (data, datetime.now())
    
    @classmethod
    def _clear_cache_for_user(cls, api_key: str):
        """Очистка кеша для конкретного пользователя"""
        keys_to_delete = []
        for key in cls._kb_documents_cache:
            if key.startswith(api_key):
                keys_to_delete.append(key)
        
        for key in keys_to_delete:
            del cls._kb_documents_cache[key]
        
        if keys_to_delete:
            logger.info(f"Cleared {len(keys_to_delete)} cache entries for user")
