# backend/websockets/voximplant_adapter.py

import asyncio
import json
import uuid
import base64
import time
from typing import Dict, Optional, Any
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.models.user import User
from backend.utils.audio_utils import base64_to_audio_buffer, audio_buffer_to_base64
from backend.services.user_service import UserService

logger = get_logger(__name__)

class MockWebSocket:
    """
    Мок WebSocket для создания внутренней связи между Voximplant адаптером 
    и существующим обработчиком ассистента
    """
    def __init__(self, partner=None):
        self.partner = partner
        self.message_queue = asyncio.Queue()
        self.is_closed = False
        self.client_state = type('ClientState', (), {'CONNECTED': 1})()
        
    async def accept(self):
        """Имитирует принятие WebSocket соединения"""
        pass
        
    async def send_json(self, data: dict):
        """Отправляет JSON сообщение партнеру"""
        if not self.is_closed and self.partner:
            await self.partner.message_queue.put({"type": "json", "data": data})
            
    async def send_bytes(self, data: bytes):
        """Отправляет байтовые данные партнеру"""
        if not self.is_closed and self.partner:
            await self.partner.message_queue.put({"type": "bytes", "data": data})
            
    async def send_text(self, data: str):
        """Отправляет текстовые данные партнеру"""
        if not self.is_closed and self.partner:
            await self.partner.message_queue.put({"type": "text", "data": data})
            
    async def receive(self):
        """Получает сообщение из очереди"""
        if self.is_closed:
            raise WebSocketDisconnect()
        
        try:
            message = await asyncio.wait_for(self.message_queue.get(), timeout=0.1)
            if message["type"] == "json":
                return {"text": json.dumps(message["data"])}
            elif message["type"] == "bytes":
                return {"bytes": message["data"]}
            else:
                return {"text": message["data"]}
        except asyncio.TimeoutError:
            # Возвращаем пустое сообщение при таймауте для неблокирующего чтения
            await asyncio.sleep(0.01)
            return await self.receive()
                    
    async def close(self):
        """Закрывает WebSocket соединение"""
        self.is_closed = True
        if self.partner:
            self.partner.is_closed = True

