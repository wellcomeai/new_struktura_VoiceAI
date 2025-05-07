# backend/utils/audio_utils.py
import base64
import struct
import io
import wave
from typing import Optional, Tuple, Union
import numpy as np

from backend.core.logging import get_logger

logger = get_logger(__name__)

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

def pcm_to_wav(
    pcm_data: bytes, 
    sample_rate: int = 16000, 
    sample_width: int = 2,
    channels: int = 1
) -> bytes:
    """
    Преобразует PCM аудио данные в формат WAV.
    
    Args:
        pcm_data: PCM аудио данные
        sample_rate: Частота дискретизации
        sample_width: Количество байт на сэмпл (2 = 16 бит)
        channels: Количество каналов
        
    Returns:
        bytes: Аудио данные в формате WAV
    """
    with io.BytesIO() as wav_buffer:
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(sample_width)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_data)
        
        return wav_buffer.getvalue()

def wav_to_pcm(wav_data: bytes) -> Tuple[bytes, int, int, int]:
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

def resample_audio(
    audio_data: bytes,
    original_rate: int,
    target_rate: int = 16000,
    sample_width: int = 2,
    channels: int = 1
) -> bytes:
    """
    Изменяет частоту дискретизации аудио.
    
    Args:
        audio_data: PCM аудио данные
        original_rate: Исходная частота дискретизации
        target_rate: Целевая частота дискретизации
        sample_width: Количество байт на сэмпл
        channels: Количество каналов
        
    Returns:
        bytes: PCM аудио данные с новой частотой дискретизации
    """
    try:
        # Проверяем, нужна ли передискретизация
        if original_rate == target_rate:
            return audio_data
            
        # Конвертируем бинарные данные в numpy array
        if sample_width == 2:  # 16-bit PCM
            fmt = f"<{len(audio_data)//2}h"
            samples = np.array(struct.unpack(fmt, audio_data))
        elif sample_width == 1:  # 8-bit PCM
            fmt = f"<{len(audio_data)}b"
            samples = np.array(struct.unpack(fmt, audio_data))
        elif sample_width == 4:  # 32-bit PCM
            fmt = f"<{len(audio_data)//4}i"
            samples = np.array(struct.unpack(fmt, audio_data))
        else:
            raise ValueError(f"Неподдерживаемая ширина сэмпла: {sample_width}")
        
        # Передискретизация
        samples_count = len(samples)
        ratio = target_rate / original_rate
        new_samples_count = int(samples_count * ratio)
        
        # Интерполяция
        resampled = np.interp(
            np.linspace(0, samples_count - 1, new_samples_count),
            np.arange(samples_count),
            samples
        )
        
        # Конвертируем обратно в бинарные данные
        if sample_width == 2:  # 16-bit PCM
            return struct.pack(f"<{len(resampled)}h", *resampled.astype(np.int16))
        elif sample_width == 1:  # 8-bit PCM
            return struct.pack(f"<{len(resampled)}b", *resampled.astype(np.int8))
        elif sample_width == 4:  # 32-bit PCM
            return struct.pack(f"<{len(resampled)}i", *resampled.astype(np.int32))
            
    except Exception as e:
        logger.error(f"❌ Ошибка при изменении частоты дискретизации: {e}")
        # В случае ошибки возвращаем исходные данные
        return audio_data

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
        # Конвертируем бинарные данные в numpy array
        if sample_width == 2:  # 16-bit PCM
            fmt = f"<{len(audio_data)//2}h"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 32767
        elif sample_width == 1:  # 8-bit PCM
            fmt = f"<{len(audio_data)}b"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 127
        elif sample_width == 4:  # 32-bit PCM
            fmt = f"<{len(audio_data)//4}i"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 2147483647
        else:
            raise ValueError(f"Неподдерживаемая ширина сэмпла: {sample_width}")
        
        # Применяем коэффициент громкости
        samples = samples * volume_factor
        
        # Клиппинг для предотвращения переполнения
        samples = np.clip(samples, -max_value, max_value)
        
        # Конвертируем обратно в бинарные данные
        if sample_width == 2:  # 16-bit PCM
            return struct.pack(f"<{len(samples)}h", *samples.astype(np.int16))
        elif sample_width == 1:  # 8-bit PCM
            return struct.pack(f"<{len(samples)}b", *samples.astype(np.int8))
        elif sample_width == 4:  # 32-bit PCM
            return struct.pack(f"<{len(samples)}i", *samples.astype(np.int32))
            
    except Exception as e:
        logger.error(f"❌ Ошибка при изменении громкости: {e}")
        # В случае ошибки возвращаем исходные данные
        return audio_data

def detect_silence(
    audio_data: bytes,
    sample_width: int = 2,
    threshold: float = 0.05,
    min_duration: float = 0.5,
    sample_rate: int = 16000
) -> list:
    """
    Обнаруживает участки тишины в аудио.
    
    Args:
        audio_data: PCM аудио данные
        sample_width: Количество байт на сэмпл
        threshold: Порог амплитуды для определения тишины (от 0 до 1)
        min_duration: Минимальная длительность участка тишины в секундах
        sample_rate: Частота дискретизации
        
    Returns:
        list: Список кортежей (начало, конец) с участками тишины в секундах
    """
    try:
        # Конвертируем бинарные данные в numpy array
        if sample_width == 2:  # 16-bit PCM
            fmt = f"<{len(audio_data)//2}h"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 32767.0
        elif sample_width == 1:  # 8-bit PCM
            fmt = f"<{len(audio_data)}b"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 127.0
        elif sample_width == 4:  # 32-bit PCM
            fmt = f"<{len(audio_data)//4}i"
            samples = np.array(struct.unpack(fmt, audio_data))
            max_value = 2147483647.0
        else:
            raise ValueError(f"Неподдерживаемая ширина сэмпла: {sample_width}")
        
        # Нормализуем значения к диапазону [-1, 1]
        samples = samples / max_value
        
        # Вычисляем абсолютные значения амплитуды
        amplitude = np.abs(samples)
        
        # Находим участки, где амплитуда ниже порога
        is_silence = amplitude < threshold
        
        # Преобразуем в непрерывные участки
        silence_segments = []
        in_silence = False
        start = 0
        
        min_samples = int(min_duration * sample_rate)
        
        for i, silent in enumerate(is_silence):
            if silent and not in_silence:
                # Начинается участок тишины
                in_silence = True
                start = i
            elif not silent and in_silence:
                # Заканчивается участок тишины
                in_silence = False
                if i - start >= min_samples:
                    silence_segments.append((start / sample_rate, i / sample_rate))
        
        # Обработка случая, когда тишина в конце
        if in_silence and len(samples) - start >= min_samples:
            silence_segments.append((start / sample_rate, len(samples) / sample_rate))
        
        return silence_segments
        
    except Exception as e:
        logger.error(f"❌ Ошибка при обнаружении тишины: {e}")
        return []
