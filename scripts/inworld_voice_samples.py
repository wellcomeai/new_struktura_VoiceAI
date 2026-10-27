"""
Примеры голосов Inworld для Каскада одной фразой → R2.
Запуск в Shell на Render (R2 берётся из окружения сервиса, ключ Inworld — в команде):

    INWORLD_API_KEY=... python3 scripts/inworld_voice_samples.py               # все голоса
    INWORLD_API_KEY=... python3 scripts/inworld_voice_samples.py Galina Lev    # выбранные
    INWORLD_API_KEY=... python3 scripts/inworld_voice_samples.py --no-upload   # без R2, в ./voice_samples_out

INWORLD_API_KEY — ключ из platform.inworld.ai (Basic, как есть в кабинете) с правом
на синтез речи. Голоса — INWORLD_VOICES в backend/api/grok_assistants.py (id в
Inworld совпадает с именем). Каждый голос произносит фразу из scripts/voice_samples.py
моделью звонков (INWORLD_MODEL в сценариях каскада) и сохраняется WAV по пути
voice-samples/cascade/<голос в нижнем регистре>.wav — его играет кнопка «Послушать»
(js/voice-samples.js). Повторный запуск перезаписывает. В voice-samples/index.json
обновляются записи provider=cascade. Тишина по краям обрезается.

В таблице: пол, громкость речи (dBFS), пик, длительность и ссылка.
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import wave
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from voice_samples import PHRASE, R2_PREFIX, loudness, make_uploader, to_wav, trim_silence  # noqa: E402

from backend.api.grok_assistants import INWORLD_VOICES  # noqa: E402

INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice"
INWORLD_MODEL = "inworld-tts-2"     # как INWORLD_MODEL в inbound_cascade.js / outbound_cascade.js
SAMPLE_RATE = 24000
TIMEOUT_S = 60


def synthesize(api_key: str, voice: str, text: str, model: str) -> tuple:
    """Синтез через REST Inworld → (pcm16 моно, частота)."""
    r = requests.post(
        INWORLD_TTS_URL,
        headers={"Authorization": f"Basic {api_key}", "Content-Type": "application/json"},
        json={
            "text": text,
            "voiceId": voice,
            "modelId": model,
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": SAMPLE_RATE},
        },
        timeout=TIMEOUT_S,
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    audio = base64.b64decode(r.json().get("audioContent") or "")
    if not audio:
        raise RuntimeError("пустой audioContent")
    return pcm_from_audio(audio)


def pcm_from_audio(audio: bytes) -> tuple:
    """LINEAR16 приходит WAV-файлом; без заголовка — сырой PCM SAMPLE_RATE."""
    if audio[:4] != b"RIFF":
        return audio, SAMPLE_RATE
    with wave.open(io.BytesIO(audio)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise RuntimeError(f"неожиданный формат: {w.getnchannels()} кан., {w.getsampwidth() * 8} бит")
        return w.readframes(w.getnframes()), w.getframerate()


def save_index(results, uploader, reader, phrase):
    """index.json: записи cascade поверх прежних, остальные провайдеры не трогаем."""
    key = f"{R2_PREFIX}/index.json"
    try:
        index = json.loads(reader(key) or b"{}")
    except ValueError:
        index = {}
    fresh = {r["slug"]: r for r in results if not r.get("error")}
    voices = [fresh.pop(v.get("slug"), v) if v.get("provider") == "cascade" else v
              for v in index.get("voices") or []]
    voices += list(fresh.values())
    index.update({"voices": voices, "cascade_phrase": phrase,
                  "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return uploader(key, json.dumps(index, ensure_ascii=False, indent=2).encode("utf-8"),
                    "application/json; charset=utf-8")


def main():
    p = argparse.ArgumentParser(description="Примеры голосов Inworld (Каскад) → R2")
    p.add_argument("voices", nargs="*", help="только эти голоса (id Inworld, например Galina)")
    p.add_argument("--phrase", default=PHRASE)
    p.add_argument("--model", default=INWORLD_MODEL)
    p.add_argument("--no-upload", action="store_true", help="не грузить в R2, сохранить в --out")
    p.add_argument("--out", default="voice_samples_out")
    args = p.parse_args()

    api_key = (os.getenv("INWORLD_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("Нет INWORLD_API_KEY: INWORLD_API_KEY=... python3 scripts/inworld_voice_samples.py")

    known = {vid.lower(): (vid, name, gender) for vid, name, gender, _ in INWORLD_VOICES}
    if args.voices:
        missing = [v for v in args.voices if v.lower() not in known]
        if missing:
            raise SystemExit(f"Неизвестные голоса: {missing}. Есть: {[v[0] for v in INWORLD_VOICES]}")
        jobs = [known[v.lower()] for v in args.voices]
    else:
        jobs = [(vid, name, gender) for vid, name, gender, _ in INWORLD_VOICES]

    uploader, reader = make_uploader(args.no_upload, args.out)
    print(f"Inworld {args.model}: {len(jobs)} голосов, фраза «{args.phrase}»")

    results = []
    for vid, name, gender in jobs:
        slug = vid.lower()
        row = {"provider": "cascade", "voice": vid, "slug": slug, "name": name,
               "gender": "ж" if gender == "female" else "м"}
        t0 = time.monotonic()
        try:
            pcm, rate = synthesize(api_key, vid, args.phrase, args.model)
            pcm = trim_silence(pcm, rate)
            url = uploader(f"{R2_PREFIX}/cascade/{slug}.wav", to_wav(pcm, rate), "audio/wav")
            row.update(loudness(pcm, rate), url=url, rate=rate, model=args.model)
            print(f"  ✅ {vid:<9} {name:<9} {time.monotonic() - t0:4.1f} с  {url}")
        except Exception as e:
            row["error"] = str(e)
            print(f"  ❌ {vid:<9} {name:<9} {e}")
        results.append(row)

    print("\n" + "═" * 96)
    print(f"{'голос':<10} {'имя':<10} {'пол':<3} {'речь dBFS':>9} {'пик':>6} {'сек':>5}  ссылка")
    print("─" * 96)
    for r in results:
        if r.get("error"):
            print(f"{r['voice']:<10} {r['name']:<10} {r['gender']:<3} {'—':>9} {'—':>6} {'—':>5}  ❌ {r['error']}")
        else:
            print(f"{r['voice']:<10} {r['name']:<10} {r['gender']:<3} {r['speech_rms_dbfs']:>9} "
                  f"{r['peak_dbfs']:>6} {r['duration_s']:>5}  {r['url']}")
    print("\nГромкость: чем ближе к 0, тем громче; разница 6 dB ≈ в 2 раза по амплитуде.")

    if any(not r.get("error") for r in results):
        print("index.json:", save_index(results, uploader, reader, args.phrase))
    if any(r.get("error") for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
