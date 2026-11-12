"""
Замер моделей эмбеддингов через OpenRouter перед переносом базы знаний с Pinecone
на pgvector. Запуск в Shell на Render (нужны OPENROUTER_API_KEY и DATABASE_URL —
оба уже есть в окружении сервиса):

    python3 scripts/bench_embeddings.py --list                 # базы знаний в БД
    python3 scripts/bench_embeddings.py                        # замер на самой большой базе
    python3 scripts/bench_embeddings.py --namespace kb-abc123  # замер на конкретной базе
    python3 scripts/bench_embeddings.py -q "сколько стоит доставка" -q "график работы"
    python3 scripts/bench_embeddings.py --file prices.txt      # текст из файла, без БД
    python3 scripts/bench_embeddings.py --skip-quality         # только каталог и скорость

Что делает:
  1. Каталог: какие модели эмбеддингов реально есть на OpenRouter, цена, контекст.
  2. Параметр dimensions: принимает ли его модель и совпадает ли результат с
     обрезкой вектора у нас (первые N чисел + нормализация).
  3. Скорость: один поисковый запрос (это путь живого звонка) и загрузка базы
     пачками, с оценкой времени на 2 млн символов. Для Qwen — отдельно по провайдерам.
  4. Качество на реальной базе: LLM придумывает вопросы клиента по случайным
     фрагментам, считаем, нашёлся ли нужный фрагмент (hit@1, hit@3, MRR), плюс
     оценки для вопросов не по теме — по ним выбирается порог MIN_SCORE.
  5. Свои вопросы (-q): топ-3 фрагмента каждой модели рядом, для проверки глазами.

Скрипт ничего не пишет в БД и не трогает Pinecone. Текст выбранной базы уходит в
OpenRouter (эмбеддинги) — то же самое будет делать боевой код после переноса.
Стоимость прогона на базе в 200 тыс. символов — меньше 1 рубля.
"""
import argparse
import json
import os
import random
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np

sys.stdout.reconfigure(line_buffering=True)

API = "https://openrouter.ai/api/v1"
KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Инструкция Qwen3 для поискового запроса (документы идут без неё). Пишется
# по-английски — так обучена модель, язык самих текстов любой.
QWEN_TASK = "Given a customer question, retrieve passages from the knowledge base that answer it"

# model, размерности для сравнения (первая — родная), нужна ли инструкция запросу
MODELS = [
    {"model": "openai/text-embedding-3-small", "dims": [1536], "instruct": False, "note": "сейчас в проде"},
    {"model": "qwen/qwen3-embedding-8b", "dims": [4096, 1024, 512], "instruct": True, "note": "кандидат"},
    {"model": "qwen/qwen3-embedding-4b", "dims": [2560, 1024], "instruct": True, "note": "запасной"},
    # Новые модели из каталога (ноябрь 2026). Родная размерность неизвестна (0) —
    # берётся из ответа. kind — как модели сообщается «запрос» / «документ».
    {"model": "mongodb/voyage-4-lite", "dims": [0, 1024, 512], "kind": ("query", "document"), "note": "новая, $0.02"},
    {"model": "mongodb/voyage-4", "dims": [0, 1024, 512], "kind": ("query", "document"), "note": "новая, $0.06"},
    {"model": "mongodb/voyage-4-large", "dims": [0, 1024], "kind": ("query", "document"), "note": "новая, $0.12"},
    {"model": "cohere/embed-5-fast", "dims": [0, 1024, 512], "kind": ("search_query", "search_document"),
     "note": "новая, $0.08"},
    {"model": "cohere/embed-5-pro", "dims": [0, 1024], "kind": ("search_query", "search_document"),
     "note": "новая, $0.12"},
    {"model": "perplexity/pplx-embed-v1-4b", "dims": [0, 1024], "note": "новая, $0.03"},
    {"model": "google/gemini-embedding-2", "dims": [0, 1024], "note": "новая, $0.20"},
    {"model": "baai/bge-m3", "dims": [0], "note": "открытая, $0.01"},
]
for _cfg in MODELS:
    _cfg.setdefault("instruct", False)
    _cfg.setdefault("kind", None)

