import asyncio
import json
import logging
import time
from typing import Dict, Any, Optional
from fastapi import WebSocket, WebSocketDisconnect
from backend.openai_client import OpenAIRealtimeClient
from backend.database import get_assistant_config, get_openai_api_key

logger = logging.getLogger(__name__)

class WebSocketHandler:
    """
    Обработчик WebSocket соединений с поддержкой мгновенного прерывания ассистента
    """
    
    def __init__(self, websocket: WebSocket, assistant_id: str):
        self.websocket = websocket
        self.assistant_id = assistant_id
        self.openai_client: Optional[OpenAIRealtimeClient] = None
        self.is_connected = False
        self.last_ping_time = 0
        self.connection_start_time = time.time()
        
        # Статистика соединения
        self.messages_sent = 0
        self.messages_received = 0
        self.audio_chunks_processed = 0
        
    async def handle_connection(self):
        """Основная функция обработки WebSocket соединения"""
        try:
            # Принимаем соединение
            await self.websocket.accept()
            logger.info(f"WebSocket соединение установлено для assistant_id: {self.assistant_id}")
            
            # Отправляем статус подключения
            await self.send_message({
                "type": "connection_status",
                "status": "connected",
                "assistant_id": self.assistant_id,
                "timestamp": time.time()
            })
            
            # Получаем конфигурацию ассистента
            assistant_config = await get_assistant_config(self.assistant_id)
            if not assistant_config:
                await self.send_error("Assistant not found", "ASSISTANT_NOT_FOUND")
                return
            
            # Получаем API ключ
            api_key = await get_openai_api_key(self.assistant_id)
            if not api_key:
                await self.send_error("OpenAI API key not configured", "API_KEY_MISSING")
                return
            
            # Создаем и подключаем OpenAI клиент
            self.openai_client = OpenAIRealtimeClient(api_key, assistant_config)
            self.openai_client.set_message_handler(self.handle_openai_message)
            
            success = await self.openai_client.connect()
            if not success:
                await self.send_error("Failed to connect to OpenAI", "OPENAI_CONNECTION_ERROR")
                return
            
            self.is_connected = True
            logger.info(f"OpenAI клиент подключен для assistant_id: {self.assistant_id}")
            
            # Запускаем задачи для обработки сообщений
            await asyncio.gather(
                self.listen_for_client_messages(),
                self.openai_client.listen_for_messages(),
                return_exceptions=True
            )
            
        except WebSocketDisconnect:
            logger.info(f"WebSocket соединение закрыто клиентом: {self.assistant_id}")
        except Exception as e:
            logger.error(f"Ошибка в WebSocket обработчике: {e}")
            await self.send_error(f"Connection error: {str(e)}", "CONNECTION_ERROR")
        finally:
            await self.cleanup()
    
    async def listen_for_client_messages(self):
        """Прослушивание сообщений от клиента"""
        try:
            while self.is_connected:
                try:
                    # Получаем сообщение от клиента
                    raw_message = await self.websocket.receive_text()
                    self.messages_received += 1
                    
                    try:
                        data = json.loads(raw_message)
                        msg_type = data.get("type")
                        
                        if not msg_type:
                            logger.warning("Получено сообщение без типа")
                            continue
                        
                        logger.debug(f"[CLIENT] Получено сообщение типа: {msg_type}")
                        
                        # Обработка пинга
                        if msg_type == "ping":
                            await self.handle_ping(data)
                            continue
                        
                        # Проверяем, что OpenAI клиент готов
                        if not self.openai_client or not self.openai_client.is_connected:
                            logger.warning(f"OpenAI клиент не готов для сообщения типа: {msg_type}")
                            continue
                        
                        # КРИТИЧЕСКИ ВАЖНАЯ ОБРАБОТКА КОМАНД ПРЕРЫВАНИЯ
                        if msg_type == "response.cancel":
                            await self.handle_response_cancel(data)
                            continue
                        
                        if msg_type == "output_audio_buffer.clear":
                            await self.handle_output_audio_buffer_clear(data)
                            continue
                        
                        if msg_type == "conversation.item.truncate":
                            await self.handle_conversation_item_truncate(data)
                            continue
                        
                        # Обработка аудио данных
                        if msg_type == "input_audio_buffer.append":
                            await self.handle_audio_append(data)
                            continue
                        
                        if msg_type == "input_audio_buffer.commit":
                            await self.handle_audio_commit(data)
                            continue
                        
                        if msg_type == "input_audio_buffer.clear":
                            await self.handle_audio_clear(data)
                            continue
                        
                        # Обработка создания ответа
                        if msg_type == "response.create":
                            await self.handle_response_create(data)
                            continue
                        
                        # Обработка результатов функций
                        if msg_type == "function_call_output":
                            await self.handle_function_call_output(data)
                            continue
                        
                        # Аварийная остановка (для критических случаев)
                        if msg_type == "emergency_stop":
                            await self.handle_emergency_stop(data)
                            continue
                        
                        # Обработка неизвестных типов сообщений
                        logger.warning(f"Неизвестный тип сообщения от клиента: {msg_type}")
                        
                    except json.JSONDecodeError as e:
                        logger.error(f"Ошибка парсинга JSON от клиента: {e}")
                        await self.send_error("Invalid JSON format", "JSON_PARSE_ERROR")
                        continue
                        
                except WebSocketDisconnect:
                    logger.info("Клиент отключился")
                    break
                except Exception as e:
                    logger.error(f"Ошибка при получении сообщения от клиента: {e}")
                    continue
                    
        except Exception as e:
            logger.error(f"Критическая ошибка в listen_for_client_messages: {e}")
        finally:
            self.is_connected = False
    
    async def handle_response_cancel(self, data: Dict[str, Any]):
        """
        Обработка команды отмены ответа с поддержкой мгновенного прерывания
        
        Args:
            data: Данные команды отмены от клиента
        """
        item_id = data.get("item_id")
        sample_count = data.get("sample_count", 0)
        was_playing_audio = data.get("was_playing_audio", False)
        
        logger.info(f"[INTERRUPTION] Получен запрос на отмену: item_id={item_id}, sample_count={sample_count}, was_playing={was_playing_audio}")
        
        success = False
        if self.openai_client and self.openai_client.is_connected:
            # ВАЖНО: НЕ ждем ACK здесь, отправляем команду асинхронно
            success = await self.openai_client.cancel_response(item_id, sample_count, was_playing_audio)
            logger.info(f"[INTERRUPTION] Команда отмены отправлена в OpenAI: success={success}")
        else:
            logger.warning("[INTERRUPTION] OpenAI клиент не подключен")
            
        # НЕ отправляем ACK здесь - он будет отправлен из handle_openai_message
        # когда получим реальный ACK от OpenAI
    
    async def handle_output_audio_buffer_clear(self, data: Dict[str, Any]):
        """Обработка команды очистки выходного аудио буфера"""
        logger.info("[INTERRUPTION] Получена команда очистки выходного аудио буфера")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.clear_output_audio_buffer()
            logger.info(f"[INTERRUPTION] Выходной буфер очищен: success={success}")
        else:
            logger.warning("[INTERRUPTION] Не удалось очистить выходной буфер - OpenAI не подключен")
    
    async def handle_conversation_item_truncate(self, data: Dict[str, Any]):
        """Обработка команды обрезки элемента разговора"""
        item_id = data.get("item_id")
        content_index = data.get("content_index", 0)
        audio_end_ms = data.get("audio_end_ms", 0)
        
        logger.info(f"[INTERRUPTION] Получена команда обрезки: item_id={item_id}, audio_end_ms={audio_end_ms}")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.truncate_conversation_item(item_id, content_index, audio_end_ms)
            logger.info(f"[INTERRUPTION] Элемент обрезан: success={success}")
        else:
            logger.warning("[INTERRUPTION] Не удалось обрезать элемент - OpenAI не подключен")
    
    async def handle_emergency_stop(self, data: Dict[str, Any]):
        """Обработка аварийной остановки"""
        logger.warning("[INTERRUPTION] Получена команда аварийной остановки!")
        
        if self.openai_client and self.openai_client.is_connected:
            # Отправляем несколько команд для полной остановки
            await asyncio.gather(
                self.openai_client.cancel_response(),
                self.openai_client.clear_output_audio_buffer(),
                self.openai_client.clear_input_audio_buffer(),
                return_exceptions=True
            )
            
        await self.send_message({
            "type": "emergency_stop.ack",
            "success": True,
            "timestamp": time.time()
        })
    
    async def handle_audio_append(self, data: Dict[str, Any]):
        """Обработка добавления аудио данных"""
        audio_data = data.get("audio")
        if not audio_data:
            logger.warning("Получен пустой аудио блок")
            return
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.append_audio(audio_data)
            if success:
                self.audio_chunks_processed += 1
            else:
                logger.error("Ошибка при добавлении аудио в OpenAI")
    
    async def handle_audio_commit(self, data: Dict[str, Any]):
        """Обработка коммита аудио буфера"""
        logger.debug("Получена команда коммита аудио буфера")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.commit_audio()
            if not success:
                logger.error("Ошибка при коммите аудио в OpenAI")
    
    async def handle_audio_clear(self, data: Dict[str, Any]):
        """Обработка очистки входного аудио буфера"""
        logger.debug("Получена команда очистки входного аудио буфера")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.clear_input_audio_buffer()
            if not success:
                logger.error("Ошибка при очистке входного аудио буфера")
    
    async def handle_response_create(self, data: Dict[str, Any]):
        """Обработка создания нового ответа"""
        logger.debug("Получена команда создания ответа")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.create_response()
            if not success:
                logger.error("Ошибка при создании ответа в OpenAI")
    
    async def handle_function_call_output(self, data: Dict[str, Any]):
        """Обработка результата выполнения функции"""
        call_id = data.get("call_id")
        output = data.get("output", "")
        
        logger.info(f"Получен результат функции для call_id: {call_id}")
        
        if self.openai_client and self.openai_client.is_connected:
            success = await self.openai_client.send_function_call_output(call_id, output)
            if success:
                # Запрашиваем новый ответ после выполнения функции
                await self.openai_client.create_response()
            else:
                logger.error("Ошибка при отправке результата функции")
    
    async def handle_ping(self, data: Dict[str, Any]):
        """Обработка пинга от клиента"""
        client_timestamp = data.get("timestamp", time.time())
        
        await self.send_message({
            "type": "pong",
            "client_timestamp": client_timestamp,
            "server_timestamp": time.time()
        })
        
        self.last_ping_time = time.time()
    
    async def handle_openai_message(self, data: Dict[str, Any]):
        """
        Обработка сообщений от OpenAI API с поддержкой обогащения ACK для прерывания
        
        Args:
            data: Данные сообщения от OpenAI
        """
        try:
            msg_type = data.get("type")
            
            logger.debug(f"[OPENAI] Получено сообщение типа: {msg_type}")
            
            # КРИТИЧЕСКИ ВАЖНАЯ ОБРАБОТКА response.cancel.ack
            if msg_type == "response.cancel.ack":
                logger.info(f"[INTERRUPTION] Получен response.cancel.ack от OpenAI: {data}")
                
                # Обогащаем ACK данными из сохраненного payload
                enriched_ack = self.openai_client.enrich_cancel_ack(data)
                
                # Отправляем обогащенный ACK клиенту
                await self.send_message(enriched_ack)
                logger.info(f"[INTERRUPTION] Отправлен обогащенный cancel.ack клиенту")
                return
            
            # Обработка output_audio_buffer.clear.ack
            if msg_type == "output_audio_buffer.clear.ack":
                logger.info(f"[INTERRUPTION] Получен output_audio_buffer.clear.ack: success={data.get('success', False)}")
                await self.send_message(data)
                return
            
            # Обработка conversation.item.truncate.ack
            if msg_type == "conversation.item.truncate.ack":
                logger.info(f"[INTERRUPTION] Получен conversation.item.truncate.ack: success={data.get('success', False)}")
                await self.send_message(data)
                return
            
            # Обработка ошибок
            if msg_type == "error":
                error_code = data.get("error", {}).get("code", "")
                error_message = data.get("error", {}).get("message", "")
                
                # Специальная обработка ошибок отмены
                if "cancel" in error_message.lower() or "response" in error_message.lower():
                    logger.warning(f"[INTERRUPTION] Ошибка отмены от OpenAI: {error_message}")
                    
                    # Отправляем клиенту информацию об ошибке отмены
                    await self.send_message({
                        "type": "response.cancel.ack",
                        "success": False,
                        "error": error_message,
                        "original_item_id": None,
                        "original_sample_count": 0,
                        "original_was_playing": False
                    })
                    return
                
                logger.error(f"Ошибка от OpenAI: {error_message} (код: {error_code})")
                await self.send_message(data)
                return
            
            # Обработка session событий
            if msg_type in ["session.created", "session.updated"]:
                logger.info(f"Сессия {msg_type.split('.')[1]}")
                await self.send_message(data)
                return
            
            # Обработка response событий
            if msg_type in ["response.created", "response.done"]:
                logger.debug(f"Response event: {msg_type}")
                await self.send_message(data)
                return
            
            # Обработка аудио событий
            if msg_type in ["response.audio.delta", "response.audio.done"]:
                await self.send_message(data)
                return
            
            # Обработка транскрипций
            if msg_type.startswith("conversation.item.input_audio_transcription"):
                await self.send_message(data)
                return
            
            if msg_type.startswith("response.audio_transcript"):
                await self.send_message(data)
                return
            
            # Обработка текстовых дельт
            if msg_type in ["response.content_part.added", "response.content_part.done"]:
                await self.send_message(data)
                return
            
            # Обработка функций
            if msg_type.startswith("response.function_call"):
                await self.send_message(data)
                return
            
            # Обработка прочих событий
            if msg_type in ["input_audio_buffer.committed", "input_audio_buffer.cleared", 
                          "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped",
                          "conversation.item.created", "conversation.item.deleted",
                          "rate_limits.updated"]:
                await self.send_message(data)
                return
            
            # Логируем неизвестные типы сообщений
            logger.debug(f"Неизвестный тип сообщения от OpenAI: {msg_type}")
            await self.send_message(data)
            
        except Exception as e:
            logger.error(f"Ошибка при обработке сообщения от OpenAI: {e}")
    
    async def send_message(self, message: Dict[str, Any]):
        """Отправка сообщения клиенту"""
        try:
            await self.websocket.send_text(json.dumps(message))
            self.messages_sent += 1
        except Exception as e:
            logger.error(f"Ошибка отправки сообщения клиенту: {e}")
    
    async def send_error(self, message: str, error_code: str = "UNKNOWN_ERROR"):
        """Отправка сообщения об ошибке клиенту"""
        error_message = {
            "type": "error",
            "error": {
                "message": message,
                "code": error_code,
                "timestamp": time.time()
            }
        }
        await self.send_message(error_message)
    
    async def cleanup(self):
        """Очистка ресурсов при закрытии соединения"""
        self.is_connected = False
        
        if self.openai_client:
            try:
                await self.openai_client.disconnect()
            except Exception as e:
                logger.error(f"Ошибка при отключении OpenAI клиента: {e}")
            finally:
                self.openai_client = None
        
        try:
            if not self.websocket.client_state.DISCONNECTED:
                await self.websocket.close()
        except Exception as e:
            logger.debug(f"Ошибка при закрытии WebSocket: {e}")
        
        # Логируем статистику сессии
        session_duration = time.time() - self.connection_start_time
        logger.info(f"Сессия завершена для {self.assistant_id}. "
                   f"Длительность: {session_duration:.1f}с, "
                   f"Сообщений отправлено: {self.messages_sent}, "
                   f"Сообщений получено: {self.messages_received}, "
                   f"Аудио чанков: {self.audio_chunks_processed}")


async def handle_websocket(websocket: WebSocket, assistant_id: str):
    """
    Основная функция для обработки WebSocket соединения
    
    Args:
        websocket: WebSocket соединение
        assistant_id: ID ассистента
    """
    handler = WebSocketHandler(websocket, assistant_id)
    await handler.handle_connection()
