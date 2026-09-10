"""
Фоновый освободитель тестовых номеров.

Раз в check_interval секунд снимает привязку с номеров, у которых истекла
аренда (TestNumberService.expire_due), и возвращает их в пул. Дополнительно
истёкшие аренды подчищаются лениво при запросах /api/telephony/test-numbers/*
и не обслуживаются в /api/telephony/config, так что задержка планировщика
не даёт «лишних» звонков — только задержку в UI освобождения.

Идемпотентен при нескольких воркерах Gunicorn: каждая аренда закрывается
одним UPDATE по своему id, повторный проход ничего не находит.
"""

import asyncio

from backend.core.logging import get_logger
from backend.db.session import SessionLocal

logger = get_logger(__name__)

_running = False


async def start_test_number_expirer(check_interval: int = 15):
    global _running
    if _running:
        return
    _running = True
    await asyncio.sleep(10)  # даём приложению подняться
    logger.info(f"[TEST-NUMBER] Expirer started (every {check_interval}s)")
    from backend.services.test_number_service import TestNumberService
    while _running:
        try:
            db = SessionLocal()
            try:
                released = TestNumberService.expire_due(db)
                if released:
                    logger.info(f"[TEST-NUMBER] Expirer released {released} lease(s)")
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[TEST-NUMBER] Expirer error: {e}")
        await asyncio.sleep(check_interval)


def stop_test_number_expirer():
    global _running
    _running = False
