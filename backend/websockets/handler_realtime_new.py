"""
Real-time WebSocket Handler with OpenAI Realtime API (GA) - v2.11
OpenAI VAD Only Architecture - Simplified

🔥 NEW in v2.11 - SIMPLIFIED ARCHITECTURE:
- Убрана обработка клиентского commit (OpenAI делает auto commit)
- Упрощена логика пересылки аудио (только forward chunks)
- Код проще на 15%, меньше точек отказа
- OpenAI server VAD управляет всем процессом

Compatible with:
- openai_client_new.py v3.1 (OpenAI GA + server VAD)
- widget.js v3.2.2 (OpenAI VAD Only - Simplified)
"""

import asyncio
import json
import os
import base64
from datetime import datetime
from typing import Dict, Optional, Any
from fastapi import WebSocket, WebSocketDisconnect

# ✅ ПРАВИЛЬНЫЕ ИМПОРТЫ для вашей структуры проекта:
from backend.db.session import SessionLocal
from backend.models import AssistantConfig, Conversation  # ← Правильно!
from backend.websockets.openai_client_new import RealtimeClient

# Импорты для функций
import httpx
from bs4 import BeautifulSoup

# Глобальная переменная для отслеживания активных соединений
active_connections: Dict[str, RealtimeClient] = {}

def log_to_render(message: str, level: str = "INFO"):
    """Логирование с timestamp для Render"""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[{timestamp}] [{level}] [v2.11 OpenAI VAD] {message}", flush=True)

# ==================== ASYNC FUNCTION IMPLEMENTATIONS ====================

async def query_llm(query: str, context: Optional[str] = None) -> Dict[str, Any]:
    """
    v2.10: Async LLM query function
    Делает запрос к LLM через OpenAI для получения информации
    """
    log_to_render(f"[FUNCTION] query_llm called with query: {query[:100]}...")
    
    try:
        import openai
        
        # Формируем prompt с контекстом если есть
        messages = []
        
        if context:
            messages.append({
                "role": "system",
                "content": f"Контекст: {context}"
            })
        
        messages.append({
            "role": "user",
            "content": query
        })
        
        # Делаем запрос к OpenAI API
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not found")
        
        client = openai.AsyncOpenAI(api_key=api_key)
        
        response = await client.chat.completions.create(
            model="gpt-4o-mini",  # Быстрая и дешевая модель для функций
            messages=messages,
            max_tokens=500,
            temperature=0.7
        )
        
        result = response.choices[0].message.content
        
        log_to_render(f"[FUNCTION] query_llm result: {result[:100]}...")
        
        return {
            "success": True,
            "result": result,
            "model": "gpt-4o-mini"
        }
        
    except Exception as e:
        log_to_render(f"[FUNCTION] query_llm error: {str(e)}", "ERROR")
        return {
            "success": False,
            "error": str(e)
        }

async def get_current_weather(location: str, unit: str = "celsius") -> Dict[str, Any]:
    """
    v2.10: Async weather function
    Получает текущую погоду для указанной локации
    """
    log_to_render(f"[FUNCTION] get_current_weather called for {location}")
    
    try:
        # Используем OpenWeatherMap API (нужен API ключ в .env)
        api_key = os.getenv("OPENWEATHER_API_KEY")
        
        if not api_key:
            # Если нет ключа, возвращаем моковые данные
            log_to_render("[FUNCTION] No OpenWeatherMap API key, returning mock data", "WARN")
            return {
                "success": True,
                "location": location,
                "temperature": 22,
                "unit": unit,
                "conditions": "Partly cloudy",
                "humidity": 65,
                "wind_speed": 10,
                "mock": True
            }
        
        # Делаем реальный запрос к OpenWeatherMap
        async with httpx.AsyncClient() as client:
            url = f"https://api.openweathermap.org/data/2.5/weather"
            params = {
                "q": location,
                "appid": api_key,
                "units": "metric" if unit == "celsius" else "imperial"
            }
            
            response = await client.get(url, params=params, timeout=10.0)
            response.raise_for_status()
            
            data = response.json()
            
            result = {
                "success": True,
                "location": data["name"],
                "temperature": round(data["main"]["temp"]),
                "unit": unit,
                "conditions": data["weather"][0]["description"],
                "humidity": data["main"]["humidity"],
                "wind_speed": round(data["wind"]["speed"]),
                "mock": False
            }
            
            log_to_render(f"[FUNCTION] Weather data: {result}")
            return result
            
    except Exception as e:
        log_to_render(f"[FUNCTION] get_current_weather error: {str(e)}", "ERROR")
        return {
            "success": False,
            "error": str(e)
        }

