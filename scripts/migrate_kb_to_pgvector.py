"""
Перенос баз знаний из Pinecone в собственный Postgres (таблица kb_chunks, pgvector).
Запуск в Shell на Render:

    python3 scripts/migrate_kb_to_pgvector.py --dry-run     # что будет перенесено, без записи
    python3 scripts/migrate_kb_to_pgvector.py               # перенести все ещё не перенесённые
    python3 scripts/migrate_kb_to_pgvector.py kb-abc123     # одну базу
    python3 scripts/migrate_kb_to_pgvector.py --force       # пересчитать все заново

Текст берётся из Postgres (pinecone_configs.full_content, agent_configs.kb_content),
режется заново и считается моделью из backend/services/kb_store.py. Если текста в
Postgres нет (старые базы), фрагменты вытаскиваются из Pinecone как есть.

Pinecone не изменяется и не чистится — он остаётся для отката (KB_BACKEND=pinecone).
Переменная KB_BACKEND для переноса не нужна: скрипт пишет в kb_chunks при любом значении,
а поиск начнёт туда ходить только после KB_BACKEND=pgvector. Повторный запуск безопасен.
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(line_buffering=True)

import backend.core.config  # noqa: E402,F401
from sqlalchemy import text  # noqa: E402
from backend.db.session import SessionLocal, engine  # noqa: E402
from backend.services import kb_store  # noqa: E402

BASES_SQL = """
    SELECT namespace, COALESCE(name, '') AS name, full_content AS body, 'ассистенты' AS src
      FROM pinecone_configs WHERE namespace IS NOT NULL
    UNION ALL
    SELECT kb_namespace, COALESCE(kb_name, name, ''), kb_content, 'агент'
      FROM agent_configs WHERE kb_namespace IS NOT NULL
"""


def pinecone_chunks(namespace):
    """Тексты фрагментов базы из Pinecone (id вида <namespace>-<номер>)."""
    import pinecone
    key = os.environ.get("PINECONE_API_KEY")
    if not key:
        return []
    index = pinecone.Pinecone(api_key=key).Index("voicufi")
    stats = index.describe_index_stats()
    ns = (stats.get("namespaces") or {}).get(namespace)
    count = int((ns or {}).get("vector_count") or 0)
    found = {}
    for start in range(0, count + 50, 100):  # запас: при сбоях записи номера шли с пропусками
        ids = [f"{namespace}-{i}" for i in range(start, start + 100)]
        got = index.fetch(ids=ids, namespace=namespace)
        vectors = got.get("vectors") if isinstance(got, dict) else got.vectors
        for vid, vec in (vectors or {}).items():
            meta = vec.get("metadata") if isinstance(vec, dict) else vec.metadata
            body = (meta or {}).get("text")
            if body:
                found[int(vid.rsplit("-", 1)[1])] = body
    return [found[i] for i in sorted(found)]


async def main():
    ap = argparse.ArgumentParser(description="Перенос баз знаний в pgvector")
    ap.add_argument("namespace", nargs="?", help="перенести только эту базу")
    ap.add_argument("--force", action="store_true", help="пересчитать и уже перенесённые")
    ap.add_argument("--dry-run", action="store_true", help="только отчёт")
    args = ap.parse_args()

    kb_store.ensure_table(engine)
    db = SessionLocal()
    try:
        rows = db.execute(text(BASES_SQL)).fetchall()
    finally:
        db.close()

    seen, bases = set(), []
    for r in rows:
        if r.namespace in seen or (args.namespace and r.namespace != args.namespace):
            continue
        seen.add(r.namespace)
        bases.append(r)
    print(f"Баз знаний: {len(bases)}; модель {kb_store.MODEL_KEY}; KB_BACKEND={kb_store.BACKEND}\n")

    done = skipped = failed = empty = 0
    for n, r in enumerate(bases, 1):
        label = f"[{n}/{len(bases)}] {r.namespace} ({r.src}, {r.name[:30]})"
        try:
            if not args.force and await kb_store.exists(r.namespace):
                skipped += 1
                print(f"{label}: уже перенесена")
                continue
            body = (r.body or "").strip()
            if body:
                chunks, source = kb_store.split_chunks(body), f"{len(body)} символов из Postgres"
            else:
                chunks = await asyncio.to_thread(pinecone_chunks, r.namespace)
                source = "текст из Pinecone"
            if not chunks:
                empty += 1
                print(f"{label}: ПУСТО — текста нет ни в Postgres, ни в Pinecone")
                continue
            if args.dry_run:
                print(f"{label}: будет перенесена — {len(chunks)} фрагментов, {source}")
                continue
            await kb_store.save_chunks(r.namespace, chunks)
            done += 1
            print(f"{label}: перенесена — {len(chunks)} фрагментов, {source}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"{label}: ОШИБКА — {e}")

    print(f"\nИтог: перенесено {done}, уже были {skipped}, пустых {empty}, ошибок {failed}")
    if failed:
        print("Запустите скрипт ещё раз — перенесённые базы он пропустит.")
    elif not args.dry_run:
        print("Теперь можно поставить KB_BACKEND=pgvector в окружении сервиса.")


if __name__ == "__main__":
    asyncio.run(main())