class VoximplantAdapter:
    """
    Адаптер для интеграции Voximplant с существующим обработчиком WebSocket ассистента.
    Конвертирует протокол Voximplant в формат, совместимый с OpenAI Realtime API.
    """
    
    def __init__(self, voximplant_ws: WebSocket, assistant_id: str, db: Session):
        self.voximplant_ws = voximplant_ws
        self.assistant_id = assistant_id
        self.db = db
        self.client_id = str(uuid.uuid4())
        self.is_connected = False
        self.assistant_ws = None
        self.server_ws = None
        
        # Буфер для накопления аудио данных от Voximplant
        self.audio_buffer = bytearray()
        self.last_audio_time = time.time()
        self.audio_chunk_size = 640  # 20мс при 16kHz, 16bit mono = 640 байт
        
        # Задачи для фонового выполнения
        self.background_tasks = []
        
        logger.info(f"[VOXIMPLANT] Создан адаптер для assistant_id={assistant_id}, client_id={self.client_id}")

    async def start(self):
        """Запускает адаптер и устанавливает соединения"""
        try:
            await self.voximplant_ws.accept()
            self.is_connected = True
            logger.info(f"[VOXIMPLANT] WebSocket соединение принято от Voximplant")
            
            # Создаем внутреннее соединение с обработчиком ассистента
            await self.create_internal_connection()
            
            # Отправляем статус подключения в Voximplant
            await self.send_to_voximplant({
                "type": "connection_status",
                "status": "connected",
                "message": "Ассистент готов к работе"
            })
            
            # Запускаем обработку сообщений от Voximplant
            await self.handle_voximplant_messages()
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка запуска адаптера: {e}")
            await self.cleanup()

    async def create_internal_connection(self):
        """Создает внутреннее соединение с обработчиком ассистента"""
        try:
            # Создаем пару WebSocket соединений для внутренней связи
            self.server_ws, self.assistant_ws = self.create_websocket_pair()
            
            # Импортируем обработчик здесь, чтобы избежать циклических импортов
            from backend.websockets.handler import handle_websocket_connection
            
            # Запускаем обработчик ассистента в отдельной задаче
            assistant_task = asyncio.create_task(
                handle_websocket_connection(self.server_ws, self.assistant_id, self.db)
            )
            self.background_tasks.append(assistant_task)
            
            # Запускаем обработку ответов от ассистента
            response_task = asyncio.create_task(self.handle_assistant_responses())
            self.background_tasks.append(response_task)
            
            logger.info(f"[VOXIMPLANT] Внутреннее соединение с ассистентом установлено")
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка создания внутреннего соединения: {e}")
            raise

    def create_websocket_pair(self):
        """Создает пару связанных WebSocket соединений для внутренней связи"""
        server_ws = MockWebSocket()
        client_ws = MockWebSocket(server_ws)
        server_ws.partner = client_ws
        
        return server_ws, client_ws

    async def handle_voximplant_messages(self):
        """Обрабатывает сообщения от Voximplant"""
        try:
            while self.is_connected:
                message = await self.voximplant_ws.receive()
                
                if "text" in message:
                    try:
                        data = json.loads(message["text"])
                        await self.handle_text_message(data)
                    except json.JSONDecodeError:
                        logger.warning(f"[VOXIMPLANT] Некорректный JSON: {message['text'][:100]}")
                elif "bytes" in message:
                    await self.handle_audio_message(message["bytes"])
                    
        except WebSocketDisconnect:
            logger.info(f"[VOXIMPLANT] Соединение закрыто")
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки сообщений: {e}")
        finally:
            await self.cleanup()

    async def handle_text_message(self, data: dict):
        """Обрабатывает текстовые сообщения от Voximplant"""
        msg_type = data.get("type", "")
        
        logger.info(f"[VOXIMPLANT] Получено сообщение: {msg_type}")
        
        if msg_type == "call_started":
            # Звонок начался - инициализируем сессию
            caller_number = data.get("caller_number", "unknown")
            call_id = data.get("call_id", "unknown")
            
            logger.info(f"[VOXIMPLANT] Звонок начат: caller={caller_number}, call_id={call_id}")
            
            # Отправляем начальное сообщение ассистенту для инициализации
            await self.send_to_assistant({
                "type": "session.update",
                "session": {
                    "caller_number": caller_number,
                    "call_id": call_id,
                    "platform": "voximplant"
                }
            })
            
        elif msg_type == "call_ended":
            # Звонок завершен
            logger.info(f"[VOXIMPLANT] Звонок завершен: {data.get('call_id')}")
            await self.cleanup()
            
        elif msg_type == "interruption.manual":
            # Ручное перебивание
            await self.send_to_assistant({
                "type": "interruption.manual",
                "event_id": f"voximplant_interrupt_{int(time.time() * 1000)}"
            })
            
        elif msg_type == "microphone.state":
            # Состояние микрофона
            mic_enabled = data.get("enabled", True)
            logger.info(f"[VOXIMPLANT] Микрофон: {'включен' if mic_enabled else 'выключен'}")

    async def handle_audio_message(self, audio_data: bytes):
        """Обрабатывает аудио данные от Voximplant"""
        try:
            # Накапливаем аудио в буфере
            self.audio_buffer.extend(audio_data)
            self.last_audio_time = time.time()
            
            # Отправляем аудио чанками оптимального размера
            while len(self.audio_buffer) >= self.audio_chunk_size:
                chunk = bytes(self.audio_buffer[:self.audio_chunk_size])
                self.audio_buffer = self.audio_buffer[self.audio_chunk_size:]
                
                # Конвертируем в base64 для отправки ассистенту
                audio_b64 = audio_buffer_to_base64(chunk)
                
                # Отправляем в формате OpenAI Realtime API
                await self.send_to_assistant({
                    "type": "input_audio_buffer.append",
                    "audio": audio_b64,
                    "event_id": f"voximplant_audio_{int(time.time() * 1000)}"
                })
            
            # Запускаем автоматический коммит через паузу
            asyncio.create_task(self.auto_commit_audio())
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки аудио: {e}")

    async def auto_commit_audio(self):
        """Автоматически коммитит аудио буфер после паузы"""
        # Ждем паузу для определения конца речи
        await asyncio.sleep(0.5)
        
        # Если после паузы нет нового аудио - коммитим буфер
        if time.time() - self.last_audio_time >= 0.4:
            await self.send_to_assistant({
                "type": "input_audio_buffer.commit",
                "event_id": f"voximplant_commit_{int(time.time() * 1000)}"
            })

    async def handle_assistant_responses(self):
        """Обрабатывает ответы от ассистента"""
        try:
            while self.is_connected and self.assistant_ws and not self.assistant_ws.is_closed:
                try:
                    message = await self.assistant_ws.receive()
                    
                    if "text" in message:
                        response = json.loads(message["text"])
                        await self.handle_assistant_response(response)
                    elif "bytes" in message:
                        # Аудио от ассистента - отправляем в Voximplant
                        await self.voximplant_ws.send_bytes(message["bytes"])
                        
                except asyncio.TimeoutError:
                    # Таймаут - это нормально, продолжаем
                    continue
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка чтения ответа ассистента: {e}")
                    break
                    
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки ответов ассистента: {e}")

    async def handle_assistant_response(self, response: dict):
        """Обрабатывает конкретный ответ от ассистента"""
        msg_type = response.get("type", "")
        
        # Пробрасываем важные события в Voximplant
        if msg_type in [
            "error", 
            "function_call.start", 
            "function_call.completed",
            "session.interrupted",
            "conversation.interrupted"
        ]:
            await self.send_to_voximplant(response)
        
        # Специальная обработка аудио событий
        elif msg_type == "response.audio.delta":
            # Аудио от ассистента - декодируем и отправляем в Voximplant
            delta_audio = response.get("delta", "")
            if delta_audio:
                try:
                    audio_bytes = base64_to_audio_buffer(delta_audio)
                    await self.voximplant_ws.send_bytes(audio_bytes)
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка отправки аудио: {e}")
        
        # Обработка событий начала и окончания речи ассистента
        elif msg_type == "assistant.speech.started":
            await self.send_to_voximplant({
                "type": "assistant_speaking",
                "speaking": True,
                "timestamp": time.time()
            })
            
        elif msg_type == "assistant.speech.ended":
            await self.send_to_voximplant({
                "type": "assistant_speaking", 
                "speaking": False,
                "timestamp": time.time()
            })

    async def send_to_assistant(self, message: dict):
        """Отправляет сообщение ассистенту"""
        if self.assistant_ws and not self.assistant_ws.is_closed:
            try:
                await self.assistant_ws.send_json(message)
            except Exception as e:
                logger.error(f"[VOXIMPLANT] Ошибка отправки сообщения ассистенту: {e}")

    async def send_to_voximplant(self, message: dict):
        """Отправляет сообщение в Voximplant"""
        if self.is_connected:
            try:
                await self.voximplant_ws.send_text(json.dumps(message))
            except Exception as e:
                logger.error(f"[VOXIMPLANT] Ошибка отправки сообщения в Voximplant: {e}")

    async def cleanup(self):
        """Очищает ресурсы"""
        logger.info(f"[VOXIMPLANT] Начало очистки адаптера для client_id={self.client_id}")
        
        self.is_connected = False
        
        # Отменяем все фоновые задачи
        for task in self.background_tasks:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка при отмене задачи: {e}")
        
        # Закрываем внутренние WebSocket соединения
        if self.assistant_ws and not self.assistant_ws.is_closed:
            await self.assistant_ws.close()
            
        if self.server_ws and not self.server_ws.is_closed:
            await self.server_ws.close()
            
        logger.info(f"[VOXIMPLANT] Адаптер очищен для client_id={self.client_id}")


