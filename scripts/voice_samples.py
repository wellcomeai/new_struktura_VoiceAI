"""
Образцы голосов OpenAI (gpt-live-1), Gemini Live и Fish одной фразой → R2.
Запуск в Shell на Render (ключи и R2 берутся из окружения сервиса):

    python3 scripts/voice_samples.py                  # все провайдеры
    python3 scripts/voice_samples.py openai           # только OpenAI
    python3 scripts/voice_samples.py gemini Kore Puck # выбранные голоса
    python3 scripts/voice_samples.py --no-upload      # без R2, файлы в ./voice_samples_out
    python3 scripts/voice_samples.py --quiet          # без этапов, только итог по голосу

Каждый голос произносит PHRASE и сохраняется одним WAV в исходном качестве
(OpenAI и Gemini — PCM16 24 кГц, Fish — 44.1 кГц) по постоянному пути
voice-samples/<провайдер>/<голос>.wav, повторный запуск перезаписывает. В R2
кладётся и voice-samples/index.json со всеми ссылками.

OpenAI и Gemini — разговорные модели, а не синтез: фразу они «повторяют» и
могут её изменить. Скрипт сверяет расшифровку с фразой и при расхождении
делает до MAX_ATTEMPTS попыток, оставляя самую близкую. Fish читает текст как есть.

В таблице: пол голоса (по описанию провайдера, «?» — неизвестен, проверить
на слух), громкость речи (RMS по фрагментам с речью, dBFS), пик, совпадение
с фразой и ссылка.
"""
import argparse
import asyncio
import base64
import difflib
import io
import json
import logging
import math
import os
import re
import sys
import time
import wave
from array import array
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(line_buffering=True)   # ход работы виден сразу, и через | tee тоже

# Конфиг — первым, как в app.py: импорт backend.models до backend.core даёт
# циклический импорт (models.file → core → task_scheduler → services → models.file)
import backend.core.config  # noqa: E402,F401

PHRASE = "Это мой пример голоса, которым я буду говорить на платформе Voicyfy."
MAX_ATTEMPTS = 3
CONCURRENCY = 3
R2_PREFIX = "voice-samples"

# ── OpenAI gpt-live-1 ────────────────────────────────────────────────
OPENAI_RATE = 24000
OPENAI_SILENCE_TICK_MS = 100           # шаг досылки тишины: таймлайн Live идёт только при входящем звуке
OPENAI_END_SILENCE_S = 2.5             # после последнего кусочка аудио столько ждём и считаем фразу законченной
OPENAI_MAX_S = 30
SAMPLE_PROMPT = (
    "Ты диктор и записываешь образец своего голоса. Произноси только ту фразу, которую тебя "
    "попросят, слово в слово, естественно и спокойно, как в живом разговоре по телефону. "
    "Ничего не добавляй до и после фразы, не здоровайся, не задавай вопросов."
)

