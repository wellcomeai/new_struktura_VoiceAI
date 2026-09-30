# backend/websockets/handler_llm_proxy.py
"""
Прокси Voximplant ⇄ OpenAI Chat Completions для каскада inbound_fish.js.

Зачем он нужен
--------------
Коннектор Voximplant (OpenAI.createChatCompletionsAPIClient) добавлял к
первому токену 0.5–3.5 с: из сценария первый токен шёл 1.1–4.2 с, а тот же
запрос с Render — 0.5–0.65 с. Здесь сценарий ходит в модель через наш сокет,
а мы держим тёплое соединение с OpenAI и сразу пересылаем стрим.

Протокол со стороны сценария (текстовые JSON-фреймы)
----------------------------------------------------
    → {"event":"request","id":N,"payload":{...тело Chat Completions...}}
    → {"event":"cancel","id":N}           оборвать ответ (перебивание)
    ← {"event":"ready"}                   сокет готов
    ← {"event":"chunk","id":N,"payload":{...chat.completion.chunk...}}
    ← {"event":"done","id":N}             стрим закрыт
    ← {"event":"error","id":N,"message":"..."}  ошибка OpenAI (текст как есть —
                                          сценарий по нему решает, что убрать)

Одновременно идёт один ответ: новый request обрывает предыдущий.
Ключ OpenAI в сценарий не уходит — берём тот же, что и для остального
Fish-ассистента (provider_keys.resolve(user, "fish").api_key). Списание — как
раньше, по отчёту сценария (/api/voximplant/log).
"""

import asyncio
import json
import os
import time
import traceback
from typing import Optional

import httpx
from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import release_db_connection
from backend.models.fish_assistant import FishAssistantConfig
from backend.models.user import User
from backend.services import provider_keys

logger = get_logger(__name__)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"

# Ключ платформы не должен превращаться в открытый шлюз к любой модели:
# сценарий может просить только эти.
ALLOWED_MODELS = {
    m.strip() for m in (os.getenv("LLM_PROXY_MODELS") or "gpt-6-luna,gpt-5.6-luna").split(",")
    if m.strip()
}
MAX_COMPLETION_TOKENS = 1024
# Параметры, которые пропускаем в OpenAI как есть; остальное отбрасываем.
PASS_KEYS = ("messages", "tools", "tool_choice", "reasoning_effort", "service_tier",
             "temperature", "max_completion_tokens", "parallel_tool_calls")

# Один клиент на процесс: пул держит TLS-соединения с OpenAI тёплыми между
# звонками, первый запрос звонка не платит за рукопожатие.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0),
            limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=120.0),
        )
    return _client


def build_body(payload: dict) -> dict:
    """Тело запроса к OpenAI из того, что прислал сценарий (с ограничениями)."""
    model = payload.get("model")
    if model not in ALLOWED_MODELS:
        raise ValueError(f"model not allowed: {model}")
    body = {"model": model, "stream": True, "stream_options": {"include_usage": True}}
    for key in PASS_KEYS:
        if payload.get(key) is not None:
            body[key] = payload[key]
    if not isinstance(body.get("messages"), list) or not body["messages"]:
        raise ValueError("messages required")
    limit = body.get("max_completion_tokens")
    if not isinstance(limit, int) or limit <= 0 or limit > MAX_COMPLETION_TOKENS:
        body["max_completion_tokens"] = MAX_COMPLETION_TOKENS
    return body


