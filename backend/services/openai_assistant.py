"""
OpenAI Assistants API Service
Управление Assistant, Threads и Streaming ответами
"""

from openai import AsyncOpenAI
import os
from loguru import logger
from typing import AsyncGenerator

# Инициализация клиента
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Конфигурация Assistant (в коде, не в .env)
ASSISTANT_CONFIG = {
    "name": "JARVIS LLM Assistant",
    "model": "gpt-4o-mini",
    "instructions": """
        Вы - JARVIS, интеллектуальный голосовой помощник.

        Ваши задачи:
        - Отвечайте кратко и по существу
        - Используйте markdown для форматирования
        - Будьте дружелюбны и профессиональны
        - Если не знаете ответ - честно скажите об этом
        - Помогайте пользователю решать задачи эффективно
    """,
    "tools": [],  # Можно добавить code_interpreter, retrieval и т.д.
    "temperature": 0.7
}

# Глобальная переменная для хранения ID ассистента
_assistant_id = None


async def get_or_create_assistant() -> str:
    """
    Получить существующий Assistant или создать новый

    Returns:
        str: ID ассистента
    """
    global _assistant_id

    # Проверяем в переменных окружения
    stored_id = os.getenv("OPENAI_ASSISTANT_ID")

    if stored_id:
        logger.info(f"[ASSISTANT] 🔍 Using stored ID: {stored_id}")
        _assistant_id = stored_id
        return stored_id

    # Если уже создавали в этой сессии
    if _assistant_id:
        logger.info(f"[ASSISTANT] ♻️  Using cached ID: {_assistant_id}")
        return _assistant_id

    # Создаем нового Assistant
    logger.info("[ASSISTANT] 🆕 Creating new assistant...")
    try:
        assistant = await client.beta.assistants.create(**ASSISTANT_CONFIG)
        _assistant_id = assistant.id

        logger.success(f"[ASSISTANT] ✅ Created with ID: {assistant.id}")
        logger.warning(f"[ASSISTANT] ⚠️  Add to .env: OPENAI_ASSISTANT_ID={assistant.id}")

        return assistant.id
    except Exception as e:
        logger.error(f"[ASSISTANT] ❌ Failed to create assistant: {e}")
        raise


async def create_thread() -> str:
    """
    Создать новый Thread

    Returns:
        str: ID треда
    """
    try:
        thread = await client.beta.threads.create()
        logger.info(f"[THREAD] ✅ Created: {thread.id}")
        return thread.id
    except Exception as e:
        logger.error(f"[THREAD] ❌ Failed to create thread: {e}")
        raise


async def add_message_to_thread(thread_id: str, content: str) -> dict:
    """
    Добавить сообщение пользователя в Thread

    Args:
        thread_id: ID треда
        content: Текст сообщения

    Returns:
        dict: Объект сообщения
    """
    try:
        message = await client.beta.threads.messages.create(
            thread_id=thread_id,
            role="user",
            content=content
        )
        logger.info(f"[THREAD] 💬 Message added to {thread_id}: {content[:50]}...")
        return message
    except Exception as e:
        logger.error(f"[THREAD] ❌ Failed to add message: {e}")
        raise


async def stream_assistant_response(
    thread_id: str,
    assistant_id: str
) -> AsyncGenerator[str, None]:
    """
    Стрим ответа от Assistant

    Args:
        thread_id: ID треда
        assistant_id: ID ассистента

    Yields:
        str: Chunks текста
    """
    logger.info(f"[ASSISTANT] 🚀 Starting stream for thread {thread_id}")

    try:
        # Асинхронный streaming
        async with client.beta.threads.runs.stream(
            thread_id=thread_id,
            assistant_id=assistant_id
        ) as stream:
            async for event in stream:
                # Обрабатываем только delta события с текстом
                if event.event == 'thread.message.delta':
                    delta_content = event.data.delta.content

                    if delta_content and len(delta_content) > 0:
                        content_block = delta_content[0]

                        # Проверяем что это текст
                        if hasattr(content_block, 'text') and content_block.text:
                            chunk = content_block.text.value
                            if chunk:
                                yield chunk

                elif event.event == 'thread.run.completed':
                    logger.success(f"[ASSISTANT] ✅ Run completed for thread {thread_id}")

                elif event.event == 'thread.run.failed':
                    error_msg = f"Assistant run failed: {event.data}"
                    logger.error(f"[ASSISTANT] ❌ {error_msg}")
                    raise Exception(error_msg)

    except Exception as e:
        logger.error(f"[ASSISTANT] ❌ Streaming error: {e}")
        raise


async def delete_thread(thread_id: str) -> bool:
    """
    Удалить Thread (опционально, для cleanup)

    Args:
        thread_id: ID треда

    Returns:
        bool: True если успешно удален
    """
    try:
        await client.beta.threads.delete(thread_id)
        logger.info(f"[THREAD] 🗑️  Deleted: {thread_id}")
        return True
    except Exception as e:
        logger.error(f"[THREAD] ❌ Failed to delete thread: {e}")
        return False


async def get_thread_messages(thread_id: str, limit: int = 10) -> list:
    """
    Получить историю сообщений из Thread

    Args:
        thread_id: ID треда
        limit: Максимальное количество сообщений

    Returns:
        list: Список сообщений
    """
    try:
        messages = await client.beta.threads.messages.list(
            thread_id=thread_id,
            limit=limit
        )
        logger.info(f"[THREAD] 📜 Retrieved {len(messages.data)} messages from {thread_id}")
        return messages.data
    except Exception as e:
        logger.error(f"[THREAD] ❌ Failed to get messages: {e}")
        raise
