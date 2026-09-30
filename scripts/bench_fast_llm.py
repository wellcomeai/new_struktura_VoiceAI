"""
Замер времени до первого токена у быстрых LLM для голосового каскада
(inbound_fish: ASR → LLM → Fish). Запуск в Shell на Render:

    export OPENROUTER_API_KEY=sk-or-...
    python3 scripts/bench_fast_llm.py            # все кандидаты
    python3 scripts/bench_fast_llm.py deepseek   # только те, где в имени есть «deepseek»

Берёт настоящий промпт ассистента «Спа центр» из базы и делает первый ход
звонка (system + приветствие + реплика абонента). На каждую модель: 1 прогревочный
запрос (не в зачёт) и RUNS замеров. Печатает медиану/максимум первого токена
ТЕКСТА (рассуждения не в счёт), кто из провайдеров OpenRouter ответил, сколько
токенов ушло на рассуждения и начало ответа — чтобы оценить русский.
Рассуждения выключаются (reasoning.effort = none), если модель не даёт —
пробуем minimal, затем low.
"""
import json
import os
import statistics
import sys
import time

import requests
from sqlalchemy import create_engine, text

ASSISTANT_ID = "2eeb2054-f353-48d5-ba77-c49869f160ae"
USER_TURN = "здравствуйте расскажите о вашем комплексе"
RUNS = 3
OR_URL = "https://openrouter.ai/api/v1/chat/completions"
LATENCY = {"sort": "latency"}

# (подпись, модель, настройки провайдера OpenRouter)
CANDIDATES = [
    ("deepseek-v4.1-flash · быстрейший", "deepseek/deepseek-v4.1-flash", LATENCY),
    ("deepseek-v4.1-flash · DeepSeek", "deepseek/deepseek-v4.1-flash", {"only": ["deepseek"]}),
    ("deepseek-v4-flash · быстрейший", "deepseek/deepseek-v4-flash", LATENCY),
    ("gemini-3.5-flash-lite", "google/gemini-3.5-flash-lite", LATENCY),
    ("gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite", LATENCY),
    ("gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite", LATENCY),
    ("gpt-oss-120b · Groq", "openai/gpt-oss-120b", {"only": ["groq"]}),
    ("gpt-oss-120b · Cerebras", "openai/gpt-oss-120b", {"only": ["cerebras"]}),
    ("gpt-oss-120b · SambaNova", "openai/gpt-oss-120b", {"only": ["sambanova"]}),
    ("glm-5.3-flash · быстрейший", "z-ai/glm-5.3-flash", LATENCY),
    ("qwen3.8-flash", "qwen/qwen3.8-flash", LATENCY),
    ("qwen3.7-flash", "qwen/qwen3.7-flash", LATENCY),
    ("mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash", LATENCY),
    ("mistral-small-2603", "mistralai/mistral-small-2603", LATENCY),
    ("ling-3.0-flash", "inclusionai/ling-3.0-flash", LATENCY),
    ("step-3.7-flash", "stepfun/step-3.7-flash", LATENCY),
    ("gpt-6-luna · через OpenRouter", "openai/gpt-6-luna", LATENCY),
]


def load_prompt():
    url = os.environ["DATABASE_URL"].replace("postgres://", "postgresql://", 1)
    with create_engine(url).connect() as c:
        row = c.execute(
            text("select system_prompt, greeting_message from fish_assistant_configs where id = :i"),
            {"i": ASSISTANT_ID},
        ).first()
    return row[0] or "", row[1] or "Здравствуйте!"


def stream(url, key, body, extra_headers=None):
    """Первый токен текста (мс), провайдер, токены рассуждений, текст — или ошибка."""
    headers = {"Authorization": f"Bearer {key}"}
    headers.update(extra_headers or {})
    t0 = time.time()
    first, provider, reasoning_tokens, out = None, None, 0, ""
    r = requests.post(url, headers=headers, json=body, stream=True, timeout=40)
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}: {r.text[:180]}"}
    for line in r.iter_lines():
        if not line.startswith(b"data: {"):
            continue
        ch = json.loads(line[6:])
        if ch.get("error"):
            return {"error": str(ch["error"])[:180]}
        provider = ch.get("provider") or provider
        d = (ch.get("choices") or [{}])[0].get("delta") or {}
        if d.get("content"):
            if first is None:
                first = (time.time() - t0) * 1000
            out += d["content"]
        u = ch.get("usage") or {}
        reasoning_tokens = ((u.get("completion_tokens_details") or {}).get("reasoning_tokens")
                            or reasoning_tokens)
    if first is None:
        return {"error": "пустой ответ (ушло в рассуждения?)"}
    return {"ttft": first, "provider": provider, "reasoning": reasoning_tokens,
            "text": out.strip().replace("\n", " ")}


def bench(label, url, key, body_base, efforts, extra_headers=None):
    body = None
    res = None
    for eff in efforts:                  # подбираем, как выключить рассуждения
        body = dict(body_base)
        if eff is not None:
            body.update(eff)
        res = stream(url, key, body, extra_headers)
        if "error" not in res:
            break
    if "error" in res:
        print(f"✖ {label:36} {res['error']}")
        return None
    times, last = [], res
    for _ in range(RUNS):
        r = stream(url, key, body, extra_headers)
        if "error" in r:
            print(f"✖ {label:36} {r['error']}")
            return None
        times.append(r["ttft"])
        last = r
    med = statistics.median(times)
    print(f"{label:36} медиана {med:5.0f} мс · макс {max(times):5.0f} · холодный {res['ttft']:5.0f}"
          f" · {last['provider'] or '—':12} · рассужд. {last['reasoning'] or 0:>3} | {last['text'][:90]}")
    return label, med


def main():
    flt = sys.argv[1].lower() if len(sys.argv) > 1 else ""
    prompt, greet = load_prompt()
    messages = [{"role": "system", "content": prompt},
                {"role": "assistant", "content": greet},
                {"role": "user", "content": USER_TURN}]
    print(f"Промпт: {len(prompt)} символов. Замеров на модель: {RUNS} (+1 холодный).\n")
    results = []

    okey = os.environ.get("OPENAI_API_KEY")
    if okey and (not flt or "luna" in flt or "openai" in flt):
        r = bench("gpt-6-luna · OpenAI напрямую, priority", "https://api.openai.com/v1/chat/completions", okey,
                  {"model": "gpt-6-luna", "messages": messages, "stream": True, "max_completion_tokens": 200,
                   "stream_options": {"include_usage": True}, "service_tier": "priority"},
                  [{"reasoning_effort": "none"}, {}])
        if r:
            results.append(r)

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("\nНет OPENROUTER_API_KEY — модели OpenRouter пропущены (export OPENROUTER_API_KEY=...)")
    else:
        hdr = {"HTTP-Referer": "https://voicyfy.ru", "X-Title": "voicyfy latency bench"}
        for label, model, provider in CANDIDATES:
            if flt and flt not in (label + model).lower():
                continue
            base = {"model": model, "messages": messages, "stream": True, "max_tokens": 200,
                    "usage": {"include": True}, "provider": provider}
            r = bench(label, OR_URL, key, base,
                      [{"reasoning": {"effort": "none"}}, {"reasoning": {"effort": "minimal", "exclude": True}},
                       {"reasoning": {"effort": "low", "exclude": True}}], hdr)
            if r:
                results.append(r)

    if results:
        print("\nПо медиане первого токена:")
        for i, (label, med) in enumerate(sorted(results, key=lambda x: x[1]), 1):
            print(f"  {i:2}. {label:36} {med:5.0f} мс")


if __name__ == "__main__":
    main()