QUESTION_MODEL = "deepseek/deepseek-v4.1-flash"
OFF_TOPIC = [
    "Какой рецепт борща с пампушками?",
    "Кто выиграл чемпионат мира по футболу в 2018 году?",
    "Как поменять колесо на велосипеде?",
    "Расскажи анекдот про программистов",
    "Какая завтра погода в Токио?",
]
BATCH = 32
TARGET_CHARS = 2_000_000

client = httpx.Client(timeout=httpx.Timeout(90.0, connect=10.0),
                      headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})


def line(title=""):
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


# --------------------------------------------------------------------------- API

def embed(model, texts, dimensions=None, provider=None, retries=2, input_type=None):
    """→ (np.array [n, dim] без нормализации, секунды, ответ JSON)."""
    body = {"model": model, "input": texts, "encoding_format": "float"}
    if input_type:
        body["input_type"] = input_type
    if dimensions:
        body["dimensions"] = dimensions
    if provider:
        body["provider"] = provider
    last = None
    for attempt in range(retries + 1):
        t0 = time.perf_counter()
        try:
            r = client.post(f"{API}/embeddings", json=body)
            dt = time.perf_counter() - t0
            if r.status_code == 200:
                data = r.json()
                if data.get("data"):
                    rows = sorted(data["data"], key=lambda d: d.get("index", 0))
                    return np.array([d["embedding"] for d in rows], dtype=np.float32), dt, data
                last = f"пустой ответ: {r.text[:300]}"
            else:
                last = f"HTTP {r.status_code}: {r.text[:300]}"
                if r.status_code in (400, 401, 403, 404):
                    break
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(last)


CHAT_ERRORS = []


def chat(prompt, max_tokens=1500):
    """Короткий ответ LLM. Модель рассуждающая: при малом max_tokens всё уходит в
    рассуждения и content приходит пустым, поэтому запас большой, а рассуждения
    просим покороче; если параметр reasoning не принят — повтор без него."""
    body = {
        "model": QUESTION_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens, "temperature": 0.7,
        "reasoning": {"effort": "low", "exclude": True},
    }
    for attempt in range(2):
        r = client.post(f"{API}/chat/completions", json=body)
        if r.status_code == 200:
            msg = (r.json().get("choices") or [{}])[0].get("message") or {}
            text = (msg.get("content") or "").strip()
            if text:
                return text
            CHAT_ERRORS.append(f"пустой ответ: {r.text[:200]}")
        else:
            CHAT_ERRORS.append(f"HTTP {r.status_code}: {r.text[:200]}")
        body.pop("reasoning", None)
    raise RuntimeError(CHAT_ERRORS[-1])


def as_query(cfg, text):
    return f"Instruct: {QWEN_TASK}\nQuery: {text}" if cfg["instruct"] else text


def kind(cfg, is_query):
    """input_type для моделей, различающих запрос и документ (None — не передавать)."""
    if not cfg.get("kind"):
        return None
    return cfg["kind"][0 if is_query else 1]


def cut(vectors, dim):
    """Обрезка до dim измерений + нормализация (так же будет в боевом коде)."""
    v = vectors[:, :dim].astype(np.float32)
    norm = np.linalg.norm(v, axis=1, keepdims=True)
    norm[norm == 0] = 1
    return v / norm


# ----------------------------------------------------------------------- 1. каталог

