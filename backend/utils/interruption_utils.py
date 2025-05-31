"""
Утилиты для обработки прерывания голосового ассистента.
Содержит константы, валидаторы и вспомогательные функции.
"""

import time
import json
from typing import Dict, Any, Optional, Tuple, List
from enum import Enum

from backend.core.logging import get_logger

logger = get_logger(__name__)

class InterruptionStatus(Enum):
    """Статусы процесса прерывания"""
    NONE = "none"
    PENDING = "pending"
    IN_PROGRESS = "in_progress" 
    COMPLETED = "completed"
    FAILED = "failed"

class InterruptionConfig:
    """Конфигурация для прерывания ассистента"""
    
    # Минимальные интервалы между командами
    MIN_INTERRUPTION_GAP_MS = 500
    MIN_CANCEL_TO_CLEAR_DELAY_MS = 50
    MIN_CLEAR_TO_TRUNCATE_DELAY_MS = 100
    
    # Таймауты
    CANCEL_TIMEOUT_MS = 5000
    ACK_WAIT_TIMEOUT_MS = 3000
    
    # Аудио параметры
    DEFAULT_SAMPLE_RATE = 24000
    MIN_AUDIO_SAMPLES_FOR_TRUNCATE = 100
    
    # Повторные попытки
    MAX_CANCEL_RETRIES = 3
    MAX_CLEAR_RETRIES = 2
    MAX_TRUNCATE_RETRIES = 2

