# backend/websockets/voximplant_handler.py - НОВЫЙ УПРОЩЕННЫЙ ОБРАБОТЧИК

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
from backend.models.user import User
from backend.websockets.openai_client import OpenAIRealtimeClient
from backend.utils.audio_utils import base64_to_audio_buffer, audio_buffer_to_base64
from backend.services.user_service import UserService

logger = get_logger(__name__)

class SimpleVoximplantHandler:
    """
    УПРОЩЕННЫЙ обработчик для Voximplant без промежуточных адаптеров.
    Напрямую интегрируется с OpenAI Realtime API.
    """
    
    def __init__(self, voximplant_ws: WebSocket, assistant_id: str, db: Session):
        self.voximplant_ws = voximplant_ws
        self.assistant_id = assistant_id
        self.db = db
        self.client_id = str(uuid.uuid4())
        self.is_connected = False
        self.openai_client = None
        
        # Аудио настройки для Voximplant PCM16
        self.audio_buffer = bytearray()
        self.last_audio_time = time.time()
        self.audio_chunk_size = 1280  # 40мс при 16kHz PCM16
        self.sample_rate = 16000
        
        # Фоновые задачи
        self.background_tasks = []
        
        logger.info(f"[VOXIMPLANT] Создан простой обработчик для assistant_id={assistant_id}")

    async def start(self):
        """Запускает обработчик"""
        try:
            await self.voximplant_ws.accept()
            self.is_connected = True
            logger.info(f"[VOXIMPLANT] WebSocket принят")
            
            # Загружаем конфигурацию ассистента
            assistant = await self.load_assistant_config()
            if not assistant:
                return
            
            # Проверяем подписку
            if not await self.check_subscription(assistant):
                return
            
            # Создаем OpenAI клиент
            api_key = await self.get_api_key(assistant)
            if not api_key:
                await self.send_error("no_api_key", "Отсутствует ключ API OpenAI")
                return
                
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
            
            # Запускаем задачи обработки
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
                
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка запуска: {e}")
        finally:
            await self.cleanup()

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
            return True  # Продолжаем работу при ошибке проверки

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

    async def handle_voximplant_messages(self):
        """Обрабатывает сообщения от Voximplant"""
        try:
            while self.is_connected:
                message = await self.voximplant_ws.receive()
                
                if "text" in message:
                    try:
                        data = json.loads(message["text"])
                        await self.process_text_message(data)
                    except json.JSONDecodeError as e:
                        logger.warning(f"[VOXIMPLANT] Некорректный JSON: {e}")
                elif "bytes" in message:
                    await self.process_audio_data(message["bytes"])
                    
        except WebSocketDisconnect:
            logger.info(f"[VOXIMPLANT] Соединение закрыто")
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки сообщений: {e}")

    async def process_text_message(self, data: dict):
        """Обрабатывает текстовые сообщения"""
        msg_type = data.get("type", "")
        
        if not msg_type:
            # Игнорируем сообщения без типа - это нормально для аудио
            return
            
        logger.info(f"[VOXIMPLANT] Получено: {msg_type}")
        
        if msg_type == "call_started":
            logger.info(f"[VOXIMPLANT] Звонок начат: {data.get('caller_number')}")
            
        elif msg_type == "call_ended":
            logger.info(f"[VOXIMPLANT] Звонок завершен")
            await self.cleanup()
            
        elif msg_type == "audio_ready":
            logger.info(f"[VOXIMPLANT] Аудио готово: {data.get('format', 'unknown')}")
            
        elif msg_type == "interruption.manual":
            if self.openai_client:
                await self.openai_client.handle_interruption()

    async def process_audio_data(self, audio_bytes: bytes):
        """Обрабатывает аудио данные от Voximplant"""
        if not self.openai_client or not audio_bytes:
            return
            
        try:
            # ✅ ИСПРАВЛЕНО: Добавляем детальное логирование аудио
            logger.info(f"[VOXIMPLANT] Получен аудио пакет: {len(audio_bytes)} байт")
            
            # Накапливаем аудио в буфере
            self.audio_buffer.extend(audio_bytes)
            self.last_audio_time = time.time()
            
            # Отправляем чанками в OpenAI
            chunks_sent = 0
            while len(self.audio_buffer) >= self.audio_chunk_size:
                chunk = bytes(self.audio_buffer[:self.audio_chunk_size])
                self.audio_buffer = self.audio_buffer[self.audio_chunk_size:]
                
                # Отправляем в OpenAI
                await self.openai_client.process_audio(chunk)
                chunks_sent += 1
            
            if chunks_sent > 0:
                logger.info(f"[VOXIMPLANT] Отправлено в OpenAI: {chunks_sent} чанков аудио")
            
            # Автоматический коммит после паузы
            asyncio.create_task(self.auto_commit_audio())
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки аудио: {e}")

    async def auto_commit_audio(self):
        """Автоматически коммитит аудио после паузы"""
        await asyncio.sleep(0.6)
        
        if time.time() - self.last_audio_time >= 0.5:
            if self.openai_client:
                logger.info(f"[VOXIMPLANT] Коммит аудио буфера в OpenAI")
                await self.openai_client.commit_audio()

    async def handle_openai_messages(self):
        """Обрабатывает сообщения от OpenAI"""
        if not self.openai_client or not self.openai_client.is_connected:
            return
            
        try:
            async for message in self.openai_client.receive_messages():
                await self.process_openai_message(message)
                
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Ошибка обработки OpenAI: {e}")

    async def process_openai_message(self, message: dict):
        """Обрабатывает конкретное сообщение от OpenAI"""
        msg_type = message.get("type", "")
        
        # ✅ ИСПРАВЛЕНО: Детальное логирование всех сообщений от OpenAI
        logger.info(f"[VOXIMPLANT] OpenAI сообщение: {msg_type}")
        
        # Отправляем важные события в Voximplant
        if msg_type in ["error", "function_call.start", "function_call.completed"]:
            await self.send_message(message)
            
        # ✅ ИСПРАВЛЕНО: Улучшенная обработка аудио от ассистента
        elif msg_type == "response.audio.delta":
            delta_audio = message.get("delta", "")
            if delta_audio:
                try:
                    audio_bytes = base64_to_audio_buffer(delta_audio)
                    logger.info(f"[VOXIMPLANT] Отправка аудио в Voximplant: {len(audio_bytes)} байт")
                    await self.voximplant_ws.send_bytes(audio_bytes)
                except Exception as e:
                    logger.error(f"[VOXIMPLANT] Ошибка отправки аудио: {e}")
                    
        # ✅ НОВОЕ: Обработка транскрипции для диагностики
        elif msg_type == "conversation.item.input_audio_transcription.completed":
            transcript = message.get("transcript", "")
            if transcript:
                logger.info(f"[VOXIMPLANT] Транскрипция пользователя: '{transcript}'")
                
        elif msg_type == "response.audio_transcript.done":
            transcript = message.get("transcript", "")
            if transcript:
                logger.info(f"[VOXIMPLANT] Транскрипция ассистента: '{transcript}'")
                    
        # Отслеживаем состояние речи ассистента
        elif msg_type in ["response.audio.done", "response.done"]:
            logger.info(f"[VOXIMPLANT] Ассистент закончил генерацию ответа")
            await self.send_message({
                "type": "assistant_speaking",
                "speaking": False,
                "timestamp": time.time()
            })
            
        # ✅ НОВОЕ: Логируем начало генерации ответа
        elif msg_type == "response.created":
            logger.info(f"[VOXIMPLANT] Ассистент начал генерацию ответа")
            
        # ✅ НОВОЕ: Логируем события аудио буфера
        elif msg_type == "input_audio_buffer.committed":
            logger.info(f"[VOXIMPLANT] Аудио буфер успешно коммитнут в OpenAI")
            
        elif msg_type == "input_audio_buffer.speech_started":
            logger.info(f"[VOXIMPLANT] OpenAI обнаружил начало речи пользователя")
            
        elif msg_type == "input_audio_buffer.speech_stopped":
            logger.info(f"[VOXIMPLANT] OpenAI обнаружил окончание речи пользователя")

    async def send_message(self, message: dict):
        """Отправляет сообщение в Voximplant"""
        if self.is_connected:
            try:
                await self.voximplant_ws.send_text(json.dumps(message))
            except Exception as e:
                logger.error(f"[VOXIMPLANT] Ошибка отправки сообщения: {e}")

    async def send_error(self, code: str, message: str):
        """Отправляет ошибку в Voximplant"""
        await self.send_message({
            "type": "error",
            "error": {
                "code": code,
                "message": message
            }
        })
        await self.voximplant_ws.close(code=1008)

    async def cleanup(self):
        """Очищает ресурсы"""
        logger.info(f"[VOXIMPLANT] Начало очистки для {self.client_id}")
        
        self.is_connected = False
        
        # Отменяем задачи
        for task in self.background_tasks:
            if not task.done():
                task.cancel()
        
        # Закрываем OpenAI клиент
        if self.openai_client:
            await self.openai_client.close()
            
        logger.info(f"[VOXIMPLANT] Очистка завершена для {self.client_id}")


async def handle_voximplant_websocket_simple(websocket: WebSocket, assistant_id: str, db: Session):
    """
    УПРОЩЕННАЯ функция для обработки Voximplant WebSocket соединений
    """
    handler = None
    try:
        # Создаем отдельную сессию БД для обработчика
        from backend.db.session import SessionLocal
        handler_db = SessionLocal()
        
        try:
            handler = SimpleVoximplantHandler(websocket, assistant_id, handler_db)
            await handler.start()
        finally:
            handler_db.close()
            
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка обработки: {e}")
        
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
