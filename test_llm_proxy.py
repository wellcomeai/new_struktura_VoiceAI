"""Проверка прокси Voximplant ⇄ OpenAI Chat Completions на подставных сокетах."""
import asyncio, json, warnings, logging
warnings.filterwarnings("ignore"); logging.disable(logging.CRITICAL)

import os, sys, types
import httpx

# Пакет backend.websockets при импорте тянет все хендлеры звонков (Gemini,
# Grok…) — для этого теста они не нужны, грузим модуль прокси напрямую.
_pkg = types.ModuleType("backend.websockets")
_pkg.__path__ = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "websockets")]
sys.modules.setdefault("backend.websockets", _pkg)
from backend.websockets import handler_llm_proxy as proxy


class FakeVoxWS:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(json.loads(text))


def sse(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


def install(handler):
    proxy._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))


REQ = {"model": "gpt-6-luna", "messages": [{"role": "user", "content": "привет"}],
       "service_tier": "priority", "reasoning_effort": "none", "user": "лишнее"}


async def test_stream():
    """Чанки пересылаются как есть, в конце done; тело к OpenAI очищено и ограничено."""
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, text=sse(
            {"choices": [{"index": 0, "delta": {"content": "Здрав"}}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ))

    install(handler)
    vox = FakeVoxWS()
    s = proxy._LLMProxySession(vox, "sk-srv", "a1")
    await s.start(7, REQ)
    await s.task
    assert seen["auth"] == "Bearer sk-srv"
    b = seen["body"]
    assert b["stream"] is True and b["stream_options"] == {"include_usage": True}
    assert b["service_tier"] == "priority" and "user" not in b
    assert b["max_completion_tokens"] == proxy.MAX_COMPLETION_TOKENS
    assert [m["event"] for m in vox.sent] == ["chunk", "chunk", "done"]
    assert isinstance(vox.sent[-1]["openai_first_ms"], int) and isinstance(vox.sent[-1]["total_ms"], int)
    assert all(m["id"] == 7 for m in vox.sent)
    assert vox.sent[0]["payload"]["choices"][0]["delta"]["content"] == "Здрав"
    print("✅ стрим: чанки как есть + done, тело очищено")


async def test_error_and_model():
    """Ошибка OpenAI уходит текстом (сценарий смотрит на reasoning/service_tier); чужая модель — отказ."""
    install(lambda r: httpx.Response(400, text='{"error":{"message":"Unsupported value: reasoning_effort"}}'))
    vox = FakeVoxWS()
    s = proxy._LLMProxySession(vox, "k", "a1")
    await s.start(1, REQ)
    await s.task
    assert vox.sent[-1]["event"] == "error" and "reasoning_effort" in vox.sent[-1]["message"]

    vox.sent.clear()
    await s.start(2, dict(REQ, model="gpt-9-ultra"))
    assert vox.sent == [{"event": "error", "id": 2, "message": "model not allowed: gpt-9-ultra"}]
    print("✅ ошибки: текст OpenAI пересылается, чужая модель не пропускается")


async def test_cancel():
    """Новый request и cancel обрывают идущий стрим, done от него не приходит."""
    async def slow():
        yield b'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n'
        await asyncio.sleep(5)
        yield b"data: [DONE]\n\n"

    install(lambda r: httpx.Response(200, content=slow()))
    vox = FakeVoxWS()
    s = proxy._LLMProxySession(vox, "k", "a1")
    await s.start(1, REQ)
    await asyncio.sleep(0.05)
    first = s.task
    await s.start(2, REQ)
    assert first.cancelled()
    await asyncio.sleep(0.05)
    await s.cancel(2)
    assert s.task.cancelled()
    assert not any(m["event"] == "done" for m in vox.sent)
    assert {m["id"] for m in vox.sent} == {1, 2}
    print("✅ отмена: новый request и cancel обрывают стрим")


async def test_openrouter():
    """Модель с «/» — в OpenRouter на его ключе, тело переведено; ошибка в стриме → error."""
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, text=": OPENROUTER PROCESSING\n\n" + sse(
            {"choices": [{"index": 0, "delta": {"content": "Да"}}], "provider": "Together"},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ))

    install(handler)
    vox = FakeVoxWS()
    s = proxy._LLMProxySession(vox, "sk-openai", "a1", openrouter_key="sk-or")
    await s.start(3, dict(REQ, model="deepseek/deepseek-v4.1-flash", max_completion_tokens=16))
    await s.task
    b = seen["body"]
    assert seen["url"] == proxy.OPENROUTER_CHAT_URL and seen["auth"] == "Bearer sk-or"
    assert b["reasoning"] == {"effort": "none", "exclude": True} and b["max_tokens"] == 16
    assert "service_tier" not in b and "reasoning_effort" not in b and "max_completion_tokens" not in b
    assert b["provider"]["order"] == ["together"] and b["usage"] == {"include": True}
    assert [m["event"] for m in vox.sent] == ["chunk", "chunk", "done"]

    install(lambda r: httpx.Response(200, text=sse(
        {"choices": [{"index": 0, "delta": {"content": "Д"}}]},
        {"error": {"code": 502, "message": "Provider disconnected"}, "choices": [{"finish_reason": "error"}]})))
    vox.sent.clear()
    await s.start(4, dict(REQ, model="deepseek/deepseek-v4.1-flash"))
    await s.task
    assert vox.sent[-1]["event"] == "error" and "Provider disconnected" in vox.sent[-1]["message"]

    vox.sent.clear()
    s2 = proxy._LLMProxySession(vox, "sk-openai", "a1", openrouter_key=None)
    await s2.start(5, dict(REQ, model="deepseek/deepseek-v4.1-flash"))
    assert vox.sent[-1]["event"] == "error" and "OPENROUTER_API_KEY" in vox.sent[-1]["message"]
    print("✅ OpenRouter: ключ и тело переведены, ошибка посреди стрима → error, нет ключа → error")