async def search_web(query: str, num_results: int = 3) -> Dict[str, Any]:
    """
    v2.10: Async web search function
    Ищет информацию в интернете (используя DuckDuckGo или другой API)
    """
    log_to_render(f"[FUNCTION] search_web called with query: {query}")
    
    try:
        # Используем DuckDuckGo HTML search (не требует API ключа)
        async with httpx.AsyncClient() as client:
            url = "https://html.duckduckgo.com/html/"
            data = {"q": query}
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
            
            response = await client.post(url, data=data, headers=headers, timeout=10.0)
            response.raise_for_status()
            
            # Парсим HTML результаты
            soup = BeautifulSoup(response.text, 'html.parser')
            results = []
            
            for result_div in soup.find_all('div', class_='result')[:num_results]:
                title_tag = result_div.find('a', class_='result__a')
                snippet_tag = result_div.find('a', class_='result__snippet')
                
                if title_tag and snippet_tag:
                    results.append({
                        "title": title_tag.get_text(strip=True),
                        "url": title_tag.get('href', ''),
                        "snippet": snippet_tag.get_text(strip=True)
                    })
            
            log_to_render(f"[FUNCTION] Found {len(results)} search results")
            
            return {
                "success": True,
                "query": query,
                "results": results,
                "count": len(results)
            }
            
    except Exception as e:
        log_to_render(f"[FUNCTION] search_web error: {str(e)}", "ERROR")
        return {
            "success": False,
            "error": str(e),
            "query": query
        }

# ==================== END FUNCTION IMPLEMENTATIONS ====================

