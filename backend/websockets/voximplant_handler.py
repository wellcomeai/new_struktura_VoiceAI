# backend/websockets/voximplant_handler.py - ВЕРСИЯ 2.1 ИСПРАВЛЕННАЯ

"""
Voximplant WebSocket handler - Version 2.1 Optimized
Direct integration with proper protocol support.
Улучшена обработка соединений и исправлены ошибки закрытия WebSocket.
"""

import asyncio
import json
import uuid
import base64
import time
import traceback
from typing import Dict, Optional, Any, Set
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.models.conversation import Conversation
from backend.websockets.openai_client_new import OpenAIRealtimeClientNew
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.services.user_service import UserService
from backend.services.google_sheets_service import GoogleSheetsService
from backend.functions import execute_function, normalize_function_name

logger = get_logger(__name__)


class VoximplantProtocolHandler:
    """
    Оптимизированный обработчик v2.1 для прямой интеграции Voximplant с OpenAI.
    Исправлена обработка закрытия соединений и остановки задач.
    """
    
    def __init__(self, websocket: WebSocket, assistant_id: str, db: Session):
        self.websocket = websocket
        self.assistant_id = assistant_id
        self.db = db
        self.client_id = str(uuid.uuid4())
        
        # OpenAI клиент
        self.openai_client: Optional[OpenAIRealtimeClient] = None
        
        # Состояние соединения
        self.is_connected = False
        self.connection_closed = False
        self.websocket_closed = False
        
        # Протокол Voximplant
        self.sequence_number = 0
        self.chunk_number = 0
        self.stream_started = False
        self.stream_start_time = time.time()
        
        # Аудио настройки
        self.sample_rate = 16000
        self.channels = 1
        self.encoding = "audio/pcm16"
        
        # Буферы
        self.incoming_audio_buffer = bytearray()
        self.outgoing_audio_buffer = bytearray()
        self.audio_chunk_size = 1280  # 40мс при 16kHz
        
        # Таймеры
        self.last_audio_time = time.time()
        self.start_time = time.time()
        
        # Транскрипции для логирования
        self.user_transcript = ""
        self.assistant_transcript = ""
        self.function_result = None
        
        # Фоновые задачи
        self.background_tasks: Set[asyncio.Task] = set()
        
        # Статистика
        self.audio_packets_received = 0
        self.audio_bytes_received = 0
        self._audio_sent_count = 0
        
        logger.info(f"[VOX-v2] Создан оптимизированный обработчик для {assistant_id}")

    async def start(self):
        """Запуск обработчика с оптимизированной архитектурой."""
        try:
            await self.websocket.accept()
            self.is_connected = True
            logger.info("[VOX-v2] WebSocket соединение принято")
            
            # Загружаем конфигурацию ассистента
            assistant = await self._load_assistant_config()
            if not assistant:
                return
            
            # Проверяем подписку
            if not await self._check_subscription(assistant):
                return
            
            # Получаем API ключ
            api_key = await self._get_api_key(assistant)
            if not api_key:
                await self._send_error("no_api_key", "Отсутствует ключ API OpenAI")
                return
            
            # Создаем и подключаем OpenAI клиент
            self.openai_client = OpenAIRealtimeClient(
                api_key=api_key,
                assistant_config=assistant,
                client_id=self.client_id,
                db_session=self.db,
                user_agent="Voximplant/2.1"
            )
            
            if not await self.openai_client.connect():
                await self._send_error("openai_connection_failed", "Не удалось подключиться к OpenAI")
                return
            
            # Отправляем статус готовности
            await self._send_message({
                "type": "connection_status",
                "status": "connected",
                "message": "Connection established",
                "protocol_version": "2.1"
            })
            
            # Запускаем обработчики
            await self._start_message_handlers()
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка запуска: {e}")
            logger.error(f"[VOX-v2] Трассировка: {traceback.format_exc()}")
            await self._send_error("server_error", str(e))
        finally:
            await self.cleanup()

    async def _start_message_handlers(self):
        """Запуск обработчиков сообщений."""
        try:
            # Создаем задачи для обработки
            voximplant_task = asyncio.create_task(self._handle_voximplant_messages())
            openai_task = asyncio.create_task(self._handle_openai_messages())
            
            self.background_tasks.add(voximplant_task)
            self.background_tasks.add(openai_task)
            
            # Ждем завершения любой из задач
            done, pending = await asyncio.wait(
                self.background_tasks,
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Устанавливаем флаг закрытия соединения
            self.connection_closed = True
            
            # Отменяем оставшиеся задачи с таймаутом
            for task in pending:
                if not task.done():
                    task.cancel()
            
            # Ждем отмены задач с таймаутом
            if pending:
                try:
                    await asyncio.wait(pending, timeout=2.0)
                except Exception as e:
                    logger.error(f"[VOX-v2] Ошибка ожидания отмены задач: {e}")
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка в обработчике сообщений: {e}")
            self.connection_closed = True  # Устанавливаем флаг при ошибке
        finally:
            # Гарантируем установку флага закрытия соединения
            self.connection_closed = True
            logger.info("[VOX-v2] Обработчики сообщений завершены")

    async def _handle_voximplant_messages(self):
        """Обработка сообщений от Voximplant."""
        try:
            while self.is_connected and not self.connection_closed and not self.websocket_closed:
                try:
                    # Дополнительная проверка перед вызовом receive
                    if self.connection_closed or self.websocket_closed:
                        break
                        
                    message = await self.websocket.receive()
                    
                    if "text" in message:
                        data = json.loads(message["text"])
                        await self._process_voximplant_message(data)
                    elif "bytes" in message:
                        # v2.0: Обрабатываем сырые байты как fallback
                        await self._process_raw_audio_fallback(message["bytes"])
                        
                except WebSocketDisconnect:
                    logger.info("[VOX-v2] WebSocket отключен")
                    self.connection_closed = True
                    self.websocket_closed = True
                    break
                except ConnectionClosed:
                    logger.info("[VOX-v2] Соединение закрыто")
                    self.connection_closed = True
                    self.websocket_closed = True
                    break
                except json.JSONDecodeError as e:
                    logger.error(f"[VOX-v2] Ошибка JSON: {e}")
                except Exception as e:
                    logger.error(f"[VOX-v2] Ошибка обработки: {e}")
                    # Если ошибка связана с закрытым соединением - завершаем
                    if "disconnect message" in str(e) or "receive" in str(e):
                        logger.warning("[VOX-v2] Обнаружена ошибка закрытого соединения, завершаем обработку")
                        self.connection_closed = True
                        self.websocket_closed = True
                        break
        finally:
            # Устанавливаем флаг закрытия соединения
            self.connection_closed = True
            logger.info("[VOX-v2] Обработчик сообщений Voximplant завершен")

    async def _process_voximplant_message(self, data: Dict[str, Any]):
        """Обработка конкретного сообщения от Voximplant."""
        if self.connection_closed:
            return
            
        msg_type = data.get("type")
        event = data.get("event")
        
        # Обработка по типу сообщения
        if msg_type == "call_started":
            await self._handle_call_started(data)
            
        elif msg_type == "call_ended":
            await self._handle_call_ended(data)
            
        elif msg_type == "audio_ready":
            logger.info(f"[VOX-v2] Аудио готово: {data.get('format')}")
            
        # Обработка событий протокола медиа-стриминга
        elif event == "start":
            await self._handle_stream_start(data)
            
        elif event == "media":
            await self._handle_media_data(data)
            
        elif event == "stop":
            await self._handle_stream_stop(data)
            
        # Обработка управляющих команд
        elif msg_type == "interruption.manual":
            await self._handle_interruption()
        
        # Обработка повторения последнего ответа
        elif msg_type == "repeat_last_response":
            await self._handle_repeat_last_response()

    async def _handle_call_started(self, data: Dict[str, Any]):
        """Обработка начала звонка."""
        if self.connection_closed:
            return
            
        caller = data.get("caller_number", "unknown")
        call_id = data.get("call_id", "unknown")
        
        logger.info(f"[VOX-v2] Звонок начат: {caller}, ID: {call_id}")
        
        # Создаем запись в БД
        if self.db and self.openai_client:
            try:
                conv = Conversation(
                    assistant_id=self.openai_client.assistant_config.id,
                    session_id=self.openai_client.session_id,
                    user_message="",
                    assistant_message="",
                    metadata={
                        "caller": caller,
                        "call_id": call_id,
                        "source": "voximplant",
                        "protocol": "v2.1"
                    }
                )
                self.db.add(conv)
                self.db.commit()
                self.db.refresh(conv)
                self.openai_client.conversation_record_id = str(conv.id)
                logger.info(f"[VOX-v2] Создана запись разговора: {conv.id}")
            except Exception as e:
                logger.error(f"[VOX-v2] Ошибка создания записи: {e}")

    async def _handle_stream_start(self, data: Dict[str, Any]):
        """Обработка начала аудио-стрима."""
        if self.connection_closed:
            return
            
        start_info = data.get("start", {})
        media_format = start_info.get("mediaFormat", {})
        
        self.encoding = media_format.get("encoding", "audio/pcm16")
        self.sample_rate = media_format.get("sampleRate", 16000)
        self.channels = media_format.get("channels", 1)
        
        logger.info(f"[VOX-v2] Начало стрима: {self.encoding}, {self.sample_rate}Hz, {self.channels}ch")
        
        self.stream_started = True
        self.stream_start_time = time.time()

    async def _handle_media_data(self, data: Dict[str, Any]):
        """Обработка аудио данных от Voximplant по протоколу v2.0."""
        if self.connection_closed or not self.openai_client or not self.stream_started:
            return
        
        media = data.get("media", {})
        payload = media.get("payload", "")
        
        if not payload:
            return
        
        try:
            # Декодируем base64 аудио
            audio_bytes = base64.b64decode(payload)
            
            # Обновляем статистику
            self.audio_packets_received += 1
            self.audio_bytes_received += len(audio_bytes)
            
            # Добавляем в буфер
            self.incoming_audio_buffer.extend(audio_bytes)
            self.last_audio_time = time.time()
            
            # Обрабатываем буфер чанками
            while len(self.incoming_audio_buffer) >= self.audio_chunk_size:
                chunk = bytes(self.incoming_audio_buffer[:self.audio_chunk_size])
                self.incoming_audio_buffer = self.incoming_audio_buffer[self.audio_chunk_size:]
                
                # Отправляем в OpenAI если соединение активно
                if not self.connection_closed and self.openai_client.is_connected:
                    await self.openai_client.process_audio(chunk)
            
            # Запускаем автокоммит если соединение активно
            if not self.connection_closed:
                asyncio.create_task(self._auto_commit_audio())
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка обработки аудио: {e}")

    async def _process_raw_audio_fallback(self, audio_bytes: bytes):
        """Fallback для обработки сырых аудио данных (совместимость с v1.0)."""
        if self.connection_closed or not self.openai_client or not audio_bytes:
            return
            
        try:
            # Добавляем в буфер
            self.incoming_audio_buffer.extend(audio_bytes)
            self.last_audio_time = time.time()
            
            # Обрабатываем чанками
            while len(self.incoming_audio_buffer) >= self.audio_chunk_size:
                chunk = bytes(self.incoming_audio_buffer[:self.audio_chunk_size])
                self.incoming_audio_buffer = self.incoming_audio_buffer[self.audio_chunk_size:]
                
                # Отправляем в OpenAI если соединение активно
                if not self.connection_closed and self.openai_client.is_connected:
                    await self.openai_client.process_audio(chunk)
            
            # Автокоммит если соединение активно
            if not self.connection_closed:
                asyncio.create_task(self._auto_commit_audio())
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка обработки сырого аудио: {e}")

    async def _auto_commit_audio(self):
        """Автоматический коммит аудио после паузы."""
        try:
            await asyncio.sleep(0.5)
            
            # Проверяем флаг закрытия соединения
            if self.connection_closed or not self.openai_client:
                return
                
            if time.time() - self.last_audio_time >= 0.4:
                if self.openai_client.is_connected and len(self.incoming_audio_buffer) > 0:
                    # Отправляем остаток буфера
                    chunk = bytes(self.incoming_audio_buffer)
                    self.incoming_audio_buffer.clear()
                    await self.openai_client.process_audio(chunk)
                
                # Коммитим если соединение активно
                if not self.connection_closed and self.openai_client.is_connected:
                    await self.openai_client.commit_audio()
                    logger.info("[VOX-v2] Автокоммит аудио")
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка в автокоммите: {e}")

    async def _handle_openai_messages(self):
        """Обработка сообщений от OpenAI."""
        if not self.openai_client:
            return
        
        try:
            async for message in self.openai_client.receive_messages():
                # Проверка флага закрытия соединения
                if self.connection_closed:
                    break
                    
                await self._process_openai_message(message)
                
        except ConnectionClosed:
            logger.info("[VOX-v2] Соединение с OpenAI закрыто")
            self.connection_closed = True
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка обработки OpenAI: {e}")
            # Устанавливаем флаг закрытия соединения при ошибке
            self.connection_closed = True
        finally:
            logger.info("[VOX-v2] Обработчик сообщений OpenAI завершен")

    async def _process_openai_message(self, message: Dict[str, Any]):
        """Обработка сообщения от OpenAI."""
        if self.connection_closed:
            return
            
        msg_type = message.get("type", "")
        
        # Обработка ошибок
        if msg_type == "error":
            await self._send_message(message)
            
        # Обработка аудио от ассистента
        elif msg_type == "response.audio.delta":
            delta = message.get("delta", "")
            if delta:
                try:
                    audio_bytes = base64.b64decode(delta)
                    await self._send_audio_to_voximplant(audio_bytes)
                except Exception as e:
                    logger.error(f"[VOX-v2] Ошибка отправки аудио: {e}")
                    
        # Транскрипции для логирования
        elif msg_type == "conversation.item.input_audio_transcription.completed":
            self.user_transcript = message.get("transcript", "")
            logger.info(f"[VOX-v2] 👤 User: {self.user_transcript}")
            
        elif msg_type == "response.audio_transcript.done":
            self.assistant_transcript = message.get("transcript", "")
            logger.info(f"[VOX-v2] 🤖 Assistant: {self.assistant_transcript}")
            
        # События функций
        elif msg_type == "response.function_call_arguments.done":
            await self._handle_function_call(message)
            
        # Завершение ответа - логирование
        elif msg_type == "response.done":
            await self._log_conversation()

    async def _send_audio_to_voximplant(self, audio_bytes: bytes):
        """Отправка аудио в Voximplant по правильному протоколу v2.0."""
        if self.connection_closed or self.websocket_closed:
            return
        
        # Начинаем стрим если еще не начали
        if not self.stream_started:
            await self._start_audio_stream()
        
        # Буферизируем аудио
        self.outgoing_audio_buffer.extend(audio_bytes)
        
        # Отправляем чанками
        chunk_size = 640  # 20мс при 16kHz
        
        while len(self.outgoing_audio_buffer) >= chunk_size and not self.connection_closed:
            chunk = self.outgoing_audio_buffer[:chunk_size]
            self.outgoing_audio_buffer = self.outgoing_audio_buffer[chunk_size:]
            
            # Формируем сообщение по протоколу
            self.sequence_number += 1
            self.chunk_number += 1
            
            message = {
                "event": "media",
                "sequenceNumber": self.sequence_number,
                "media": {
                    "chunk": self.chunk_number,
                    "timestamp": int((time.time() - self.stream_start_time) * 1000),
                    "payload": base64.b64encode(chunk).decode('utf-8')
                }
            }
            
            await self._send_message(message)
            self._audio_sent_count += 1
            
            # Периодическое логирование
            if self._audio_sent_count % 50 == 0:
                logger.info(f"[VOX-v2] ➡️ Отправлено аудио: {self._audio_sent_count} пакетов")

    async def _start_audio_stream(self):
        """Начало аудио стрима в Voximplant."""
        if self.connection_closed or self.websocket_closed:
            return
            
        self.stream_started = True
        self.stream_start_time = time.time()
        self.sequence_number = 0
        self.chunk_number = 0
        
        message = {
            "event": "start",
            "sequenceNumber": self.sequence_number,
            "start": {
                "mediaFormat": {
                    "encoding": self.encoding,
                    "sampleRate": self.sample_rate,
                    "channels": self.channels
                }
            }
        }
        
        await self._send_message(message)
        logger.info("[VOX-v2] Начат аудио стрим в Voximplant")

    async def _handle_function_call(self, message: Dict[str, Any]):
        """Обработка вызова функции."""
        if self.connection_closed:
            return
            
        function_name = message.get("function_name")
        arguments_str = message.get("arguments", "{}")
        call_id = message.get("call_id")
        
        if not function_name or not call_id:
            return
        
        try:
            arguments = json.loads(arguments_str)
            
            # Уведомляем Voximplant
            await self._send_message({
                "type": "function_call.start",
                "function": function_name,
                "function_call_id": call_id
            })
            
            # Выполняем функцию
            result = await execute_function(
                name=function_name,
                arguments=arguments,
                context={
                    "assistant_config": self.openai_client.assistant_config,
                    "client_id": self.client_id,
                    "db_session": self.db
                }
            )
            
            self.function_result = result
            
            # Отправляем результат в OpenAI
            if not self.connection_closed and self.openai_client and self.openai_client.is_connected:
                await self.openai_client.send_function_result(call_id, result)
            
            # Уведомляем Voximplant
            await self._send_message({
                "type": "function_call.completed",
                "function": function_name,
                "function_call_id": call_id,
                "result": result
            })
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка выполнения функции: {e}")

    async def _handle_interruption(self):
        """Обработка перебивания."""
        if self.connection_closed:
            return
            
        if self.openai_client:
            await self.openai_client.handle_interruption()
            
        await self._send_message({
            "type": "conversation.interrupted",
            "timestamp": time.time()
        })
        
        logger.info("[VOX-v2] Перебивание обработано")

    async def _handle_repeat_last_response(self):
        """Обработка запроса на повторение последнего ответа."""
        if self.connection_closed or not self.openai_client:
            return
            
        logger.info("[VOX-v2] Запрос на повторение последнего ответа")
        
        # Отправляем специальное сообщение в OpenAI
        try:
            await self.openai_client.create_response_after_function()
            
            await self._send_message({
                "type": "repeating_last_response",
                "timestamp": time.time()
            })
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка повторения ответа: {e}")

    async def _handle_call_ended(self, data: Dict[str, Any]):
        """Обработка завершения звонка."""
        logger.info(f"[VOX-v2] Звонок завершен: {data.get('call_id')}")
        
        # Останавливаем стрим
        if self.stream_started:
            await self._stop_audio_stream()
        
        self.connection_closed = True

    async def _handle_stream_stop(self, data: Dict[str, Any]):
        """Обработка остановки стрима."""
        stop_info = data.get("stop", {})
        media_info = stop_info.get("mediaInfo", {})
        
        duration = media_info.get("duration", 0)
        bytes_sent = media_info.get("bytesSent", 0)
        
        logger.info(f"[VOX-v2] Стрим остановлен: {duration}s, {bytes_sent} bytes")
        
        self.stream_started = False

    async def _stop_audio_stream(self):
        """Остановка аудио стрима."""
        if not self.stream_started or self.connection_closed or self.websocket_closed:
            return
        
        try:
            # Отправляем оставшееся аудио
            if len(self.outgoing_audio_buffer) > 0:
                chunk = bytes(self.outgoing_audio_buffer)
                self.outgoing_audio_buffer.clear()
                
                self.sequence_number += 1
                message = {
                    "event": "media",
                    "sequenceNumber": self.sequence_number,
                    "media": {
                        "chunk": self.chunk_number + 1,
                        "timestamp": int((time.time() - self.stream_start_time) * 1000),
                        "payload": base64.b64encode(chunk).decode('utf-8')
                    }
                }
                await self._send_message(message)
            
            # Отправляем событие stop
            self.sequence_number += 1
            message = {
                "event": "stop",
                "sequenceNumber": self.sequence_number,
                "stop": {
                    "mediaInfo": {
                        "duration": int(time.time() - self.stream_start_time),
                        "bytesSent": self.chunk_number * 640
                    }
                }
            }
            
            await self._send_message(message)
            self.stream_started = False
            logger.info("[VOX-v2] Аудио стрим остановлен")
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка остановки аудио стрима: {e}")
            self.stream_started = False

    async def _log_conversation(self):
        """Логирование разговора в БД и Google Sheets."""
        if self.connection_closed:
            return
            
        try:
            # Сохраняем в БД
            if self.db and self.openai_client and self.openai_client.conversation_record_id:
                try:
                    conv = self.db.query(Conversation).get(
                        uuid.UUID(self.openai_client.conversation_record_id)
                    )
                    if conv:
                        conv.user_message = self.user_transcript
                        conv.assistant_message = self.assistant_transcript
                        conv.metadata = {
                            **(conv.metadata or {}),
                            "duration": int(time.time() - self.start_time),
                            "audio_packets": self.audio_packets_received,
                            "audio_bytes": self.audio_bytes_received
                        }
                        self.db.commit()
                        logger.info("[VOX-v2] Разговор сохранен в БД")
                except Exception as e:
                    logger.error(f"[VOX-v2] Ошибка сохранения в БД: {e}")
            
            # Логируем в Google Sheets
            if self.openai_client and self.openai_client.assistant_config:
                assistant_config = self.openai_client.assistant_config
                if hasattr(assistant_config, 'google_sheet_id') and assistant_config.google_sheet_id:
                    try:
                        await GoogleSheetsService.log_conversation(
                            sheet_id=assistant_config.google_sheet_id,
                            user_message=self.user_transcript,
                            assistant_message=self.assistant_transcript,
                            function_result=self.function_result
                        )
                        logger.info("[VOX-v2] Разговор записан в Google Sheets")
                    except Exception as e:
                        logger.error(f"[VOX-v2] Ошибка записи в Google Sheets: {e}")
            
            # Сбрасываем транскрипции
            self.user_transcript = ""
            self.assistant_transcript = ""
            self.function_result = None
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка логирования разговора: {e}")

    async def _send_message(self, message: Dict[str, Any]):
        """Отправка сообщения в Voximplant."""
        if not self.is_connected or self.connection_closed or self.websocket_closed:
            return
            
        try:
            await self.websocket.send_text(json.dumps(message))
        except WebSocketDisconnect:
            logger.warning("[VOX-v2] WebSocket отключен при отправке сообщения")
            self.websocket_closed = True
            self.connection_closed = True
        except ConnectionClosed:
            logger.warning("[VOX-v2] Соединение закрыто при отправке сообщения")
            self.websocket_closed = True
            self.connection_closed = True
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка отправки: {e}")
            if "disconnect message" in str(e) or "receive" in str(e):
                self.websocket_closed = True
                self.connection_closed = True

    async def _send_error(self, code: str, message: str):
        """Отправка ошибки в Voximplant."""
        try:
            await self._send_message({
                "type": "error",
                "error": {
                    "code": code,
                    "message": message
                }
            })
            
            # Закрываем WebSocket только если он не закрыт
            if not self.websocket_closed:
                await self.websocket.close(code=1008)
                self.websocket_closed = True
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка отправки сообщения об ошибке: {e}")
            self.websocket_closed = True
            self.connection_closed = True

    async def cleanup(self):
        """Очистка ресурсов."""
        logger.info("[VOX-v2] Начало очистки")
        
        # Первым делом устанавливаем флаги закрытия
        self.is_connected = False
        self.connection_closed = True
        
        # Логируем статистику
        if self.audio_packets_received > 0:
            duration = self.audio_bytes_received / (self.sample_rate * 2)
            logger.info(f"[VOX-v2] ✅ Статистика: {self.audio_packets_received} пакетов, {duration:.1f} сек")
        
        # Останавливаем стрим если активен
        if self.stream_started:
            try:
                await self._stop_audio_stream()
            except Exception as e:
                logger.error(f"[VOX-v2] Ошибка остановки стрима: {e}")
        
        # Отменяем фоновые задачи с таймаутом
        try:
            for task in self.background_tasks:
                if not task.done():
                    task.cancel()
            
            # Ждем отмены задач с таймаутом
            pending_tasks = [t for t in self.background_tasks if not t.done()]
            if pending_tasks:
                await asyncio.wait(pending_tasks, timeout=2.0)
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка при отмене задач: {e}")
        
        # Закрываем OpenAI клиент
        if self.openai_client:
            try:
                await self.openai_client.close()
            except Exception as e:
                logger.error(f"[VOX-v2] Ошибка закрытия OpenAI клиента: {e}")
        
        # Закрываем WebSocket с обработкой ошибок
        if not self.websocket_closed:
            try:
                if hasattr(self.websocket, 'client_state') and self.websocket.client_state != 3:
                    await self.websocket.close(code=1000)
                    self.websocket_closed = True
            except Exception as e:
                logger.error(f"[VOX-v2] Ошибка закрытия WebSocket: {e}")
        
        logger.info("[VOX-v2] Очистка завершена")

    async def _load_assistant_config(self) -> Optional[AssistantConfig]:
        """Загрузка конфигурации ассистента."""
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
                await self._send_error("assistant_not_found", "Ассистент не найден")
                return None
            
            return assistant
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка загрузки ассистента: {e}")
            await self._send_error("server_error", "Ошибка загрузки ассистента")
            return None

    async def _check_subscription(self, assistant: AssistantConfig) -> bool:
        """Проверка подписки пользователя."""
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
                await self._send_error(error_code, "Подписка истекла")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка проверки подписки: {e}")
            return True

    async def _get_api_key(self, assistant: AssistantConfig) -> Optional[str]:
        """Получение API ключа OpenAI."""
        try:
            if assistant.user_id:
                user = self.db.query(User).get(assistant.user_id)
                if user and user.openai_api_key:
                    return user.openai_api_key
            return None
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка получения API ключа: {e}")
            return None


# Основная функция для v2.1
async def handle_voximplant_websocket_with_protocol(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
):
    """
    Точка входа для оптимизированного Voximplant WebSocket обработчика v2.1.
    Исправлена обработка закрытия соединений и предотвращены ошибки повторного вызова receive().
    """
    handler = None
    try:
        # Создаем отдельную сессию БД
        from backend.db.session import SessionLocal
        handler_db = SessionLocal()
        
        try:
            handler = VoximplantProtocolHandler(websocket, assistant_id, handler_db)
            await handler.start()
        except Exception as e:
            logger.error(f"[VOX-v2] Ошибка в обработчике: {e}")
            logger.error(f"[VOX-v2] Трассировка: {traceback.format_exc()}")
        finally:
            handler_db.close()
            
    except Exception as e:
        logger.error(f"[VOX-v2] Критическая ошибка: {e}")
        logger.error(f"[VOX-v2] Трассировка: {traceback.format_exc()}")
        
        try:
            if not handler:
                try:
                    await websocket.accept()
                except:
                    pass
                    
            try:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": {"code": "server_error", "message": "Внутренняя ошибка сервера"}
                }))
            except:
                pass
        except:
            pass
        
        if handler:
            try:
                await handler.cleanup()
            except:
                pass
        else:
            try:
                await websocket.close()
            except:
                pass


# Для обратной совместимости - оставляем старые названия
SimpleVoximplantHandler = VoximplantProtocolHandler
handle_voximplant_websocket_simple = handle_voximplant_websocket_with_protocol
