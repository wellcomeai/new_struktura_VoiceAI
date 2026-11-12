"""
Тест базы знаний на pgvector (backend/services/kb_store.py).

    python test_kb_store.py                                  # только нарезка текста
    DATABASE_URL=postgresql://... python test_kb_store.py    # + запись/поиск в Postgres с pgvector

OpenRouter не вызывается: эмбеддинги подставные (мешок слов).
"""
import asyncio
import hashlib
import os
import re
import sys

os.environ["KB_BACKEND"] = "pgvector"
os.environ.setdefault("OPENROUTER_API_KEY", "sk-test")

import backend.core.config  # noqa: E402,F401
import numpy as np  # noqa: E402
from backend.services import kb_store  # noqa: E402

STATE = {"fail": False, "calls": 0}


async def fake_embed_batch(client, texts):
    STATE["calls"] += 1
    if STATE["fail"]:
        raise RuntimeError("embeddings failed: test")
    out = []
    for t in texts:
        v = np.zeros(kb_store.EMBEDDING_DIMS, dtype=np.float32)
        for w in re.findall(r"\w+", t.lower()):
            v[int(hashlib.md5(w[:5].encode()).hexdigest(), 16) % len(v)] += 1
        out.append(kb_store._vector_literal(v / (np.linalg.norm(v) or 1)))
    return out


kb_store._embed_batch = fake_embed_batch


def test_split():
    assert kb_store.split_chunks("") == []
    assert kb_store.split_chunks("Привет.\n\nКак дела?") == ["Привет.\n\nКак дела?"]
    # Текст одним куском без пустых строк и без точек — раньше уезжал целиком
    solid = "слово " * 2000
    chunks = kb_store.split_chunks(solid)
    assert len(chunks) > 10 and all(len(c) <= kb_store.CHUNK_SIZE for c in chunks)
    assert sum(len(c.replace(" ", "")) for c in chunks) == len(solid.replace(" ", ""))
    # Длинный абзац режется по предложениям
    para = " ".join(f"Предложение номер {i} про доставку товара." for i in range(120))
    chunks = kb_store.split_chunks(para)
    assert all(len(c) <= kb_store.CHUNK_SIZE for c in chunks) and all(c.endswith(".") for c in chunks)
    # Мелкие абзацы склеиваются
    many = "\n\n".join(f"Пункт {i}." for i in range(300))
    assert len(kb_store.split_chunks(many)) < 10
    print("split_chunks: OK")


async def test_db():
    from fastapi import HTTPException
    from backend.db.session import engine
    from backend.services.pinecone_service import PineconeService
    from backend.functions.search_pinecone import PineconeSearchFunction

    kb_store.ensure_table(engine)
    kb_store.ensure_table(engine)  # идемпотентно
    text = "\n\n".join([
        "Доставка по Москве стоит 300 рублей и занимает один день. " * 12,
        "Гарантия на оборудование составляет два года с момента покупки. " * 12,
        "Оплата возможна картой, наличными курьеру или по счёту для юрлиц. " * 12,
    ])
    ns, chars = await PineconeService.create_or_update_knowledge_base(content=text, api_key="unused")
    assert ns.startswith("kb-") and chars == len(text)
    assert await kb_store.exists(ns)

    found = await PineconeService.search("сколько стоит доставка по Москве", ns, api_key="unused", top_k=2)
    assert len(found) == 2 and "Доставка" in found[0]["text"], found
    assert found[0]["score"] > found[1]["score"] and 0 < found[0]["score"] <= 1.0001
    assert found[0]["metadata"]["text"] == found[0]["text"]

    # Функция живого звонка: формат ответа и порог
    kb_store.MIN_SCORE = 0.3
    res = await PineconeSearchFunction.execute({"query": "гарантия на оборудование", "namespace": ns})
    assert res["success"] and res["total"] >= 1 and "Гарантия" in res["results"][0]["metadata"]["text"], res
    kb_store.MIN_SCORE = 0.99
    res = await PineconeSearchFunction.execute({"query": "рецепт борща", "namespace": ns})
    assert res["success"] and res["total"] == 0 and res["found"] is False, res

    # Обновление заменяет базу целиком
    await PineconeService.create_or_update_knowledge_base(
        content="Склад работает с девяти до шести по будням.", api_key="unused", namespace=ns)
    found = await PineconeService.search("доставка", ns, api_key="unused", top_k=5)
    assert len(found) == 1 and "Склад" in found[0]["text"]

    # Сбой эмбеддингов не трогает прежнюю базу
    STATE["fail"] = True
    try:
        await PineconeService.create_or_update_knowledge_base(content="Новый текст.", api_key="unused", namespace=ns)
        raise AssertionError("ожидалась ошибка")
    except HTTPException as e:
        assert e.status_code == 502
    STATE["fail"] = False
    found = await kb_store.search("склад", ns, 3)
    assert len(found) == 1 and "Склад" in found[0]["text"]

    # Большая база: пачки и параллельность
    big = "\n\n".join(f"Раздел {i}. " + "Условия обслуживания клиентов категории. " * 20 for i in range(400))
    STATE["calls"] = 0
    ns2, _ = await kb_store.save(big)
    assert STATE["calls"] > 5 and len(await kb_store.search("раздел 17", ns2, 10)) == 10

    # Лимит
    try:
        await kb_store.save("я" * (kb_store.MAX_CHARS + 1))
        raise AssertionError("ожидалась ошибка лимита")
    except HTTPException as e:
        assert e.status_code == 400

    # Не перенесённая база → None (вызывающий код идёт в Pinecone)
    assert await kb_store.search("что угодно", "kb-not-migrated", 3) is None

    os.environ.pop("PINECONE_API_KEY", None)
    assert await PineconeService.delete_knowledge_base(ns) is True
    await kb_store.delete(ns2)
    assert not await kb_store.exists(ns) and not await kb_store.exists(ns2)
    print("pgvector save/search/delete: OK")


if __name__ == "__main__":
    test_split()
    if os.environ.get("DATABASE_URL"):
        asyncio.run(test_db())
    else:
        print("DATABASE_URL не задан — проверка Postgres пропущена")
    print("ALL OK")
    sys.exit(0)
