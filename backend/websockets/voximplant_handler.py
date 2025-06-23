# backend/websockets/voximplant_handler.py - ИСПРАВЛЕННАЯ ВЕРСИЯ

"""
Voximplant WebSocket handler with proper protocol support.
Fixes audio decoding issues and connection handling.
"""

import asyncio
import json
import uuid
import base64
import time
from typing import Dict, Optional, Any
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.websockets.openai_client import OpenAIRealtimeClient
from backend.utils.audio_utils import base64_to_audio_buffer, audio_buffer_to_base64
from backend.services.user_service import UserService

logger = get_logger(__name__)

class VoximplantProtocolHandler:
    """
    Исправленный обработчик для Voximplant с правильной поддержкой протокола.
    """
    
    def __init__(self, voximplant_ws: WebSocket, assistant_id: str, db: Session):
        self.voximplant_ws = voximplant_ws
        self.assistant_id = assistant_id
        self.db = db
        self.client_id = str(uuid.uuid4())
        self.is_connected = False
        self.openai_client = None
        
        # Аудио настройки для PCM16
        self.audio_buffer = bytearray()
        self.last_audio_time = time.time()
        self.audio_chunk_size = 1280  # 40мс при 16kHz PCM16
        self.sample_rate = 16000
        self.is_audio_streaming = False
        
        # Статистика
        self.audio_packets_received = 0
        self.audio_bytes_received = 0
        self.sequence_number = 0
        
        # Фоновые задачи
        self.background_tasks = []
        
        # Флаг для отслеживания состояния соединения
        self.connection_closed = False
        
        logger.info(f"[VOXIMPLANT] Создан обработчик для assistant_id={assistant_id}")

    async def start(self):
        """Запускает обработчик с исправленной обработкой соединения"""
        try:
            await self.voximplant_ws.accept()
            self.is_connected = True
            logger.info(f"[VOXIMPLANT] WebSocket соединение принято")
            
            # Загружаем конфигурацию
            assistant = await self.load_assistant_config()
            if not assistant:
                return
            
            # Проверяем подписку
            if not await self.check_subscription(assistant):
                return
            
            # Получаем API ключ
            api_key = await self.get_api_key(assistant)
            if not api_key:
                await self.send_error("no_api_key", "Отсутствует ключ API OpenAI")
                return
                
            # Создаем OpenAI клиент
            self.openai_client = OpenAIRealtimeClient(
                api_key=api_key,
                assistant_config=assistant,
                client_id=self.client_id,
                db_session=self.db,
                user_agent="Voximplant/1.0"
            )
            
            # Подключаемся к OpenAI
            if not await self.openai_client.connect():
                await self.send_error("openai_connection_failed", "Не удалось подключиться к OpenAI")
                return
            
            # Отправляем статус готовности
            await self.send_message({
                "type": "connection_status",
                "status": "connected", 
                "message": "Connection established"
            })
            
            # Запускаем обработчики
            openai_task = asyncio.create_task(self.handle_openai_messages())
            voximplant_task = asyncio.create_task(self.handle_voximplant_messages())
            
            self.background_tasks.extend([openai_task, voximplant_task])
            
            # Ждем завершения любой из задач
            done, pending = await asyncio.wait(
                self.background_tasks, 
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Отменяем остальные задачи
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                    
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка в start(): {e}")
        finally:
            await self.cleanup()

    async def handle_voximplant_messages(self):
        """Обработка сообщений от Voximplant с исправленной обработкой протокола"""
        try:
            while self.is_connected and not self.connection_closed:
                try:
                    message = await self.voximplant_ws.receive()
                    
                    if "text" in message:
                        try:
                            data = json.loads(message["text"])
                            await self.process_voximplant_message(data)
                        except json.JSONDecodeError as e:
                            logger.warning(f"[VOXIMPLANT] Некорректный JSON: {e}")
                    elif "bytes" in message:
                        # Обрабатываем сырые аудио данные
                        await self.process_raw_audio_data(message["bytes"])
                        
                except WebSocketDisconnect:
                    logger.info(f"[VOXIMPLANT] WebSocket отключен")
                    self.connection_closed = True
                    break
                except ConnectionClosed:
                    logger.info(f"[VOXIMPLANT] Соединение закрыто")
                    self.connection_closed = True
                    break
                except Exception as e:
                    if "Cannot call \"receive\"" in str(e):
                        logger.info(f"[VOXIMPLANT] Соединение уже закрыто")
                        self.connection_closed = True
                        break
                    else:
                        logger.error(f"[VOXIMPLANT] Ошибка получения сообщения: {e}")
                        
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Критическая ошибка в handle_voximplant_messages: {e}")
        finally:
            self.is_connected = False

    async def process_voximplant_message(self, data: dict):
        """Обработка сообщений с правильной поддержкой протокола Voximplant"""
        # Проверяем, является ли это событием аудио протокола
        if "event" in data:
            await self.handle_voximplant_audio_event(data)
            return
            
        # Обработка обычных сообщений
        msg_type = data.get("type", "")
        
        if msg_type:
            logger.info(f"[VOXIMPLANT] Получено сообщение: {msg_type}")
        
        if msg_type == "call_started":
            logger.info(f"[VOXIMPLANT] Звонок начат: {data.get('caller_number')}")
            
        elif msg_type == "call_ended":
            logger.info(f"[VOXIMPLANT] Звонок завершен")
            self.connection_closed = True
            
        elif msg_type == "audio_ready":
            logger.info(f"[VOXIMPLANT] Аудио готово: {data.get('format', 'pcm16')}")

    async def handle_voximplant_audio_event(self, data: dict):
        """Исправленная обработка аудио событий Voximplant"""
        event_type = data.get("event")
        sequence_number = data.get("sequenceNumber", 0)
        
        if event_type == "start":
            # Начало аудио потока
            start_data = data.get("start", {})
            media_format = start_data.get("mediaFormat", {})
            encoding = media_format.get("encoding", "audio/x-mulaw")
            sample_rate = media_format.get("sampleRate", 8000)
            channels = media_format.get("channels", 1)
            
            logger.info(f"[VOXIMPLANT] ✅ Начало аудио: {encoding}, {sample_rate}Hz, {channels} канал(ов)")
            self.is_audio_streaming = True
            self.audio_packets_received = 0
            self.audio_bytes_received = 0
            
        elif event_type == "media":
            # Аудио данные в base64
            media_data = data.get("media", {})
            
            # ИСПРАВЛЕНИЕ: media может быть строкой или объектом
            if isinstance(media_data, str):
                audio_base64 = media_data
            elif isinstance(media_data, dict):
                audio_base64 = media_data.get("payload", "")
            else:
                logger.error(f"[VOXIMPLANT] Неожиданный формат media: {type(media_data)}")
                return
                
            if audio_base64 and self.is_audio_streaming:
                try:
                    # Декодируем base64 аудио
                    audio_bytes = base64.b64decode(audio_base64)
                    self.audio_packets_received += 1
                    self.audio_bytes_received += len(audio_bytes)
                    
                    # Логируем прогресс
                    if self.audio_packets_received % 10 == 0:
                        logger.info(f"[VOXIMPLANT] ✅ Пакетов: {self.audio_packets_received}, байт: {self.audio_bytes_received}")
                    
                    # Обрабатываем аудио
                    await self.process_audio_data(audio_bytes)
                    
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка декодирования аудио: {e}")
            
        elif event_type == "stop":
            # Окончание аудио потока
            stop_data = data.get("stop", {})
            media_info = stop_data.get("mediaInfo", {})
            bytes_sent = media_info.get("bytesSent", 0)
            duration = media_info.get("duration", 0)
            
            logger.info(f"[VOXIMPLANT] ✅ Конец аудио: {bytes_sent} байт, {duration} сек")
            logger.info(f"[VOXIMPLANT] ✅ Всего: пакетов={self.audio_packets_received}, байт={self.audio_bytes_received}")
            
            self.is_audio_streaming = False
            
            # Коммитим оставшееся аудио
            if self.openai_client and len(self.audio_buffer) > 0:
                logger.info(f"[VOXIMPLANT] Финальный коммит аудио")
                await self.openai_client.commit_audio()

    async def process_audio_data(self, audio_bytes: bytes):
        """Обработка аудио данных с правильным размером чанков"""
        if not self.openai_client or not audio_bytes:
            return
            
        try:
            # Добавляем в буфер
            self.audio_buffer.extend(audio_bytes)
            self.last_audio_time = time.time()
            
            # Отправляем чанками оптимального размера
            chunks_sent = 0
            while len(self.audio_buffer) >= self.audio_chunk_size:
                chunk = bytes(self.audio_buffer[:self.audio_chunk_size])
                self.audio_buffer = self.audio_buffer[self.audio_chunk_size:]
                
                # Отправляем в OpenAI
                if await self.openai_client.process_audio(chunk):
                    chunks_sent += 1
            
            if chunks_sent > 0:
                logger.debug(f"[VOXIMPLANT] Отправлено в OpenAI: {chunks_sent} чанков")
            
            # Автокоммит после паузы
            asyncio.create_task(self.auto_commit_audio())
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки аудио: {e}")

    async def process_raw_audio_data(self, audio_bytes: bytes):
        """Обработка сырых аудио данных (для обратной совместимости)"""
        logger.debug(f"[VOXIMPLANT] Получены сырые аудио: {len(audio_bytes)} байт")
        await self.process_audio_data(audio_bytes)

    async def auto_commit_audio(self):
        """Автоматический коммит после паузы в речи"""
        await asyncio.sleep(0.8)
        
        if time.time() - self.last_audio_time >= 0.7:
            if self.openai_client and not self.connection_closed:
                logger.info(f"[VOXIMPLANT] Автокоммит аудио в OpenAI")
                await self.openai_client.commit_audio()

    async def handle_openai_messages(self):
        """Обработка сообщений от OpenAI с правильной отправкой аудио"""
        if not self.openai_client or not self.openai_client.is_connected:
            return
            
        try:
            while self.is_connected and not self.connection_closed:
                try:
                    async for message in self.openai_client.receive_messages():
                        if self.connection_closed:
                            break
                        await self.process_openai_message(message)
                except ConnectionClosed:
                    logger.info("[VOXIMPLANT] OpenAI соединение закрыто")
                    break
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка получения от OpenAI: {e}")
                    await asyncio.sleep(1)
                    
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Критическая ошибка в handle_openai_messages: {e}")

    async def process_openai_message(self, message: dict):
        """Обработка сообщений от OpenAI с правильным форматом для Voximplant"""
        msg_type = message.get("type", "")
        
        # Логируем только важные события
        if msg_type not in ["response.audio.delta"]:
            logger.debug(f"[VOXIMPLANT] OpenAI: {msg_type}")
        
        # Отправляем ошибки и события функций
        if msg_type in ["error", "function_call.start", "function_call.completed"]:
            await self.send_message(message)
            
        # Обработка аудио от ассистента
        elif msg_type == "response.audio.delta":
            delta_audio = message.get("delta", "")
            if delta_audio:
                try:
                    # Декодируем аудио из base64
                    audio_bytes = base64.b64decode(delta_audio)
                    
                    # ВАЖНО: Отправляем аудио в формате протокола Voximplant
                    await self.send_audio_to_voximplant(audio_bytes)
                    
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка обработки аудио от OpenAI: {e}")
                    
        # Обработка транскрипций
        elif msg_type == "conversation.item.input_audio_transcription.completed":
            transcript = message.get("transcript", "")
            if transcript:
                logger.info(f"[VOXIMPLANT] 📝 Пользователь: '{transcript}'")
                
        elif msg_type == "response.audio_transcript.done":
            transcript = message.get("transcript", "")
            if transcript:
                logger.info(f"[VOXIMPLANT] 🤖 Ассистент: '{transcript}'")

    async def send_audio_to_voximplant(self, audio_bytes: bytes):
        """Отправка аудио в Voximplant в правильном формате протокола"""
        if not self.is_connected or self.connection_closed:
            return
            
        try:
            # Формируем сообщение по протоколу Voximplant
            self.sequence_number += 1
            
            # Кодируем аудио в base64
            audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
            
            # Создаем сообщение в формате протокола
            audio_message = {
                "event": "media",
                "sequenceNumber": self.sequence_number,
                "media": audio_base64
            }
            
            # Отправляем как JSON
            await self.voximplant_ws.send_text(json.dumps(audio_message))
            
            # Периодическое логирование
            if self.sequence_number % 50 == 0:
                logger.debug(f"[VOXIMPLANT] Отправлено {self.sequence_number} аудио пакетов")
                
        except Exception as e:
            if not self.connection_closed:
                logger.error(f"[VOXIMPLANT] Ошибка отправки аудио: {e}")

    async def send_message(self, message: dict):
        """Отправка сообщения в Voximplant"""
        if self.is_connected and not self.connection_closed:
            try:
                await self.voximplant_ws.send_text(json.dumps(message))
            except Exception as e:
                if not self.connection_closed:
                    logger.error(f"[VOXIMPLANT] Ошибка отправки сообщения: {e}")

    async def send_error(self, code: str, message: str):
        """Отправка ошибки в Voximplant"""
        try:
            await self.send_message({
                "type": "error",
                "error": {
                    "code": code,
                    "message": message
                }
            })
            await self.voximplant_ws.close(code=1008)
        except:
            pass

    async def cleanup(self):
        """Очистка ресурсов с правильным завершением"""
        logger.info(f"[VOXIMPLANT] Начало очистки")
        
        self.is_connected = False
        self.connection_closed = True
        self.is_audio_streaming = False
        
        # Отменяем все задачи
        for task in self.background_tasks:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        
        # Закрываем OpenAI клиент
        if self.openai_client:
            try:
                await self.openai_client.close()
            except:
                pass
        
        # Закрываем WebSocket если еще не закрыт
        try:
            if not self.voximplant_ws.client_state == 3:  # 3 = CLOSED
                await self.voximplant_ws.close()
        except:
            pass
            
        logger.info(f"[VOXIMPLANT] Очистка завершена. Статистика: пакетов={self.audio_packets_received}, байт={self.audio_bytes_received}")

    # Остальные методы остаются без изменений...
    async def load_assistant_config(self) -> Optional[AssistantConfig]:
        """Загружает конфигурацию ассистента"""
        try:
            if self.assistant_id == "demo":
                assistant = self.db.query(AssistantConfig).filter(
                    AssistantConfig.is_public.is_(True)
                ).first()
                if not assistant:
                    assistant = self.db.query(AssistantConfig).first()
            else:
                try:
                    uuid_obj = uuid.UUID(self.assistant_id)
                    assistant = self.db.query(AssistantConfig).get(uuid_obj)
                except ValueError:
                    assistant = self.db.query(AssistantConfig).filter(
                        AssistantConfig.id.cast(str) == self.assistant_id
                    ).first()
            
            if not assistant:
                await self.send_error("assistant_not_found", "Ассистент не найден")
                return None
                
            return assistant
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка загрузки ассистента: {e}")
            await self.send_error("server_error", "Ошибка загрузки ассистента")
            return None

    async def check_subscription(self, assistant: AssistantConfig) -> bool:
        """Проверяет подписку пользователя"""
        try:
            if not assistant.user_id or assistant.is_public:
                return True
                
            user = self.db.query(User).get(assistant.user_id)
            if not user or user.is_admin or user.email == "well96well@gmail.com":
                return True
                
            subscription_status = await UserService.check_subscription_status(
                self.db, str(user.id)
            )
            
            if not subscription_status["active"]:
                error_code = "TRIAL_EXPIRED" if subscription_status.get("is_trial") else "SUBSCRIPTION_EXPIRED"
                await self.send_error(error_code, "Подписка истекла")
                return False
                
            return True
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка проверки подписки: {e}")
            return True

    async def get_api_key(self, assistant: AssistantConfig) -> Optional[str]:
        """Получает API ключ OpenAI"""
        try:
            if assistant.user_id:
                user = self.db.query(User).get(assistant.user_id)
                if user and user.openai_api_key:
                    return user.openai_api_key
            return None
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка получения API ключа: {e}")
            return None


# Главная функция для обработки WebSocket соединения
async def handle_voximplant_websocket_with_protocol(websocket: WebSocket, assistant_id: str, db: Session):
    """
    Основная функция для обработки Voximplant WebSocket
    """
    handler = None
    try:
        # Создаем отдельную сессию БД для избежания проблем с потоками
        from backend.db.session import SessionLocal
        handler_db = SessionLocal()
        
        try:
            handler = VoximplantProtocolHandler(websocket, assistant_id, handler_db)
            await handler.start()
        finally:
            handler_db.close()
            
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Критическая ошибка: {e}")
        
        try:
            if not handler:
                await websocket.accept()
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": {"code": "server_error", "message": "Внутренняя ошибка сервера"}
            }))
        except:
            pass
        
        if handler:
            await handler.cleanup()
        else:
            try:
                await websocket.close()
            except:
                pass

# Для обратной совместимости
SimpleVoximplantHandler = VoximplantProtocolHandler
handle_voximplant_websocket_simple = handle_voximplant_websocket_with_protocol
