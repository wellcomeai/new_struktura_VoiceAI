# backend/websockets/openai_client.py
import asyncio
import json
import uuid
import base64
import time
from typing import Optional, Dict, Any, List, Tuple
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
    """
    Клиент для взаимодействия с OpenAI Realtime API через WebSockets.
    Обрабатывает аудио, получает ответы и вызывает функции.
    """
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
        self.function_call_cache = {}  # Кэш результатов функций
        logger.info(f"🚀 Инициализация OpenAI клиента: {client_id}")

    async def connect(self) -> bool:
        """
        Устанавливает соединение с OpenAI WebSocket API.
        Возвращает True при успешном подключении.
        """
        if not self.api_key:
            logger.error("❌ API ключ не предоставлен")
            return False
            
        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "WellcomeAI/1.0")
        ]
        
        try:
            # Устанавливаем соединение с увеличенным таймаутом для стабильности
            self.ws = await asyncio.wait_for(
                websockets.connect(
                    self.openai_url,
                    extra_headers=headers,
                    max_size=20*1024*1024,  # Увеличенный размер буфера
                    ping_interval=30,
                    ping_timeout=120,
                    close_timeout=15
                ),
                timeout=30
            )
            self.is_connected = True
            logger.info(f"✅ Подключено к OpenAI: {self.client_id}")

            # Настраиваем сессию с параметрами ассистента
            voice = getattr(self.assistant_config, "voice", None) or DEFAULT_VOICE
            system_message = getattr(self.assistant_config, "system_prompt", None) or DEFAULT_SYSTEM_MESSAGE
            temperature = getattr(self.assistant_config, "temperature", 0.7)
            max_tokens = getattr(self.assistant_config, "max_tokens", 500)
            functions_cfg = getattr(self.assistant_config, "functions", None)

            success = await self.update_session(
                voice=voice,
                system_message=system_message,
                functions=functions_cfg,
                temperature=temperature,
                max_tokens=max_tokens
            )
            
            if not success:
                await self.close()
                return False
                
            return True

        except asyncio.TimeoutError:
            logger.error(f"❌ Таймаут при подключении к OpenAI")
            return False
        except Exception as e:
            logger.error(f"❌ Ошибка подключения к OpenAI: {e}")
            return False

    async def update_session(
        self,
        voice: str = DEFAULT_VOICE,
        system_message: str = DEFAULT_SYSTEM_MESSAGE,
        functions: Optional[Dict[str, Any]] = None,
        temperature: float = 0.7,
        max_tokens: int = 500
    ) -> bool:
        """
        Обновляет параметры сессии с OpenAI.
        
        Args:
            voice: Голос для синтеза речи
            system_message: Системный промпт для ассистента
            functions: Конфигурация доступных функций
            temperature: Температура генерации (0.0-1.0)
            max_tokens: Максимальное кол-во токенов в ответе
            
        Returns:
            bool: Успешно ли обновлена сессия
        """
        if not self.is_connected or not self.ws:
            return False

        # Настройка определения окончания речи пользователя
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.25,
            "prefix_padding_ms": 200,
            "silence_duration_ms": 300,
            "create_response": True,
        }

        # Подготовка инструментов (функций) для ассистента
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

        # Формирование сообщения для обновления сессии
        payload = {
            "type": "session.update",
            "session": {
                "turn_detection": turn_detection,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "voice": voice,
                "instructions": system_message,
                "modalities": ["text", "audio"],
                "temperature": temperature,
                "max_response_output_tokens": max_tokens,
                "tools": tools,
                "tool_choice": "auto" if tools else "none"
            }
        }

        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"✅ session.update отправлен (voice={voice}, tools={len(tools)})")
            
            # Создаем запись о разговоре в БД, если есть сессия
            if self.db_session:
                await self._create_conversation_record()
                
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка отправки session.update: {e}")
            return False

    async def _create_conversation_record(self) -> None:
        """Создает запись о разговоре в базе данных"""
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

    async def process_audio(self, audio_buffer: bytes, client_websocket=None) -> bool:
        """
        Обрабатывает аудио от клиента, отправляет в OpenAI и затем вызывает commit
        
        Args:
            audio_buffer: Аудио данные в бинарном формате
            client_websocket: WebSocket соединение с клиентом
            
        Returns:
            bool: Успешно ли обработано аудио
        """
        if not (self.is_connected and self.ws and audio_buffer):
            logger.warning("⚠️ Попытка отправки аудио при отсутствии соединения")
            return False
            
        try:
            # Сохраняем ссылку на клиентский WebSocket для отправки ответов
            if client_websocket:
                self.client_websocket = client_websocket
                
            # Отправляем аудио в буфер
            data_b64 = base64.b64encode(audio_buffer).decode("utf-8")
            event_id = f"audio_{time.time()}"
            
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": data_b64,
                "event_id": event_id
            }))
            
            logger.debug(f"📤 Аудио отправлено: {len(audio_buffer)} байт, event_id={event_id}")
            
            # Фиксируем аудио в буфере
            await self.commit_audio()
            return True
            
        except ConnectionClosed:
            logger.warning("🔌 Соединение с OpenAI закрыто при отправке аудио")
            self.is_connected = False
            return False
            
        except Exception as e:
            logger.error(f"❌ Ошибка при отправке аудио: {e}")
            return False

    async def commit_audio(self) -> bool:
        """
        Фиксирует аудио в буфере OpenAI, сигнализируя о завершении сегмента аудио
        
        Returns:
            bool: Успешно ли зафиксировано аудио
        """
        if not (self.is_connected and self.ws):
            return False
            
        try:
            event_id = f"commit_{time.time()}"
            
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.commit",
                "event_id": event_id
            }))
            
            logger.info(f"✅ Аудио зафиксировано в буфере (event_id={event_id})")
            return True
            
        except ConnectionClosed:
            logger.warning("🔌 Соединение с OpenAI закрыто при фиксации аудио")
            self.is_connected = False
            return False
            
        except Exception as e:
            logger.error(f"❌ Ошибка при фиксации аудио: {e}")
            return False

    async def clear_audio_buffer(self) -> bool:
        """
        Очищает буфер аудио на стороне OpenAI
        
        Returns:
            bool: Успешно ли очищен буфер
        """
        if not (self.is_connected and self.ws):
            return False
            
        try:
            event_id = f"clear_{time.time()}"
            
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.clear",
                "event_id": event_id
            }))
            
            logger.info(f"🧹 Аудио буфер очищен (event_id={event_id})")
            return True
            
        except ConnectionClosed:
            logger.warning("🔌 Соединение с OpenAI закрыто при очистке буфера")
            self.is_connected = False
            return False
            
        except Exception as e:
            logger.error(f"❌ Ошибка при очистке аудио буфера: {e}")
            return False

    async def listen_for_responses(self, client_websocket):
        """
        Слушает ответы от OpenAI и пересылает их клиенту
        
        Args:
            client_websocket: WebSocket соединение с клиентом
        """
        if not self.ws:
            logger.error("❌ WebSocket соединение с OpenAI отсутствует")
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
                    
                    # Логирование для отладки (кроме технических событий)
                    if event_type not in ["rate_limits.updated"]:
                        logger.debug(f"📩 Получено событие от OpenAI: {event_type}")
                    
                    # Обрабатываем различные типы событий
                    if event_type == "input_audio_buffer.speech_started":
                        # Началось распознавание речи пользователя
                        await client_websocket.send_json({
                            "type": "speech_started",
                            "item_id": event.get("item_id")
                        })
                        logger.debug(f"👂 Начало распознавания речи, item_id={event.get('item_id')}")
                    
                    elif event_type == "input_audio_buffer.speech_stopped":
                        # Закончилось распознавание речи пользователя
                        await client_websocket.send_json({
                            "type": "speech_stopped",
                            "item_id": event.get("item_id")
                        })
                        logger.debug(f"🛑 Конец распознавания речи, item_id={event.get('item_id')}")
                    
                    elif event_type == "conversation.item.input_audio_transcription.completed":
                        # Транскрипция аудио пользователя
                        transcript = event.get("transcript", "")
                        user_message = transcript
                        
                        await client_websocket.send_json({
                            "type": "transcript",
                            "text": transcript,
                            "item_id": event.get("item_id")
                        })
                        
                        logger.info(f"🗣️ Транскрипция: '{transcript[:50]}...' (длина: {len(transcript)})")
                    
                    elif event_type == "response.created":
                        # Создан новый ответ ассистента
                        response_id = event.get("response", {}).get("id")
                        
                        await client_websocket.send_json({
                            "type": "response_started",
                            "response_id": response_id
                        })
                        
                        logger.debug(f"🤖 Начало ответа ассистента, response_id={response_id}")
                    
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
                        
                        logger.info(f"📝 Текст ответа: '{final_text[:50]}...' (длина: {len(final_text)})")
                    
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
                        
                        logger.debug(f"🔊 Аудио ответ завершен, item_id={event.get('item_id')}")
                    
                    elif event_type == "response.function_call_arguments.delta":
                        # Получаем фрагмент аргументов функции
                        delta = event.get("delta", "")
                        current_function_args += delta
                        
                        # Получаем информацию о функции
                        if current_function_name is None:
                            item = await self._get_item_info(event.get("item_id"))
                            if item and "function" in item:
                                current_function_name = item.get("function", {}).get("name")
                                logger.info(f"🔍 Определена функция для вызова: {current_function_name}")
                        
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
                                # Проверяем кэш для оптимизации повторных вызовов
                                cache_key = f"{current_function_name}:{json.dumps(args_dict, sort_keys=True)}"
                                cached_result = self.function_call_cache.get(cache_key)
                                
                                if cached_result:
                                    logger.info(f"📦 Использован кэшированный результат для {current_function_name}")
                                    result = cached_result
                                else:
                                    # Вызываем функцию
                                    result = await self.handle_function_call(current_function_name, args_dict)
                                    # Сохраняем в кэш (только если успешно)
                                    if not isinstance(result, dict) or "error" not in result:
                                        self.function_call_cache[cache_key] = result
                                
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
                                
                                logger.info(f"✅ Результат функции {current_function_name} отправлен в OpenAI")
                                
                                # Сбрасываем для следующего вызова функции
                                current_function_name = None
                                current_function_args = ""
                            else:
                                logger.error("❌ Имя функции не определено для вызова")
                        except json.JSONDecodeError:
                            logger.error(f"❌ Ошибка декодирования JSON аргументов: {arguments}")
                        except Exception as e:
                            logger.error(f"❌ Ошибка при вызове функции: {e}")
                    
                    elif event_type == "response.done":
                        # Ответ завершен
                        response_id = event.get("response", {}).get("id")
                        
                        await client_websocket.send_json({
                            "type": "response_done",
                            "response_id": response_id
                        })
                        
                        logger.info(f"🏁 Ответ завершен, response_id={response_id}")
                        
                        # Обновляем запись разговора в БД
                        await self._update_conversation_record(user_message, assistant_message)
                    
                    elif event_type == "error":
                        # Обработка ошибок от OpenAI
                        error_msg = event.get("error", {}).get("message", "Unknown error")
                        error_code = event.get("error", {}).get("code", "unknown")
                        
                        logger.error(f"❌ Ошибка от OpenAI: {error_code} - {error_msg}")
                        
                        await client_websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": error_code,
                                "message": error_msg
                            }
                        })
                
                except asyncio.TimeoutError:
                    # Таймаут не критичен, продолжаем слушать
                    continue
                    
                except ConnectionClosed:
                    logger.warning("🔌 Соединение с OpenAI закрыто")
                    break
                    
                except json.JSONDecodeError as e:
                    logger.error(f"❌ Ошибка декодирования JSON от OpenAI: {e}")
                    continue
                    
                except Exception as e:
                    logger.error(f"❌ Ошибка при обработке ответа от OpenAI: {e}")
                    # Продолжаем работу даже при ошибке в обработке одного события
                    continue
        
        except Exception as e:
            logger.error(f"❌ Критическая ошибка в listen_for_responses: {e}")
        finally:
            logger.info("🔚 Завершение прослушивания ответов OpenAI")

    async def _update_conversation_record(self, user_message: str, assistant_message: str) -> None:
        """Обновляет запись разговора в базе данных"""
        if self.db_session and self.conversation_record_id:
            try:
                conv = self.db_session.query(Conversation).filter(
                    Conversation.id == uuid.UUID(self.conversation_record_id)
                ).first()
                
                if conv:
                    # Обрезаем сообщения, чтобы избежать переполнения БД
                    conv.user_message = user_message[:1000]
                    conv.assistant_message = assistant_message[:1000]
                    self.db_session.commit()
                    logger.info(f"📊 Обновлена запись разговора: {self.conversation_record_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка обновления записи разговора: {e}")

    async def _get_item_info(self, item_id: str) -> Optional[Dict[str, Any]]:
        """
        Получает информацию об элементе разговора по его ID
        
        Args:
            item_id: Идентификатор элемента разговора
            
        Returns:
            Optional[Dict[str, Any]]: Информация об элементе или None при ошибке
        """
        if not (self.is_connected and self.ws):
            return None
            
        try:
            event_id = f"retrieve_{time.time()}"
            
            await self.ws.send(json.dumps({
                "type": "conversation.item.retrieve",
                "item_id": item_id,
                "event_id": event_id
            }))
            
            # Ждем ответ с информацией об элементе
            for _ in range(5):  # Пробуем до 5 раз
                message = await asyncio.wait_for(self.ws.recv(), timeout=5)
                event = json.loads(message)
                
                if event.get("type") == "conversation.item.retrieved" and event.get("item_id") == item_id:
                    return event.get("item")
            
            logger.warning(f"⚠️ Не удалось получить информацию для item_id={item_id}")
            return None
            
        except Exception as e:
            logger.error(f"❌ Ошибка при получении информации об элементе: {e}")
            return None

    async def handle_function_call(self, function_name: str, arguments: dict) -> Any:
        """
        Вызывает зарегистрированную функцию с переданными аргументами
        
        Args:
            function_name: Имя функции для вызова
            arguments: Словарь аргументов функции
            
        Returns:
            Any: Результат вызова функции или словарь с ошибкой
        """
        logger.info(f"🔔 Вызов функции {function_name}, args={json.dumps(arguments, default=str)[:100]}")
        
        try:
            # Получаем информацию о функции из реестра
            info = get_function(function_name)
            
            if not info:
                logger.warning(f"⚠️ Функция {function_name} не найдена в реестре")
                return {"error": f"Function '{function_name}' not found"}
            
            # Вызываем функцию с переданными аргументами
            func = info["function"]
            start_time = time.time()
            result = await func(**arguments)
            execution_time = time.time() - start_time
            
            logger.info(f"📤 Результат функции {function_name} получен за {execution_time:.2f}с")
            return result
            
        except TypeError as e:
            # Ошибка несоответствия аргументов
            logger.error(f"❌ Ошибка типов аргументов в {function_name}: {e}")
            return {"error": f"Invalid arguments: {str(e)}"}
            
        except Exception as e:
            logger.error(f"❌ Ошибка в handle_function_call ({function_name}): {e}")
            return {"error": str(e)}

    async def close(self) -> None:
        """Закрывает соединение с OpenAI WebSocket API"""
        if self.ws:
            try:
                await self.ws.close()
                logger.info(f"🔒 WebSocket закрыт: {self.client_id}")
            except Exception as e:
                logger.error(f"❌ Ошибка при закрытии WebSocket: {e}")
        
        # Очистка ресурсов
        self.is_connected = False
        self.function_call_cache.clear()
