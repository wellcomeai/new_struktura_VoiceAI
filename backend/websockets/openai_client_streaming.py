"""
🚀 LLM Stream WebSocket Handler v1.0
=====================================

Отдельный WebSocket эндпоинт для LLM текстового стриминга.
Изолирован от голосового канала для предотвращения искажений аудио.

АРХИТЕКТУРА:
┌─────────────┐         ┌──────────────────┐
│   Browser   │   WS    │   LLM Stream     │
│             │◄───────►│   Handler        │
│  (text UI)  │         │  (OpenAI API)    │
└─────────────┘         └──────────────────┘

СОБЫТИЯ:
Client → Server:
- llm.query: Запрос к LLM

Server → Client:
- llm.stream.start: Начало стриминга
- llm.stream.delta: Chunk текста
- llm.stream.done: Завершение
- llm.stream.error: Ошибка
"""

from fastapi import WebSocket, WebSocketDisconnect
import json
import asyncio
import uuid
import time
import os
import aiohttp
from typing import Optional, Dict, Any

from backend.core.logging import get_logger

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
- Приводи примеры где уместно"""


# ============================================================================
# HANDLER
# ============================================================================

async def handle_openai_streaming_websocket(websocket: WebSocket) -> None:
    """
    WebSocket handler для LLM текстового стриминга.
    
    Полностью изолирован от голосового канала.
    """
    client_id = str(uuid.uuid4())[:8]
    api_key = os.environ.get('OPENAI_API_KEY')
    
    logger.info(f"[LLM-WS] New connection: {client_id}")
    
    try:
        await websocket.accept()
        logger.info(f"[LLM-WS] ✅ Connected: {client_id}")
        
        if not api_key:
            await websocket.send_json({
                "type": "error",
                "error": "OpenAI API key not configured"
            })
            await websocket.close()
            return
        
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "client_id": client_id
        })
        
        # Main loop
        while True:
            try:
                data = await websocket.receive_json()
                msg_type = data.get("type")
                
                if msg_type == "llm.query":
                    query = data.get("query", "")
                    request_id = data.get("request_id", f"req_{uuid.uuid4().hex[:8]}")
                    
                    if query:
                        await stream_llm_response(
                            websocket=websocket,
                            query=query,
                            request_id=request_id,
                            api_key=api_key
                        )
                
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    
            except WebSocketDisconnect:
                logger.info(f"[LLM-WS] Disconnected: {client_id}")
                break
            except Exception as e:
                logger.error(f"[LLM-WS] Error: {e}")
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
        logger.info(f"[LLM-WS] Closed: {client_id}")


async def stream_llm_response(
    websocket: WebSocket,
    query: str,
    request_id: str,
    api_key: str
) -> None:
    """
    Стримит ответ от OpenAI на WebSocket.
    """
    start_time = time.time()
    full_content = ""
    buffer = ""
    last_flush = time.time()
    messages_sent = 0
    
    logger.info(f"[LLM-WS] Query: {query[:100]}")
    
    try:
        # Start event
        await websocket.send_json({
            "type": "llm.stream.start",
            "request_id": request_id,
            "query": query
        })
        
        # Stream from OpenAI
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        
        payload = {
            "model": LLMStreamConfig.MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": query}
            ],
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
                    raise Exception(f"OpenAI error: {response.status}")
                
                tokens_used = 0
                
                async for line in response.content:
                    line = line.decode('utf-8').strip()
                    
                    if not line or not line.startswith("data: "):
                        continue
                    
                    data_str = line[6:]
                    
                    if data_str == "[DONE]":
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
                                    buffer.rstrip().endswith(('.', '!', '?', '\n'))
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
            "messages_sent": messages_sent
        })
        
        logger.info(f"[LLM-WS] ✅ Done: {duration_ms}ms, {messages_sent} messages")
        
    except Exception as e:
        logger.error(f"[LLM-WS] ❌ Error: {e}")
        await websocket.send_json({
            "type": "llm.stream.error",
            "request_id": request_id,
            "error": str(e)[:200]
        })