async def test_connection_kinds():
    """/ws/fish/llm ищет Fish-ассистента, /ws/cascade/llm — каскадного; ключ
    берётся у своего провайдера, чужой id сокет закрывает."""
    from fastapi import WebSocketDisconnect

    class Assistant:
        is_active = True
        user_id = "u1"

    class Query:
        def __init__(self, model):
            self.model = model
        def filter(self, *conds):
            self.conds = [str(c) for c in conds]
            return self
        def first(self):
            if self.model is proxy.User:
                return object()
            return Assistant() if self.model is wanted["model"] else None

    class DB:
        def __init__(self):
            self.queries = []
        def query(self, model):
            q = Query(model)
            self.queries.append(q)
            return q
        def close(self):
            pass

    class WS(FakeVoxWS):
        def __init__(self):
            super().__init__()
            self.closed = None
        async def accept(self):
            pass
        async def receive_text(self):
            raise WebSocketDisconnect()
        async def close(self, code=1000, reason=""):
            self.closed = self.closed or (code, reason)

    resolved = []
    orig_resolve, orig_release = proxy.provider_keys.resolve, proxy.release_db_connection
    proxy.provider_keys.resolve = lambda user, kind: resolved.append(kind) or types.SimpleNamespace(api_key="sk-" + kind)
    proxy.release_db_connection = lambda db: None
    orig_warm = proxy._LLMProxySession.warm
    async def no_warm(self):
        return None
    proxy._LLMProxySession.warm = no_warm
    wanted = {}
    try:
        wanted["model"] = proxy.GrokAssistantConfig
        db, ws = DB(), WS()
        await proxy.handle_llm_proxy_connection(ws, "a1", db, kind="cascade")
        assert ws.sent and ws.sent[0]["event"] == "ready", ws.sent
        assert resolved == ["cascade"], resolved
        assert db.queries[0].model is proxy.GrokAssistantConfig
        assert any("assistant_type" in c for c in db.queries[0].conds), db.queries[0].conds

        resolved.clear()
        db, ws = DB(), WS()
        await proxy.handle_llm_proxy_connection(ws, "a1", db, kind="cascade")
        assert ws.sent[0]["event"] == "ready"

        # Fish-эндпоинт каскадного ассистента не находит и наоборот
        resolved.clear()
        db, ws = DB(), WS()
        await proxy.handle_llm_proxy_connection(ws, "a1", db)
        assert ws.closed and ws.closed[0] == 1008 and not ws.sent, (ws.closed, ws.sent)
        assert db.queries[0].model is proxy.FishAssistantConfig and not resolved

        wanted["model"] = proxy.FishAssistantConfig
        db, ws = DB(), WS()
        await proxy.handle_llm_proxy_connection(ws, "a1", db)
        assert ws.sent[0]["event"] == "ready" and resolved == ["fish"], resolved
    finally:
        proxy.provider_keys.resolve, proxy.release_db_connection = orig_resolve, orig_release
        proxy._LLMProxySession.warm = orig_warm
    print("✅ эндпоинты: fish → FishAssistantConfig + ключ fish, cascade → grok_assistant_configs (cascade) + ключ cascade")


async def main():
    await test_stream()
    await test_openrouter()
    await test_error_and_model()
    await test_cancel()
    await test_connection_kinds()
    print("\nвсе проверки прокси LLM пройдены")


if __name__ == "__main__":
    asyncio.run(main())
