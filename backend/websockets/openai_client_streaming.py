"""
🚀 LLM Stream WebSocket Handler v3.0
=====================================

Отдельный WebSocket эндпоинт для LLM текстового стриминга.
Изолирован от голосового канала для предотвращения искажений аудио.

🔧 v2.0: OpenAI API key from User model via assistant_id chain:
    assistant_id → GeminiAssistantConfig → user_id → User → openai_api_key

🔧 v3.0: Chat history support (5 pairs = 10 messages context)

АРХИТЕКТУРА:
┌─────────────┐         ┌──────────────────┐
│   Browser   │   WS    │   LLM Stream     │
│             │◄───────►│   Handler        │
│  (text UI)  │         │  (OpenAI API)    │
└─────────────┘         └──────────────────┘

СОБЫТИЯ:
Client → Server:
- llm.query: Запрос к LLM (с опциональной историей)
  {
    "type": "llm.query",
    "query": "текущий вопрос",
    "history": [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "..."}
    ],
    "request_id": "text_123"
  }

Server → Client:
- llm.stream.start: Начало стриминга
- llm.stream.delta: Chunk текста
- llm.stream.done: Завершение
- llm.stream.error: Ошибка
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import time
import os
import aiohttp
from typing import Optional, Dict, Any, List

from backend.core.logging import get_logger
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.user import User

logger = get_logger(__name__)


# ============================================================================
# CONFIGURATION
# ============================================================================

class LLMStreamConfig:
    """Конфигурация LLM Stream Handler"""
    MODEL = "gpt-4o-mini"
    MAX_TOKENS = 4096
    TEMPERATURE = 0.1
    REQUEST_TIMEOUT = 60.0
    CONNECT_TIMEOUT = 10.0
    OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
    
    # Буферизация для плавного вывода
    BUFFER_MIN_CHARS = 30
    BUFFER_MAX_WAIT = 0.2
    
    # 🆕 v3.0: Ограничение истории
    MAX_HISTORY_MESSAGES = 10  # 5 пар


SYSTEM_PROMPT = """Ты — умный и полезный ассистент. Отвечай подробно, структурированно и по существу.

