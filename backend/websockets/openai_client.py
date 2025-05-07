# backend/websockets/handler.py
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
import time
from typing import Dict, List, Optional, Set
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.openai_client import OpenAIRealtimeClient
from backend.services.assistant_service import AssistantService

logger = get_logger(__name__)

# Активные соединения по каждому assistant_id
active_connections: Dict[str, List[WebSocket]] = {}

# Активные OpenAI клиенты по идентификаторам WebSocket
active_clients: Dict[str, OpenAIRealtimeClient] = {}

# Лимиты и счетчики для защиты от перегрузки
connection_limits: Dict[str, int] = {}  # Лимиты подключений по IP
rate_limits: Dict[str, List[float]] = {}  # Временные метки запросов по IP
blocked_ips: Dict[str, float] = {}  # Заблокированные IP с временем блокировки (в секундах)
block_warnings: Dict[str, int] = {}  # Счетчик предупреждений для прогрессивной блокировки

# Константы для лимитов
MAX_CONNECTIONS_PER_IP = 5       # Максимальное число одновременных соединений с одного IP
MAX_REQUESTS_PER_MINUTE = 30     # Максимальное число запросов в минуту
BLOCK_DURATION_BASE = 60         # Базовая длительность блокировки (сек)
EXCESSIVE_REQUESTS_MULTIPLIER = 3 # Множитель для определения чрезмерных запросов


