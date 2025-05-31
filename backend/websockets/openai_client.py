import asyncio
import json
import uuid
import base64
import time
import websockets
import re
from websockets.exceptions import ConnectionClosed

from typing import Optional, List, Dict, Any, Union, AsyncGenerator

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.functions import get_function_definitions, get_enabled_functions, normalize_function_name, execute_function

# Импорты для функций прерывания
try:
    from backend.utils.interruption_utils import (
        InterruptionStatus,
        InterruptionConfig, 
        validate_interruption_payload,
        create_cancel_payload,
        create_truncate_payload,
        create_clear_output_payload,
        create_emergency_stop_payload,
        enrich_cancel_ack,
        log_interruption_event,
        InterruptionSequencer,
        create_interruption_sequence
    )
    INTERRUPTION_UTILS_AVAILABLE = True
except ImportError:
    INTERRUPTION_UTILS_AVAILABLE = False
    
    # Fallback классы и функции
    class InterruptionStatus:
        NONE = "none"
        PENDING = "pending"
        IN_PROGRESS = "in_progress"
        COMPLETED = "completed"
        FAILED = "failed"
    
    class InterruptionSequencer:
        def __init__(self):
            self.pending_commands = []
        
        def add_command(self, command_type, payload, delay_ms=0):
            pass
        
        def get_ready_commands(self):
            return []
        
        def clear_pending(self):
            pass
    
    def validate_interruption_payload(payload):
        return True, None
    
    def log_interruption_event(event_type, details, client_id=None):
        pass

logger = get_logger(__name__)

DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

def normalize_functions(assistant_functions):
    """
    Преобразует список функций из UI в полные определения с параметрами.
    
    Args:
        assistant_functions: Список функций ассистента в любом формате
            
    Returns:
        List: Список полных определений функций с параметрами
    """
    if not assistant_functions:
        return []
    
    # Извлекаем имена функций
    enabled_names = []
    
    # Обработка формата {"enabled_functions": [...]}
    if isinstance(assistant_functions, dict) and "enabled_functions" in assistant_functions:
        enabled_names = [normalize_function_name(name) for name in assistant_functions.get("enabled_functions", [])]
    # Обработка списка объектов из UI
    else:
        enabled_names = [normalize_function_name(func.get("name")) for func in assistant_functions if func.get("name")]
        
    # Получаем определения для включенных функций
    return get_enabled_functions(enabled_names)

