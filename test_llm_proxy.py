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


async def main():
    await test_stream()
    await test_error_and_model()
    await test_cancel()
    print("\nвсе проверки прокси LLM пройдены")


if __name__ == "__main__":
    asyncio.run(main())
