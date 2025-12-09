"""
🧪 ЭКСПЕРИМЕНТАЛЬНЫЙ OpenAI Realtime API Client с оптимизированным стримингом

Особенности:
- Sentence boundary detection для минимальной latency
- Chunked TTS streaming
- Aggressive interruption handling
- Parallel processing LLM → TTS
"""

import asyncio
import websockets
import json
import base64
import logging
from typing import Optional, Callable, Dict, Any
from .sentence_detector import StreamingSentenceDetector

logger = logging.getLogger(__name__)


class OpenAIRealtimeClientStreaming:
    """
    Клиент для работы с OpenAI Realtime API (GA) с оптимизацией стриминга
    """
    
    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o-realtime-preview-2024-12-17",
        voice: str = "alloy",
        language: str = "ru",
        instructions: Optional[str] = None,
        temperature: float = 0.8,
        max_tokens: int = 300  # Ограничиваем для коротких реплик
    ):
        self.api_key = api_key
        self.model = model
        self.voice = voice
        self.language = language
        self.instructions = instructions or "Ты голосовой ассистент. Отвечай кратко и естественно короткими фразами."
        self.temperature = temperature
        self.max_tokens = max_tokens
        
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.session_id: Optional[str] = None
        
        # Sentence detector для оптимального разбиения
        self.sentence_detector = StreamingSentenceDetector(
            language=language,
            min_chunk_length=30  # Агрессивная отправка
        )
        
        # Колбэки
        self.on_audio_delta: Optional[Callable] = None
        self.on_text_delta: Optional[Callable] = None
        self.on_sentence_ready: Optional[Callable] = None  # 🆕 для TTS chunking
        self.on_error: Optional[Callable] = None
        self.on_interruption: Optional[Callable] = None
        
        # Состояние
        self.is_speaking = False
        self.current_response_id: Optional[str] = None
        self.text_buffer = ""
        
        # Статистика для оптимизации
        self.stats = {
            "first_token_latency": None,
            "first_audio_latency": None,
            "sentences_sent": 0,
            "interruptions": 0
        }
    
    async def connect(self):
        """Подключение к OpenAI Realtime API"""
        url = f"wss://api.openai.com/v1/realtime?model={self.model}"
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "OpenAI-Beta": "realtime=v1"
        }
        
        try:
            self.ws = await websockets.connect(url, extra_headers=headers)
            logger.info(f"✅ Connected to OpenAI Realtime API (streaming mode)")
            
            # Конфигурация сессии
            await self._configure_session()
            
            # Запускаем обработку сообщений
            asyncio.create_task(self._receive_messages())
            
        except Exception as e:
            logger.error(f"❌ Connection error: {e}")
            if self.on_error:
                await self.on_error(str(e))
            raise
    
    async def _configure_session(self):
        """Конфигурация сессии с оптимизацией для streaming"""
        config = {
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": self.instructions,
                "voice": self.voice,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": "whisper-1"
                },
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500  # Быстрое детектирование паузы
                },
                "temperature": self.temperature,
                "max_response_output_tokens": self.max_tokens  # Короткие ответы
            }
        }
        
        await self.ws.send(json.dumps(config))
        logger.info("📝 Session configured for streaming optimization")
    
    async def send_audio_chunk(self, audio_data: bytes):
        """Отправка аудио чанка пользователя"""
        if not self.ws:
            return
        
        base64_audio = base64.b64encode(audio_data).decode('utf-8')
        
        message = {
            "type": "input_audio_buffer.append",
            "audio": base64_audio
        }
        
        await self.ws.send(json.dumps(message))
    
    async def commit_audio_buffer(self):
        """Коммит аудио буфера - начало обработки"""
        if not self.ws:
            return
        
        message = {"type": "input_audio_buffer.commit"}
        await self.ws.send(json.dumps(message))
        
        # Создаем response для генерации ответа
        await self.create_response()
    
    async def create_response(self):
        """Создание нового response для генерации ответа"""
        if not self.ws:
            return
        
        # Сбрасываем sentence detector
        self.sentence_detector.buffer = ""
        self.text_buffer = ""
        
        message = {
            "type": "response.create",
            "response": {
                "modalities": ["text", "audio"],
                "instructions": "Отвечай кратко, одним-двумя предложениями."
            }
        }
        
        await self.ws.send(json.dumps(message))
        logger.info("🎤 Response creation triggered")
    
    async def cancel_response(self):
        """Отмена текущего response (для interruption)"""
        if not self.ws or not self.current_response_id:
            return
        
        message = {
            "type": "response.cancel"
        }
        
        await self.ws.send(json.dumps(message))
        
        self.stats["interruptions"] += 1
        self.is_speaking = False
        self.current_response_id = None
        
        # Сбрасываем буферы
        self.sentence_detector.buffer = ""
        self.text_buffer = ""
        
        logger.info(f"🛑 Response cancelled (interruption #{self.stats['interruptions']})")
        
        if self.on_interruption:
            await self.on_interruption()
    
    async def _receive_messages(self):
        """Основной цикл обработки сообщений от OpenAI"""
        try:
            async for message in self.ws:
                data = json.loads(message)
                await self._handle_message(data)
                
        except websockets.exceptions.ConnectionClosed:
            logger.warning("⚠️ WebSocket connection closed")
        except Exception as e:
            logger.error(f"❌ Error in receive loop: {e}")
            if self.on_error:
                await self.on_error(str(e))
    
    async def _handle_message(self, data: Dict[str, Any]):
        """Обработка сообщения от OpenAI"""
        msg_type = data.get("type")
        
        # === SESSION EVENTS ===
        if msg_type == "session.created":
            self.session_id = data.get("session", {}).get("id")
            logger.info(f"✅ Session created: {self.session_id}")
        
        elif msg_type == "session.updated":
            logger.info("✅ Session updated")
        
        # === RESPONSE EVENTS ===
        elif msg_type == "response.created":
            self.current_response_id = data.get("response", {}).get("id")
            self.is_speaking = True
            logger.info(f"🎯 Response started: {self.current_response_id}")
        
        elif msg_type == "response.done":
            # Отправляем остаток буфера
            await self._flush_sentence_buffer()
            
            self.is_speaking = False
            self.current_response_id = None
            logger.info(f"✅ Response complete. Sentences sent: {self.stats['sentences_sent']}")
        
        # === TEXT STREAMING (🔥 главное для sentence detection) ===
        elif msg_type == "response.text.delta":
            delta = data.get("delta", "")
            self.text_buffer += delta
            
            # Детектируем границы предложений
            sentences = self.sentence_detector.add_chunk(delta)
            
            for sentence in sentences:
                await self._send_sentence_to_tts(sentence)
            
            # Колбэк для UI
            if self.on_text_delta:
                await self.on_text_delta(delta)
        
        elif msg_type == "response.text.done":
            text = data.get("text", "")
            logger.info(f"💬 Text complete: {text[:100]}...")
        
        # === AUDIO STREAMING ===
        elif msg_type == "response.audio.delta":
            audio_b64 = data.get("delta", "")
            if audio_b64 and self.on_audio_delta:
                audio_bytes = base64.b64decode(audio_b64)
                await self.on_audio_delta(audio_bytes)
        
        elif msg_type == "response.audio.done":
            logger.info("🔊 Audio streaming complete")
        
        # === INPUT AUDIO EVENTS ===
        elif msg_type == "input_audio_buffer.speech_started":
            logger.info("🎙️ User started speaking")
            # Прерываем текущий ответ если он идет
            if self.is_speaking:
                await self.cancel_response()
        
        elif msg_type == "input_audio_buffer.speech_stopped":
            logger.info("🎙️ User stopped speaking")
        
        elif msg_type == "input_audio_buffer.committed":
            logger.info("✅ Audio buffer committed")
        
        # === CONVERSATION EVENTS ===
        elif msg_type == "conversation.item.created":
            item = data.get("item", {})
            logger.info(f"💾 Item created: {item.get('type')}")
        
        # === ERROR HANDLING ===
        elif msg_type == "error":
            error = data.get("error", {})
            error_msg = error.get("message", "Unknown error")
            logger.error(f"❌ OpenAI Error: {error_msg}")
            
            if self.on_error:
                await self.on_error(error_msg)
        
        # === RATE LIMIT ===
        elif msg_type == "rate_limits.updated":
            limits = data.get("rate_limits", [])
            logger.debug(f"📊 Rate limits: {limits}")
    
    async def _send_sentence_to_tts(self, sentence: str):
        """Отправка готового предложения в TTS колбэк"""
        if not sentence or len(sentence) < 5:
            return
        
        self.stats["sentences_sent"] += 1
        
        logger.info(f"📤 Sentence #{self.stats['sentences_sent']}: {sentence[:50]}...")
        
        if self.on_sentence_ready:
            await self.on_sentence_ready(sentence)
    
    async def _flush_sentence_buffer(self):
        """Отправка остатка буфера в конце ответа"""
        final_sentence = self.sentence_detector.flush()
        if final_sentence:
            await self._send_sentence_to_tts(final_sentence)
    
    async def disconnect(self):
        """Закрытие соединения"""
        if self.ws:
            await self.ws.close()
            logger.info("👋 Disconnected from OpenAI Realtime API")
    
    def get_stats(self) -> Dict[str, Any]:
        """Получение статистики для анализа производительности"""
        return {
            **self.stats,
            "buffer_size": len(self.sentence_detector.buffer),
            "is_speaking": self.is_speaking
        }