def show_catalog():
    line("1. КАТАЛОГ МОДЕЛЕЙ ЭМБЕДДИНГОВ НА OPENROUTER")
    items = None
    for url in (f"{API}/embeddings/models", f"{API}/models?output_modalities=embeddings"):
        try:
            r = client.get(url)
            if r.status_code == 200 and r.json().get("data"):
                items = r.json()["data"]
                break
            print(f"  {url} → HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            print(f"  {url} → {e}")
    if not items:
        print("  Каталог не получен — не страшно, дальше модели проверяются запросом.")
        return
    rows = []
    for m in items:
        price = (m.get("pricing") or {}).get("prompt")
        try:
            price = float(price) * 1_000_000
        except (TypeError, ValueError):
            price = None
        rows.append((m.get("created") or 0, m.get("id", "?"), m.get("context_length"), price))
    rows.sort(reverse=True)
    print(f"  Всего: {len(rows)}. Сначала новые.\n")
    print(f"  {'модель':<48} {'добавлена':<11} {'контекст':>9} {'$ за 1М':>9}")
    for created, mid, ctx, price in rows:
        day = time.strftime("%Y-%m-%d", time.gmtime(created)) if created else "?"
        cost = f"{price:.3f}" if price is not None else "?"
        print(f"  {mid:<48} {day:<11} {str(ctx or '?'):>9} {cost:>9}")
    known = {r[1] for r in rows}
    for cfg in MODELS:
        if cfg["model"] not in known:
            print(f"\n  ⚠ {cfg['model']} нет в каталоге под таким id — см. список выше.")


def list_providers(model):
    """Провайдеры модели (slug для provider.only). Пусто — если эндпоинт недоступен."""
    try:
        r = client.get(f"{API}/models/{model}/endpoints")
        if r.status_code != 200:
            return []
        eps = (r.json().get("data") or {}).get("endpoints") or []
        out = []
        for e in eps:
            slug = (e.get("tag") or e.get("provider_name") or "").strip()
            if slug and slug not in [o[0] for o in out]:
                out.append((slug, e.get("provider_name") or slug, e.get("quantization") or "?"))
        return out
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------------- 2. dimensions

def check_dimensions(cfg):
    model, native = cfg["model"], cfg["dims"][0]
    sample = ["Доставка по Москве занимает один день и стоит 300 рублей."]
    try:
        full, _, _ = embed(model, sample, retries=0)
    except Exception as e:  # noqa: BLE001
        print(f"  {model}: ✗ не отвечает — {e}")
        return False
    if cfg.get("kind"):
        try:
            embed(model, sample, retries=0, input_type=kind(cfg, True))
            print(f"  {model}: input_type принят — запрос и документ кодируются по-разному")
        except Exception as e:  # noqa: BLE001
            print(f"  {model}: input_type отклонён, работаем без него ({str(e)[:100]})")
            cfg["kind"] = None
    got = full.shape[1]
    flag = "" if native in (0, got) else f" (ожидали {native} — поправьте MODELS)"
    print(f"  {model}: родная размерность {got}{flag}")
    cfg["dims"] = [got] + [d for d in cfg["dims"][1:] if d < got]
    for dim in cfg["dims"][1:]:
        try:
            small, _, _ = embed(model, sample, dimensions=dim, retries=0)
            if small.shape[1] != dim:
                print(f"    dimensions={dim}: параметр проигнорирован (вернулось {small.shape[1]}) "
                      f"→ режем у себя")
                continue
            same = float((cut(full, dim) @ cut(small, dim).T)[0, 0])
            verdict = "совпадает с обрезкой у нас" if same > 0.999 else "НЕ совпадает с обрезкой у нас"
            print(f"    dimensions={dim}: принят, {verdict} (cos={same:.4f})")
        except Exception as e:  # noqa: BLE001
            print(f"    dimensions={dim}: ошибка → режем у себя ({str(e)[:120]})")
    return True


# ------------------------------------------------------------------------ 3. скорость

def latency(cfg, provider=None, runs=8):
    """Один короткий запрос — столько ждёт абонент в звонке перед поиском."""
    q = as_query(cfg, "Сколько стоит доставка и когда привезёте?")
    times, served = [], set()
    for _ in range(runs):
        try:
            _, dt, data = embed(cfg["model"], [q], provider=provider, retries=0, input_type=kind(cfg, True))
            times.append(dt * 1000)
            if data.get("provider"):
                served.add(str(data["provider"]))
        except Exception as e:  # noqa: BLE001
            return None, str(e)[:160]
    warm = times[1:] or times
    return {
        "first": times[0], "median": statistics.median(warm),
        "p90": sorted(warm)[max(0, int(len(warm) * 0.9) - 1)], "max": max(warm),
        "served": ", ".join(sorted(served)) or "—",
    }, None


def show_latency(alive):
    line("3. СКОРОСТЬ ОДНОГО ПОИСКОВОГО ЗАПРОСА (мс; путь живого звонка)")
    print(f"  {'модель / провайдер':<46} {'первый':>7} {'медиана':>8} {'p90':>6} {'макс':>6}  отвечал")
    for cfg in alive:
        res, err = latency(cfg)
        if err:
            print(f"  {cfg['model']:<46} ✗ {err}")
            continue
        print(f"  {cfg['model']:<46} {res['first']:>7.0f} {res['median']:>8.0f} {res['p90']:>6.0f} "
              f"{res['max']:>6.0f}  {res['served']}")
        cfg["median_ms"] = res["median"]
        providers = list_providers(cfg["model"])
        if len(providers) < 2:
            continue
        for slug, name, quant in providers:
            res, err = latency(cfg, provider={"only": [slug], "allow_fallbacks": False}, runs=5)
            label = f"    └ {slug} [{quant}]"
            if err:
                print(f"  {label:<46} ✗ {err}")
            else:
                print(f"  {label:<46} {res['first']:>7.0f} {res['median']:>8.0f} {res['p90']:>6.0f} "
                      f"{res['max']:>6.0f}")
    print("\n  Ориентир: медиана до ~300 мс и p90 до ~600 мс — в звонке незаметно.")


# ------------------------------------------------------------------------- текст базы

def db_engine():
    from sqlalchemy import create_engine
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        sys.exit("DATABASE_URL не задан — запустите в Render Shell или передайте --file.")
    return create_engine(url.replace("postgres://", "postgresql://", 1))


KB_SQL = """
    SELECT 'ассистенты' AS src, namespace, COALESCE(name, '') AS name,
           COALESCE(length(full_content), 0) AS chars
      FROM pinecone_configs
    UNION ALL
    SELECT 'агент', kb_namespace, COALESCE(kb_name, name, ''), COALESCE(length(kb_content), 0)
      FROM agent_configs WHERE kb_namespace IS NOT NULL
"""


def list_bases():
    from sqlalchemy import text
    with db_engine().connect() as conn:
        rows = conn.execute(text(KB_SQL + " ORDER BY 4 DESC")).fetchall()
    line(f"БАЗЫ ЗНАНИЙ В БД: {len(rows)}")
    empty = sum(1 for r in rows if not r.chars)
    print(f"  {'namespace':<24} {'где':<11} {'символов':>10}  название")
    for r in rows[:60]:
        print(f"  {str(r.namespace):<24} {r.src:<11} {r.chars:>10}  {r.name[:40]}")
    if len(rows) > 60:
        print(f"  … и ещё {len(rows) - 60}")
    print(f"\n  Всего символов: {sum(r.chars for r in rows):,}".replace(",", " "))
    print(f"  Без сохранённого текста: {empty} (их при переносе придётся вытащить из Pinecone)")


def load_text(args):
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            return f.read(), args.file
    from sqlalchemy import text
    with db_engine().connect() as conn:
        if args.namespace:
            row = conn.execute(text(
                "SELECT full_content AS body FROM pinecone_configs WHERE namespace = :ns "
                "UNION ALL SELECT kb_content FROM agent_configs WHERE kb_namespace = :ns LIMIT 1"
            ), {"ns": args.namespace}).fetchone()
            if not row or not row.body:
                sys.exit(f"База {args.namespace} не найдена или без текста. См. --list.")
            return row.body, args.namespace
        pick = conn.execute(text(
            f"SELECT namespace, chars FROM ({KB_SQL}) t WHERE chars BETWEEN 5000 AND :cap "
            "ORDER BY chars DESC LIMIT 1"), {"cap": args.max_chars}).fetchone()
        if not pick:
            sys.exit("Подходящей базы нет (5 000…max-chars символов). Укажите --namespace или --file.")
    args.namespace = pick.namespace
    return load_text(args)


def split_chunks(text, size=1000):
    """Нарезка для замера: абзацы, длинные — по предложениям. Без перекрытия,
    чтобы у каждого вопроса был ровно один «правильный» фрагмент."""
    parts = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= size:
            parts.append(para)
            continue
        buf = ""
        for sent in re.split(r"(?<=[.!?…])\s+|\n", para):
            while len(sent) > size:
                parts.append((buf + " " + sent[:size]).strip() if buf else sent[:size])
                buf, sent = "", sent[size:]
            if len(buf) + len(sent) + 1 > size and buf:
                parts.append(buf)
                buf = sent
            else:
                buf = (buf + " " + sent).strip()
        if buf:
            parts.append(buf)
    chunks, buf = [], ""
    for p in parts:  # склеиваем мелкие абзацы до size
        if len(buf) + len(p) + 2 > size and buf:
            chunks.append(buf)
            buf = p
        else:
            buf = (buf + "\n\n" + p).strip()
    if buf:
        chunks.append(buf)
    return chunks


def make_questions(chunks, count, seed):
    """Вопросы клиента по случайным фрагментам → [(вопрос, номер фрагмента)]."""
    rnd = random.Random(seed)
    pool = [i for i, c in enumerate(chunks) if len(c) >= 250]
    picked = rnd.sample(pool, min(count, len(pool)))

    def ask(i):
        prompt = (
            "Ниже фрагмент базы знаний компании. Напиши ОДИН короткий вопрос, который клиент "
            "мог бы задать по телефону и ответ на который есть именно в этом фрагменте. "
            "Вопрос должен быть конкретным — таким, чтобы по нему можно было отличить этот "
            "фрагмент от соседних частей того же документа. "
            "Разговорным языком, своими словами, не копируй формулировки из текста. "
            "Ответь только вопросом, без кавычек.\n\nФРАГМЕНТ:\n" + chunks[i][:1500]
        )
        try:
            q = chat(prompt).split("\n")[0].strip(" \"«»")
            return (q, i) if 8 <= len(q) <= 300 else None
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=5) as pool_exec:
        made = [x for x in pool_exec.map(ask, picked) if x]
    if len(made) >= max(5, len(picked) // 2):
        return made, "вопросы придумала модель " + QUESTION_MODEL
    # Запасной путь: предложение из середины фрагмента. Оценке качества по таким
    # вопросам верить нельзя: это обрывки текста, часто одинаковые в десятках фрагментов.
    if CHAT_ERRORS:
        print(f"  ⚠ LLM не ответила ({len(CHAT_ERRORS)} ошибок), первая: {CHAT_ERRORS[0]}")
    made = []
    for i in picked:
        sents = [s for s in re.split(r"(?<=[.!?])\s+", chunks[i]) if 40 <= len(s) <= 200]
        if sents:
            made.append((sents[len(sents) // 2], i))
    return made, "ВНИМАНИЕ: LLM недоступна, вопросы — обрывки текста, таблице качества НЕ ВЕРИТЬ"


# ------------------------------------------------------------------------ 4. качество

def embed_all(cfg, texts, label, is_query=False):
    out, spent, tokens = [], 0.0, 0
    for start in range(0, len(texts), BATCH):
        vec, dt, data = embed(cfg["model"], texts[start:start + BATCH], input_type=kind(cfg, is_query))
        out.append(vec)
        spent += dt
        tokens += int((data.get("usage") or {}).get("prompt_tokens") or 0)
        print(f"\r    {label}: {min(start + BATCH, len(texts))}/{len(texts)}", end="")
    print()
    return np.vstack(out), spent, tokens


def quality(alive, chunks, questions, own_questions):
    line("4. КАЧЕСТВО ПОИСКА И СКОРОСТЬ ЗАГРУЗКИ БАЗЫ")
    total_chars = sum(len(c) for c in chunks)
    q_texts = [q for q, _ in questions]
    target = np.array([i for _, i in questions])
    summary, own_out = [], {}

    for cfg in alive:
        print(f"\n  {cfg['model']} ({cfg['note']})")
        try:
            docs, spent, tokens = embed_all(cfg, chunks, "фрагменты")
            extra = OFF_TOPIC + own_questions
            qv, _, _ = embed_all(cfg, [as_query(cfg, q) for q in q_texts + extra], "вопросы", is_query=True)
        except Exception as e:  # noqa: BLE001
            print(f"    ✗ {e}")
            continue
        est = spent * TARGET_CHARS / total_chars
        print(f"    загрузка: {len(chunks)} фрагментов за {spent:.1f} с ({tokens} токенов) "
              f"→ 2 млн символов ≈ {est / 60:.1f} мин последовательно")

        for dim in cfg["dims"]:
            d, q = cut(docs, dim), cut(qv, dim)
            sims = q @ d.T
            rel = sims[:len(q_texts)]
            order = np.argsort(-rel, axis=1)
            rank = np.array([int(np.where(order[i] == target[i])[0][0]) for i in range(len(q_texts))])
            right = rel[np.arange(len(q_texts)), target]
            off = sims[len(q_texts):len(q_texts) + len(OFF_TOPIC)].max(axis=1)
            summary.append({
                "name": f"{cfg['model']} @{dim}",
                "hit1": float((rank == 0).mean()), "hit3": float((rank < 3).mean()),
                "mrr": float((1.0 / (rank + 1)).mean()),
                "right_p10": float(np.percentile(right, 10)), "right_med": float(np.median(right)),
                "off_max": float(off.max()), "off_med": float(np.median(off)),
                "kb": dim * 4 / 1024, "ms": cfg.get("median_ms"),
            })
            if own_questions and dim == cfg["dims"][min(1, len(cfg["dims"]) - 1)]:
                own = sims[len(q_texts) + len(OFF_TOPIC):]
                own_out[f"{cfg['model']} @{dim}"] = [
                    [(int(j), float(own[k, j])) for j in np.argsort(-own[k])[:3]]
                    for k in range(len(own_questions))
                ]

    if not summary:
        print("\n  Ни одна модель не отработала.")
        return
    print(f"\n  Вопросов: {len(questions)} (один вопрос = {100 / len(questions):.1f} п.п.; разница "
          f"меньше ~{300 / len(questions):.0f} п.п. — шум).")
    print(f"  hit@1 — нужный фрагмент первый, hit@3 — в тройке "
          f"(столько получает модель в звонке).")
    print(f"\n  {'модель @размерность':<40} {'hit@1':>6} {'hit@3':>6} {'MRR':>6} {'КБ/фрагм':>9} {'запрос, мс':>11}")
    for s in summary:
        ms = f"{s['ms']:.0f}" if s.get("ms") else "?"
        print(f"  {s['name']:<40} {s['hit1']:>6.0%} {s['hit3']:>6.0%} {s['mrr']:>6.2f} {s['kb']:>9.1f} {ms:>11}")

    print("\n  ПОРОГ РЕЛЕВАНТНОСТИ (сейчас MIN_SCORE = 0.25 под text-embedding-3-small)")
    print(f"  {'модель @размерность':<40} {'верный p10':>10} {'верный мед':>10} "
          f"{'мимо мед':>9} {'мимо макс':>9} {'порог':>7}")
    for s in summary:
        gap = s["right_p10"] - s["off_max"]
        thr = f"{(s['right_p10'] + s['off_max']) / 2:.2f}" if gap > 0.02 else "нет зазора"
        print(f"  {s['name']:<40} {s['right_p10']:>10.2f} {s['right_med']:>10.2f} "
              f"{s['off_med']:>9.2f} {s['off_max']:>9.2f} {thr:>7}")
    print("  «верный» — оценка нужного фрагмента, «мимо» — лучшая оценка на вопросы не по теме.")

    if own_out:
        line("5. ВАШИ ВОПРОСЫ: топ-3 фрагмента каждой модели")
        for k, question in enumerate(own_questions):
            print(f"\n  ВОПРОС: {question}")
            for name, tops in own_out.items():
                print(f"    {name}")
                for j, score in tops[k]:
                    snippet = re.sub(r"\s+", " ", chunks[j])[:150]
                    print(f"      {score:.2f}  #{j}: {snippet}")


# ------------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description="Замер моделей эмбеддингов через OpenRouter")
    ap.add_argument("--list", action="store_true", help="показать базы знаний в БД и выйти")
    ap.add_argument("--namespace", help="namespace базы для замера качества")
    ap.add_argument("--file", help="взять текст из файла вместо БД")
    ap.add_argument("--max-chars", type=int, default=300_000, help="потолок размера базы при автовыборе")
    ap.add_argument("--questions", type=int, default=80, help="сколько вопросов придумать")
    ap.add_argument("-q", action="append", default=[], help="свой вопрос (можно несколько)")
    ap.add_argument("--models", help="свои id моделей через запятую вместо набора по умолчанию")
    ap.add_argument("--only", help="оставить из набора модели, в id которых есть одна из подстрок (через запятую)")
    ap.add_argument("--skip-quality", action="store_true", help="только каталог и скорость")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if args.list:
        list_bases()
        return
    if not KEY:
        sys.exit("OPENROUTER_API_KEY не задан.")
    if args.models:
        MODELS[:] = [{"model": m.strip(), "dims": [0, 1024], "instruct": "qwen" in m, "kind": None,
                      "note": "задана вручную"}
                     for m in args.models.split(",") if m.strip()]

    if args.only:
        keep = [x.strip().lower() for x in args.only.split(",") if x.strip()]
        MODELS[:] = [c for c in MODELS if any(k in c["model"].lower() for k in keep)]
    show_catalog()

    line("2. РАЗМЕРНОСТЬ И ПАРАМЕТР dimensions")
    alive = [cfg for cfg in MODELS if check_dimensions(cfg)]
    if not alive:
        sys.exit("\nНи одна модель не ответила — проверьте ключ и id моделей по каталогу выше.")

    show_latency(alive)

    if args.skip_quality:
        return
    body, source = load_text(args)
    chunks = split_chunks(body)
    line(f"БАЗА ДЛЯ ЗАМЕРА: {source} — {len(body):,} символов, {len(chunks)} фрагментов".replace(",", " "))
    if len(chunks) < 10:
        sys.exit("Слишком маленькая база для замера (меньше 10 фрагментов) — возьмите другую.")
    questions, how = make_questions(chunks, args.questions, args.seed)
    print(f"  {len(questions)} вопросов; {how}")
    for q, i in questions[:5]:
        print(f"    • {q}  → фрагмент #{i}")
    quality(alive, chunks, questions, args.q)

    line("ГОТОВО")
    print("  Пришлите весь вывод целиком — по нему фиксируем модель, размерность,\n"
          "  провайдеров и порог.")


if __name__ == "__main__":
    main()