Правила форматирования:
- Используй markdown для структурирования ответа
- Заголовки: ## для основных разделов, ### для подразделов
- Списки: - или 1. 2. 3. для перечислений
- Код: ```язык для блоков кода, `код` для inline
- Выделяй **важные термины** жирным

Правила ответов:
- Отвечай на языке вопроса
- Будь конкретным и информативным
- Приводи примеры где уместно
- Учитывай контекст предыдущих сообщений в диалоге"""


# ============================================================================
# API KEY RESOLUTION
# ============================================================================

def get_openai_api_key_from_assistant(
    db: Session,
    assistant_id: Optional[str]
) -> Optional[str]:
    """
    Получает OpenAI API ключ из модели User через цепочку:
    assistant_id → GeminiAssistantConfig → user_id → User → openai_api_key
    
    Args:
        db: Database session
        assistant_id: UUID of Gemini assistant
        
    Returns:
        OpenAI API key or None if not found
    """
    if not assistant_id or not db:
        logger.warning("[LLM-WS] No assistant_id or db provided, falling back to env")
        return os.environ.get('OPENAI_API_KEY')
    
    try:
        # 1. Загружаем Gemini ассистента
        try:
            assistant_uuid = uuid.UUID(assistant_id)
            assistant = db.query(GeminiAssistantConfig).get(assistant_uuid)
        except ValueError:
            # Если не UUID, пробуем как строку
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id.cast(str) == assistant_id
            ).first()
        
        if not assistant:
            logger.warning(f"[LLM-WS] Assistant not found: {assistant_id}")
            return os.environ.get('OPENAI_API_KEY')
        
        logger.info(f"[LLM-WS] Found assistant: {getattr(assistant, 'name', assistant_id)}")
        
        # 2. Получаем user_id из ассистента
        if not assistant.user_id:
            logger.warning(f"[LLM-WS] Assistant has no user_id")
            return os.environ.get('OPENAI_API_KEY')
        
        # 3. Загружаем пользователя
        user = db.query(User).get(assistant.user_id)
        
        if not user:
            logger.warning(f"[LLM-WS] User not found: {assistant.user_id}")
            return os.environ.get('OPENAI_API_KEY')
        
        logger.info(f"[LLM-WS] Found user: {user.email}")
        
        # 4. Получаем OpenAI ключ
        api_key = user.openai_api_key
        
        if api_key:
            logger.info(f"[LLM-WS] ✅ OpenAI API key loaded from User model: {api_key[:10]}...{api_key[-4:]}")
            return api_key
        else:
            logger.warning(f"[LLM-WS] User {user.email} has no OpenAI API key configured")
            # Fallback to environment variable
            env_key = os.environ.get('OPENAI_API_KEY')
            if env_key:
                logger.info(f"[LLM-WS] ⚠️ Falling back to environment OPENAI_API_KEY")
            return env_key
            
    except Exception as e:
        logger.error(f"[LLM-WS] Error getting API key: {e}")
        return os.environ.get('OPENAI_API_KEY')


# ============================================================================
# HISTORY PROCESSING (v3.0)
# ============================================================================

def process_chat_history(history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """
    Обрабатывает и валидирует историю чата.
    
    Args:
        history: Список сообщений от клиента
        
    Returns:
        Очищенный список сообщений для OpenAI API
    """
    if not history:
        return []
    
    processed = []
    
    for msg in history:
        if not isinstance(msg, dict):
            continue
            
        role = msg.get("role", "").strip().lower()
        content = msg.get("content", "").strip()
        
        # Валидация role
        if role not in ("user", "assistant"):
            continue
            
        # Пропускаем пустые сообщения
        if not content:
            continue
            
        processed.append({
            "role": role,
            "content": content
        })
    
    # Ограничиваем количество сообщений
    if len(processed) > LLMStreamConfig.MAX_HISTORY_MESSAGES:
        processed = processed[-LLMStreamConfig.MAX_HISTORY_MESSAGES:]
        logger.info(f"[LLM-WS] History trimmed to {LLMStreamConfig.MAX_HISTORY_MESSAGES} messages")
    
    return processed


# ============================================================================
# HANDLER
# ============================================================================

async def handle_openai_streaming_websocket(
    websocket: WebSocket,
    assistant_id: Optional[str] = None,
    db: Optional[Session] = None
) -> None:
    """
    WebSocket handler для LLM текстового стриминга.
    
    🔧 v2.0: OpenAI API key берётся из модели User через assistant_id.
    🔧 v3.0: Поддержка истории чата (до 5 пар сообщений).
    
    Args:
        websocket: WebSocket connection
        assistant_id: UUID of Gemini assistant for API key lookup
        db: Database session
    """
    client_id = str(uuid.uuid4())[:8]
    
    logger.info(f"[LLM-WS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    logger.info(f"[LLM-WS] 🔌 NEW CONNECTION (v3.0)")
    logger.info(f"[LLM-WS]    Client ID: {client_id}")
    logger.info(f"[LLM-WS]    Assistant ID: {assistant_id}")
    logger.info(f"[LLM-WS]    API Key Source: User model")
    logger.info(f"[LLM-WS]    History Support: ✅ (max {LLMStreamConfig.MAX_HISTORY_MESSAGES} msgs)")
    logger.info(f"[LLM-WS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Получаем API ключ из User модели
    api_key = get_openai_api_key_from_assistant(db, assistant_id)
    
    try:
        await websocket.accept()
        logger.info(f"[LLM-WS] ✅ Connected: {client_id}")
        
        if not api_key:
            logger.error(f"[LLM-WS] ❌ No OpenAI API key available")
            await websocket.send_json({
                "type": "error",
                "error": "OpenAI API key not configured. Please add your OpenAI API key in Settings.",
                "error_code": "no_api_key"
            })
            await websocket.close(code=1008, reason="No API key")
            return
        
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "client_id": client_id,
            "api_key_source": "user_model" if assistant_id else "environment",
            "history_support": True,
            "max_history": LLMStreamConfig.MAX_HISTORY_MESSAGES
        })
        
        # Main loop
        while True:
            try:
                data = await websocket.receive_json()
                msg_type = data.get("type")
                
                if msg_type == "llm.query":
                    query = data.get("query", "")
                    request_id = data.get("request_id", f"req_{uuid.uuid4().hex[:8]}")
                    
                    # 🆕 v3.0: Получаем историю
                    raw_history = data.get("history", [])
                    history = process_chat_history(raw_history)
                    
                    if query:
                        await stream_llm_response(
                            websocket=websocket,
                            query=query,
                            request_id=request_id,
                            api_key=api_key,
                            history=history  # 🆕 Передаём историю
                        )
                
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    
            except WebSocketDisconnect:
                logger.info(f"[LLM-WS] Disconnected: {client_id}")
                break
            except json.JSONDecodeError as e:
                logger.warning(f"[LLM-WS] Invalid JSON: {e}")
                continue
            except Exception as e:
                logger.error(f"[LLM-WS] Error in main loop: {e}")
                try:
                    await websocket.send_json({
                        "type": "error",
                        "error": str(e)[:200]
                    })
                except:
                    break
                    
    except Exception as e:
        logger.error(f"[LLM-WS] Connection error: {e}")
    finally:
        logger.info(f"[LLM-WS] 👋 Closed: {client_id}")


async def stream_llm_response(
    websocket: WebSocket,
    query: str,
    request_id: str,
    api_key: str,
    history: List[Dict[str, str]] = None  # 🆕 v3.0
) -> None:
    """
    Стримит ответ от OpenAI на WebSocket.
    
    Args:
        websocket: WebSocket connection
        query: User query
        request_id: Request ID for tracking
        api_key: OpenAI API key (from User model)
        history: Chat history (list of {role, content} dicts)
    """
    if history is None:
        history = []
    
    start_time = time.time()
    full_content = ""
    buffer = ""
    last_flush = time.time()
    messages_sent = 0
    
    logger.info(f"[LLM-WS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    logger.info(f"[LLM-WS] 🚀 STREAM START")
    logger.info(f"[LLM-WS]    Request ID: {request_id}")
    logger.info(f"[LLM-WS]    Query: {query[:100]}{'...' if len(query) > 100 else ''}")
    logger.info(f"[LLM-WS]    History: {len(history)} messages")  # 🆕
    logger.info(f"[LLM-WS]    Model: {LLMStreamConfig.MODEL}")
    logger.info(f"[LLM-WS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    try:
        # Start event
        await websocket.send_json({
            "type": "llm.stream.start",
            "request_id": request_id,
            "query": query,
            "model": LLMStreamConfig.MODEL,
            "history_count": len(history)  # 🆕
        })
        
        # 🆕 v3.0: Формируем messages с историей
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        
        # Добавляем историю
        for msg in history:
            messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })
        
        # Добавляем текущий запрос
        messages.append({
            "role": "user",
            "content": query
        })
        
        logger.info(f"[LLM-WS]    Total messages to API: {len(messages)} (1 system + {len(history)} history + 1 current)")
        
        # Stream from OpenAI
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        
        payload = {
            "model": LLMStreamConfig.MODEL,
            "messages": messages,  # 🆕 Теперь с историей
            "max_tokens": LLMStreamConfig.MAX_TOKENS,
            "temperature": LLMStreamConfig.TEMPERATURE,
            "stream": True,
            "stream_options": {"include_usage": True}
        }
        
        timeout = aiohttp.ClientTimeout(
            total=LLMStreamConfig.REQUEST_TIMEOUT,
            connect=LLMStreamConfig.CONNECT_TIMEOUT
        )
        
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                LLMStreamConfig.OPENAI_API_URL,
                headers=headers,
                json=payload
            ) as response:
                
                if response.status != 200:
                    error_text = await response.text()
                    logger.error(f"[LLM-WS] ❌ OpenAI API error: {response.status}")
                    logger.error(f"[LLM-WS]    Response: {error_text[:500]}")
                    
                    # Parse OpenAI error
                    try:
                        error_data = json.loads(error_text)
                        error_message = error_data.get("error", {}).get("message", error_text)
                    except:
                        error_message = error_text[:200]
                    
                    raise Exception(f"OpenAI API error ({response.status}): {error_message}")
                
                tokens_used = 0
                
                logger.info(f"[LLM-WS] 📥 Streaming response...")
                
                async for line in response.content:
                    line = line.decode('utf-8').strip()
                    
                    if not line or not line.startswith("data: "):
                        continue
                    
                    data_str = line[6:]
                    
                    if data_str == "[DONE]":
                        logger.info(f"[LLM-WS] 📥 Stream finished")
                        break
                    
                    try:
                        data = json.loads(data_str)
                        
                        choices = data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content")
                            
                            if content:
                                full_content += content
                                buffer += content
                                
                                # Flush buffer conditions
                                current_time = time.time()
                                should_flush = (
                                    len(buffer) >= LLMStreamConfig.BUFFER_MIN_CHARS or
                                    (current_time - last_flush) >= LLMStreamConfig.BUFFER_MAX_WAIT or
                                    buffer.rstrip().endswith(('.', '!', '?', '\n', '。', '！', '？'))
                                )
                                
                                if should_flush and buffer:
                                    await websocket.send_json({
                                        "type": "llm.stream.delta",
                                        "request_id": request_id,
                                        "content": buffer
                                    })
                                    messages_sent += 1
                                    buffer = ""
                                    last_flush = current_time
                                    
                                    # Small delay to prevent browser overload
                                    await asyncio.sleep(0.01)
                        
                        usage = data.get("usage")
                        if usage:
                            tokens_used = usage.get("total_tokens", 0)
                            
                    except json.JSONDecodeError:
                        continue
        
        # Flush remaining buffer
        if buffer:
            await websocket.send_json({
                "type": "llm.stream.delta",
                "request_id": request_id,
                "content": buffer
            })
            messages_sent += 1
        
        # Done event
        duration_ms = int((time.time() - start_time) * 1000)
        
        await websocket.send_json({
            "type": "llm.stream.done",
            "request_id": request_id,
            "full_content": full_content,
            "tokens_used": tokens_used,
            "duration_ms": duration_ms,
            "messages_sent": messages_sent,
            "model": LLMStreamConfig.MODEL,
            "history_count": len(history)  # 🆕
        })
        
        logger.info(f"[LLM-WS] ✅ STREAM COMPLETE")
        logger.info(f"[LLM-WS]    Duration: {duration_ms}ms")
        logger.info(f"[LLM-WS]    Content: {len(full_content)} chars")
        logger.info(f"[LLM-WS]    Tokens: {tokens_used}")
        logger.info(f"[LLM-WS]    Messages: {messages_sent}")
        logger.info(f"[LLM-WS]    History used: {len(history)} msgs")  # 🆕
        
    except asyncio.TimeoutError:
        error_msg = "Request timeout - OpenAI API did not respond in time"
        logger.error(f"[LLM-WS] ❌ TIMEOUT: {error_msg}")
        await websocket.send_json({
            "type": "llm.stream.error",
            "request_id": request_id,
            "error": error_msg,
            "error_code": "timeout"
        })
        
    except aiohttp.ClientError as e:
        error_msg = f"Connection error: {str(e)}"
        logger.error(f"[LLM-WS] ❌ CONNECTION ERROR: {error_msg}")
        await websocket.send_json({
            "type": "llm.stream.error",
            "request_id": request_id,
            "error": error_msg,
            "error_code": "connection_error"
        })
        
    except Exception as e:
        error_msg = str(e)[:200]
        logger.error(f"[LLM-WS] ❌ ERROR: {e}")
        await websocket.send_json({
            "type": "llm.stream.error",
            "request_id": request_id,
            "error": error_msg,
            "error_code": "internal_error"
        })
