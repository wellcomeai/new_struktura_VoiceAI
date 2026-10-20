"""
Фоновый цикл номеров физлиц (раз в check_interval секунд, по умолчанию час):
  * обновляет копии ключей/сценариев/правил аккаунта администратора в
    hosted-записях (после раскатки сценариев id могли поменяться);
  * продлевает номера, у которых закончился оплаченный месяц, приостанавливает
    неоплаченные и возвращает в запас просроченные (hosted_numbers.renew_due);
  * удаляет документы верификации, срок хранения которых истёк.

Вся работа с БД — в потоке (asyncio.to_thread).
"""

import asyncio

from backend.core.logging import get_logger
from backend.db.session import SessionLocal

logger = get_logger(__name__)

_running = False


def _run_once() -> dict:
    from backend.services import hosted_numbers
    from backend.services.telephony_verification_service import purge_due
    db = SessionLocal()
    try:
        synced = hosted_numbers.sync_all_hosted(db)
        stats = hosted_numbers.renew_due(db)
        purged = purge_due(db)
        return {"synced": synced, **stats, "purged": purged}
    finally:
        db.close()


async def start_hosted_numbers_loop(check_interval: int = 3600):
    global _running
    if _running:
        return
    _running = True
    await asyncio.sleep(30)  # даём приложению подняться
    try:
        from backend.services.verification_bot import ensure_webhook
        await ensure_webhook()
    except Exception as e:
        logger.warning(f"[HOSTED] verification bot webhook setup failed: {e}")
    logger.info(f"[HOSTED] Loop started (every {check_interval}s)")
    while _running:
        try:
            stats = await asyncio.to_thread(_run_once)
            if any(stats.get(k) for k in ("renewed", "suspended", "released", "purged")):
                logger.info(f"[HOSTED] {stats}")
        except Exception as e:
            logger.error(f"[HOSTED] loop error: {e}")
        await asyncio.sleep(check_interval)


def stop_hosted_numbers_loop():
    global _running
    _running = False
