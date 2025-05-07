"""
Утилиты для работы с аудио.
Включает функции для преобразования форматов аудио и кодирования/декодирования.
"""
import base64
import io
import wave
import struct
from typing import Tuple, Optional

from backend.core.logging import get_logger

logger = get_logger(__name__)

def audio_buffer_to_base64(audio_buffer: bytes, mime_type: str = "audio/wav") -> str:
    """
    Преобразует бинарный аудио-буфер в строку base64.
    
    Args:
        audio_buffer: Бинарные аудио данные
        mime_type: MIME-тип аудио (например, "audio/wav", "audio/mp3")
        
    Returns:
        str: Аудио данные в формате base64 с префиксом MIME типа
    """
    try:
        # Кодируем бинарные данные в base64
        b64_data = base64.b64encode(audio_buffer).decode('utf-8')
        
        # Возвращаем с префиксом MIME типа
        return f"data:{mime_type};base64,{b64_data}"
        
    except Exception as e:
        logger.error(f"❌ Ошибка при кодировании аудио в base64: {e}")
        raise ValueError(f"Ошибка преобразования в base64: {e}")

def base64_to_audio_buffer(b64_data: str) -> bytes:
    """
    Преобразует base64-строку в бинарный аудио-буфер.
    
    Args:
        b64_data: Аудио данные в формате base64
        
    Returns:
        bytes: Бинарный аудио-буфер
        
    Raises:
        ValueError: Если данные не являются корректной base64-строкой
    """
    try:
        # Проверяем и удаляем префикс data:audio/*, если присутствует
        if b64_data.startswith('data:audio/'):
            # Удаляем префикс data:audio и все до base64,
            b64_data = b64_data.split('base64,')[1]
        
        # Декодируем base64 в бинарные данные
        audio_bytes = base64.b64decode(b64_data)
        return audio_bytes
        
    except Exception as e:
        logger.error(f"❌ Ошибка при декодировании base64 аудио: {e}")
        raise ValueError(f"Некорректные base64 данные: {e}")

def create_wav_from_pcm(
    pcm_data: bytes, 
    sample_rate: int = 16000, 
    sample_width: int = 2,
    channels: int = 1
) -> bytes:
    """
    Создает WAV файл из PCM аудио данных.
    
    Args:
        pcm_data: PCM аудио данные
        sample_rate: Частота дискретизации (Гц)
        sample_width: Количество байт на сэмпл (2 = 16 бит)
        channels: Количество каналов (1 = моно, 2 = стерео)
        
    Returns:
        bytes: Аудио данные в формате WAV
    """
    try:
        with io.BytesIO() as wav_buffer:
            with wave.open(wav_buffer, 'wb') as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(sample_width)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(pcm_data)
            
            return wav_buffer.getvalue()
            
    except Exception as e:
        logger.error(f"❌ Ошибка при создании WAV из PCM: {e}")
        raise ValueError(f"Ошибка создания WAV файла: {e}")

def extract_pcm_from_wav(wav_data: bytes) -> Tuple[bytes, int, int, int]:
    """
    Извлекает PCM данные из WAV файла.
    
    Args:
        wav_data: Аудио данные в формате WAV
        
    Returns:
        Tuple[bytes, int, int, int]: PCM данные, частота дискретизации, ширина сэмпла, количество каналов
        
    Raises:
        ValueError: Если данные не являются корректным WAV файлом
    """
    try:
        with io.BytesIO(wav_data) as wav_buffer:
            with wave.open(wav_buffer, 'rb') as wav_file:
                channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                sample_rate = wav_file.getframerate()
                pcm_data = wav_file.readframes(wav_file.getnframes())
                
                return pcm_data, sample_rate, sample_width, channels
                
    except Exception as e:
        logger.error(f"❌ Ошибка при извлечении PCM из WAV: {e}")
        raise ValueError(f"Некорректные WAV данные: {e}")

def get_audio_duration(
    audio_data: bytes,
    sample_rate: int = 16000,
    sample_width: int = 2,
    channels: int = 1
) -> float:
    """
    Рассчитывает длительность аудио в секундах.
    
    Args:
        audio_data: PCM аудио данные
        sample_rate: Частота дискретизации
        sample_width: Количество байт на сэмпл
        channels: Количество каналов
        
    Returns:
        float: Длительность аудио в секундах
    """
    bytes_per_sample = sample_width * channels
    samples_count = len(audio_data) // bytes_per_sample
    duration = samples_count / sample_rate
    return duration

def adjust_audio_volume(
    audio_data: bytes,
    volume_factor: float,
    sample_width: int = 2
) -> bytes:
    """
    Изменяет громкость аудио.
    
    Args:
        audio_data: PCM аудио данные
        volume_factor: Коэффициент громкости (1.0 = исходная громкость)
        sample_width: Количество байт на сэмпл
        
    Returns:
        bytes: PCM аудио данные с измененной громкостью
    """
    try:
        if sample_width == 2:  # 16-bit PCM
            fmt = f"<{len(audio_data)//2}h"
            samples = struct.unpack(fmt, audio_data)
            max_value = 32767
            
            # Применяем коэффициент громкости с клиппингом
            adjusted = [
                max(-max_value, min(max_value, int(s * volume_factor))) 
                for s in samples
            ]
            
            return struct.pack(fmt, *adjusted)
            
        elif sample_width == 1:  # 8-bit PCM
            fmt = f"<{len(audio_data)}b"
            samples = struct.unpack(fmt, audio_data)
            max_value = 127
            
            adjusted = [
                max(-max_value, min(max_value, int(s * volume_factor))) 
                for s in samples
            ]
            
            return struct.pack(fmt, *adjusted)
            
        else:
            logger.warning(f"⚠️ Неподдерживаемая ширина сэмпла: {sample_width}")
            return audio_data
            
    except Exception as e:
        logger.error(f"❌ Ошибка при изменении громкости: {e}")
        return audio_data
