"""
Мост из рабочего потока в event loop сервера.

Синхронный эндпоинт FastAPI (`def`, не `async def`) выполняется в потоке
anyio, поэтому его синхронные запросы к БД не останавливают event loop (звонки,
WebSocket'ы). Но внутри такого эндпоинта бывают асинхронные вызовы (HTTP к
Voximplant/R2, уведомления) и фоновые задачи `asyncio.create_task` — их нельзя
выполнить прямо в потоке. Эти две функции передают их в основной loop.

Работают только из потока, запущенного anyio (обычные `def`-эндпоинты и
зависимости FastAPI, `anyio.to_thread.run_sync`). Не из `asyncio.to_thread`.
"""

import asyncio
from typing import Any, Awaitable

import anyio.from_thread


def await_in_loop(coro: Awaitable[Any]) -> Any:
    """Выполнить корутину в event loop сервера и дождаться результата (поток ждёт, loop свободен)."""
    async def _runner():
        return await coro
    return anyio.from_thread.run(_runner)


def spawn_in_loop(coro: Awaitable[Any]) -> None:
    """Запустить корутину фоновой задачей в event loop сервера (аналог asyncio.create_task)."""
    anyio.from_thread.run_sync(asyncio.create_task, coro)