# ── Gemini Live ──────────────────────────────────────────────────────
GEMINI_URL = ("wss://generativelanguage.googleapis.com/ws/"
              "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
GEMINI_MODEL = "gemini-3.1-flash-live-preview"   # по умолчанию в звонках (inbound_gemini)
GEMINI_RATE = 24000
GEMINI_MAX_S = 30

# ── Fish ─────────────────────────────────────────────────────────────
FISH_WS_URL = "wss://api.fish.audio/v1/tts/live"
FISH_RATE = 44100
FISH_MAX_S = 30
FISH_SLUGS = {"Светлана": "svetlana", "Сергей": "sergey"}

# Пол голоса по описанию провайдера. «?» — у OpenAI нет описания, определяем на слух.
OPENAI_GENDER = {
    "alloy": "ж", "ash": "м", "ballad": "м", "coral": "ж", "echo": "м",
    "sage": "ж", "shimmer": "ж", "verse": "м", "marin": "ж", "cedar": "м",
}
# Список совпадает с GEMINI_VOICES в backend/api/agent.py, пол — из документации Gemini.
GEMINI_GENDER = {
    "Zephyr": "ж", "Puck": "м", "Charon": "м", "Kore": "ж", "Fenrir": "м",
    "Leda": "ж", "Orus": "м", "Aoede": "ж", "Callirrhoe": "ж", "Autonoe": "ж",
    "Enceladus": "м", "Iapetus": "м", "Umbriel": "м", "Algieba": "м", "Despina": "ж",
    "Erinome": "ж", "Algenib": "м", "Rasalgethi": "м", "Laomedeia": "ж", "Achernar": "ж",
    "Alnilam": "м", "Schedar": "м", "Gacrux": "ж", "Pulcherrima": "ж", "Achird": "м",
    "Zubenelgenubi": "м", "Vindemiatrix": "ж", "Sadachbia": "м", "Sadaltager": "м", "Sulafat": "ж",
}


# ═════════════════════════════════════════════════════════════════════
# Аудио и сверка текста
# ═════════════════════════════════════════════════════════════════════
def _dbfs(value: float) -> float:
    return round(20 * math.log10(value / 32768.0), 1) if value > 0 else -99.0


def loudness(pcm: bytes, rate: int) -> dict:
    """Громкость речи: RMS по 20-мс фрагментам громче -50 dBFS (паузы не в счёт) и пик."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return {"speech_rms_dbfs": -99.0, "peak_dbfs": -99.0, "duration_s": 0.0}
    frame = max(1, rate // 50)
    gate = 32768.0 * 10 ** (-50 / 20)
    energy, count = 0.0, 0
    for i in range(0, len(samples), frame):
        chunk = samples[i:i + frame]
        e = sum(s * s for s in chunk)
        if math.sqrt(e / len(chunk)) >= gate:
            energy += e
            count += len(chunk)
    peak = max(abs(min(samples)), abs(max(samples)))
    return {
        "speech_rms_dbfs": _dbfs(math.sqrt(energy / count)) if count else -99.0,
        "peak_dbfs": _dbfs(peak),
        "duration_s": round(len(samples) / rate, 2),
    }


def to_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm[: len(pcm) - len(pcm) % 2])
    return buf.getvalue()


def _norm(text: str) -> str:
    text = (text or "").lower().replace("ё", "е")
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


def similarity(said: str, phrase: str = PHRASE) -> float:
    return round(difflib.SequenceMatcher(None, _norm(said), _norm(phrase)).ratio(), 2)


# Название платформы расшифровка пишет как угодно: Voicyfy, Войсифай, Voicify
_BRAND = re.compile(r"^(voic|войс|воис)")


def is_verbatim(said: str, phrase: str = PHRASE) -> bool:
    """Слово в слово, кроме написания названия платформы."""
    words = lambda t: [w for w in _norm(t).split() if not _BRAND.match(w)]
    return bool(said.strip()) and words(said) == words(phrase)


# ═════════════════════════════════════════════════════════════════════
# Провайдеры: каждый возвращает (pcm, rate, расшифровка)
# ═════════════════════════════════════════════════════════════════════
async def openai_sample(voice: str, phrase: str, step):
    from backend.websockets.live_client import OpenAILiveClient

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("нет OPENAI_API_KEY")
    stub = SimpleNamespace(system_prompt=SAMPLE_PROMPT, voice=voice, functions=None)
    client = OpenAILiveClient(api_key, stub, client_id=f"voice-sample-{voice}", audio_rate=OPENAI_RATE)
    t0 = time.monotonic()
    if not await client.connect():
        raise RuntimeError("Live не открыл сессию (подробности в логе выше)")
    step(f"сессия открыта за {time.monotonic() - t0:.1f} с, жду речь…")

    audio = bytearray()
    said = []
    last_audio = [None]
    started = time.monotonic()

    async def read():
        async for event in client.receive_events():
            etype = event.get("type")
            if etype == "session.output_audio.delta":
                if last_audio[0] is None:
                    step(f"речь пошла через {time.monotonic() - started:.1f} с")
                audio.extend(base64.b64decode(event.get("delta") or ""))
                last_audio[0] = time.monotonic()
            elif etype == "session.output_transcript.delta":
                said.append(event.get("delta") or "")
            elif etype == "error":
                step(f"⚠️ ошибка Live: {json.dumps(event.get('error') or event, ensure_ascii=False)[:300]}", always=True)

    reader = asyncio.create_task(read())
    try:
        await client.say_greeting(phrase)
        silence = b"\x00\x00" * (OPENAI_RATE * OPENAI_SILENCE_TICK_MS // 1000)
        while not reader.done():
            now = time.monotonic()
            if last_audio[0] and now - last_audio[0] >= OPENAI_END_SILENCE_S:
                break
            if now - started >= OPENAI_MAX_S:
                step(f"⚠️ не закончил за {OPENAI_MAX_S} с", always=True)
                break
            await client.send_audio(silence)
            await asyncio.sleep(OPENAI_SILENCE_TICK_MS / 1000)
    finally:
        await client.close(timeout=5)
        reader.cancel()
    return bytes(audio), OPENAI_RATE, "".join(said)


async def gemini_sample(voice: str, phrase: str, step, model: str = GEMINI_MODEL):
    import websockets

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("нет GEMINI_API_KEY")
    generation = {
        "responseModalities": ["AUDIO"],
        "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
    }
    if "3.1" in model:
        generation["thinkingConfig"] = {"thinkingLevel": "minimal"}
    setup = {"setup": {
        "model": f"models/{model}",
        "generationConfig": generation,
        "systemInstruction": {"parts": [{"text": SAMPLE_PROMPT}]},
        "outputAudioTranscription": {},
    }}
    audio = bytearray()
    said = []
    t0 = time.monotonic()
    async with websockets.connect(f"{GEMINI_URL}?key={api_key}", max_size=None, open_timeout=30) as ws:
        await ws.send(json.dumps(setup))
        deadline = time.monotonic() + GEMINI_MAX_S
        ready = False
        while time.monotonic() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()))
            if "setupComplete" in msg:
                if not ready:
                    ready = True
                    step(f"сессия {model} открыта за {time.monotonic() - t0:.1f} с, жду речь…")
                    ask = f"Скажи дословно, слово в слово, и больше ничего: «{phrase}»"
                    # 3.1 принимает текст только через realtimeInput, 2.5 — через clientContent
                    await ws.send(json.dumps(
                        {"realtimeInput": {"text": ask}} if "3.1" in model else
                        {"clientContent": {"turns": [{"role": "user", "parts": [{"text": ask}]}],
                                           "turnComplete": True}}))
                continue
            if "error" in msg:
                raise RuntimeError(json.dumps(msg["error"], ensure_ascii=False)[:300])
            content = msg.get("serverContent") or {}
            for part in (content.get("modelTurn") or {}).get("parts") or []:
                data = (part.get("inlineData") or {}).get("data")
                if data:
                    if not audio:
                        step(f"речь пошла через {time.monotonic() - t0:.1f} с")
                    audio.extend(base64.b64decode(data))
            text = (content.get("outputTranscription") or {}).get("text")
            if text:
                said.append(text)
            if content.get("turnComplete"):
                break
        else:
            step(f"⚠️ не закончил за {GEMINI_MAX_S} с", always=True)
    return bytes(audio), GEMINI_RATE, "".join(said)


async def fish_sample(voice_id: str, phrase: str, step):
    import msgpack
    import websockets
    from backend.models.fish_assistant import DEFAULT_FISH_MODEL, DEFAULT_FISH_LATENCY

    api_key = os.getenv("FISH_API_KEY")
    if not api_key:
        raise RuntimeError("нет FISH_API_KEY")
    headers = {"Authorization": f"Bearer {api_key}", "model": DEFAULT_FISH_MODEL}
    request = {
        "text": "", "format": "pcm", "sample_rate": FISH_RATE, "latency": DEFAULT_FISH_LATENCY,
        "temperature": 0.7, "prosody": {"speed": 1.0}, "reference_id": voice_id,
    }
    audio = bytearray()
    t0 = time.monotonic()
    async with websockets.connect(FISH_WS_URL, extra_headers=headers, max_size=None) as ws:
        step(f"соединение с Fish за {time.monotonic() - t0:.1f} с, синтез {DEFAULT_FISH_MODEL}…")
        await ws.send(msgpack.packb({"event": "start", "request": request}))
        await ws.send(msgpack.packb({"event": "text", "text": phrase}))
        await ws.send(msgpack.packb({"event": "flush"}))
        await ws.send(msgpack.packb({"event": "stop"}))
        deadline = time.monotonic() + FISH_MAX_S
        while time.monotonic() < deadline:
            message = msgpack.unpackb(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()), raw=False)
            if message.get("event") == "audio":
                if not audio:
                    step(f"речь пошла через {time.monotonic() - t0:.1f} с")
                audio.extend(message.get("audio") or b"")
            elif message.get("event") == "finish":
                if message.get("reason") == "error":
                    raise RuntimeError("Fish вернул ошибку синтеза")
                break
    return bytes(audio), FISH_RATE, phrase


# ═════════════════════════════════════════════════════════════════════
# Список задач, запуск, загрузка
# ═════════════════════════════════════════════════════════════════════
def build_jobs(providers, only_voices):
    jobs = []
    if "openai" in providers:
        from backend.schemas.assistant import OPENAI_VOICES
        for v in OPENAI_VOICES:
            jobs.append({"provider": "openai", "voice": v, "slug": v, "gender": OPENAI_GENDER.get(v, "?"),
                         "run": lambda phrase, step, v=v: openai_sample(v, phrase, step)})
    if "gemini" in providers:
        for v, g in GEMINI_GENDER.items():
            jobs.append({"provider": "gemini", "voice": v, "slug": v.lower(), "gender": g,
                         "run": lambda phrase, step, v=v: gemini_sample(v, phrase, step, ARGS.gemini_model)})
    if "fish" in providers:
        from backend.models.fish_assistant import FISH_VOICES
        for fv in FISH_VOICES:
            jobs.append({"provider": "fish", "voice": fv["name"], "slug": FISH_SLUGS.get(fv["name"], fv["id"]),
                         "gender": fv.get("gender", "?").replace("f", "ж").replace("m", "м"),
                         "fish_id": fv["id"], "run": lambda phrase, step, i=fv["id"]: fish_sample(i, phrase, step)})
    if only_voices:
        wanted = {v.lower() for v in only_voices}
        jobs = [j for j in jobs if j["voice"].lower() in wanted or j["slug"] in wanted]
    return jobs


PROGRESS = {"done": 0, "total": 0, "t0": 0.0}


def _elapsed() -> str:
    sec = int(time.monotonic() - PROGRESS["t0"])
    return f"{sec // 60}:{sec % 60:02d}"


async def run_job(job, phrase, sem, uploader):
    name = f"{job['provider']}/{job['voice']}"
    tag = f"[{job['n']:>2}/{PROGRESS['total']}]"

    def say(mark, text):
        print(f"{tag} {mark} {name:<22} {text}")

    def step(text, always=False):
        if always or not ARGS.quiet:
            say(" ", text)

    async with sem:
        best = None
        attempts = 1 if job["provider"] == "fish" else MAX_ATTEMPTS
        for attempt in range(1, attempts + 1):
            step("старт" if attempt == 1 else f"попытка {attempt}…")
            t0 = time.monotonic()
            try:
                pcm, rate, said = await job["run"](phrase, step)
            except Exception as e:
                say("❌", f"попытка {attempt}: {e}")
                continue
            if not pcm:
                say("❌", f"попытка {attempt}: аудио не пришло")
                continue
            score = 1.0 if is_verbatim(said, phrase) else min(similarity(said, phrase), 0.99)
            if best is None or score > best[3]:
                best = (pcm, rate, said, score)
            step(f"фраза {len(pcm) / 2 / rate:.1f} с за {time.monotonic() - t0:.1f} с: "
                 f"«{said.strip()}» {'✓' if score == 1.0 else score}")
            if score == 1.0:
                break
            say("↻", f"попытка {attempt}: не слово в слово ({score})")
        PROGRESS["done"] += 1
        progress = f"(готово {PROGRESS['done']}/{PROGRESS['total']}, прошло {_elapsed()})"
        if best is None:
            say("❌", f"не удалось получить образец {progress}")
            return {**_public(job), "error": "не удалось получить образец"}
        pcm, rate, said, score = best
        key = f"{R2_PREFIX}/{job['provider']}/{job['slug']}.wav"
        step("загружаю в R2…" if not ARGS.no_upload else "сохраняю…")
        url = await asyncio.to_thread(uploader, key, to_wav(pcm, rate), "audio/wav")
        result = {**_public(job), "url": url, "said": said.strip(), "match": score,
                  "rate": rate, **loudness(pcm, rate)}
        say("✅", f"{result['speech_rms_dbfs']} dBFS, совпадение {score} → {url} {progress}")
        return result


def _public(job):
    out = {k: job[k] for k in ("provider", "voice", "slug", "gender")}
    if job.get("fish_id"):
        out["fish_id"] = job["fish_id"]
    return out


def make_uploader(no_upload: bool, out_dir: str):
    if no_upload:
        def save(key, body, content_type):
            path = os.path.join(out_dir, key)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(body)
            return os.path.abspath(path)
        return save

    from backend.core.config import settings
    from backend.services.r2_storage import R2StorageService

    client = R2StorageService._get_client()
    if client is None or not settings.R2_PUBLIC_URL:
        raise SystemExit("R2 не настроен (R2_ACCESS_KEY / R2_SECRET_KEY / R2_PUBLIC_URL). "
                         "Запустите с --no-upload, чтобы сохранить файлы локально.")

    def upload(key, body, content_type):
        client.put_object(Bucket=settings.R2_BUCKET, Key=key, Body=body,
                          ContentType=content_type, CacheControl="public, max-age=300")
        return f"{settings.R2_PUBLIC_URL.rstrip('/')}/{key}"
    return upload


def print_report(results):
    print("\n" + "═" * 100)
    print(f"{'провайдер':<8} {'голос':<14} {'пол':<3} {'речь dBFS':>9} {'пик':>6} {'сек':>5} {'совп.':>5}  ссылка")
    print("─" * 100)
    for r in results:
        if r.get("error"):
            print(f"{r['provider']:<8} {r['voice']:<14} {r['gender']:<3} {'—':>9} {'—':>6} {'—':>5} {'—':>5}  ❌ {r['error']}")
            continue
        print(f"{r['provider']:<8} {r['voice']:<14} {r['gender']:<3} {r['speech_rms_dbfs']:>9} "
              f"{r['peak_dbfs']:>6} {r['duration_s']:>5} {r['match']:>5}  {r['url']}")
    off = [r for r in results if not r.get("error") and r["match"] < 1.0]
    if off:
        print("\nСказали не слово в слово:")
        for r in off:
            print(f"  {r['provider']}/{r['voice']}: «{r['said']}»")
    print("\nПол: по описанию провайдера, «?» — определить на слух. "
          "Громкость: чем ближе к 0, тем громче; разница 6 dB ≈ в 2 раза по амплитуде.")


PROVIDER_KEYS = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "fish": "FISH_API_KEY"}


async def main():
    missing = [p for p in ARGS.providers if not os.getenv(PROVIDER_KEYS[p])]
    for p in missing:
        print(f"⚠️ {p}: нет {PROVIDER_KEYS[p]} в окружении — пропускаю")
    jobs = build_jobs([p for p in ARGS.providers if p not in missing], ARGS.voices)
    if not jobs:
        raise SystemExit("Нет голосов под выбранные фильтры")
    uploader = make_uploader(ARGS.no_upload, ARGS.out)
    for n, job in enumerate(jobs, 1):
        job["n"] = n
    PROGRESS.update(total=len(jobs), t0=time.monotonic())
    print(f"Фраза: «{ARGS.phrase}»\nГолосов: {len(jobs)}, параллельно: {ARGS.concurrency}\n")
    sem = asyncio.Semaphore(ARGS.concurrency)
    results = await asyncio.gather(*(run_job(j, ARGS.phrase, sem, uploader) for j in jobs))
    index = {
        "phrase": ARGS.phrase,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "gemini_model": ARGS.gemini_model,
        "voices": results,
    }
    index_url = None
    if not ARGS.voices and set(ARGS.providers) == {"openai", "gemini", "fish"}:
        # Индекс перезаписываем только полным прогоном, чтобы не потерять остальные голоса
        index_url = uploader(f"{R2_PREFIX}/index.json",
                             json.dumps(index, ensure_ascii=False, indent=2).encode("utf-8"),
                             "application/json; charset=utf-8")
    print_report(results)
    if index_url:
        print(f"\nindex.json: {index_url}")
    print(f"Всего: {_elapsed()}")


def parse_args():
    p = argparse.ArgumentParser(description="Образцы голосов OpenAI / Gemini / Fish → R2")
    p.add_argument("provider", nargs="?", default="all", choices=["all", "openai", "gemini", "fish"])
    p.add_argument("voices", nargs="*", help="только эти голоса (имя или slug)")
    p.add_argument("--phrase", default=PHRASE)
    p.add_argument("--gemini-model", default=GEMINI_MODEL)
    p.add_argument("--concurrency", type=int, default=CONCURRENCY)
    p.add_argument("--no-upload", action="store_true", help="не грузить в R2, сохранить в --out")
    p.add_argument("--out", default="voice_samples_out")
    p.add_argument("--quiet", action="store_true", help="без этапов: только итог по каждому голосу и таблица")
    args = p.parse_args()
    args.providers = ["openai", "gemini", "fish"] if args.provider == "all" else [args.provider]
    return args


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    ARGS = parse_args()
    asyncio.run(main())