async def handle_voximplant_websocket(websocket: WebSocket, assistant_id: str, db: Session):
    """
    Основная функция для обработки WebSocket соединений от Voximplant.
    
    Args:
        websocket: WebSocket соединение от Voximplant
        assistant_id: ID ассистента для подключения
        db: Сессия базы данных
    """
    adapter = None
    try:
        # Проверяем существование ассистента
        if assistant_id == "demo":
            # Для демо используем первый публичный ассистент
            assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(AssistantConfig).first()
            logger.info(f"[VOXIMPLANT] Использование ассистента {assistant.id if assistant else 'None'} для демо")
        else:
            # Ищем ассистента по ID
            try:
                uuid_obj = uuid.UUID(assistant_id)
                assistant = db.query(AssistantConfig).get(uuid_obj)
            except ValueError:
                assistant = db.query(AssistantConfig).filter(AssistantConfig.id.cast(str) == assistant_id).first()

        if not assistant:
            logger.error(f"[VOXIMPLANT] Ассистент {assistant_id} не найден")
            await websocket.accept()
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Assistant not found"}
            }))
            await websocket.close(code=1008)
            return

        # Проверяем подписку пользователя (если ассистент не публичный)
        if assistant.user_id and not assistant.is_public:
            user = db.query(User).get(assistant.user_id)
            if user and not user.is_admin and user.email != "well96well@gmail.com":
                subscription_status = await UserService.check_subscription_status(db, str(user.id))
                
                if not subscription_status["active"]:
                    logger.warning(f"[VOXIMPLANT] Доступ заблокирован для пользователя {user.id} - подписка истекла")
                    
                    await websocket.accept()
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "error": {
                            "code": "SUBSCRIPTION_EXPIRED",
                            "message": "Подписка истекла. Обновите подписку для продолжения использования.",
                            "subscription_status": subscription_status,
                            "requires_payment": True
                        }
                    }))
                    await websocket.close(code=1008)
                    return

        # Создаем и запускаем адаптер
        adapter = VoximplantAdapter(websocket, assistant_id, db)
        await adapter.start()
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка обработки WebSocket: {e}")
        
        # Попытка отправить ошибку клиенту перед закрытием
        try:
            if not adapter:
                await websocket.accept()
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": {
                    "code": "server_error",
                    "message": "Внутренняя ошибка сервера"
                }
            }))
        except:
            pass
        
        if adapter:
            await adapter.cleanup()
        else:
            try:
                await websocket.close()
            except:
                pass
