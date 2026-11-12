"""
База знаний в собственном Postgres (pgvector) вместо Pinecone.

Включается переменной окружения KB_BACKEND=pgvector (по умолчанию — pinecone,
поведение прежнее). Точки входа не менялись: PineconeService.create_or_update_knowledge_base /
search / delete_knowledge_base и функция search_pinecone сами уходят сюда, когда
бэкенд включён. Namespace остаётся ключом базы, поэтому строка
«Pinecone namespace: <ns>» в промптах и agent_configs.kb_namespace работают как раньше.

Эмбеддинги — OpenRouter (settings.OPENROUTER_API_KEY), модель google/gemini-embedding-2,
1024 измерения (замер scripts/bench_embeddings.py). Вектор хранится нормализованным;
векторного индекса нет: поиск всегда внутри одной базы (до ~3000 строк), точный
перебор по btree-индексу namespace занимает миллисекунды.

Запись: текст режется на фрагменты → эмбеддинги пачками (параллельно) → одна
транзакция «удалить старые строки + вставить новые». Если эмбеддинги не посчитались,
старая база остаётся нетронутой.

База, которой ещё нет в таблице (не перенесена scripts/migrate_kb_to_pgvector.py),
ищется по-старому в Pinecone — search() для неё возвращает None.
"""
import asyncio
import os
import re
import uuid
from typing import Dict, List, Optional, Tuple

import httpx
import numpy as np
from fastapi import HTTPException, status
from sqlalchemy import text

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

BACKEND = (os.getenv("KB_BACKEND") or "pinecone").strip().lower()
EMBEDDING_MODEL = os.getenv("KB_EMBEDDING_MODEL") or "google/gemini-embedding-2"
EMBEDDING_DIMS = int(os.getenv("KB_EMBEDDING_DIMS") or 1024)
# Метка в строках таблицы: при смене модели или размерности старые векторы
# перестают находиться (их нельзя сравнивать с новыми) — базу надо пересчитать.
MODEL_KEY = f"{EMBEDDING_MODEL}@{EMBEDDING_DIMS}"

# Порог релевантности для живого звонка. У gemini-embedding-2 оценки сжаты:
# вопросы не по теме дают до 0.55, верные фрагменты — от 0.65 (замер на базе
# 253 тыс. символов). Старый порог 0.25 (text-embedding-3-small) тут пропускал бы всё.
MIN_SCORE = float(os.getenv("KB_MIN_SCORE") or 0.57)

# Провайдеры OpenRouter по порядку; google-vertex/eu в замере был втрое медленнее.
_providers = [p.strip() for p in (os.getenv("KB_EMBEDDING_PROVIDERS")
                                  or "google-vertex/us,google-ai-studio,google-vertex/global").split(",")
              if p.strip()]
PROVIDER = {"order": _providers, "allow_fallbacks": True}

MAX_CHARS = 2_000_000
CHUNK_SIZE = 1000
EMBED_BATCH = 32
EMBED_CONCURRENCY = 4
EMBED_URL = "https://openrouter.ai/api/v1/embeddings"