async def handle_realtime_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: SessionLocal
):
    """
    v2.11: Обработчик WebSocket соединения (OpenAI VAD Only - Simplified)
    
    УПРОЩЕНИЯ v2.11:
    - Убрана обработка input_audio_buffer.commit от клиента
    - Только пересылка audio chunks
    - OpenAI делает VAD и auto commit
    """
    
    log_to_render(f"[v2.11 OpenAI VAD] New WebSocket connection for assistant: {assistant_id}")
    
    # ✅ Используем правильное имя класса: AssistantConfig
    assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
    
    if not assistant:
        log_to_render(f"Assistant not found: {assistant_id}", "ERROR")
        await websocket.close(code=4004, reason="Assistant not found")
        return
    
    log_to_render(f"[v2.11] Assistant found: {assistant.name}")
    
    # Создаем клиента OpenAI Realtime API
    openai_client = RealtimeClient(
        assistant_id=assistant_id,
        system_prompt=assistant.system_prompt,
        voice=assistant.voice or "alloy",
        temperature=assistant.temperature or 0.8
    )
    
    # Регистрируем функции в клиенте
    log_to_render("[v2.11] Registering async functions...")
    
    # v2.10: Регистрируем async функции
    openai_client.register_function("query_llm", query_llm, {
        "type": "function",
        "name": "query_llm",
        "description": "Делает запрос к языковой модели для получения информации или ответа на вопрос",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Вопрос или запрос к модели"
                },
                "context": {
                    "type": "string",
                    "description": "Дополнительный контекст для запроса (опционально)"
                }
            },
            "required": ["query"]
        }
    })
    
    openai_client.register_function("get_current_weather", get_current_weather, {
        "type": "function",
        "name": "get_current_weather",
        "description": "Получает текущую погоду для указанной локации",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "Город или локация, например 'Москва' или 'London'"
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                    "description": "Единицы измерения температуры"
                }
            },
            "required": ["location"]
        }
    })
    
    openai_client.register_function("search_web", search_web, {
        "type": "function",
        "name": "search_web",
        "description": "Ищет информацию в интернете по заданному запросу",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Поисковый запрос"
                },
                "num_results": {
                    "type": "integer",
                    "description": "Количество результатов (по умолчанию 3)",
                    "default": 3
                }
            },
            "required": ["query"]
        }
    })
    
    log_to_render("[v2.11] Functions registered successfully")
    
    # Сохраняем соединение в активных
    connection_id = f"{assistant_id}_{id(websocket)}"
    active_connections[connection_id] = openai_client
    
    log_to_render(f"[v2.11] Active connections: {len(active_connections)}")
    
    # Подключаемся к OpenAI
    await openai_client.connect()
    
    # Отправляем статус подключения клиенту
    await websocket.send_json({
        "type": "connection_status",
        "status": "connected",
        "message": "Connected to OpenAI Realtime API (v2.11 - OpenAI VAD Only)",
        "assistant_id": assistant_id
    })
    
    # Создаем задачу для обработки событий от OpenAI
    async def handle_openai_events():
        """Обработка событий от OpenAI и отправка клиенту"""
        try:
            while openai_client.is_connected:
                event = await openai_client.receive_event()
                
                if event:
                    event_type = event.get("type", "")
                    
                    # Логируем только важные события
                    if event_type not in [
                        "response.audio_transcript.delta",
                        "input_audio_buffer.speech_started",
                        "input_audio_buffer.speech_stopped"
                    ]:
                        log_to_render(f"[v2.11 OpenAI→Client] {event_type}")
                    
                    # Пересылаем событие клиенту
                    try:
                        await websocket.send_json(event)
                    except Exception as e:
                        log_to_render(f"[v2.11] Error sending event to client: {e}", "ERROR")
                        break
                
                await asyncio.sleep(0.01)  # Небольшая задержка
                
        except Exception as e:
            log_to_render(f"[v2.11] Error in OpenAI event handler: {e}", "ERROR")
    
    # Запускаем обработчик событий от OpenAI
    openai_task = asyncio.create_task(handle_openai_events())
    
    # Основной цикл обработки сообщений от клиента
    try:
        while True:
            # Получаем сообщение от клиента
            try:
                message = await websocket.receive()
            except WebSocketDisconnect:
                log_to_render("[v2.11] Client disconnected")
                break
            except Exception as e:
                log_to_render(f"[v2.11] Error receiving message: {e}", "ERROR")
                break
            
            # Обрабатываем текстовое сообщение (JSON)
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")
                    
                    # Логируем только важные типы сообщений
                    if msg_type not in ["input_audio_buffer.append", "ping"]:
                        log_to_render(f"[v2.11 Client→OpenAI] {msg_type}")
                    
                    # Обработка ping/pong
                    if msg_type == "ping":
                        await websocket.send_text("pong")
                        continue
                    
                    # 🔥 v2.11: УБРАНА обработка commit от клиента!
                    # OpenAI делает auto commit через server VAD
                    if msg_type == "input_audio_buffer.commit":
                        log_to_render("[v2.11 VAD] ⚠️ Client sent commit - ignoring (OpenAI handles auto commit)", "WARN")
                        # Не пересылаем на OpenAI - OpenAI сам делает commit!
                        continue
                    
                    # 🔥 v2.11: УБРАНА обработка clear от клиента
                    # OpenAI управляет буфером через server VAD
                    if msg_type == "input_audio_buffer.clear":
                        log_to_render("[v2.11 VAD] ⚠️ Client sent clear - ignoring (OpenAI manages buffer)", "WARN")
                        # Не пересылаем - OpenAI сам управляет
                        continue
                    
                    # Обработка audio chunks - просто пересылаем на OpenAI
                    if msg_type == "input_audio_buffer.append":
                        if "audio" in data:
                            try:
                                # 🔥 v2.11: Упрощенная пересылка - только forward chunk
                                audio_base64 = data["audio"]
                                await openai_client.send_audio(audio_base64)
                            except Exception as e:
                                log_to_render(f"[v2.11] Error processing audio: {e}", "ERROR")
                        continue
                    
                    # Обработка screen capture
                    if msg_type == "screen.capture" or msg_type == "screen.context":
                        if "image" in data:
                            try:
                                log_to_render("[v2.11 SCREEN] Processing screen capture...")
                                
                                image_base64 = data["image"]
                                
                                # Удаляем префикс data:image если есть
                                if "," in image_base64:
                                    image_base64 = image_base64.split(",")[1]
                                
                                # Формируем prompt
                                if msg_type == "screen.context":
                                    # Тихий режим - без prompt, только context
                                    prompt = None
                                    log_to_render("[v2.11 SCREEN] Silent context update (no prompt)")
                                else:
                                    # Обычный режим - с prompt
                                    prompt = data.get("prompt", "Опиши что ты видишь на этом изображении экрана")
                                    log_to_render(f"[v2.11 SCREEN] With prompt: {prompt[:50]}...")
                                
                                # Отправляем изображение через OpenAI client
                                await openai_client.send_image(image_base64, prompt)
                                
                                log_to_render("[v2.11 SCREEN] Screen capture sent to OpenAI")
                                
                            except Exception as e:
                                log_to_render(f"[v2.11 SCREEN] Error processing screen: {e}", "ERROR")
                        continue
                    
                    # Обработка отмены ответа (для перебивания)
                    if msg_type == "response.cancel":
                        log_to_render("[v2.11 INTERRUPTION] Cancelling response...")
                        await openai_client.cancel_response()
                        continue
                    
                    # Обработка остановки воспроизведения аудио
                    if msg_type == "audio_playback.stopped":
                        log_to_render("[v2.11 INTERRUPTION] Audio playback stopped by client")
                        # Просто логируем, OpenAI уже знает через VAD
                        continue
                    
                    # Все остальные сообщения пересылаем на OpenAI как есть
                    await openai_client.send_event(data)
                    
                except json.JSONDecodeError as e:
                    log_to_render(f"[v2.11] JSON decode error: {e}", "ERROR")
                except Exception as e:
                    log_to_render(f"[v2.11] Error processing message: {e}", "ERROR")
            
            # Обрабатываем бинарные данные (если вдруг клиент отправит)
            elif "bytes" in message:
                log_to_render("[v2.11] Received binary data (unexpected)", "WARN")
    
    except Exception as e:
        log_to_render(f"[v2.11] Error in main loop: {e}", "ERROR")
    
    finally:
        # Очистка при закрытии соединения
        log_to_render("[v2.11] Cleaning up connection...")
        
        # Отменяем задачу обработки событий от OpenAI
        if not openai_task.done():
            openai_task.cancel()
            try:
                await openai_task
            except asyncio.CancelledError:
                pass
        
        # Закрываем соединение с OpenAI
        await openai_client.disconnect()
        
        # Удаляем из активных соединений
        if connection_id in active_connections:
            del active_connections[connection_id]
        
        log_to_render(f"[v2.11] Connection closed. Active connections: {len(active_connections)}")
        
        # Закрываем WebSocket если еще открыт
        try:
            await websocket.close()
        except Exception:
            pass

# ✅ Экспортируем функцию с правильным именем для совместимости
async def handle_websocket_connection_new(websocket: WebSocket, assistant_id: str, db: SessionLocal):
    """Wrapper для совместимости с существующим кодом"""
    await handle_realtime_connection(websocket, assistant_id, db)

async def get_active_connections_count() -> int:
    """Возвращает количество активных соединений"""
    return len(active_connections)

async def disconnect_all():
    """Отключает все активные соединения"""
    log_to_render(f"[v2.11] Disconnecting all {len(active_connections)} connections...")
    
    for client in active_connections.values():
        try:
            await client.disconnect()
        except Exception as e:
            log_to_render(f"[v2.11] Error disconnecting client: {e}", "ERROR")
    
    active_connections.clear()
    log_to_render("[v2.11] All connections disconnected")