async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    Обрабатывает WebSocket соединение для голосового ассистента.
    
    Args:
        websocket: WebSocket соединение
        assistant_id: ID ассистента
        db: Сессия базы данных
    """
    client_id = str(uuid.uuid4())
    openai_client = None
    response_task = None
    client_ip = websocket.client.host if hasattr(websocket, "client") else "unknown"
    
    # Проверка на блокировку IP
    if await is_ip_blocked(client_ip):
        try:
            await websocket.accept()
            remaining_time = int(blocked_ips[client_ip] - time.time())
            if remaining_time > 0:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "ip_blocked", 
                        "message": f"Ваш IP временно заблокирован из-за превышения лимитов. Повторите через {remaining_time} секунд."
                    }
                })
            else:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "ip_blocked", 
                        "message": "Ваш IP временно заблокирован из-за превышения лимитов."
                    }
                })
            await websocket.close(code=1008)
            return
        except Exception:
            return

    # Проверка ограничения количества соединений по IP
    if not await check_connection_limits(client_ip):
        try:
            await websocket.accept()
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "connection_limit", 
                    "message": f"Превышено максимальное число одновременных подключений ({MAX_CONNECTIONS_PER_IP})."
                }
            })
            await websocket.close(code=1008)
            return
        except Exception:
            return

    try:
        # Принимаем соединение
        await websocket.accept()
        logger.info(f"✅ WebSocket соединение принято: client_id={client_id}, assistant_id={assistant_id}, ip={client_ip}")

        # Регистрируем соединение
        active_connections.setdefault(assistant_id, []).append(websocket)
        
        # Поиск ассистента
        try:
            # Демо режим
            if assistant_id == "demo":
                assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
                if not assistant:
                    assistant = db.query(AssistantConfig).first()
                logger.info(f"🔍 Используется ассистент {assistant.id if assistant else 'None'} для демо")
            else:
                # Поиск по UUID
                try:
                    uuid_obj = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).get(uuid_obj)
                    logger.info(f"🔍 Загружен ассистент: {assistant.id}, имя: {assistant.name}")
                except ValueError:
                    # Поиск по строковому ID
                    assistant = db.query(AssistantConfig).filter(AssistantConfig.id.cast(str) == assistant_id).first()
                    if assistant:
                        logger.info(f"🔍 Загружен ассистент по строковому ID: {assistant.id}, имя: {assistant.name}")
        except Exception as e:
            logger.error(f"❌ Ошибка при поиске ассистента: {e}")
            assistant = None

        if not assistant:
            logger.error(f"❌ Ассистент не найден: {assistant_id}")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
            })
            await websocket.close(code=1008)
            return
        
        # Увеличиваем счетчик разговоров для статистики
        asyncio.create_task(AssistantService.increment_conversation_count(db, str(assistant.id)))

        # Получение API ключа пользователя
        api_key = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user and user.openai_api_key:
                api_key = user.openai_api_key
                logger.info(f"🔑 Найден API ключ пользователя для ассистента")
            else:
                logger.warning(f"⚠️ API ключ не найден для пользователя {user.id if user else 'None'}")

        if not api_key:
            logger.error("❌ Отсутствует ключ API OpenAI для ассистента")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Отсутствует ключ API OpenAI. Пожалуйста, добавьте ключ в настройках личного кабинета."}
            })
            await websocket.close(code=1008)
            return

        # Создание клиента OpenAI
        openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
        active_clients[client_id] = openai_client
        
        # Подключение к OpenAI
        if not await openai_client.connect():
            logger.error("❌ Не удалось подключиться к OpenAI")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "openai_connection_failed", "message": "Failed to connect to OpenAI"}
            })
            await websocket.close(code=1008)
            return

        # Запускаем асинхронную задачу для прослушивания ответов от OpenAI
        response_task = asyncio.create_task(openai_client.listen_for_responses(websocket))

        # Логируем информацию о функциях ассистента
        if hasattr(assistant, 'functions') and assistant.functions:
            enabled_functions = assistant.functions.get("enabled_functions", [])
            logger.info(f"🔧 Доступные функции ассистента ({len(enabled_functions)}): {', '.join(enabled_functions) if enabled_functions else 'нет'}")

        # Отправляем подтверждение подключения
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected",
            "assistant": {
                "id": str(assistant.id),
                "name": assistant.name,
                "voice": assistant.voice
            }
        })

        # Сбрасываем счетчик предупреждений при новом соединении
        if client_ip in block_warnings:
            # Уменьшаем, но не сбрасываем полностью, чтобы сохранить историю нарушений
            block_warnings[client_ip] = max(0, block_warnings[client_ip] - 1)

        excessive_warnings = 0  # Счетчик чрезмерных предупреждений
        has_blocked = False     # Флаг, что соединение было заблокировано

        # Основной цикл обработки сообщений от клиента
        while True:
            try:
                data = await websocket.receive_json()
            except json.JSONDecodeError:
                logger.warning(f"⚠️ Получены некорректные JSON данные от {client_ip}")
                continue
            
            # Проверка ограничения частоты запросов
            rate_check_result = await check_rate_limits(client_ip)
            
            if rate_check_result == "blocked":
                # IP был заблокирован из-за превышения лимита
                has_blocked = True
                
                # Отправляем сообщение о блокировке
                block_time = int(blocked_ips[client_ip] - time.time())
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "rate_limit_exceeded", 
                        "message": f"Превышен лимит запросов. Ваш IP заблокирован на {block_time} секунд."
                    }
                })
                
                # Закрываем соединение при первой блокировке
                if excessive_warnings == 0:
                    logger.warning(f"🚫 Закрытие соединения для {client_ip} из-за блокировки IP")
                    break
                    
                # Продолжаем счетчик предупреждений
                excessive_warnings += 1
                continue
                
            elif rate_check_result == "warning":
                # Предупреждение о приближении к лимиту
                excessive_warnings += 1
                
                # Закрываем соединение при чрезмерном превышении лимита
                if excessive_warnings > 10:
                    logger.warning(f"🚫 Закрытие соединения для {client_ip} из-за чрезмерного превышения лимита ({excessive_warnings} предупреждений)")
                    
                    await websocket.send_json({
                        "type": "error",
                        "error": {
                            "code": "excessive_requests", 
                            "message": "Соединение закрыто из-за чрезмерной активности."
                        }
                    })
                    break
                
                # Отправляем предупреждение (не каждый раз, чтобы не спамить)
                if excessive_warnings % 5 == 0:
                    await websocket.send_json({
                        "type": "warning",
                        "warning": {
                            "code": "approaching_rate_limit", 
                            "message": "Приближение к лимиту запросов. Пожалуйста, снизьте частоту запросов."
                        }
                    })
                
                continue

            # Обработка запросов
            if data["type"] == "audio":
                logger.info("🎤 Пользователь закончил говорить, обрабатываем аудио")
                try:
                    audio_buffer = base64_to_audio_buffer(data["audio"])
                    await openai_client.process_audio(audio_buffer, websocket)
                except Exception as e:
                    logger.error(f"❌ Ошибка при обработке аудио: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "audio_processing_error", "message": "Error processing audio"}
                    })
                    
            elif data["type"] == "ping":
                # Простой пинг для проверки соединения
                await websocket.send_json({
                    "type": "pong", 
                    "timestamp": data.get("timestamp"),
                    "server_time": time.time()
                })
                
            elif data["type"] == "clear_audio":
                # Очистка буфера аудио
                logger.info("🧹 Запрос на очистку аудио буфера")
                await openai_client.clear_audio_buffer()
                await websocket.send_json({
                    "type": "audio_buffer_cleared"
                })
                
            elif data["type"] == "stop_response":
                # Остановка текущего ответа
                logger.info("🛑 Запрос на остановку ответа")
                await websocket.send_json({
                    "type": "stop_acknowledged"
                })

    except WebSocketDisconnect:
        logger.info(f"🔌 Клиент отключился: client_id={client_id}")
    except ConnectionClosed:
        logger.info(f"🔌 Соединение закрыто: client_id={client_id}")
    except Exception as e:
        logger.error(f"❌ Ошибка в WebSocket цикле: {e}")
        # Попытка отправить сообщение об ошибке клиенту
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {"code": "internal_error", "message": f"Произошла ошибка: {str(e)}"}
                })
        except Exception:
            pass
    finally:
        # Отменяем задачу прослушивания ответов
        if response_task:
            response_task.cancel()
            try:
                await response_task
            except asyncio.CancelledError:
                pass
        
        # Закрываем клиент OpenAI
        if openai_client:
            await openai_client.close()
            
        # Удаляем из активных клиентов
        if client_id in active_clients:
            del active_clients[client_id]
        
        # Удаляем из активных соединений
        if assistant_id in active_connections and websocket in active_connections[assistant_id]:
            active_connections[assistant_id].remove(websocket)
            if not active_connections[assistant_id]:
                del active_connections[assistant_id]
        
        # Уменьшаем счетчик соединений по IP
        if client_ip in connection_limits:
            connection_limits[client_ip] -= 1
            if connection_limits[client_ip] <= 0:
                del connection_limits[client_ip]
        
        logger.info(f"🔌 Удалено WebSocket соединение: client_id={client_id}")

async def is_ip_blocked(client_ip: str) -> bool:
    """
    Проверяет, заблокирован ли IP-адрес.
    
    Args:
        client_ip: IP-адрес клиента
        
    Returns:
        bool: True если IP заблокирован, False если нет
    """
    if client_ip not in blocked_ips:
        return False
        
    # Проверяем, не истекло ли время блокировки
    block_until = blocked_ips[client_ip]
    if time.time() > block_until:
        # Разблокируем IP
        del blocked_ips[client_ip]
        return False
        
    return True

async def check_connection_limits(client_ip: str) -> bool:
    """
    Проверяет ограничение на количество одновременных соединений с одного IP.
    
    Args:
        client_ip: IP-адрес клиента
        
    Returns:
        bool: True если лимит не превышен, False если превышен
    """
    current = connection_limits.get(client_ip, 0)
    if current >= MAX_CONNECTIONS_PER_IP:
        logger.warning(f"⚠️ Превышен лимит соединений для IP {client_ip}: {current}/{MAX_CONNECTIONS_PER_IP}")
        return False
        
    connection_limits[client_ip] = current + 1
    return True

async def check_rate_limits(client_ip: str) -> str:
    """
    Проверяет ограничение частоты запросов с одного IP.
    
    Args:
        client_ip: IP-адрес клиента
        
    Returns:
        str: 
            - "ok" - лимит не превышен
            - "warning" - лимит превышен, но не критично
            - "blocked" - IP заблокирован из-за превышения лимита
    """
    # Проверяем, не заблокирован ли уже IP
    if await is_ip_blocked(client_ip):
        return "blocked"
    
    now = time.time()
    
    # Инициализируем список временных меток, если его еще нет
    if client_ip not in rate_limits:
        rate_limits[client_ip] = []
        
    # Добавляем текущую временную метку
    rate_limits[client_ip].append(now)
    
    # Удаляем устаревшие метки (старше 60 секунд)
    rate_limits[client_ip] = [t for t in rate_limits[client_ip] if t > now - 60]
    
    # Текущее количество запросов за последнюю минуту
    current_requests = len(rate_limits[client_ip])
    
    # Блокируем IP при чрезмерном превышении лимита
    if current_requests > MAX_REQUESTS_PER_MINUTE:
        # Регистрируем предупреждение при превышении лимита
        logger.warning(f"⚠️ Превышен лимит запросов для IP {client_ip}: {current_requests}/{MAX_REQUESTS_PER_MINUTE} за 60с")
        
        # Проверяем чрезмерное превышение (более чем в EXCESSIVE_REQUESTS_MULTIPLIER раз)
        if current_requests > MAX_REQUESTS_PER_MINUTE * EXCESSIVE_REQUESTS_MULTIPLIER:
            # Увеличиваем счетчик предупреждений
            block_warnings[client_ip] = block_warnings.get(client_ip, 0) + 1
            
            # Блокируем IP при повторном чрезмерном превышении
            if block_warnings[client_ip] >= 2:
                # Прогрессивная длительность блокировки
                block_duration = BLOCK_DURATION_BASE * (2 ** (block_warnings[client_ip] - 1))
                block_duration = min(block_duration, 3600 * 6)  # Максимум 6 часов
                
                # Устанавливаем время блокировки
                blocked_ips[client_ip] = now + block_duration
                
                logger.warning(f"🚫 IP {client_ip} заблокирован на {block_duration} секунд после {block_warnings[client_ip]} предупреждений")
                return "blocked"
                
        return "warning"
        
    return "ok"

async def broadcast_to_assistant(assistant_id: str, message: dict) -> None:
    """
    Отправляет сообщение всем активным соединениям для указанного ассистента.
    
    Args:
        assistant_id: ID ассистента
        message: Сообщение для отправки
    """
    if assistant_id not in active_connections:
        return
        
    disconnected = []
    
    for connection in active_connections[assistant_id]:
        try:
            await connection.send_json(message)
        except Exception:
            disconnected.append(connection)
            
    # Удаляем отключенные соединения
    for conn in disconnected:
        if conn in active_connections[assistant_id]:
            active_connections[assistant_id].remove(conn)
            
    if not active_connections[assistant_id]:
        del active_connections[assistant_id]

async def close_all_connections() -> None:
    """
    Закрывает все активные WebSocket соединения. 
    Используется при завершении работы сервера.
    """
    logger.info("🔌 Закрытие всех WebSocket соединений...")
    
    # Закрываем все OpenAI клиенты
    for client_id, client in active_clients.items():
        try:
            await client.close()
        except Exception as e:
            logger.error(f"❌ Ошибка при закрытии OpenAI клиента {client_id}: {e}")
    
    active_clients.clear()
    
    # Закрываем все WebSocket соединения
    for assistant_id, connections in active_connections.items():
        for connection in connections:
            try:
                await connection.close(code=1001)
            except Exception as e:
                logger.error(f"❌ Ошибка при закрытии WebSocket соединения: {e}")
    
    active_connections.clear()
    connection_limits.clear()
    rate_limits.clear()
    blocked_ips.clear()
    block_warnings.clear()
    
    logger.info("✅ Все WebSocket соединения закрыты")

# Периодическая очистка устаревших данных
async def cleanup_task():
    """
    Периодически очищает устаревшие данные о лимитах и блокировках.
    Запускается как фоновая задача при старте приложения.
    """
    while True:
        try:
            now = time.time()
            
            # Очистка устаревших данных лимитов частоты запросов
            for ip in list(rate_limits.keys()):
                rate_limits[ip] = [t for t in rate_limits[ip] if t > now - 60]
                if not rate_limits[ip]:
                    del rate_limits[ip]
            
            # Очистка истекших блокировок
            for ip in list(blocked_ips.keys()):
                if blocked_ips[ip] <= now:
                    del blocked_ips[ip]
                    logger.info(f"✅ IP {ip} разблокирован (истек срок блокировки)")
            
            # Снижение счетчиков предупреждений со временем
            for ip in list(block_warnings.keys()):
                # Если нет активного подключения и нет активной блокировки, постепенно снижаем счетчик
                if ip not in connection_limits and ip not in blocked_ips:
                    block_warnings[ip] = max(0, block_warnings[ip] - 1)
                    if block_warnings[ip] == 0:
                        del block_warnings[ip]
                        
        except Exception as e:
            logger.error(f"❌ Ошибка в задаче очистки: {e}")
            
        # Запускаем каждые 5 минут
        await asyncio.sleep(300)