class _LLMProxySession:
    def __init__(self, websocket: WebSocket, api_key: str, assistant_id: str):
        self.ws = websocket
        self.api_key = api_key
        self.assistant_id = assistant_id
        self.send_lock = asyncio.Lock()
        self.task: Optional[asyncio.Task] = None
        self.task_id = None

    async def send_json_text(self, text: str) -> None:
        async with self.send_lock:
            await self.ws.send_text(text)

    async def send(self, obj: dict) -> None:
        await self.send_json_text(json.dumps(obj, ensure_ascii=False))

    async def warm(self) -> None:
        """Лёгкий запрос, чтобы в пуле было готовое TLS-соединение к OpenAI."""
        try:
            await _get_client().get(OPENAI_MODELS_URL,
                                    headers={"Authorization": f"Bearer {self.api_key}"})
        except Exception as e:
            logger.info(f"[LLM-PROXY] warm-up failed (не критично): {e}")

    async def cancel(self, req_id=None) -> None:
        task = self.task
        if task is None or task.done():
            return
        if req_id is not None and req_id != self.task_id:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def start(self, req_id, payload: dict) -> None:
        await self.cancel()
        try:
            body = build_body(payload if isinstance(payload, dict) else {})
        except ValueError as e:
            await self.send({"event": "error", "id": req_id, "message": str(e)})
            return
        self.task_id = req_id
        self.task = asyncio.create_task(self._stream(req_id, body))

    async def _stream(self, req_id, body: dict) -> None:
        t0 = time.monotonic()
        first = None
        try:
            async with _get_client().stream(
                "POST", OPENAI_CHAT_URL, json=body,
                headers={"Authorization": f"Bearer {self.api_key}"},
            ) as resp:
                if resp.status_code != 200:
                    text = (await resp.aread()).decode("utf-8", "replace")
                    logger.warning(f"[LLM-PROXY] OpenAI HTTP {resp.status_code}: {text[:300]}")
                    await self.send({"event": "error", "id": req_id,
                                     "message": f"HTTP {resp.status_code}: {text[:2000]}"})
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    if first is None:
                        first = time.monotonic()
                    # Чанк пересылаем как есть, без повторного разбора JSON.
                    await self.send_json_text(
                        '{"event":"chunk","id":' + json.dumps(req_id) + ',"payload":' + data + "}"
                    )
            await self.send({"event": "done", "id": req_id})
            logger.info(
                f"[LLM-PROXY] {self.assistant_id} id={req_id} first chunk "
                f"{int(((first or time.monotonic()) - t0) * 1000)}ms, "
                f"total {int((time.monotonic() - t0) * 1000)}ms"
            )
        except asyncio.CancelledError:
            logger.info(f"[LLM-PROXY] {self.assistant_id} id={req_id} cancelled")
            raise
        except Exception as e:
            logger.warning(f"[LLM-PROXY] stream error id={req_id}: {e}")
            try:
                await self.send({"event": "error", "id": req_id, "message": f"proxy: {e}"})
            except Exception:
                pass


async def handle_llm_proxy_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session,
) -> None:
    """Точка входа для /ws/fish/llm/{assistant_id}."""
    await websocket.accept()
    session: Optional[_LLMProxySession] = None
    try:
        assistant = db.query(FishAssistantConfig).filter(
            FishAssistantConfig.id == assistant_id
        ).first()
        if not assistant or not assistant.is_active:
            logger.warning(f"[LLM-PROXY] Assistant not found or inactive: {assistant_id}")
            await websocket.close(code=1008, reason="Assistant not found")
            return

        user = db.query(User).filter(User.id == assistant.user_id).first()
        api_key = provider_keys.resolve(user, "fish").api_key
        release_db_connection(db)
        if not api_key:
            await websocket.close(code=1008, reason="OpenAI API key is not configured")
            return

        session = _LLMProxySession(websocket, api_key, assistant_id)
        asyncio.create_task(session.warm())
        await session.send({"event": "ready"})

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = msg.get("event")
            if event == "request":
                await session.start(msg.get("id"), msg.get("payload") or {})
            elif event == "cancel":
                await session.cancel(msg.get("id"))
            elif event == "stop":
                break

    except WebSocketDisconnect:
        logger.info(f"[LLM-PROXY] Scenario disconnected: {assistant_id}")
    except Exception as e:
        logger.error(f"[LLM-PROXY] Session error for {assistant_id}: {e}")
        logger.error(traceback.format_exc())
    finally:
        if session is not None:
            await session.cancel()
        try:
            await websocket.close()
        except Exception:
            pass