def validate_interruption_payload(payload: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Валидирует payload для команд прерывания
    
    Args:
        payload: Словарь с данными команды
        
    Returns:
        Tuple[bool, Optional[str]]: (валидность, сообщение об ошибке)
    """
    if not isinstance(payload, dict):
        return False, "Payload должен быть словарем"
    
    msg_type = payload.get("type")
    if not msg_type:
        return False, "Отсутствует поле 'type'"
    
    # Валидация response.cancel
    if msg_type == "response.cancel":
        # item_id опционален, но если есть - должен быть строкой
        item_id = payload.get("item_id")
        if item_id is not None and not isinstance(item_id, str):
            return False, "item_id должен быть строкой"
        
        # sample_count опционален, но если есть - должен быть неотрицательным числом
        sample_count = payload.get("sample_count")
        if sample_count is not None:
            if not isinstance(sample_count, (int, float)) or sample_count < 0:
                return False, "sample_count должен быть неотрицательным числом"
    
    # Валидация conversation.item.truncate
    elif msg_type == "conversation.item.truncate":
        item_id = payload.get("item_id")
        if not item_id or not isinstance(item_id, str):
            return False, "item_id обязателен и должен быть строкой"
        
        content_index = payload.get("content_index", 0)
        if not isinstance(content_index, int) or content_index < 0:
            return False, "content_index должен быть неотрицательным целым числом"
        
        audio_end_ms = payload.get("audio_end_ms", 0)
        if not isinstance(audio_end_ms, (int, float)) or audio_end_ms < 0:
            return False, "audio_end_ms должен быть неотрицательным числом"
    
    # Валидация output_audio_buffer.clear (без дополнительных параметров)
    elif msg_type == "output_audio_buffer.clear":
        pass  # Дополнительная валидация не требуется
    
    # Валидация emergency_stop (без дополнительных параметров)
    elif msg_type == "emergency_stop":
        pass  # Дополнительная валидация не требуется
    
    else:
        return False, f"Неподдерживаемый тип команды: {msg_type}"
    
    return True, None

def calculate_audio_end_ms(sample_count: int, sample_rate: int = None) -> int:
    """
    Вычисляет время окончания аудио в миллисекундах
    
    Args:
        sample_count: Количество воспроизведенных семплов
        sample_rate: Частота дискретизации (по умолчанию из конфига)
        
    Returns:
        int: Время в миллисекундах
    """
    if sample_rate is None:
        sample_rate = InterruptionConfig.DEFAULT_SAMPLE_RATE
    
    if sample_count <= 0 or sample_rate <= 0:
        return 0
    
    return int((sample_count / sample_rate) * 1000)

def create_cancel_payload(
    item_id: Optional[str] = None,
    sample_count: Optional[int] = None,
    event_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Создает payload для команды response.cancel
    
    Args:
        item_id: ID прерываемого элемента
        sample_count: Количество воспроизведенных семплов
        event_id: ID события (если не указан, генерируется автоматически)
        
    Returns:
        Dict: Готовый payload
    """
    payload = {
        "type": "response.cancel",
        "event_id": event_id or f"cancel_{int(time.time() * 1000)}"
    }
    
    if item_id:
        payload["item_id"] = item_id
    
    if sample_count is not None and sample_count > 0:
        payload["sample_count"] = sample_count
    
    return payload

def create_truncate_payload(
    item_id: str,
    sample_count: int,
    sample_rate: int = None,
    content_index: int = 0,
    event_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Создает payload для команды conversation.item.truncate
    
    Args:
        item_id: ID элемента для обрезки
        sample_count: Количество воспроизведенных семплов
        sample_rate: Частота дискретизации
        content_index: Индекс контента
        event_id: ID события
        
    Returns:
        Dict: Готовый payload
    """
    audio_end_ms = calculate_audio_end_ms(sample_count, sample_rate)
    
    return {
        "type": "conversation.item.truncate",
        "event_id": event_id or f"truncate_{int(time.time() * 1000)}",
        "item_id": item_id,
        "content_index": content_index,
        "audio_end_ms": audio_end_ms
    }

def create_clear_output_payload(event_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Создает payload для команды output_audio_buffer.clear
    
    Args:
        event_id: ID события
        
    Returns:
        Dict: Готовый payload
    """
    return {
        "type": "output_audio_buffer.clear",
        "event_id": event_id or f"clear_output_{int(time.time() * 1000)}"
    }

def create_emergency_stop_payload(event_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Создает payload для команды emergency_stop
    
    Args:
        event_id: ID события
        
    Returns:
        Dict: Готовый payload
    """
    return {
        "type": "emergency_stop", 
        "event_id": event_id or f"emergency_{int(time.time() * 1000)}"
    }

def enrich_cancel_ack(
    original_ack: Dict[str, Any],
    saved_payload: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Обогащает response.cancel.ack дополнительными данными
    
    Args:
        original_ack: Исходный ACK от OpenAI
        saved_payload: Сохраненные данные от клиента
        
    Returns:
        Dict: Обогащенный ACK
    """
    enriched = original_ack.copy()
    
    if saved_payload:
        # Добавляем оригинальные параметры в ACK
        for key in ["original_item_id", "original_sample_count", "original_was_playing"]:
            if key in saved_payload:
                enriched[key] = saved_payload[key]
    
    return enriched

def is_interruption_command(msg_type: str) -> bool:
    """
    Проверяет, является ли тип сообщения командой прерывания
    
    Args:
        msg_type: Тип сообщения
        
    Returns:
        bool: True если это команда прерывания
    """
    interruption_commands = {
        "response.cancel",
        "output_audio_buffer.clear",
        "conversation.item.truncate", 
        "emergency_stop"
    }
    
    return msg_type in interruption_commands

def log_interruption_event(
    event_type: str,
    details: Dict[str, Any],
    client_id: Optional[str] = None
) -> None:
    """
    Логирует события прерывания с единообразным форматом
    
    Args:
        event_type: Тип события
        details: Детали события
        client_id: ID клиента
    """
    log_msg = f"[INTERRUPTION-{event_type.upper()}]"
    
    if client_id:
        log_msg += f" Client: {client_id}"
    
    # Форматируем детали
    details_str = ", ".join([f"{k}={v}" for k, v in details.items()])
    log_msg += f" - {details_str}"
    
    logger.info(log_msg)

class InterruptionSequencer:
    """
    Управляет последовательностью команд прерывания с соблюдением задержек
    """
    
    def __init__(self):
        self.last_command_time = 0
        self.pending_commands = []
    
    def add_command(
        self,
        command_type: str,
        payload: Dict[str, Any],
        delay_ms: int = 0
    ) -> None:
        """
        Добавляет команду в очередь с задержкой
        
        Args:
            command_type: Тип команды
            payload: Данные команды
            delay_ms: Задержка в миллисекундах
        """
        execute_time = time.time() * 1000 + delay_ms
        
        self.pending_commands.append({
            "type": command_type,
            "payload": payload,
            "execute_time": execute_time
        })
        
        # Сортируем по времени выполнения
        self.pending_commands.sort(key=lambda x: x["execute_time"])
    
    def get_ready_commands(self) -> List[Dict[str, Any]]:
        """
        Возвращает команды, готовые к выполнению
        
        Returns:
            List: Список готовых команд
        """
        current_time = time.time() * 1000
        ready = []
        remaining = []
        
        for cmd in self.pending_commands:
            if cmd["execute_time"] <= current_time:
                ready.append(cmd)
            else:
                remaining.append(cmd)
        
        self.pending_commands = remaining
        return ready
    
    def clear_pending(self) -> None:
        """Очищает все ожидающие команды"""
        self.pending_commands.clear()

def create_interruption_sequence(
    item_id: Optional[str],
    sample_count: int,
    was_playing_audio: bool,
    sample_rate: int = None
) -> List[Dict[str, Any]]:
    """
    Создает полную последовательность команд прерывания
    
    Args:
        item_id: ID прерываемого элемента
        sample_count: Количество воспроизведенных семплов
        was_playing_audio: Было ли воспроизведение
        sample_rate: Частота дискретизации
        
    Returns:
        List: Последовательность команд с задержками
    """
    commands = []
    
    # 1. response.cancel (немедленно)
    cancel_payload = create_cancel_payload(item_id, sample_count)
    commands.append({
        "type": "response.cancel",
        "payload": cancel_payload,
        "delay_ms": 0
    })
    
    # 2. output_audio_buffer.clear (если было воспроизведение)
    if was_playing_audio and item_id:
        clear_payload = create_clear_output_payload()
        commands.append({
            "type": "output_audio_buffer.clear",
            "payload": clear_payload,
            "delay_ms": InterruptionConfig.MIN_CANCEL_TO_CLEAR_DELAY_MS
        })
    
    # 3. conversation.item.truncate (если есть семплы для обрезки)
    if item_id and sample_count > InterruptionConfig.MIN_AUDIO_SAMPLES_FOR_TRUNCATE:
        truncate_payload = create_truncate_payload(
            item_id, sample_count, sample_rate
        )
        commands.append({
            "type": "conversation.item.truncate", 
            "payload": truncate_payload,
            "delay_ms": InterruptionConfig.MIN_CLEAR_TO_TRUNCATE_DELAY_MS
        })
    
    return commands
