"""
Subscription blocker — фоновая задача жёсткой блокировки истёкших подписок
тарифа `agent` (ТЗ раздел 7).

Запускается каждые 5 минут:
1. Находит юзеров с истёкшей подпиской agent и ставит agent_subscription_blocked=True.
2. Отменяет все их SCHEDULED agent-задачи (звонки).

Кредиты при этом НЕ сгорают — только блокируется возможность их тратить.
"""

import asyncio
from datetime import datetime, timezone

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan
from backend.models.task import Task, TaskStatus

logger = get_logger(__name__)

CHECK_INTERVAL_SEC = 5 * 60  # каждые 5 минут


async def check_expired_agent_subscriptions():
    """Один проход: блокировка истёкших agent-подписок и отмена их задач."""
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)

        expired_users = (
            db.query(User)
            .join(SubscriptionPlan, User.subscription_plan_id == SubscriptionPlan.id)
            .filter(
                SubscriptionPlan.code == "agent",
                User.subscription_end_date < now,
                User.agent_subscription_blocked == False,  # noqa: E712
                User.is_admin == False,  # noqa: E712
            )
            .all()
        )

        if not expired_users:
            return

        for user in expired_users:
            user.agent_subscription_blocked = True
            logger.warning(f"[BLOCKER] User {user.id} agent subscription expired, blocking")

            tasks_cancelled = (
                db.query(Task)
                .filter(
                    Task.user_id == user.id,
                    Task.is_agent_task == True,  # noqa: E712
                    Task.status == TaskStatus.SCHEDULED,
                )
                .update({"status": TaskStatus.CANCELLED}, synchronize_session=False)
            )
            logger.info(f"[BLOCKER] Cancelled {tasks_cancelled} scheduled tasks for user {user.id}")

        db.commit()
        logger.info(f"[BLOCKER] Blocked {len(expired_users)} expired agent subscription(s)")

    except Exception as e:
        db.rollback()
        logger.error(f"[BLOCKER] Error checking expired agent subscriptions: {e}", exc_info=True)
    finally:
        db.close()


async def start_subscription_blocker():
    """Фоновый раннер — запускает проверку каждые 5 минут."""
    logger.info("[BLOCKER] Starting agent subscription blocker (every 5 min)")
    # Небольшая задержка, чтобы дать приложению подняться
    await asyncio.sleep(60)
    while True:
        try:
            await check_expired_agent_subscriptions()
        except Exception as e:
            logger.error(f"[BLOCKER] Unhandled error: {e}", exc_info=True)
        await asyncio.sleep(CHECK_INTERVAL_SEC)
