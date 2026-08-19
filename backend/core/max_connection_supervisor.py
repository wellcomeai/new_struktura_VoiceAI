"""
MAX Connection Supervisor — держит постоянные ONLINE-соединения с MAX (вариант A).

Заменяет прежний поллинг (max_poller). MAX требует живую ONLINE-сессию для
отправки и отзывает токен при частых переподключениях, поэтому на каждый
подключённый аккаунт с включённым автоответом поднимается ОДНО постоянное
соединение PyMax (max_user_service.ensure_live_client): входящие приходят пушем
(on_message), исходящие идут через тот же клиент.

Роль supervisor:
- периодически сверять желаемое состояние (аккаунты connected + auto_reply) с
  фактически поднятыми клиентами; поднимать недостающие, гасить лишние,
  перезапускать умершие;
- single-owner через lease по БД (колонка last_poll_at как heartbeat): если
  процессов несколько (gunkicorn-воркеры), аккаунт держит ровно один. При одном
  процессе (uvicorn) — всегда он.

Сами соединения живут в event loop процесса (в памяти max_user_service), поэтому
тулза отправки и планировщик, работающие в том же процессе, шлют через них
напрямую.
"""

import asyncio
from datetime import datetime, timedelta

from sqlalchemy import or_

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.services import max_user_service as max_user

logger = get_logger(__name__)

# Lease «протухает», если owner не обновлял heartbeat дольше этого времени —
# тогда соединение может подхватить другой процесс. Больше интервала тика.
LEASE_TTL_SECONDS = 90

# Аккаунты, которые ДЕРЖИТ этот процесс (источник истины по владению, не зависит
# от того, жив ли прямо сейчас клиент в реестре: если клиент упал, а lease наш —
# ensure_live_client перезапустит его сразу, без ожидания протухания lease).
_owned_leases: set = set()


async def start_max_supervisor(check_interval: int = 30):
    """Запуск supervisor. No-op, если MAX_SESSION_KEY не задан или pymax недоступен."""
    if not max_user.is_configured():
        logger.info("[MAX-SUPERVISOR] MAX connector not configured, supervisor disabled")
        return

    logger.info(f"[MAX-SUPERVISOR] Started (reconcile every {check_interval}s)")
    while True:
        try:
            await _tick()
        except Exception as e:
            logger.error(f"[MAX-SUPERVISOR] tick error: {e}", exc_info=True)
        await asyncio.sleep(check_interval)


async def _tick():
    from backend.models.agent_max_account import AgentMaxAccount

    db = SessionLocal()
    try:
        accounts = db.query(AgentMaxAccount).filter(
            AgentMaxAccount.status == "connected",
            AgentMaxAccount.auto_reply_enabled == True,  # noqa: E712
        ).all()

        wanted = set()
        for acc in accounts:
            aid = str(acc.id)
            wanted.add(aid)
            already_ours = aid in _owned_leases
            # Держим/захватываем lease. Owner обновляет heartbeat безусловно;
            # чужой аккаунт берём, только если его lease протух.
            if _claim_or_renew(db, acc.id, already_ours):
                _owned_leases.add(aid)
                # idempotent: поднимет клиент, если он ещё не запущен или упал.
                max_user.ensure_live_client(aid, acc.phone or "")
            else:
                _owned_leases.discard(aid)  # аккаунт держит другой процесс

        # Отпускаем и гасим соединения аккаунтов, которые больше не нужны
        # (отключены, автоответ выключен, удалены).
        for aid in list(_owned_leases):
            if aid not in wanted:
                _owned_leases.discard(aid)
                max_user.stop_live_client(aid)
    finally:
        db.close()


def _claim_or_renew(db, account_id, i_own: bool) -> bool:
    """
    Owner (уже держит клиент) — обновляет heartbeat безусловно и остаётся owner.
    Иначе — пытается захватить аккаунт, только если lease протух (или пуст).
    Возвращает True, если этот процесс вправе держать соединение.
    """
    from backend.models.agent_max_account import AgentMaxAccount

    now = datetime.utcnow()
    if i_own:
        db.query(AgentMaxAccount).filter(
            AgentMaxAccount.id == account_id
        ).update({"last_poll_at": now}, synchronize_session=False)
        db.commit()
        return True

    cutoff = now - timedelta(seconds=LEASE_TTL_SECONDS)
    claimed = db.query(AgentMaxAccount).filter(
        AgentMaxAccount.id == account_id,
        or_(
            AgentMaxAccount.last_poll_at.is_(None),
            AgentMaxAccount.last_poll_at < cutoff,
        ),
    ).update({"last_poll_at": now}, synchronize_session=False)
    db.commit()
    return bool(claimed)