def extract_webhook_url_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает URL вебхука из системного промпта ассистента.
    
    Args:
        prompt: Системный промпт ассистента
        
    Returns:
        Найденный URL или None
    """
    if not prompt:
        return None
        
    # Ищем URL с помощью регулярного выражения
    # Паттерн 1: "URL вебхука: https://example.com"
    pattern1 = r'URL\s+(?:вебхука|webhook):\s*(https?://[^\s"\'<>]+)'
    # Паттерн 2: "webhook URL: https://example.com"
    pattern2 = r'(?:вебхука|webhook)\s+URL:\s*(https?://[^\s"\'<>]+)'
    # Паттерн 3: просто URL в тексте (менее точный)
    pattern3 = r'https?://[^\s"\'<>]+'
    
    # Проверяем шаблоны по убыванию специфичности
    for pattern in [pattern1, pattern2, pattern3]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

def generate_short_id(prefix: str = "") -> str:
    """
    Генерирует короткий уникальный идентификатор длиной до 32 символов.
    
    Args:
        prefix: Опциональный префикс для ID
        
    Returns:
        str: Короткий уникальный ID
    """
    # Создаем UUID без дефисов и обрезаем до нужной длины
    raw_id = str(uuid.uuid4()).replace("-", "")
    
    # Если есть префикс, учитываем его в общей длине
    max_id_len = 32 - len(prefix)
    
    # Возвращаем ID с префиксом, общей длиной не более 32 символов
    return f"{prefix}{raw_id[:max_id_len]}"

class OpenAIRealtimeClient:
    """
    Client for interacting with OpenAI's Realtime API through WebSockets.
    Handles voice interactions, function calling, conversation tracking, and interruptions.
    """
    
    def __init__(
        self,
        api_key: str,
        assistant_config: AssistantConfig,
        client_id: str,
        db_session: Any = None
    ):
        """
        Initialize the OpenAI Realtime client.
        
        Args:
            api_key: OpenAI API key
            assistant_config: Configuration for the assistant
            client_id: Unique identifier for the client
            db_session: Database session for persistence (optional)
        """
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.webhook_url = None  # Сохраняем URL вебхука из промпта
        self.last_function_name = None  # Сохраняем имя последней вызванной функции
        self.enabled_functions = []  # Список разрешенных функций
        
        # ПЕРЕМЕННЫЕ ДЛЯ ОБОГАЩЕНИЯ response.cancel.ack
        self.last_sent_cancel_payload = None  # Сохраняем последний отправленный cancel payload
        
        # НОВЫЕ ПЕРЕМЕННЫЕ ДЛЯ ПРЕРЫВАНИЯ (если утилиты доступны)
        if INTERRUPTION_UTILS_AVAILABLE:
            self.interruption_status = InterruptionStatus.NONE
            self.interruption_sequencer = InterruptionSequencer()
            self.interruption_metrics = {
                "total_interruptions": 0,
                "successful_cancels": 0,
                "failed_cancels": 0,
                "avg_response_time_ms": 0
            }
        
        # Извлекаем список разрешенных функций
        if hasattr(assistant_config, "functions"):
            functions = assistant_config.functions
            if isinstance(functions, list):
                self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
            elif isinstance(functions, dict) and "enabled_functions" in functions:
                self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
            logger.info(f"Извлечены разрешенные функции: {self.enabled_functions}")
        
        # Извлекаем URL вебхука из промпта только если функция send_webhook разрешена
        if "send_webhook" in self.enabled_functions and hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
            self.webhook_url = extract_webhook_url_from_prompt(assistant_config.system_prompt)
            if self.webhook_url:
                logger.info(f"Извлечен URL вебхука из промпта: {self.webhook_url}")

    async def connect(self) -> bool:
        """
        Establish WebSocket connection to OpenAI Realtime API
        and immediately send up-to-date session settings,
        including the system_prompt from the database.
        
        Returns:
            bool: True if connection was successful, False otherwise
        """
        if not self.api_key:
            logger.error("OpenAI API key not provided")
            return False

        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI/1.0")
        ]
        try:
            self.ws = await asyncio.wait_for(
                websockets.connect(
                    self.openai_url,
                    extra_headers=headers,
                    max_size=15*1024*1024,  # 15 MB max message size
                    ping_interval=30,
                    ping_timeout=120,
                    close_timeout=15
                ),
                timeout=30
            )
            self.is_connected = True
            logger.info(f"Connected to OpenAI for client {self.client_id}")

            # Fetch fresh settings from assistant_config
            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            functions = getattr(self.assistant_config, "functions", None)
            
            # Обновляем список разрешенных функций
            if functions:
                if isinstance(functions, list):
                    self.enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
                elif isinstance(functions, dict) and "enabled_functions" in functions:
                    self.enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
                
                logger.info(f"Обновлены разрешенные функции: {self.enabled_functions}")

            # Проверяем, есть ли URL вебхука в промпте, только если функция send_webhook разрешена
            if "send_webhook" in self.enabled_functions:
                self.webhook_url = extract_webhook_url_from_prompt(system_message)
                if self.webhook_url:
                    logger.info(f"Извлечен URL вебхука из промпта: {self.webhook_url}")

            # Send updated session settings with actual system_prompt
            if not await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions
            ):
                logger.error("Failed to update session settings")
                await self.close()
                return False

            return True
        except asyncio.TimeoutError:
            logger.error(f"Connection timeout to OpenAI for client {self.client_id}")
            return False
        except Exception as e:
            logger.error(f"Failed to connect to OpenAI: {e}")
            return False

    async def reconnect(self) -> bool:
        """
        Пытается переподключиться к OpenAI Realtime API после потери соединения.
        
        Returns:
            bool: True если переподключение успешно, False иначе
        """
        logger.info(f"Попытка переподключения к OpenAI для клиента {self.client_id}")
        try:
            # Закрываем старое соединение, если оно ещё существует
            if self.ws:
                try:
                    await self.ws.close()
                except:
                    pass
            
            self.is_connected = False
            self.ws = None
            
            # Подключаемся заново
            return await self.connect()
        except Exception as e:
            logger.error(f"Ошибка при переподключении к OpenAI: {e}")
            return False

    # УЛУЧШЕННАЯ ФУНКЦИЯ ДЛЯ ОТМЕНЫ ОТВЕТА с utilities
    async def cancel_response_with_utils(
        self, 
        item_id: str = None, 
        sample_count: int = 0, 
        was_playing_audio: bool = False
    ) -> bool:
        """
        Отменяет текущий ответ ассистента с использованием utilities
        
        Args:
            item_id: ID элемента для отмены
            sample_count: Количество воспроизведенных семплов  
            was_playing_audio: Флаг воспроизведения аудио
            
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            if INTERRUPTION_UTILS_AVAILABLE:
                log_interruption_event(
                    "cancel_failed", 
                    {"reason": "not_connected"}, 
                    self.client_id
                )
            return False
            
        try:
            # Обновляем статус
            if INTERRUPTION_UTILS_AVAILABLE:
                self.interruption_status = InterruptionStatus.IN_PROGRESS
            
            # Создаем payload через utility
            if INTERRUPTION_UTILS_AVAILABLE:
                payload = create_cancel_payload(item_id, sample_count)
                
                # Валидируем payload
                is_valid, error = validate_interruption_payload(payload)
                if not is_valid:
                    logger.error(f"Invalid cancel payload: {error}")
                    self.interruption_status = InterruptionStatus.FAILED
                    return False
            else:
                # Fallback
                payload = {
                    "type": "response.cancel",
                    "event_id": f"cancel_{int(time.time() * 1000)}"
                }
                if item_id:
                    payload["item_id"] = item_id
                if sample_count > 0:
                    payload["sample_count"] = sample_count
            
            # Сохраняем для обогащения ACK
            self.last_sent_cancel_payload = {
                "original_item_id": item_id,
                "original_sample_count": sample_count,
                "original_was_playing": was_playing_audio,
                "timestamp": time.time()
            }
            
            # Отправляем команду
            await self.ws.send(json.dumps(payload))
            
            # Логируем событие
            if INTERRUPTION_UTILS_AVAILABLE:
                log_interruption_event(
                    "cancel_sent",
                    {
                        "item_id": item_id,
                        "sample_count": sample_count,
                        "was_playing": was_playing_audio
                    },
                    self.client_id
                )
                
                # Обновляем метрики
                self.interruption_metrics["total_interruptions"] += 1
            
            logger.info(f"[INTERRUPTION] Response cancel sent: item_id={item_id}, sample_count={sample_count}, was_playing={was_playing_audio}")
            return True
            
        except Exception as e:
            logger.error(f"Error in cancel_response_with_utils: {e}")
            if INTERRUPTION_UTILS_AVAILABLE:
                self.interruption_status = InterruptionStatus.FAILED
                self.interruption_metrics["failed_cancels"] += 1
            return False

    # ОРИГИНАЛЬНАЯ ФУНКЦИЯ ДЛЯ ОТМЕНЫ ОТВЕТА (для обратной совместимости)
    async def cancel_response(self, item_id: str = None, sample_count: int = 0, was_playing_audio: bool = False) -> bool:
        """
        Отменяет текущий ответ ассистента с сохранением данных для обогащения ACK
        
        Args:
            item_id: ID элемента для отмены (опционально)
            sample_count: Количество воспроизведенных семплов
            was_playing_audio: Флаг того, что аудио воспроизводилось
        
        Returns:
            bool: True если успешно отправлено
        """
        # Если утилиты доступны, используем улучшенный метод
        if INTERRUPTION_UTILS_AVAILABLE:
            return await self.cancel_response_with_utils(item_id, sample_count, was_playing_audio)
        
        # Fallback к оригинальной реализации
        if not self.is_connected or not self.ws:
            logger.warning("Cannot send response.cancel: not connected")
            return False
            
        try:
            payload = {
                "type": "response.cancel",
                "event_id": f"cancel_{int(time.time() * 1000)}"
            }
            
            # Добавляем параметры если указаны
            if item_id:
                payload["item_id"] = item_id
            if sample_count > 0:
                payload["sample_count"] = sample_count
                
            # СОХРАНЯЕМ PAYLOAD ДЛЯ ОБОГАЩЕНИЯ ACK
            self.last_sent_cancel_payload = {
                "original_item_id": item_id,
                "original_sample_count": sample_count,
                "original_was_playing": was_playing_audio,
                "timestamp": time.time()
            }
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"[INTERRUPTION] Response cancel sent: item_id={item_id}, sample_count={sample_count}, was_playing={was_playing_audio}")
            
            # Ждем короткое время для обработки отмены
            await asyncio.sleep(0.1)
            
            return True
            
        except Exception as e:
            logger.error(f"Error sending response.cancel: {e}")
            # Очищаем payload при ошибке
            self.last_sent_cancel_payload = None
            return False

    def enrich_cancel_ack_with_utils(self, ack_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обогащает ACK с использованием utility функции
        
        Args:
            ack_data: Исходные данные ACK
            
        Returns:
            Dict: Обогащенные данные ACK
        """
        if INTERRUPTION_UTILS_AVAILABLE:
            enriched_ack = enrich_cancel_ack(ack_data, self.last_sent_cancel_payload)
            
            # Обновляем статус и метрики
            if "error" not in enriched_ack:
                self.interruption_status = InterruptionStatus.COMPLETED
                self.interruption_metrics["successful_cancels"] += 1
                
                log_interruption_event(
                    "cancel_ack_success",
                    {"enriched_fields": len(enriched_ack) - len(ack_data)},
                    self.client_id
                )
            else:
                self.interruption_status = InterruptionStatus.FAILED
            
            # Очищаем сохраненные данные
            self.last_sent_cancel_payload = None
            
            return enriched_ack
        else:
            # Fallback к обычному методу
            return self.enrich_cancel_ack(ack_data)

    def enrich_cancel_ack(self, ack_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обогащает response.cancel.ack данными из сохраненного payload
        
        Args:
            ack_data: Исходные данные ACK от OpenAI
            
        Returns:
            Dict: Обогащенные данные ACK
        """
        enriched_ack = ack_data.copy()
        
        if self.last_sent_cancel_payload:
            # Добавляем сохраненные данные в ACK
            enriched_ack.update({
                "original_item_id": self.last_sent_cancel_payload["original_item_id"],
                "original_sample_count": self.last_sent_cancel_payload["original_sample_count"], 
                "original_was_playing": self.last_sent_cancel_payload["original_was_playing"]
            })
            
            logger.info(f"[INTERRUPTION] Обогащен cancel.ack: {enriched_ack}")
            
            # Очищаем сохраненный payload
            self.last_sent_cancel_payload = None
        else:
            logger.warning("[INTERRUPTION] Нет сохраненного payload для обогащения cancel.ack")
        
        return enriched_ack

    async def execute_interruption_sequence(
        self,
        item_id: str = None,
        sample_count: int = 0,
        was_playing_audio: bool = False,
        sample_rate: int = None
    ) -> bool:
        """
        Выполняет полную последовательность команд прерывания
        
        Args:
            item_id: ID прерываемого элемента
            sample_count: Количество воспроизведенных семплов
            was_playing_audio: Было ли воспроизведение
            sample_rate: Частота дискретизации
            
        Returns:
            bool: True если все команды выполнены успешно
        """
        if not INTERRUPTION_UTILS_AVAILABLE:
            # Fallback к простой отмене
            return await self.cancel_response(item_id, sample_count, was_playing_audio)
        
        if not self.is_connected or not self.ws:
            return False
        
        try:
            # Создаем последовательность команд
            commands = create_interruption_sequence(
                item_id, sample_count, was_playing_audio, sample_rate
            )
            
            if not commands:
                logger.warning("No interruption commands generated")
                return False
            
            # Добавляем команды в sequencer
            for cmd in commands:
                self.interruption_sequencer.add_command(
                    cmd["type"],
                    cmd["payload"], 
                    cmd["delay_ms"]
                )
            
            # Выполняем команды с учетом задержек
            success_count = 0
            
            while True:
                ready_commands = self.interruption_sequencer.get_ready_commands()
                
                if not ready_commands:
                    # Проверяем, есть ли еще ожидающие команды
                    if not self.interruption_sequencer.pending_commands:
                        break
                    # Ждем короткое время
                    await asyncio.sleep(0.01)
                    continue
                
                # Выполняем готовые команды
                for cmd in ready_commands:
                    try:
                        # Валидируем перед отправкой
                        is_valid, error = validate_interruption_payload(cmd["payload"])
                        if not is_valid:
                            logger.error(f"Invalid payload for {cmd['type']}: {error}")
                            continue
                        
                        await self.ws.send(json.dumps(cmd["payload"]))
                        success_count += 1
                        
                        log_interruption_event(
                            cmd["type"].replace(".", "_"),
                            {"success": True},
                            self.client_id
                        )
                        
                    except Exception as e:
                        logger.error(f"Error executing command {cmd['type']}: {e}")
                        log_interruption_event(
                            cmd["type"].replace(".", "_"),
                            {"success": False, "error": str(e)},
                            self.client_id
                        )
            
            # Очищаем sequencer
            self.interruption_sequencer.clear_pending()
            
            return success_count == len(commands)
            
        except Exception as e:
            logger.error(f"Error in execute_interruption_sequence: {e}")
            return False

    async def emergency_stop_with_sequence(self) -> bool:
        """
        Экстренная остановка с использованием sequencer
        
        Returns:
            bool: True если успешно
        """
        if not INTERRUPTION_UTILS_AVAILABLE:
            return await self.emergency_stop_all()
        
        if not self.is_connected or not self.ws:
            return False
        
        try:
            # Очищаем все ожидающие команды
            self.interruption_sequencer.clear_pending()
            
            # Создаем payload для экстренной остановки
            emergency_payload = create_emergency_stop_payload()
            
            # Валидируем
            is_valid, error = validate_interruption_payload(emergency_payload)
            if not is_valid:
                logger.error(f"Invalid emergency stop payload: {error}")
                return False
            
            # Отправляем
            await self.ws.send(json.dumps(emergency_payload))
            
            # Также выполняем стандартную последовательность
            await self.execute_interruption_sequence(
                item_id=None,
                sample_count=0,
                was_playing_audio=True
            )
            
            log_interruption_event(
                "emergency_stop",
                {"success": True},
                self.client_id
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Error in emergency_stop_with_sequence: {e}")
            log_interruption_event(
                "emergency_stop",
                {"success": False, "error": str(e)},
                self.client_id
            )
            return False

    def get_interruption_metrics(self) -> Dict[str, Any]:
        """
        Возвращает метрики прерывания
        
        Returns:
            Dict: Метрики производительности
        """
        if not INTERRUPTION_UTILS_AVAILABLE:
            return {
                "status": "utilities_not_available",
                "message": "Interruption utilities not loaded"
            }
        
        return {
            **self.interruption_metrics,
            "current_status": self.interruption_status.value if hasattr(self.interruption_status, 'value') else self.interruption_status,
            "pending_commands": len(self.interruption_sequencer.pending_commands) if self.interruption_sequencer else 0
        }

    async def clear_output_audio_buffer(self) -> bool:
        """
        Очищает буфер вывода аудио
        
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot clear output audio buffer: not connected")
            return False
            
        try:
            if INTERRUPTION_UTILS_AVAILABLE:
                payload = create_clear_output_payload()
            else:
                payload = {
                    "type": "output_audio_buffer.clear",
                    "event_id": f"clear_output_{int(time.time() * 1000)}"
                }
            
            await self.ws.send(json.dumps(payload))
            logger.info("[INTERRUPTION] Output audio buffer clear sent")
            return True
            
        except Exception as e:
            logger.error(f"Error clearing output audio buffer: {e}")
            return False

    async def truncate_conversation_item(self, item_id: str, content_index: int = 0, audio_end_ms: int = 0) -> bool:
        """
        Обрезает элемент диалога для синхронизации транскрипта
        
        Args:
            item_id: ID элемента для обрезки
            content_index: Индекс контента
            audio_end_ms: Время окончания аудио в миллисекундах
            
        Returns:
            bool: True если успешно отправлено
        """
        if not self.is_connected or not self.ws:
            logger.warning("Cannot truncate conversation item: not connected")
            return False
            
        try:
            if INTERRUPTION_UTILS_AVAILABLE:
                # Если не передан audio_end_ms, вычисляем по стандартной формуле
                if audio_end_ms == 0 and hasattr(self, 'last_sent_cancel_payload') and self.last_sent_cancel_payload:
                    sample_count = self.last_sent_cancel_payload.get("original_sample_count", 0)
                    if sample_count > 0:
                        from backend.utils.interruption_utils import calculate_audio_end_ms
                        audio_end_ms = calculate_audio_end_ms(sample_count)
                
                payload = create_truncate_payload(
                    item_id, sample_count if 'sample_count' in locals() else 0, 
                    content_index=content_index, event_id=None
                )
                # Перезаписываем audio_end_ms если он был передан
                if audio_end_ms > 0:
                    payload["audio_end_ms"] = audio_end_ms
            else:
                payload = {
                    "type": "conversation.item.truncate",
                    "event_id": f"truncate_{int(time.time() * 1000)}",
                    "item_id": item_id,
                    "content_index": content_index,
                    "audio_end_ms": audio_end_ms
                }
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"[INTERRUPTION] Conversation item truncate sent: item_id={item_id}, audio_end_ms={audio_end_ms}")
            return True
            
        except Exception as e:
            logger.error(f"Error truncating conversation item: {e}")
            return False

    async def emergency_stop_all(self) -> bool:
        """
        Экстренная остановка всех активных процессов OpenAI
        
        Returns:
            bool: True если все команды отправлены успешно
        """
        if not self.is_connected or not self.ws:
            return False
            
        try:
            # 1. Отменяем ответ
            await self.cancel_response()
            
            # 2. Очищаем буфер вывода аудио
            await self.clear_output_audio_buffer()
            
            # 3. Очищаем входной буфер аудио
            await self.clear_audio_buffer()
            
            logger.info("[INTERRUPTION] Emergency stop - все команды отправлены")
            return True
            
        except Exception as e:
            logger.error(f"Error in emergency stop: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None
    ) -> bool:
        """
        Update session settings on the OpenAI Realtime API side.
        
        Args:
            voice: Voice ID to use for speech synthesis
            system_message: System instructions for the assistant
            functions: List of functions or dictionary with enabled_functions key
            
        Returns:
            bool: True if update was successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot update session: not connected")
            return False
            
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.25,
            "prefix_padding_ms": 200,
            "silence_duration_ms": 300,
            "create_response": True,
        }
        
        # Получаем нормализованные определения функций
        normalized_functions = normalize_functions(functions)
        
        # Формируем tools для API
        tools = []
        for func_def in normalized_functions:
            tools.append({
                "type": "function",
                "name": func_def["name"],
                "description": func_def["description"],
                "parameters": func_def["parameters"]
            })
        
        # Обновляем список разрешенных функций на основе tools
        self.enabled_functions = [normalize_function_name(tool["name"]) for tool in tools]
        logger.info(f"[DEBUG-FUNCTION] Активированные функции для сессии: {self.enabled_functions}")
        
        # Устанавливаем tool_choice на основе наличия tools
        tool_choice = "auto" if tools else "none"
        
        logger.info(f"Setting up session with {len(tools)} tools, tool_choice={tool_choice}")
        
        # Включение транскрипции аудио в соответствии с документацией OpenAI
        input_audio_transcription = {
            "model": "whisper-1"
        }
            
        payload = {
            "type": "session.update",
            "session": {
                "turn_detection": turn_detection,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "voice": voice,
                "instructions": system_message,
                "modalities": ["text", "audio"],
                "temperature": 0.7,
                "max_response_output_tokens": 500,
                "tools": tools,
                "tool_choice": tool_choice,
                "input_audio_transcription": input_audio_transcription
            }
        }
        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"Session settings sent (voice={voice}, tools={len(tools)}, tool_choice={tool_choice})")
            
            # Вывод подробной информации о функциях в лог
            if tools:
                for tool in tools:
                    logger.info(f"[DEBUG-FUNCTION] Enabled function: {tool['name']}, params: {json.dumps(tool['parameters'], ensure_ascii=False)[:100]}...")
        except Exception as e:
            logger.error(f"Error sending session.update: {e}")
            return False

        # Create a conversation record in the database if available
        if self.db_session:
            try:
                conv = Conversation(
                    assistant_id=self.assistant_config.id,
                    session_id=self.session_id,
                    user_message="",
                    assistant_message="",
                )
                self.db_session.add(conv)
                self.db_session.commit()
                self.db_session.refresh(conv)
                self.conversation_record_id = str(conv.id)
                logger.info(f"Created conversation record: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"Error creating Conversation in DB: {e}")

        return True

    async def handle_function_call(self, function_call_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process a function call from OpenAI.
        
        Args:
            function_call_data: Function call data from OpenAI
            
        Returns:
            Dict: Result of the function execution
        """
        try:
            function_name = function_call_data.get("function", {}).get("name")
            arguments = function_call_data.get("function", {}).get("arguments", {})
            
            # Сохраняем имя функции для последующего использования
            self.last_function_name = function_name
            
            # Нормализуем имя функции из любого формата
            normalized_function_name = normalize_function_name(function_name) or function_name
            logger.info(f"[DEBUG-FUNCTION] Нормализация имени функции: {function_name} -> {normalized_function_name}")
            
            # Проверяем, разрешена ли функция
            if normalized_function_name not in self.enabled_functions:
                error_msg = f"Попытка вызвать неразрешенную функцию: {normalized_function_name}. Разрешены только: {self.enabled_functions}"
                logger.warning(error_msg)
                return {
                    "error": error_msg,
                    "status": "error",
                    "message": f"Функция {normalized_function_name} не активирована для этого ассистента"
                }
            
            # Если arguments - строка, парсим JSON
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse function arguments as JSON: {arguments}")
                    arguments = {}
            
            # Подготавливаем контекст выполнения
            context = {
                "assistant_config": self.assistant_config,
                "client_id": self.client_id,
                "db_session": self.db_session
            }
            
            # Выполняем функцию через новую систему
            result = await execute_function(
                name=normalized_function_name,
                arguments=arguments,
                context=context
            )
            
            return result
        except Exception as e:
            logger.error(f"Error processing function call: {e}")
            return {"error": str(e)}

    async def send_function_result(self, function_call_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Send the result of a function execution back to OpenAI as a conversation.item.create event.
        
        Args:
            function_call_id: ID of the function call
            result: Result of the function execution
            
        Returns:
            Dict: Status information about the result delivery
                {
                    "success": bool,
                    "error": str or None,
                    "payload": dict - payload that was sent 
                }
        """
        if not self.is_connected or not self.ws:
            error_msg = "Cannot send function result: not connected"
            logger.error(error_msg)
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }
        
        try:
            logger.info(f"[DEBUG-FUNCTION] Начало отправки результата функции: {function_call_id}")
            
            # Генерируем короткий ID длиной до 32 символов
            short_item_id = generate_short_id("func_")
            
            # Преобразуем результат в строку JSON
            # OpenAI ожидает, что поле output будет строкой, а не объектом
            result_json = json.dumps(result)
            
            # Исправленная структура для отправки результата функции
            payload = {
                "type": "conversation.item.create",
                "event_id": f"funcres_{time.time()}",
                "item": {
                    "id": short_item_id,  # Максимум 32 символа
                    "type": "function_call_output",
                    "call_id": function_call_id,
                    "output": result_json  # Строка вместо объекта
                }
            }
            
            logger.info(f"Отправка результата функции: {function_call_id}")
            logger.info(f"Payload: {json.dumps(payload, ensure_ascii=False)[:200]}...")
            
            await self.ws.send(json.dumps(payload))
            logger.info(f"Результат функции отправлен как item.create: {function_call_id}")
            
            # Добавляем небольшую задержку перед запросом нового ответа
            logger.info(f"[DEBUG-FUNCTION] Ожидание перед созданием нового ответа (500мс)")
            await asyncio.sleep(0.5)  # 500 мс должно быть достаточно
            
            # После отправки результата, явно запрашиваем новый ответ от модели
            await self.create_response_after_function()
            
            logger.info(f"[DEBUG-FUNCTION] Результат функции отправлен и запрос на новый ответ выполнен")
            
            return {
                "success": True,
                "error": None,
                "payload": payload
            }
            
        except Exception as e:
            error_msg = f"Error sending function result: {e}"
            logger.error(error_msg)
            return {
                "success": False,
                "error": error_msg,
                "payload": None
            }

    async def create_response_after_function(self) -> bool:
        """
        Явно запрашивает новый ответ от модели после выполнения функции.
        Это обеспечит генерацию аудио-ответа.
        
        Returns:
            bool: True если успешно, False иначе
        """
        if not self.is_connected or not self.ws:
            logger.error("Cannot create response: not connected")
            return False
            
        try:
            logger.info(f"[DEBUG-FUNCTION] Создание нового ответа после выполнения функции")
            
            # Запрашиваем новый ответ от модели с более полным набором параметров
            response_payload = {
                "type": "response.create",
                "event_id": f"resp_after_func_{time.time()}",
                "response": {
                    "modalities": ["text", "audio"],
                    "voice": self.assistant_config.voice or DEFAULT_VOICE,
                    "instructions": getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE,
                    "temperature": 0.7,
                    "max_output_tokens": 200
                }
            }
            
            await self.ws.send(json.dumps(response_payload))
            logger.info("Запрошен новый ответ после выполнения функции")
            
            logger.info(f"[DEBUG-FUNCTION] Запрос на создание нового ответа отправлен успешно")
            
            return True
            
        except Exception as e:
            logger.error(f"Error creating response after function: {e}")
            return False

    async def process_audio(self, audio_buffer: bytes) -> bool:
        """
        Process and send audio data to the OpenAI API.
        
        Args:
            audio_buffer: Binary audio data in PCM16 format
            
        Returns:
            bool: True if successful, False otherwise
        """
        if not self.is_connected or not self.ws or not audio_buffer:
            return False
        try:
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": f"audio_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            logger.error("Connection closed while sending audio data")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error processing audio: {e}")
            return False

    async def commit_audio(self) -> bool:
        """
        Commit the audio buffer, indicating that the user has finished speaking.
        
        Returns:
            bool: True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            logger.error("Connection closed while committing audio")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error committing audio: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Clear the audio buffer, removing any pending audio data.
        
        Returns:
            bool: True if successful, False otherwise
        """
        if not self.is_connected or not self.ws:
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            logger.error("Connection closed while clearing audio buffer")
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"Error clearing audio buffer: {e}")
            return False

    async def close(self) -> None:
        """
        Close the WebSocket connection.
        """
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"WebSocket connection closed for client {self.client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI WebSocket: {e}")
        self.is_connected = False

    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Receive and yield messages from the OpenAI WebSocket.
        
        Yields:
            Dict: Message received from the OpenAI WebSocket
        """
        if not self.is_connected or not self.ws:
            return
            
        try:
            async for message in self.ws:
                try:
                    data = json.loads(message)
                    yield data
                except json.JSONDecodeError:
                    logger.error(f"Failed to decode message: {message[:100]}...")
        except ConnectionClosed:
            logger.info(f"WebSocket connection closed for client {self.client_id}")
            self.is_connected = False
        except Exception as e:
            logger.error(f"Error receiving messages: {e}")
            self.is_connected = False
