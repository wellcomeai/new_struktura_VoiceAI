import asyncio
import websockets
import json
import logging
import time
from typing import Optional, Dict, Any, Callable
from urllib.parse import urlencode

logger = logging.getLogger(__name__)

class OpenAIRealtimeClient:
    """
    Клиент для взаимодействия с OpenAI Realtime API с поддержкой мгновенного прерывания
    """
    
    def __init__(self, api_key: str, assistant_config: Dict[str, Any]):
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.ws: Optional[websockets.WebSocketServerProtocol] = None
        self.is_connected = False
        self.message_handler: Optional[Callable] = None
        
        # КРИТИЧЕСКИ ВАЖНО: хранилище для обогащения ACK
        self.last_sent_cancel_payload: Optional[Dict[str, Any]] = None
        
        # Конфигурация по умолчанию
        self.default_session_config = {
            "modalities": ["text", "audio"],
            "instructions": assistant_config.get("instructions", "You are a helpful assistant."),
            "voice": assistant_config.get("voice", "alloy"),
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16", 
            "input_audio_transcription": {
                "model": "whisper-1"
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500
            },
            "tools": assistant_config.get("tools", []),
            "tool_choice": "auto",
            "temperature": assistant_config.get("temperature", 0.8),
            "max_response_output_tokens": assistant_config.get("max_response_output_tokens", 4096)
        }
        
    async def connect(self) -> bool:
        """Подключение к OpenAI Realtime API"""
        try:
            # Формируем параметры подключения
            params = {
                "model": "gpt-4o-realtime-preview-2024-10-01"
            }
            
            url = f"wss://api.openai.com/v1/realtime?{urlencode(params)}"
            
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "OpenAI-Beta": "realtime=v1"
            }
            
            logger.info(f"Подключение к OpenAI Realtime API...")
            
            self.ws = await websockets.connect(
                url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=10
            )
            
            self.is_connected = True
            logger.info("Успешно подключено к OpenAI Realtime API")
            
            # Отправляем конфигурацию сессии
            await self.send_session_update()
            
            return True
            
        except Exception as e:
            logger.error(f"Ошибка подключения к OpenAI: {e}")
            self.is_connected = False
            return False
    
    async def disconnect(self):
        """Отключение от OpenAI API"""
        if self.ws:
            try:
                await self.ws.close()
            except Exception as e:
                logger.warning(f"Ошибка при закрытии соединения: {e}")
            finally:
                self.ws = None
                self.is_connected = False
                logger.info("Отключено от OpenAI Realtime API")
    
    async def send_session_update(self) -> bool:
        """Отправка конфигурации сессии"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            session_update = {
                "type": "session.update",
                "session": self.default_session_config
            }
            
            await self.ws.send(json.dumps(session_update))
            logger.info("Конфигурация сессии отправлена")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка отправки конфигурации сессии: {e}")
            return False
    
    async def append_audio(self, audio_base64: str) -> bool:
        """Добавление аудио в входной буфер"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "input_audio_buffer.append",
                "audio": audio_base64
            }
            
            await self.ws.send(json.dumps(message))
            return True
            
        except Exception as e:
            logger.error(f"Ошибка отправки аудио: {e}")
            return False
    
    async def commit_audio(self) -> bool:
        """Коммит входного аудио буфера"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "input_audio_buffer.commit"
            }
            
            await self.ws.send(json.dumps(message))
            logger.info("Аудио буфер закоммичен")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка коммита аудио: {e}")
            return False
    
    async def clear_input_audio_buffer(self) -> bool:
        """Очистка входного аудио буфера"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "input_audio_buffer.clear"
            }
            
            await self.ws.send(json.dumps(message))
            logger.info("Входной аудио буфер очищен")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка очистки входного буфера: {e}")
            return False
    
    async def cancel_response(self, item_id: str = None, sample_count: int = 0, was_playing_audio: bool = False) -> bool:
        """
        Отменяет текущий ответ ассистента с сохранением данных для обогащения ACK
        
        Args:
            item_id: ID элемента для отмены
            sample_count: Количество воспроизведенных семплов
            was_playing_audio: Флаг, был ли активен режим воспроизведения
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot send response.cancel: not connected")
            return False
            
        try:
            timestamp = int(time.time() * 1000)
            payload = {
                "type": "response.cancel",
                "event_id": f"cancel_{timestamp}"
            }
            
            # Добавляем параметры если указаны
            if item_id:
                payload["item_id"] = item_id
            if sample_count > 0:
                payload["sample_count"] = sample_count
                
            # КРИТИЧЕСКИ ВАЖНО: сохраняем payload ДО отправки
            self.last_sent_cancel_payload = {
                "original_item_id": item_id,
                "original_sample_count": sample_count,
                "original_was_playing": was_playing_audio,
                "timestamp": time.time(),
                "event_id": payload["event_id"]  # Добавляем event_id для сопоставления
            }
            
            logger.info(f"[INTERRUPTION] Отправка response.cancel с payload: {json.dumps(payload)}")
            await self.ws.send(json.dumps(payload))
            
            logger.info(f"[INTERRUPTION] Response cancel отправлен: item_id={item_id}, sample_count={sample_count}")
            return True
            
        except Exception as e:
            logger.error(f"Error sending response.cancel: {e}")
            # Очищаем payload при ошибке
            self.last_sent_cancel_payload = None
            return False
    
    async def clear_output_audio_buffer(self) -> bool:
        """Очистка выходного аудио буфера"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "output_audio_buffer.clear"
            }
            
            await self.ws.send(json.dumps(message))
            logger.info("[INTERRUPTION] Выходной аудио буфер очищен")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка очистки выходного буфера: {e}")
            return False
    
    async def truncate_conversation_item(self, item_id: str, content_index: int = 0, audio_end_ms: int = 0) -> bool:
        """Обрезка элемента разговора до указанного времени"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "conversation.item.truncate",
                "item_id": item_id,
                "content_index": content_index,
                "audio_end_ms": audio_end_ms
            }
            
            await self.ws.send(json.dumps(message))
            logger.info(f"[INTERRUPTION] Элемент разговора обрезан: item_id={item_id}, audio_end_ms={audio_end_ms}")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка обрезки элемента разговора: {e}")
            return False
    
    async def create_response(self) -> bool:
        """Создание нового ответа"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "response.create"
            }
            
            await self.ws.send(json.dumps(message))
            logger.info("Запрос нового ответа отправлен")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка создания ответа: {e}")
            return False
    
    async def send_function_call_output(self, call_id: str, output: str) -> bool:
        """Отправка результата выполнения функции"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            message = {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output
                }
            }
            
            await self.ws.send(json.dumps(message))
            logger.info(f"Результат функции отправлен для call_id: {call_id}")
            return True
            
        except Exception as e:
            logger.error(f"Ошибка отправки результата функции: {e}")
            return False
    
    def enrich_cancel_ack(self, ack_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обогащает response.cancel.ack данными из сохраненного payload
        
        Args:
            ack_data: Исходные данные ACK от OpenAI
            
        Returns:
            Обогащенные данные ACK с добавленными полями original_*
        """
        enriched_ack = ack_data.copy()
        
        if self.last_sent_cancel_payload:
            # ПРОВЕРЯЕМ соответствие event_id если возможно
            ack_event_id = ack_data.get("event_id")
            saved_event_id = self.last_sent_cancel_payload.get("event_id")
            
            if not ack_event_id or not saved_event_id or ack_event_id == saved_event_id:
                # Добавляем сохраненные данные в ACK
                enriched_ack.update({
                    "original_item_id": self.last_sent_cancel_payload["original_item_id"],
                    "original_sample_count": self.last_sent_cancel_payload["original_sample_count"], 
                    "original_was_playing": self.last_sent_cancel_payload["original_was_playing"]
                })
                
                logger.info(f"[INTERRUPTION] Обогащен cancel.ack: добавлены поля original_*")
                
                # Очищаем сохраненный payload ТОЛЬКО после успешного обогащения
                self.last_sent_cancel_payload = None
            else:
                logger.warning(f"[INTERRUPTION] Event ID не совпадает: ack={ack_event_id}, saved={saved_event_id}")
        else:
            logger.warning("[INTERRUPTION] Нет сохраненного payload для обогащения cancel.ack")
        
        return enriched_ack
    
    def cleanup_old_cancel_payload(self, max_age_seconds: int = 10):
        """Очищает устаревшие cancel payload"""
        if self.last_sent_cancel_payload:
            age = time.time() - self.last_sent_cancel_payload.get("timestamp", 0)
            if age > max_age_seconds:
                logger.warning(f"[INTERRUPTION] Очистка устаревшего cancel payload (возраст: {age:.1f}s)")
                self.last_sent_cancel_payload = None
    
    async def send_raw_message(self, message: Dict[str, Any]) -> bool:
        """Отправка произвольного сообщения в OpenAI"""
        if not self.is_connected or not self.ws:
            return False
            
        try:
            await self.ws.send(json.dumps(message))
            return True
            
        except Exception as e:
            logger.error(f"Ошибка отправки сообщения: {e}")
            return False
    
    def set_message_handler(self, handler: Callable):
        """Установка обработчика входящих сообщений"""
        self.message_handler = handler
    
    async def listen_for_messages(self):
        """Прослушивание сообщений от OpenAI API"""
        if not self.ws:
            return
            
        try:
            while self.is_connected and self.ws:
                try:
                    # Очищаем устаревшие cancel payload
                    self.cleanup_old_cancel_payload()
                    
                    message = await asyncio.wait_for(self.ws.recv(), timeout=30.0)
                    
                    if isinstance(message, str):
                        try:
                            data = json.loads(message)
                            
                            if self.message_handler:
                                await self.message_handler(data)
                            else:
                                logger.debug(f"Получено сообщение без обработчика: {data.get('type', 'unknown')}")
                                
                        except json.JSONDecodeError as e:
                            logger.error(f"Ошибка парсинга JSON: {e}")
                            
                    elif isinstance(message, bytes):
                        logger.warning("Получены бинарные данные от OpenAI (не ожидается)")
                        
                except asyncio.TimeoutError:
                    logger.debug("Таймаут при ожидании сообщения от OpenAI")
                    continue
                    
                except websockets.exceptions.ConnectionClosed:
                    logger.warning("Соединение с OpenAI закрыто")
                    break
                    
                except Exception as e:
                    logger.error(f"Ошибка при получении сообщения от OpenAI: {e}")
                    continue
                    
        except Exception as e:
            logger.error(f"Ошибка в listen_for_messages: {e}")
        finally:
            self.is_connected = False
            if self.ws:
                try:
                    await self.ws.close()
                except:
                    pass
                self.ws = None
    
    async def __aenter__(self):
        await self.connect()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.disconnect()
