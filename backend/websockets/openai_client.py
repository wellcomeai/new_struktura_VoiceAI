# backend/websockets/openai_client.py
import asyncio
import json
import uuid
import base64
import time
from typing import Optional, Dict, Any
import websockets
from websockets.exceptions import ConnectionClosed
from fastapi import WebSocket

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.conversation import Conversation
from backend.functions.registry import get_all_functions, get_function

logger = get_logger(__name__)

DEFAULT_VOICE = "alloy"
DEFAULT_SYSTEM_MESSAGE = "You are a helpful voice assistant."

class OpenAIRealtimeClient:
    def __init__(self, api_key: str, assistant_config: Any, client_id: str, db_session=None):
        self.api_key = api_key
        self.assistant_config = assistant_config
        self.client_id = client_id
        self.db_session = db_session
        self.ws = None
        self.is_connected = False
        self.openai_url = settings.REALTIME_WS_URL
        self.session_id = str(uuid.uuid4())
        self.conversation_record_id: Optional[str] = None
        self.client_websocket: Optional[WebSocket] = None
        logger.info(f"🚀 Инициализация OpenAI клиента: {client_id}")

    async def connect(self) -> bool:
        if not self.api_key:
            logger.error("❌ API ключ не предоставлен")
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
                    max_size=15*1024*1024,
                    ping_interval=30,
                    ping_timeout=120,
                    close_timeout=15
                ),
                timeout=30
            )
            self.is_connected = True
            logger.info(f"✅ Подключено к OpenAI: {self.client_id}")

            voice = self.assistant_config.voice or DEFAULT_VOICE
            system_message = self.assistant_config.system_prompt or DEFAULT_SYSTEM_MESSAGE
            functions_cfg = getattr(self.assistant_config, "functions", None)

            success = await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions_cfg
            )
            if not success:
                await self.close()
                return False
            return True

        except Exception as e:
            logger.error(f"❌ Ошибка подключения к OpenAI: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Dict[str, Any]] = None
    ) -> bool:
        if not self.is_connected or not self.ws:
            return False

        turn_detection = {
            "type": "server_vad",
            "threshold": 0.25,
            "prefix_padding_ms": 200,
            "silence_duration_ms": 300,
            "create_response": True,
        }

        tools = []
        if functions and isinstance(functions, dict) and "enabled_functions" in functions:
            enabled = functions.get("enabled_functions", [])
            registry = get_all_functions()
            for fid in enabled:
                if fid in registry:
                    finfo = registry[fid]
                    tools.append({
                        "type": "function",
                        "name": fid,
                        "description": finfo["description"],
                        "parameters": finfo["parameters"]
                    })
                    logger.info(f"🛠 Добавлена функция: {fid}")

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
                "tool_choice": "auto" if tools else "none"
            }
        }

        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"✅ session.update отправлен (voice={voice}, tools={len(tools)})")
        except Exception as e:
            logger.error(f"❌ Ошибка отправки session.update: {e}")
            return False

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
                logger.info(f"📝 Разговор в БД создан: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка сохранения Conversation: {e}")

        return True

    async def process_audio(self, audio_buffer: bytes, client_websocket=None) -> bool:
        """Обрабатывает аудио от клиента, отправляет в OpenAI и затем вызывает commit"""
        if not (self.is_connected and self.ws and audio_buffer):
            return False
        try:
            # Сохраняем ссылку на клиентский WebSocket для отправки ответов
            if client_websocket:
                self.client_websocket = client_websocket
                
            # Отправляем аудио в буфер
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": f"audio_{time.time()}"
            }))
            
            # Фиксируем аудио в буфере
            await self.commit_audio()
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"❌ Ошибка при отправке аудио: {e}")
            return False

    async def commit_audio(self) -> bool:
        if not (self.is_connected and self.ws):
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": f"commit_{time.time()}"
            }))
            logger.info("✅ Аудио зафиксировано в буфере")
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False
        except Exception as e:
            logger.error(f"❌ Ошибка при фиксации аудио: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        if not (self.is_connected and self.ws):
            return False
        try:
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": f"clear_{time.time()}"
            }))
            return True
        except ConnectionClosed:
            self.is_connected = False
            return False

    async def listen_for_responses(self, client_websocket):
        """Слушает ответы от OpenAI и пересылает их клиенту"""
        if not self.ws:
            return
            
        try:
            self.client_websocket = client_websocket
            user_message = ""
            assistant_message = ""
            current_function_name = None
            current_function_args = ""
            
            while True:
                try:
                    message = await asyncio.wait_for(self.ws.recv(), timeout=30)
                    event = json.loads(message)
                    event_type = event.get("type")
                    
                    # Логирование для отладки
                    if event_type not in ["rate_limits.updated"]:
                        logger.debug(f"Получено событие от OpenAI: {event_type}")
                    
                    # Обрабатываем различные типы событий
                    if event_type == "input_audio_buffer.speech_started":
                        # Началось распознавание речи пользователя
                        await client_websocket.send_json({
                            "type": "speech_started",
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "input_audio_buffer.speech_stopped":
                        # Закончилось распознавание речи пользователя
                        await client_websocket.send_json({
                            "type": "speech_stopped",
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "conversation.item.input_audio_transcription.completed":
                        # Транскрипция аудио пользователя
                        transcript = event.get("transcript", "")
                        user_message = transcript
                        await client_websocket.send_json({
                            "type": "transcript",
                            "text": transcript,
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.created":
                        # Создан новый ответ ассистента
                        await client_websocket.send_json({
                            "type": "response_started",
                            "response_id": event.get("response", {}).get("id")
                        })
                    
                    elif event_type == "response.text.delta":
                        # Получаем фрагмент текста
                        delta = event.get("delta", "")
                        assistant_message += delta
                        
                        # Отправляем клиенту
                        await client_websocket.send_json({
                            "type": "text",
                            "text": delta,
                            "is_final": False,
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.text.done":
                        # Финальный текст
                        final_text = event.get("text", "")
                        await client_websocket.send_json({
                            "type": "text",
                            "text": final_text,
                            "is_final": True,
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.audio.delta":
                        # Получаем фрагмент аудио
                        audio_data = event.get("delta", "")
                        await client_websocket.send_json({
                            "type": "audio",
                            "audio": audio_data,
                            "is_final": False,
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.audio.done":
                        # Финальное аудио
                        await client_websocket.send_json({
                            "type": "audio",
                            "is_final": True,
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.function_call_arguments.delta":
                        # Получаем фрагмент аргументов функции
                        delta = event.get("delta", "")
                        current_function_args += delta
                        
                        # Получаем информацию о функции
                        if current_function_name is None:
                            item = await self._get_item_info(event.get("item_id"))
                            if item and "function" in item:
                                current_function_name = item.get("function", {}).get("name")
                        
                        await client_websocket.send_json({
                            "type": "function_call_delta",
                            "function_name": current_function_name,
                            "arguments_delta": delta,
                            "call_id": event.get("call_id"),
                            "item_id": event.get("item_id")
                        })
                    
                    elif event_type == "response.function_call_arguments.done":
                        # Вызов функции завершен
                        call_id = event.get("call_id")
                        arguments = event.get("arguments", "{}")
                        
                        try:
                            args_dict = json.loads(arguments)
                            
                            if current_function_name:
                                # Вызываем функцию
                                result = await self.handle_function_call(current_function_name, args_dict)
                                
                                # Отправляем результат клиенту
                                await client_websocket.send_json({
                                    "type": "function_result",
                                    "function_name": current_function_name,
                                    "result": result,
                                    "call_id": call_id,
                                    "item_id": event.get("item_id")
                                })
                                
                                # Отправляем результат обратно в OpenAI
                                await self.ws.send(json.dumps({
                                    "type": "conversation.item.create",
                                    "item": {
                                        "type": "function_call_response",
                                        "function_call_id": call_id,
                                        "content": result
                                    }
                                }))
                                
                                # Сбрасываем для следующего вызова функции
                                current_function_name = None
                                current_function_args = ""
                            else:
                                logger.error("Имя функции не определено для вызова")
                        except Exception as e:
                            logger.error(f"Ошибка при вызове функции: {e}")
                    
                    elif event_type == "response.done":
                        # Ответ завершен
                        await client_websocket.send_json({
                            "type": "response_done",
                            "response_id": event.get("response", {}).get("id")
                        })
                        
                        # Обновляем запись разговора в БД
                        if self.db_session and self.conversation_record_id:
                            try:
                                conv = self.db_session.query(Conversation).filter(
                                    Conversation.id == uuid.UUID(self.conversation_record_id)
                                ).first()
                                if conv:
                                    conv.user_message = user_message[:1000]  # Лимитируем размер
                                    conv.assistant_message = assistant_message[:1000]
                                    self.db_session.commit()
                                    logger.info(f"Обновлена запись разговора: {self.conversation_record_id}")
                            except Exception as e:
                                logger.error(f"Ошибка обновления записи разговора: {e}")
                    
                    elif event_type == "error":
                        # Обработка ошибок
                        error_msg = event.get("error", {}).get("message", "Unknown error")
                        logger.error(f"Ошибка от OpenAI: {error_msg}")
                        await client_websocket.send_json({
                            "type": "error",
                            "error": {"message": error_msg}
                        })
                
                except asyncio.TimeoutError:
                    # Таймаут не критичен, продолжаем слушать
                    continue
                except ConnectionClosed:
                    logger.warning("Соединение с OpenAI закрыто")
                    break
                except Exception as e:
                    logger.error(f"Ошибка при обработке ответа от OpenAI: {e}")
        
        except Exception as e:
            logger.error(f"Критическая ошибка в listen_for_responses: {e}")
        finally:
            logger.info("Завершение прослушивания ответов OpenAI")

    async def _get_item_info(self, item_id):
        """Получает информацию об элементе по его ID"""
        if not (self.is_connected and self.ws):
            return None
        try:
            await self.ws.send(json.dumps({
                "type": "conversation.item.retrieve",
                "item_id": item_id,
                "event_id": f"retrieve_{time.time()}"
            }))
            
            # Ждем ответ
            for _ in range(5):  # Пробуем до 5 раз
                message = await asyncio.wait_for(self.ws.recv(), timeout=5)
                event = json.loads(message)
                if event.get("type") == "conversation.item.retrieved" and event.get("item_id") == item_id:
                    return event.get("item")
        except Exception as e:
            logger.error(f"Ошибка при получении информации об элементе: {e}")
        return None

    async def handle_function_call(self, function_name: str, arguments: dict) -> dict:
        logger.info(f"🔔 Вызов функции {function_name}, args={arguments}")
        try:
            info = get_function(function_name)
            if not info:
                logger.warning(f"⚠️ Функция {function_name} не найдена в реестре")
                return {"error": f"Function '{function_name}' not found"}
            func = info["function"]
            result = await func(**arguments)
            logger.info(f"📤 Результат функции {function_name} отправлен: {result}")
            return result
        except Exception as e:
            logger.error(f"❌ Ошибка в handle_function_call: {e}")
            return {"error": str(e)}

    async def close(self) -> None:
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"🔒 WebSocket закрыт: {self.client_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка при закрытии WebSocket: {e}")
        self.is_connected = False