TABLE_SQL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    """
    CREATE TABLE IF NOT EXISTS kb_chunks (
        id BIGSERIAL PRIMARY KEY,
        namespace VARCHAR(64) NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding vector NOT NULL,
        model VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_kb_chunks_namespace ON kb_chunks (namespace)",
]


def enabled() -> bool:
    return BACKEND == "pgvector"


def max_chars(pinecone_limit: int) -> int:
    """Лимит размера базы: 2 млн на pgvector, прежний — пока работает Pinecone."""
    return MAX_CHARS if enabled() else pinecone_limit


def ensure_table(engine) -> None:
    """Расширение vector и таблица kb_chunks. Идемпотентно, вызывается на старте."""
    try:
        with engine.begin() as conn:
            for sql in TABLE_SQL:
                conn.execute(text(sql))
        logger.info("✅ kb_chunks table is ready (pgvector)")
    except Exception as e:
        logger.error(f"❌ kb_chunks / pgvector setup failed: {e}")


# ------------------------------------------------------------------ нарезка текста

def split_chunks(content: str, size: int = CHUNK_SIZE) -> List[str]:
    """Фрагменты до size символов: абзацы склеиваются, длинный абзац режется по
    предложениям, предложение длиннее size — по символам. Ничего не теряется
    (старая нарезка рубила только по пустой строке и отдавала абзац любой длины)."""
    parts: List[str] = []
    for para in re.split(r"\n\s*\n", content):
        para = para.strip()
        if not para:
            continue
        if len(para) <= size:
            parts.append(para)
            continue
        buf = ""
        for sent in re.split(r"(?<=[.!?…])\s+|\n", para):
            sent = sent.strip()
            if not sent:
                continue
            while len(sent) > size:
                if buf:
                    parts.append(buf)
                    buf = ""
                parts.append(sent[:size])
                sent = sent[size:]
            if buf and len(buf) + len(sent) + 1 > size:
                parts.append(buf)
                buf = sent
            else:
                buf = f"{buf} {sent}".strip()
        if buf:
            parts.append(buf)

    chunks: List[str] = []
    buf = ""
    for part in parts:
        if buf and len(buf) + len(part) + 2 > size:
            chunks.append(buf)
            buf = part
        else:
            buf = f"{buf}\n\n{part}".strip()
    if buf:
        chunks.append(buf)
    return chunks


# ---------------------------------------------------------------------- эмбеддинги

def _vector_literal(vec: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


async def _embed_batch(client: httpx.AsyncClient, texts: List[str]) -> List[str]:
    """Пачка текстов → векторы (нормализованные, строками для pgvector). 3 попытки."""
    body = {
        "model": EMBEDDING_MODEL, "input": texts, "dimensions": EMBEDDING_DIMS,
        "encoding_format": "float", "provider": PROVIDER,
    }
    last = ""
    for attempt in range(3):
        try:
            r = await client.post(EMBED_URL, json=body)
            if r.status_code == 200 and r.json().get("data"):
                rows = sorted(r.json()["data"], key=lambda d: d.get("index", 0))
                if len(rows) != len(texts):
                    raise RuntimeError(f"got {len(rows)} vectors for {len(texts)} texts")
                out = []
                for row in rows:
                    vec = np.asarray(row["embedding"], dtype=np.float32)[:EMBEDDING_DIMS]
                    norm = float(np.linalg.norm(vec)) or 1.0
                    out.append(_vector_literal(vec / norm))
                return out
            last = f"HTTP {r.status_code}: {r.text[:200]}"
            if r.status_code in (400, 401, 403, 404):
                break
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        await asyncio.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"embeddings failed: {last}")


async def embed_texts(texts: List[str]) -> List[str]:
    if not settings.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is not configured")
    batches = [texts[i:i + EMBED_BATCH] for i in range(0, len(texts), EMBED_BATCH)]
    sem = asyncio.Semaphore(EMBED_CONCURRENCY)
    headers = {"Authorization": f"Bearer {settings.OPENROUTER_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), headers=headers) as client:
        async def run(batch):
            async with sem:
                return await _embed_batch(client, batch)
        done = await asyncio.gather(*(run(b) for b in batches))
    return [vec for batch in done for vec in batch]


# ------------------------------------------------------------------------------ БД

def _replace_rows(namespace: str, chunks: List[str], vectors: List[str]) -> None:
    from backend.db.session import SessionLocal
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM kb_chunks WHERE namespace = :ns"), {"ns": namespace})
        rows = [{"ns": namespace, "i": i, "c": chunk, "e": vec, "m": MODEL_KEY}
                for i, (chunk, vec) in enumerate(zip(chunks, vectors))]
        for start in range(0, len(rows), 200):
            db.execute(text(
                "INSERT INTO kb_chunks (namespace, chunk_index, content, embedding, model) "
                "VALUES (:ns, :i, :c, CAST(:e AS vector), :m)"
            ), rows[start:start + 200])
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _search_rows(namespace: str, vector: str, top_k: int) -> Optional[List[Dict]]:
    """None — базы нет в таблице (не перенесена или посчитана другой моделью)."""
    from backend.db.session import SessionLocal
    db = SessionLocal()
    try:
        rows = db.execute(text(
            "SELECT chunk_index, content, 1 - (embedding <=> CAST(:q AS vector)) AS score "
            "FROM kb_chunks WHERE namespace = :ns AND model = :m "
            "ORDER BY embedding <=> CAST(:q AS vector) LIMIT :k"
        ), {"q": vector, "ns": namespace, "m": MODEL_KEY, "k": top_k}).fetchall()
        if not rows:
            return None
        return [{
            "id": f"{namespace}-{r.chunk_index}", "score": float(r.score), "text": r.content,
            "metadata": {"text": r.content, "chunk_id": r.chunk_index},
        } for r in rows]
    finally:
        db.close()


def _exists(namespace: str) -> bool:
    from backend.db.session import SessionLocal
    db = SessionLocal()
    try:
        return db.execute(text(
            "SELECT 1 FROM kb_chunks WHERE namespace = :ns AND model = :m LIMIT 1"
        ), {"ns": namespace, "m": MODEL_KEY}).first() is not None
    finally:
        db.close()


def _delete_rows(namespace: str) -> None:
    from backend.db.session import SessionLocal
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM kb_chunks WHERE namespace = :ns"), {"ns": namespace})
        db.commit()
    finally:
        db.close()


# ------------------------------------------------------------------------ интерфейс

async def exists(namespace: str) -> bool:
    return await asyncio.to_thread(_exists, namespace)


async def save_chunks(namespace: str, chunks: List[str]) -> int:
    """Записать готовые фрагменты как базу namespace (заменяя прежнюю)."""
    chunks = [c for c in chunks if c and c.strip()]
    if not chunks:
        raise ValueError("empty knowledge base")
    vectors = await embed_texts(chunks)
    await asyncio.to_thread(_replace_rows, namespace, chunks, vectors)
    logger.info(f"[KB] saved namespace={namespace} chunks={len(chunks)} model={MODEL_KEY}")
    return len(chunks)


async def save(content: str, namespace: Optional[str] = None) -> Tuple[str, int]:
    """Создать или заменить базу знаний. → (namespace, число символов)."""
    if len(content) > MAX_CHARS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Content exceeds maximum limit of {MAX_CHARS:,} characters",
        )
    chunks = split_chunks(content)
    if not chunks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Knowledge base content is empty")
    namespace = namespace or f"kb-{uuid.uuid4().hex[:10]}"
    try:
        await save_chunks(namespace, chunks)
    except Exception as e:
        logger.error(f"[KB] save failed namespace={namespace}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Не удалось сохранить базу знаний, попробуйте ещё раз",
        )
    return namespace, len(content)


async def search(query: str, namespace: str, top_k: int = 3) -> Optional[List[Dict]]:
    """Ближайшие фрагменты [{id, score, text, metadata}] или None, если базы нет в таблице."""
    if not query or not namespace:
        return []
    if not await exists(namespace):
        return None
    vector = (await embed_texts([query]))[0]
    return await asyncio.to_thread(_search_rows, namespace, vector, top_k)


async def delete(namespace: str) -> None:
    await asyncio.to_thread(_delete_rows, namespace)
    logger.info(f"[KB] deleted namespace={namespace}")
