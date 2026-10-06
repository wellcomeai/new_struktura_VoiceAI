"""
Task Scheduler для автоматического выполнения запланированных задач.
Проверяет каждые 30 секунд наличие задач, которые нужно выполнить.

✅ ВЕРСИЯ v4.0 - PARTNER INTEGRATION + LEGACY FALLBACK
✅ v4.0: Поддержка партнёрской интеграции Voximplant (VoximplantChildAccount)
✅ v4.0: Обратная совместимость со старой интеграцией (user.get_voximplant_config())
✅ v3.4: Восстановлена правильная логика user.get_voximplant_config()
✅ v3.3: Исправлено получение assistant_id (использует task.assistant_id)
✅ v3.2: Исправлена обработка response от Voximplant API
✅ v3.1: Добавлена передача custom_greeting (персонализированное приветствие)
✅ v3.0: Передача контекста задачи в Voximplant
"""

import asyncio
import json
import httpx
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, Tuple
from sqlalchemy import and_, exists, or_, text
from sqlalchemy.orm import aliased

from backend.core.logging import get_logger
from backend.db.session import SessionLocal, safe_rollback
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.cartesia_assistant import CartesiaAssistantConfig
from backend.models.yandex_assistant import YandexAssistantConfig
from backend.models.grok_assistant import GrokAssistantConfig
from backend.models.fish_assistant import FishAssistantConfig
from backend.models.voximplant_child import VoximplantChildAccount
from backend.models.agent_config import AgentConfig
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.services.voximplant_partner import get_voximplant_partner_service
from backend.services.agent_orchestrator import PreCallOrchestrator, PostCallOrchestrator
from backend.services.agent_reply_check import REPLY_CHECK_CHANNEL, client_reply_since
from backend.core.timezone_utils import (
    MSK, adjust_to_working_hours, defer_out_of_hours, in_working_hours,
)

logger = get_logger(__name__)

# Voximplant API endpoint (для LEGACY интеграции)
VOXIMPLANT_API_URL = "https://api.voximplant.com/platform_api/StartScenarios/"

# Timezone по умолчанию
DEFAULT_TIMEZONE = "Europe/Moscow"

# Порции и параллельность (см. check_and_execute_tasks).
AGENT_BATCH_SIZE = 20        # задач агента за один проход (раз в 30 с)
AGENT_CONCURRENCY = 5        # одновременно исполняемых задач агента
REGULAR_BATCH_SIZE = 20      # обычных задач CRM за проход

# Уборка зависшего после рестарта (см. _sweep_stuck).
SWEEP_INTERVAL_SECONDS = 300
STUCK_TASK_MINUTES = 15      # задача в PENDING дольше — процесс умер посреди неё
# Для звонков отсчёт — от начала звонка (started_at), поэтому запас на длинный
# разговор плюс его разбор: иначе живой разбор приняли бы за зависший.
STUCK_CALL_MINUTES = 90      # AgentCall в 'calling' дольше — поллер погиб
STUCK_FINALIZING_MINUTES = 90
REQUEUED_MARK = "requeued_after_restart"
# Уборщик трогает только свежее зависшее. Старее — история до появления уборщика:
# такие записи закрываются молча, без разбора и без повторного звонка — иначе
# агент начал бы действовать по звонкам недельной давности (перезвоны, сообщения).
SWEEP_MAX_AGE = timedelta(hours=6)
STALE_MARK = "stale_closed_by_sweeper"
# Резервных разборов за один проход уборщика — не больше, и строго по очереди:
# каждый держит соединение с БД, сотня параллельных выбрала пул целиком.
RESERVE_PER_SWEEP = 5
CLAIM_LOCK_KEY = 7240011     # pg_advisory_xact_lock для бронирования задач агента

# Владельцу о пустом кошельке — не чаще раза в час (в памяти процесса).
WALLET_NOTIFY_INTERVAL = timedelta(hours=1)
_wallet_notified_at: Dict[str, datetime] = {}

# Провайдеры со своим исходящим сценарием. Каскаду нужна цепочка
# vox-turn-taking + outbound_cascade, Fish — прокси синтеза (/ws/fish/tts/…);
# общий outbound_crm ни того, ни другого не умеет. OpenAI — outbound_openai
# (GPT-Live, контекст CRM из customData).
OUTBOUND_RULE_BY_TYPE = {
    "cascade": "outbound_cascade",
    "fish": "outbound_fish",
    "openai": "outbound_openai",
}
DEFAULT_OUTBOUND_RULE = "outbound_crm"
# Тип, у которого outbound_crm остаётся запасным, пока своё правило не
# заведено на дочернем аккаунте (раскатка /admin/setup-openai-scenarios-stream).
OUTBOUND_RULE_FALLBACK_TO_DEFAULT = {"openai"}


def _parse_utc(value) -> Optional[datetime]:
    """ISO-строка → aware UTC (naive считается UTC); мусор → None."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _outbound_rule_name(assistant_type: Optional[str]) -> str:
    """Имя правила Voximplant для исходящего звонка этим типом ассистента."""
    return OUTBOUND_RULE_BY_TYPE.get(assistant_type, DEFAULT_OUTBOUND_RULE)


def _resolve_outbound_rule(rule_ids: Optional[dict], assistant_type: Optional[str]) -> Tuple[str, Optional[str]]:
    """
    (имя правила, id) для исходящего звонка. Если своего правила у типа нет,
    а тип допускает запасной вариант, — общий outbound_crm.
    """
    rule_ids = rule_ids or {}
    name = _outbound_rule_name(assistant_type)
    rule_id = rule_ids.get(name)
    if not rule_id and assistant_type in OUTBOUND_RULE_FALLBACK_TO_DEFAULT and rule_ids.get(DEFAULT_OUTBOUND_RULE):
        logger.warning(f"[TASK-SCHEDULER] Rule '{name}' not found, falling back to '{DEFAULT_OUTBOUND_RULE}'")
        return DEFAULT_OUTBOUND_RULE, rule_ids.get(DEFAULT_OUTBOUND_RULE)
    return name, rule_id


class TaskScheduler:
    """
    Планировщик задач для автоматических звонков.
    
    ✅ v4.0: Поддержка двух типов интеграции:
        1. НОВАЯ: VoximplantChildAccount (партнёрская интеграция)
        2. LEGACY: user.get_voximplant_config() (старая интеграция)
    
    ✅ v3.4: Правильная логика user.get_voximplant_config()
    ✅ v3.3: Правильное получение assistant_id из task
    ✅ v3.2: Корректная обработка response
    ✅ v3.1: Поддержка custom_greeting
    ✅ v3.0: Передача контекста задачи
    """
    
    def __init__(self, check_interval: int = 30):
        """
        Args:
            check_interval: Интервал проверки в секундах (по умолчанию 30 сек)
        """
        self.check_interval = check_interval
        self.is_running = False
        self._agent_semaphore = asyncio.Semaphore(AGENT_CONCURRENCY)
        # Первая уборка — сразу после старта: это и есть момент после рестарта.
        self._last_sweep = datetime.min
        
    async def start(self):
        """Запуск планировщика"""
        if self.is_running:
            logger.warning("[TASK-SCHEDULER] Already running")
            return
            
        self.is_running = True
        logger.info(f"[TASK-SCHEDULER] Started (check every {self.check_interval}s)")
        logger.info(f"[TASK-SCHEDULER] ✅ v4.0: Partner + Legacy integration support")
        
        while self.is_running:
            try:
                await self.check_and_execute_tasks()
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Error: {e}", exc_info=True)
            
            # Ждём перед следующей проверкой
            await asyncio.sleep(self.check_interval)
    
    def stop(self):
        """Остановка планировщика"""
        self.is_running = False
        logger.info("[TASK-SCHEDULER] Stopped")
    
    async def check_and_execute_tasks(self):
        """
        Один проход планировщика (agent + regular).

        Задачи «бронируются» одним запросом (SELECT … FOR UPDATE SKIP LOCKED →
        status=PENDING): второй процесс (деплой, отдельный воркер) ту же задачу не
        увидит, звонок не задвоится. За проход — не больше AGENT_BATCH_SIZE задач,
        исполняются параллельно, но не больше AGENT_CONCURRENCY одновременно, каждая
        в своей сессии БД. Остальные ждут следующего прохода — нагрузка ровная,
        без лавины звонков с одного номера. Запросы бронирования и уборки —
        в потоке (asyncio.to_thread), чтобы не держать event loop.
        """
        now = datetime.utcnow()

        if (now - self._last_sweep).total_seconds() >= SWEEP_INTERVAL_SECONDS:
            self._last_sweep = now
            try:
                reserve_calls = await asyncio.to_thread(self._sweep_stuck, now)
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Sweep error: {e}", exc_info=True)
                reserve_calls = []
            if reserve_calls:
                # Резервный поллер звонка погиб с процессом — разбираем по одному.
                asyncio.create_task(self._run_reserve_postcalls(reserve_calls))

        try:
            agent_ids = await asyncio.to_thread(self._claim_due_agent_tasks, now)
            regular_ids = await asyncio.to_thread(self._claim_due_regular_tasks, now)
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error claiming due tasks: {e}", exc_info=True)
            return

        if not agent_ids and not regular_ids:
            logger.debug(f"[TASK-SCHEDULER] No pending tasks at {now}")
            return

        logger.info(
            f"[TASK-SCHEDULER] Claimed {len(agent_ids) + len(regular_ids)} tasks "
            f"({len(agent_ids)} agent, {len(regular_ids)} regular)"
        )

        if agent_ids:
            await asyncio.gather(
                *(self._run_claimed_agent_task(tid) for tid in agent_ids),
                return_exceptions=True,
            )

        for tid in regular_ids:
            db = SessionLocal()
            try:
                task = db.query(Task).filter(Task.id == tid).first()
                if task is not None:
                    await self.execute_task(task, db)
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Error in regular task {tid}: {e}", exc_info=True)
            finally:
                db.close()

    @staticmethod
    async def _run_reserve_postcalls(reserve_calls: list) -> None:
        """Резервные разборы зависших звонков — последовательно, чтобы не выбрать пул БД."""
        for call_id, config_id, openai_key in reserve_calls:
            try:
                await PostCallOrchestrator.poll_and_run(
                    agent_call_id=call_id, agent_config_id=config_id,
                    user_openai_key=openai_key, retries=1, delay=1,
                )
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Reserve PostCall {call_id} failed: {e}", exc_info=True)

    async def _run_claimed_agent_task(self, task_id):
        """Исполнить забронированную задачу агента в своей сессии, под семафором."""
        async with self._agent_semaphore:
            db = SessionLocal()
            try:
                task = db.query(Task).filter(Task.id == task_id).first()
                if task is None or task.status != TaskStatus.PENDING:
                    return
                await self.execute_agent_task(task, db)
            except Exception as e:
                logger.error(f"[TASK-SCHEDULER] Error running agent task {task_id}: {e}", exc_info=True)
            finally:
                db.close()

    @staticmethod
    def _claim_due_agent_tasks(now: datetime) -> list:
        """
        Забронировать до AGENT_BATCH_SIZE наступивших задач агента (синхронно, в потоке).

        Пропускаются: задачи выключенных агентов (ждут включения), контакты, по
        которым прямо сейчас идёт звонок, разбор или другая задача (не звоним
        человеку дважды параллельно). Не больше одной задачи на контакт за проход.
        """
        sdb = SessionLocal()
        try:
            # Бронирование целиком — под транзакционной advisory-блокировкой: иначе
            # два процесса, пропуская строки друг друга (SKIP LOCKED), взяли бы две
            # РАЗНЫЕ задачи одного контакта и позвонили бы ему одновременно.
            sdb.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": CLAIM_LOCK_KEY})
            busy_contact = exists().where(and_(
                AgentCall.agent_contact_id == Task.agent_contact_id,
                AgentCall.status.in_(("calling", "finalizing")),
            ))
            other_task = aliased(Task)
            contact_in_work = exists().where(and_(
                other_task.agent_contact_id == Task.agent_contact_id,
                other_task.status == TaskStatus.PENDING,
            ))
            inactive_agent = exists().where(and_(
                AgentContact.id == Task.agent_contact_id,
                AgentConfig.id == AgentContact.agent_config_id,
                AgentConfig.is_active == False,  # noqa: E712
            ))
            rows = sdb.query(Task.id, Task.agent_contact_id).filter(
                Task.status == TaskStatus.SCHEDULED,
                Task.scheduled_time <= now,
                Task.is_agent_task == True,  # noqa: E712
                ~inactive_agent,
                ~busy_contact,
                ~contact_in_work,
            ).order_by(Task.scheduled_time.asc()).limit(AGENT_BATCH_SIZE * 3).with_for_update(
                skip_locked=True, of=Task
            ).all()

            picked, seen_contacts = [], set()
            for task_id, contact_id in rows:
                if contact_id in seen_contacts:
                    continue
                seen_contacts.add(contact_id)
                picked.append(task_id)
                if len(picked) >= AGENT_BATCH_SIZE:
                    break

            if picked:
                sdb.query(Task).filter(Task.id.in_(picked)).update(
                    {"status": TaskStatus.PENDING, "call_started_at": now},
                    synchronize_session=False,
                )
            sdb.commit()
            return picked
        except Exception:
            safe_rollback(sdb)
            raise
        finally:
            sdb.close()

    @staticmethod
    def _claim_due_regular_tasks(now: datetime) -> list:
        """Забронировать до REGULAR_BATCH_SIZE наступивших обычных задач CRM."""
        sdb = SessionLocal()
        try:
            ids = [r[0] for r in sdb.query(Task.id).filter(
                Task.status == TaskStatus.SCHEDULED,
                Task.scheduled_time <= now,
                Task.is_agent_task != True,  # noqa: E712
            ).order_by(Task.scheduled_time.asc()).limit(REGULAR_BATCH_SIZE).with_for_update(
                skip_locked=True, of=Task
            ).all()]
            if ids:
                sdb.query(Task).filter(Task.id.in_(ids)).update(
                    {"status": TaskStatus.PENDING}, synchronize_session=False,
                )
            sdb.commit()
            return ids
        except Exception:
            safe_rollback(sdb)
            raise
        finally:
            sdb.close()

    @staticmethod
    def _sweep_stuck(now: datetime) -> list:
        """
        Уборка зависшего после рестарта процесса (синхронно, в потоке).

        - Задача агента в PENDING дольше STUCK_TASK_MINUTES: процесс умер между
          бронированием и итогом. Звонок, который не успели набрать (нет id сессии
          Voximplant), возвращается в очередь один раз; сообщения и проверки ответа
          — FAILED (сообщение могло уже уйти, повтор задвоил бы его).
        - AgentCall в 'calling' дольше STUCK_CALL_MINUTES: если звонок был набран —
          отдаём его резервному разбору (возвращается списком, запускает вызывающий);
          иначе — 'failed'.
        - AgentCall в 'finalizing' дольше STUCK_FINALIZING_MINUTES: разбор умер с
          процессом — возвращаем в 'calling' и тоже отдаём резервному разбору.
        - Всё, что старше SWEEP_MAX_AGE, — история: закрывается FAILED / 'failed'
          без разбора и без повторного звонка. Резервных разборов за проход — не
          больше RESERVE_PER_SWEEP, вызывающий гоняет их последовательно.

        Возвращает [(agent_call_id, agent_config_id, user_openai_key)] для разбора.
        """
        sdb = SessionLocal()
        reserve = []
        try:
            fresh_from = now - SWEEP_MAX_AGE

            # 1. Задачи агента, зависшие в PENDING.
            task_cutoff = now - timedelta(minutes=STUCK_TASK_MINUTES)
            stuck_tasks = sdb.query(Task).filter(
                Task.status == TaskStatus.PENDING,
                Task.is_agent_task == True,  # noqa: E712
                Task.call_started_at < task_cutoff,
            ).limit(500).all()
            requeued = failed = 0
            for task in stuck_tasks:
                agent_call = sdb.query(AgentCall).filter(AgentCall.id == task.agent_call_id).first() \
                    if task.agent_call_id else None
                is_call = (task.channel or "call") == "call"
                dialed = bool(agent_call and agent_call.call_session_id)
                started = task.call_started_at.replace(tzinfo=None) if task.call_started_at else None
                is_fresh = started is not None and started >= fresh_from
                if is_call and not dialed and is_fresh and task.call_result != REQUEUED_MARK:
                    task.status = TaskStatus.SCHEDULED
                    task.scheduled_time = now
                    task.call_result = REQUEUED_MARK
                    task.agent_call_id = None
                    requeued += 1
                else:
                    task.status = TaskStatus.FAILED
                    task.call_result = json.dumps(
                        {"error": "interrupted_by_restart" if is_fresh else STALE_MARK}
                    )
                    task.call_completed_at = now
                    failed += 1
                if agent_call is not None and agent_call.status == "calling" and not dialed:
                    agent_call.status = "failed"
                    agent_call.completed_at = now
            if stuck_tasks:
                logger.warning(
                    f"[TASK-SCHEDULER] 🧹 Stuck PENDING agent tasks: {requeued} requeued, {failed} failed"
                )

            # 2. Звонки, зависшие в calling / finalizing.
            fin_cutoff = now - timedelta(minutes=STUCK_FINALIZING_MINUTES)
            call_cutoff = now - timedelta(minutes=STUCK_CALL_MINUTES)
            stuck_calls = sdb.query(AgentCall).filter(
                or_(
                    and_(AgentCall.status == "calling", AgentCall.started_at < call_cutoff),
                    and_(AgentCall.status == "finalizing", AgentCall.started_at < fin_cutoff),
                ),
            ).order_by(AgentCall.started_at.desc()).limit(500).all()
            stale = 0
            for call in stuck_calls:
                is_fresh = call.started_at is not None and call.started_at >= fresh_from
                if not is_fresh or len(reserve) >= RESERVE_PER_SWEEP:
                    if not is_fresh:
                        # История: закрываем без разбора, агент по ней не действует.
                        call.status = "failed"
                        call.completed_at = now
                        call.call_result = STALE_MARK
                        stale += 1
                    continue  # свежие сверх лимита — в следующий проход
                agent_config = sdb.query(AgentConfig).filter(AgentConfig.id == call.agent_config_id).first() \
                    if call.agent_config_id else None
                user = sdb.query(User).filter(User.id == call.user_id).first()
                can_orchestrate = agent_config is not None and (
                    agent_config.uses_hardcoded_prompt or (user and user.openai_api_key)
                )
                # Резервный разбор умеет только исходящий звонок (ищет транскрипт по
                # номеру). Входящие сообщения/звонки, рассылки и проверки ответа он
                # разобрал бы как звонок — такие закрываем без разбора.
                is_outbound_call = bool(call.call_session_id) and (call.direction or "outbound") == "outbound"
                if is_outbound_call and can_orchestrate:
                    call.status = "calling"  # poll_and_run забирает только 'calling'
                    reserve.append((str(call.id), str(agent_config.id), (user.openai_api_key or "") if user else ""))
                else:
                    call.status = "failed"
                    call.completed_at = now
            if stuck_calls:
                logger.warning(
                    f"[TASK-SCHEDULER] 🧹 Stuck agent calls: {len(stuck_calls)} found, {stale} stale closed "
                    f"without analysis, {len(reserve)} to reserve PostCall"
                )
            sdb.commit()
            return reserve
        except Exception:
            safe_rollback(sdb)
            raise
        finally:
            sdb.close()

    def _agent_task_may_run_now(self, task: Task, agent_contact, agent_config, db: Session) -> bool:
        """
        Проверки момента исполнения (любой канал: звонок, сообщение, проверка ответа).
        Возвращает False, если задачу сейчас выполнять нельзя — тогда она уже
        отменена или возвращена в очередь на новое время.

        - «Не звонить» → CANCELLED (стадию могли поставить после постановки задачи);
        - пауза контакта (memory.snooze_until) → переносим на конец паузы;
        - нерабочие часы агента (МСК) → переносим на утро со сдвигом на длину ночи,
          чтобы ночная очередь утром ушла с прежним интервалом, а не пачкой.
        """
        now = datetime.now(timezone.utc)

        if (agent_contact.status or "") == "do_not_call":
            task.status = TaskStatus.CANCELLED
            task.call_result = json.dumps({"skipped": "do_not_call"})
            task.call_completed_at = datetime.utcnow()
            db.commit()
            logger.info(f"[TASK-SCHEDULER] 🚫 Agent task {task.id} cancelled: contact is do_not_call")
            return False

        memory = agent_contact.memory if isinstance(agent_contact.memory, dict) else {}
        snooze_until = _parse_utc(memory.get("snooze_until"))
        if snooze_until and snooze_until > now:
            new_time, _ = adjust_to_working_hours(
                snooze_until, agent_config.working_hours_start, agent_config.working_hours_end
            )
            self._requeue(task, new_time, db)
            logger.info(f"[TASK-SCHEDULER] 💤 Agent task {task.id} moved to {new_time}: contact snoozed")
            return False

        wh_start, wh_end = agent_config.working_hours_start, agent_config.working_hours_end
        if not in_working_hours(now.astimezone(MSK).hour, wh_start, wh_end):
            scheduled = task.scheduled_time or now
            new_time = defer_out_of_hours(scheduled, now, wh_start, wh_end)
            self._requeue(task, new_time, db)
            logger.info(
                f"[TASK-SCHEDULER] 🌙 Agent task {task.id} ({task.channel or 'call'}) moved to {new_time}: "
                f"outside working hours {wh_start}-{wh_end} MSK"
            )
            return False

        return True

    @staticmethod
    def _requeue(task: Task, new_time: datetime, db: Session) -> None:
        task.status = TaskStatus.SCHEDULED
        task.scheduled_time = new_time
        task.call_started_at = None
        db.commit()

    @staticmethod
    def _wallet_allows_call(user, assistant_type: str, db: Session) -> bool:
        """Тот же шлагбаум, что в /api/telephony/outbound-config (не меньше 3 минут на балансе)."""
        try:
            from backend.api.telephony import resolve_scenario_keys, LIVE_TARIFF_CODE
            _keys, allowed, _mode = resolve_scenario_keys(
                db, user, assistant_type, "[TASK-SCHEDULER]",
                tariff_code=LIVE_TARIFF_CODE if assistant_type == "openai" else None,
            )
            return bool(allowed)
        except Exception as e:
            # Проверка не должна ронять звонок: шлагбаум сценария всё равно сработает.
            logger.warning(f"[TASK-SCHEDULER] Wallet precheck failed (allowing call): {e}")
            safe_rollback(db)
            return True

    @staticmethod
    async def _notify_wallet_empty(user, agent_config, agent_contact, db: Session) -> None:
        """Одно уведомление владельцу в час: звонки агента стоят из-за баланса."""
        key = str(user.id)
        now = datetime.utcnow()
        last = _wallet_notified_at.get(key)
        if last and now - last < WALLET_NOTIFY_INTERVAL:
            return
        _wallet_notified_at[key] = now
        try:
            from backend.services.agent_tools import fn_send_telegram_notification
            await fn_send_telegram_notification(
                {"message": (
                    "💳 Звонки агента остановлены: на кошельке недостаточно средств. "
                    f"Отменён звонок контакту {agent_contact.name or agent_contact.phone}. "
                    "Пополните баланс — новые звонки пойдут сразу; отменённые нужно поставить заново."
                )},
                agent_config, db,
            )
        except Exception as e:
            logger.warning(f"[TASK-SCHEDULER] Wallet notify failed: {e}")
            safe_rollback(db)

    def _get_assistant_info(self, task: Task, db: Session) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """
        Получить информацию об ассистенте из задачи.
        
        Returns:
            Tuple[assistant_id, assistant_name, assistant_type]
        """
        assistant_id = None
        assistant_name = "Unknown"
        assistant_type = None
        
        if task.assistant_id:
            # OpenAI Assistant
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == task.assistant_id
            ).first()
            if assistant:
                assistant_id = str(task.assistant_id)
                assistant_name = assistant.name
                assistant_type = "openai"
                logger.info(f"   Assistant: {assistant.name} (OpenAI)")
        elif task.gemini_assistant_id:
            # Gemini Assistant
            gemini_assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == task.gemini_assistant_id
            ).first()
            if gemini_assistant:
                assistant_id = str(task.gemini_assistant_id)
                assistant_name = gemini_assistant.name
                assistant_type = "gemini"
                logger.info(f"   Assistant: {gemini_assistant.name} (Gemini)")
        elif task.cartesia_assistant_id:
            # Cartesia Assistant
            cartesia_assistant = db.query(CartesiaAssistantConfig).filter(
                CartesiaAssistantConfig.id == task.cartesia_assistant_id
            ).first()
            if cartesia_assistant:
                assistant_id = str(task.cartesia_assistant_id)
                assistant_name = cartesia_assistant.name
                assistant_type = "cartesia"
                logger.info(f"   Assistant: {cartesia_assistant.name} (Cartesia)")
        elif task.yandex_assistant_id:
            # Yandex Assistant
            yandex_assistant = db.query(YandexAssistantConfig).filter(
                YandexAssistantConfig.id == task.yandex_assistant_id
            ).first()
            if yandex_assistant:
                assistant_id = str(task.yandex_assistant_id)
                assistant_name = yandex_assistant.name
                assistant_type = "yandex"
                logger.info(f"   Assistant: {yandex_assistant.name} (Yandex)")
        elif task.cascade_assistant_id:
            # Cascade Assistant (grok_assistant_configs, assistant_type='cascade')
            cascade_assistant = db.query(GrokAssistantConfig).filter(
                GrokAssistantConfig.id == task.cascade_assistant_id
            ).first()
            if cascade_assistant:
                assistant_id = str(task.cascade_assistant_id)
                assistant_name = cascade_assistant.name
                assistant_type = "cascade"
                logger.info(f"   Assistant: {cascade_assistant.name} (Cascade)")
        elif task.fish_assistant_id:
            # Fish Assistant (OpenAI Realtime в сценарии + озвучка Fish Audio)
            fish_assistant = db.query(FishAssistantConfig).filter(
                FishAssistantConfig.id == task.fish_assistant_id
            ).first()
            if fish_assistant:
                assistant_id = str(task.fish_assistant_id)
                assistant_name = fish_assistant.name
                assistant_type = "fish"
                logger.info(f"   Assistant: {fish_assistant.name} (Fish)")

        return assistant_id, assistant_name, assistant_type
    
    async def execute_agent_task(self, task: Task, db: Session):
        """
        Execute an agent task: create AgentCall, run PreCall with AgentContact,
        then initiate the call and launch PostCall.
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 🤖 Executing AGENT task {task.id}: {task.title}")

            # Get AgentContact first — оно определяет, какому агенту принадлежит звонок.
            agent_contact = None
            if task.agent_contact_id:
                agent_contact = db.query(AgentContact).filter(
                    AgentContact.id == task.agent_contact_id
                ).first()

            if not agent_contact:
                logger.error(f"[TASK-SCHEDULER] AgentContact not found for agent task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "AgentContact not found"
                db.commit()
                return

            # ✅ v3.1: резолвим КОНКРЕТНОГО агента по контакту (multi-agent).
            #   Fallback на первого агента юзера — для legacy-контактов без
            #   agent_config_id.
            agent_config = None
            if agent_contact.agent_config_id:
                agent_config = db.query(AgentConfig).filter(
                    AgentConfig.id == agent_contact.agent_config_id,
                    AgentConfig.user_id == task.user_id,
                ).first()
            if not agent_config:
                agent_config = db.query(AgentConfig).filter(
                    AgentConfig.user_id == task.user_id,
                ).order_by(AgentConfig.created_at.asc()).first()

            # Skip if the agent is missing or inactive (toggle off).
            # Задача уже забронирована (PENDING) — возвращаем в очередь, она
            # выполнится, когда агента включат.
            if not agent_config or not agent_config.is_active:
                logger.info(f"[TASK-SCHEDULER] Skipping agent task {task.id}: agent missing or inactive")
                task.status = TaskStatus.SCHEDULED
                db.commit()
                return

            if not self._agent_task_may_run_now(task, agent_contact, agent_config, db):
                return

            # Get user
            user = db.query(User).filter(User.id == task.user_id).first()
            if not user:
                logger.error(f"[TASK-SCHEDULER] User not found for agent task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "User not found"
                db.commit()
                return

            # ✅ Блокировка звонков при отсутствии доступа к агенту (триал истёк и
            #   тариф не profi). Дублирует scheduler-блокер.
            if not user.has_active_agent_subscription():
                task.status = TaskStatus.CANCELLED
                task.call_result = json.dumps({"error": "subscription_expired"})
                db.commit()
                logger.warning(f"[TASK-SCHEDULER] Skipping agent task {task.id} — no agent access")
                return

            # 🆕 Telegram-задача: вместо звонка — отложенное сообщение с личного
            # Telegram-аккаунта (текст составит оркестратор в момент отправки).
            if (task.channel or "call") in ("telegram", "max"):
                await self.execute_agent_messenger_task(task.channel, task, agent_contact, agent_config, user, db)
                return

            # Проверка ответа клиента (schedule_reply_check): не звонок.
            if (task.channel or "call") == REPLY_CHECK_CHANNEL:
                await self.execute_agent_reply_check(task, agent_contact, agent_config, user, db)
                return

            # Get assistant info
            assistant_id, assistant_name, assistant_type = self._get_assistant_info(task, db)
            if not assistant_id or not assistant_type:
                logger.error(f"[TASK-SCHEDULER] No valid assistant for agent task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Assistant not found"
                db.commit()
                return

            # Кошелёк — до PreCall и набора: без денег сценарий всё равно не стартует,
            # а PreCall/PostCall «недозвона» тратили бы модель и ставили новый звонок.
            if not self._wallet_allows_call(user, assistant_type, db):
                task.status = TaskStatus.CANCELLED
                task.call_result = json.dumps({"error": "wallet_empty"})
                task.call_completed_at = datetime.utcnow()
                db.commit()
                logger.warning(f"[TASK-SCHEDULER] 💳 Agent task {task.id} cancelled: wallet empty")
                await self._notify_wallet_empty(user, agent_config, agent_contact, db)
                return

            # Create AgentCall record
            agent_call = AgentCall(
                agent_contact_id=agent_contact.id,
                agent_config_id=agent_config.id if agent_config else None,
                user_id=user.id,
                source_task_id=task.id,
                status="calling",
                scheduled_at=task.scheduled_time,
                started_at=datetime.utcnow(),
            )
            db.add(agent_call)
            db.flush()

            # Link task to agent_call
            task.agent_call_id = agent_call.id

            # Контакт остаётся в своей стадии воронки во время звонка. Факт
            # «идёт звонок» фиксируется в AgentCall.status / Task.status, а
            # стадию контакта меняет только PostCall по итогу — и только если
            # для этого есть основание (см. stage_from_decision).
            db.commit()

            # PreCall with AgentContact.
            # v3 agents use OpenRouter (system key) → run regardless of user's OpenAI key.
            # v2 (legacy) agents require the user's OpenAI key.
            can_orchestrate = agent_config and (
                agent_config.uses_hardcoded_prompt or user.openai_api_key
            )
            if can_orchestrate:
                try:
                    pre_call = PreCallOrchestrator()
                    pre_result = await pre_call.run(task, agent_contact, agent_call, agent_config, user, db)
                    logger.info(f"[TASK-SCHEDULER] ✅ Agent PreCall completed: {pre_result.get('call_strategy', '')[:80]}")
                except Exception as e:
                    logger.error(f"[TASK-SCHEDULER] ⚠️ Agent PreCall failed (continuing): {e}")

            # Determine which integration to use for the call
            # Use agent_contact.phone as the number to call
            phone_number = agent_contact.phone
            contact_name = agent_contact.name or ""

            child_account: Optional[VoximplantChildAccount] = None
            if hasattr(user, 'voximplant_child_account') and user.voximplant_child_account:
                child_account = user.voximplant_child_account

            call_session_id = None
            call_success = False

            if child_account and child_account.can_make_outbound_calls:
                call_session_id, call_success = await self._agent_call_via_partner(
                    task, agent_contact, child_account, assistant_id, assistant_name, assistant_type, db
                )
            elif user.has_voximplant_config():
                call_session_id, call_success = await self._agent_call_via_legacy(
                    task, agent_contact, user, assistant_id, assistant_name, assistant_type, db
                )
            else:
                logger.error(f"[TASK-SCHEDULER] ❌ No Voximplant config for agent task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "No Voximplant configuration found."
                agent_call.status = "failed"
                db.commit()
                return

            if call_success and call_session_id:
                agent_call.call_session_id = str(call_session_id)
                task.call_session_id = str(call_session_id)
                task.status = TaskStatus.COMPLETED
                task.call_completed_at = datetime.utcnow()
                task.call_result = f"Agent call initiated. Session: {call_session_id}"
                db.commit()

                # Launch PostCall with agent_call_id (v3 → OpenRouter, v2 → user OpenAI key)
                if can_orchestrate:
                    asyncio.create_task(
                        PostCallOrchestrator.poll_and_run(
                            agent_call_id=str(agent_call.id),
                            agent_config_id=str(agent_config.id),
                            user_openai_key=user.openai_api_key or "",
                        )
                    )
                    logger.info(f"[TASK-SCHEDULER] 🤖 Agent PostCall started for call {agent_call.id}")
            else:
                task.status = TaskStatus.FAILED
                task.call_result = task.call_result or "Call failed"
                agent_call.status = "failed"
                db.commit()

        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error in agent task {task.id}: {e}", exc_info=True)
            safe_rollback(db)  # иначе при ошибке SQL пометка FAILED ниже тоже упадёт
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                db.commit()
            except Exception:
                pass

    async def execute_agent_reply_check(self, task: Task, agent_contact, agent_config, user, db: Session):
        """
        Исполнить проверку ответа (channel="reply_check").

        Сначала без LLM смотрим, выходил ли клиент на связь после постановки
        задачи (client_reply_since). Ответил → задача COMPLETED (REPLIED),
        оркестратор не запускаем: на сам ответ агент уже среагировал входящим
        прогоном. Молчит → AgentCall + один прогон оркестратора
        (PostCallOrchestrator.run_for_reply_check), дальше агент решает сам.

        Вызывается из execute_agent_task ПОСЛЕ общих проверок; задача уже PENDING.
        """
        agent_call = None
        try:
            reply = client_reply_since(db, agent_contact, task.created_at)
            if reply:
                task.status = TaskStatus.COMPLETED
                task.post_call_decision = "REPLIED"
                task.call_result = json.dumps({"replied": True, **reply}, ensure_ascii=False)
                task.call_completed_at = datetime.utcnow()
                db.commit()
                logger.info(
                    f"[TASK-SCHEDULER] 🔎 Reply check {task.id}: client replied via {reply['channel']}, nothing to do"
                )
                return

            # Прогон реализован только для v3-агентов (OpenRouter): тулза
            # schedule_reply_check домешивается только им.
            if not getattr(agent_config, "uses_hardcoded_prompt", False):
                task.status = TaskStatus.FAILED
                task.call_result = json.dumps({"error": "reply_check_requires_v3_agent"}, ensure_ascii=False)
                task.call_completed_at = datetime.utcnow()
                db.commit()
                logger.warning(f"[TASK-SCHEDULER] 🔎 Reply check {task.id} failed: agent is not v3")
                return

            # Запись в истории агента; канал события — postcall_log.call_direction="reply_check".
            agent_call = AgentCall(
                agent_contact_id=agent_contact.id,
                agent_config_id=agent_config.id,
                user_id=user.id,
                source_task_id=task.id,
                status="calling",
                direction="outbound",
                scheduled_at=task.scheduled_time,
                started_at=datetime.utcnow(),
            )
            db.add(agent_call)
            db.flush()
            task.agent_call_id = agent_call.id
            db.commit()

            await PostCallOrchestrator().run_for_reply_check(
                agent_call, agent_contact, agent_config, user, task, db
            )
            task.call_completed_at = datetime.utcnow()
            db.commit()
            logger.info(f"[TASK-SCHEDULER] 🔎 Reply check {task.id}: client silent, agent run completed")

        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error in reply check {task.id}: {e}", exc_info=True)
            safe_rollback(db)
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                if agent_call is not None and agent_call.status == "calling":
                    agent_call.status = "failed"
                    agent_call.completed_at = datetime.utcnow()
                db.commit()
            except Exception:
                pass

    async def execute_agent_messenger_task(self, channel: str, task: Task, agent_contact, agent_config, user, db: Session):
        """
        Исполнить агентскую задачу с channel="telegram"|"max": один прогон
        оркестратора, который по памяти контакта, хронологии и инструкции из
        task.description составляет сообщение и отправляет его с личного аккаунта
        владельца в нужном мессенджере (PostCallOrchestrator.run_for_scheduled_*).
        Звонилка не участвует.

        Вызывается из execute_agent_task ПОСЛЕ общих проверок (контакт найден,
        агент активен, подписка активна); задача уже залочена (PENDING).
        """
        from backend.services import telegram_user_service, max_user_service
        from backend.services.agent_tools import fn_send_telegram_notification

        is_max = (channel == "max")
        svc = max_user_service if is_max else telegram_user_service
        label = "MAX" if is_max else "Telegram"

        agent_call = None
        try:
            # Личный аккаунт мессенджера мог отвалиться между постановкой и
            # исполнением. Не роняем молча: FAILED + уведомление владельцу.
            account_ok = (
                svc.is_configured()
                and svc.account_connected(db, agent_config.id)
            )
            # Прогон реализован только для v3-агентов (OpenRouter): тулы
            # schedule_*_message домешиваются только им.
            if not getattr(agent_config, "uses_hardcoded_prompt", False):
                account_ok = False

            if not account_ok:
                task.status = TaskStatus.FAILED
                task.call_result = json.dumps(
                    {"error": f"{channel}_account_unavailable"}, ensure_ascii=False
                )
                task.call_completed_at = datetime.utcnow()
                db.commit()
                logger.warning(
                    f"[TASK-SCHEDULER] ✉️ {label} task {task.id} failed: personal {label} account unavailable"
                )
                try:
                    await fn_send_telegram_notification(
                        {
                            "message": (
                                f"⚠️ Не смог отправить запланированное сообщение в {label} "
                                f"контакту {agent_contact.name or agent_contact.phone}: "
                                f"личный {label}-аккаунт не подключён. "
                                f"Задача: «{task.title}». Подключите аккаунт и создайте задачу заново."
                            )
                        },
                        agent_config, db,
                    )
                except Exception as ne:
                    logger.warning(f"[TASK-SCHEDULER] Owner notify failed: {ne}")
                return

            # Запись в истории агента (лента/модалка на agent.html); канал события
            # определится по postcall_log.call_direction="telegram_outbound"/"max_outbound".
            agent_call = AgentCall(
                agent_contact_id=agent_contact.id,
                agent_config_id=agent_config.id,
                user_id=user.id,
                source_task_id=task.id,
                status="calling",
                direction="outbound",
                scheduled_at=task.scheduled_time,
                started_at=datetime.utcnow(),
            )
            db.add(agent_call)
            db.flush()
            task.agent_call_id = agent_call.id
            db.commit()

            orchestrator = PostCallOrchestrator()
            if is_max:
                await orchestrator.run_for_scheduled_max(
                    agent_call, agent_contact, agent_config, user, task, db
                )
            else:
                await orchestrator.run_for_scheduled_telegram(
                    agent_call, agent_contact, agent_config, user, task, db
                )
            # Статусы task/agent_call проставил прогон (_analyze_v3_openrouter);
            # фиксируем время завершения задачи.
            task.call_completed_at = datetime.utcnow()
            db.commit()
            logger.info(f"[TASK-SCHEDULER] ✉️ {label} task {task.id} completed")

        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error in {label} messenger task {task.id}: {e}", exc_info=True)
            safe_rollback(db)  # иначе при ошибке SQL пометка FAILED ниже тоже упадёт
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                # Не оставляем событие вечно в 'calling' — иначе оно навсегда
                # скроется из истории (список показывает только финализированные).
                if agent_call is not None and agent_call.status == "calling":
                    agent_call.status = "failed"
                    agent_call.completed_at = datetime.utcnow()
                db.commit()
            except Exception:
                pass

    async def _agent_call_via_partner(
        self, task, agent_contact, child_account, assistant_id, assistant_name, assistant_type, db
    ) -> Tuple[Optional[str], bool]:
        """Initiate agent call via partner API. Returns (session_id, success)."""
        try:
            outbound_rule_name, rule_id = _resolve_outbound_rule(child_account.vox_rule_ids, assistant_type)
            if not rule_id:
                task.call_result = f"Outbound rule '{outbound_rule_name}' not configured"
                return None, False

            caller_id = None

            # 1. Task-level caller_id
            if task.caller_id:
                if child_account.phone_numbers:
                    for phone in child_account.phone_numbers:
                        if phone.phone_number == task.caller_id and phone.is_active:
                            caller_id = task.caller_id
                            break

            # 2. AgentConfig.default_caller_id
            if not caller_id and agent_contact:
                agent_cfg = db.query(AgentConfig).filter(
                    AgentConfig.id == agent_contact.agent_config_id
                ).first()
                if agent_cfg and agent_cfg.default_caller_id:
                    if child_account.phone_numbers:
                        for phone in child_account.phone_numbers:
                            if phone.phone_number == agent_cfg.default_caller_id and phone.is_active:
                                caller_id = agent_cfg.default_caller_id
                                logger.info(f"   📞 Using agent default_caller_id: {caller_id}")
                                break

            # 3. First active number (fallback)
            if not caller_id and child_account.phone_numbers:
                for phone in child_account.phone_numbers:
                    if phone.is_active:
                        caller_id = phone.phone_number
                        break
            if not caller_id:
                task.call_result = "No active phone numbers"
                return None, False

            service = get_voximplant_partner_service()
            result = await service.start_outbound_call(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key,
                rule_id=int(rule_id),
                phone_number=agent_contact.phone,
                assistant_id=assistant_id,
                caller_id=caller_id,
                contact_name=agent_contact.name or "",
                task_title=task.title or "",
                task_description=task.description or "",
                custom_greeting=task.custom_greeting or "",
                timezone=DEFAULT_TIMEZONE,
                assistant_type=assistant_type,
            )

            if result.get("success"):
                return result.get("call_session_history_id"), True
            else:
                task.call_result = f"Partner API error: {result.get('error', 'Unknown')}"
                return None, False
        except Exception as e:
            task.call_result = f"Partner API exception: {str(e)}"
            return None, False

    async def _agent_call_via_legacy(
        self, task, agent_contact, user, assistant_id, assistant_name, assistant_type, db
    ) -> Tuple[Optional[str], bool]:
        """Initiate agent call via legacy API. Returns (session_id, success)."""
        try:
            voximplant_config = user.get_voximplant_config()
            if not voximplant_config:
                task.call_result = "No Voximplant settings"
                return None, False

            final_assistant_id = assistant_id
            if assistant_type == "gemini":
                final_assistant_id = f"gemini_{assistant_id}"

            script_custom_data = json.dumps({
                "phone_number": agent_contact.phone,
                "assistant_id": final_assistant_id,
                "caller_id": voximplant_config["caller_id"],
                "task_title": task.title or "",
                "task_description": task.description or "",
                "contact_name": agent_contact.name or "",
                "custom_greeting": task.custom_greeting or "",
                "timezone": DEFAULT_TIMEZONE,
            }, ensure_ascii=False)

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    VOXIMPLANT_API_URL,
                    data={
                        "account_id": voximplant_config["account_id"],
                        "api_key": voximplant_config["api_key"],
                        "rule_id": voximplant_config["rule_id"],
                        "script_custom_data": script_custom_data,
                    }
                )
                response_data = response.json()

                if response.status_code == 200 and response_data.get("result") == 1:
                    raw = response_data.get("call_session_history_id")
                    session_id = raw[0] if isinstance(raw, list) and raw else raw
                    return session_id, True
                else:
                    error_msg = response_data.get("error", {}).get("msg", "Unknown error")
                    task.call_result = f"Voximplant error: {error_msg}"
                    return None, False
        except Exception as e:
            task.call_result = f"Legacy API exception: {str(e)}"
            return None, False

    async def execute_task(self, task: Task, db: Session):
        """
        Выполнение конкретной задачи (инициация звонка).

        ✅ v4.0: Выбор интеграции:
            1. Проверяем VoximplantChildAccount (НОВАЯ партнёрская интеграция)
            2. Fallback на user.get_voximplant_config() (СТАРАЯ интеграция)
        
        Args:
            task: Задача для выполнения
            db: Сессия БД
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 🚀 Executing task {task.id}: {task.title}")
            
            # Обновляем статус на PENDING
            task.status = TaskStatus.PENDING
            task.call_started_at = datetime.utcnow()
            db.commit()
            
            # Получаем контакт
            contact = db.query(Contact).filter(Contact.id == task.contact_id).first()
            if not contact:
                logger.error(f"[TASK-SCHEDULER] Contact not found for task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Contact not found"
                db.commit()
                return
            
            # Получаем пользователя через relationship
            user = contact.user
            if not user:
                logger.error(f"[TASK-SCHEDULER] User not found for contact {contact.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "User not found"
                db.commit()
                return
            
            # Получаем информацию об ассистенте
            assistant_id, assistant_name, assistant_type = self._get_assistant_info(task, db)
            
            if not assistant_id or not assistant_type:
                logger.error(f"[TASK-SCHEDULER] No valid assistant found for task {task.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "Assistant not found"
                db.commit()
                return

            # =====================================================================
            # ✅ v3.0: PreCall убран из обычных задач — Voicyfy Agent работает
            # только через agent tasks (execute_agent_task). Для обычных Task'ов
            # PreCall не нужен.
            # =====================================================================

            # =====================================================================
            # ✅ v4.0: ВЫБОР ИНТЕГРАЦИИ
            # =====================================================================
            
            # Проверяем наличие партнёрской интеграции (VoximplantChildAccount)
            child_account: Optional[VoximplantChildAccount] = None
            
            # Используем backref relationship
            if hasattr(user, 'voximplant_child_account') and user.voximplant_child_account:
                child_account = user.voximplant_child_account
            
            # Определяем какую интеграцию использовать
            if child_account and child_account.can_make_outbound_calls:
                # ✅ НОВАЯ партнёрская интеграция
                logger.info(f"[TASK-SCHEDULER] 🆕 Using PARTNER integration (VoximplantChildAccount)")
                await self._execute_via_partner_api(
                    task=task,
                    contact=contact,
                    child_account=child_account,
                    assistant_id=assistant_id,
                    assistant_name=assistant_name,
                    assistant_type=assistant_type,
                    db=db
                )
            elif user.has_voximplant_config():
                # ✅ LEGACY интеграция (fallback)
                logger.info(f"[TASK-SCHEDULER] 📦 Using LEGACY integration (user.get_voximplant_config)")
                await self._execute_via_legacy_api(
                    task=task,
                    contact=contact,
                    user=user,
                    assistant_id=assistant_id,
                    assistant_name=assistant_name,
                    assistant_type=assistant_type,
                    db=db
                )
            else:
                # ❌ Нет конфигурации
                logger.error(f"[TASK-SCHEDULER] ❌ No Voximplant configuration found for user {user.id}")
                task.status = TaskStatus.FAILED
                task.call_result = "No Voximplant configuration found. Please configure telephony in Settings or connect Partner integration."
                db.commit()
            
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Error executing task {task.id}: {e}", exc_info=True)
            safe_rollback(db)  # иначе при ошибке SQL пометка FAILED ниже тоже упадёт
            
            # Помечаем задачу как failed
            try:
                task.status = TaskStatus.FAILED
                task.call_result = f"Internal error: {str(e)}"
                db.commit()
            except Exception as commit_error:
                logger.error(f"[TASK-SCHEDULER] Failed to update task status: {commit_error}")
    
    async def _execute_via_partner_api(
        self,
        task: Task,
        contact: Contact,
        child_account: VoximplantChildAccount,
        assistant_id: str,
        assistant_name: str,
        assistant_type: str,
        db: Session
    ):
        """
        ✅ v4.0: Выполнение звонка через НОВУЮ партнёрскую интеграцию.
        
        Использует VoximplantPartnerService для запуска звонка.
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 🆕 PARTNER API CALL")
            logger.info(f"   Contact: {contact.name or contact.phone}")
            logger.info(f"   Assistant: {assistant_name} ({assistant_type})")
            logger.info(f"   Task: {task.title}")
            if task.custom_greeting:
                logger.info(f"   💬 Custom Greeting: {task.custom_greeting[:80]}...")
            
            # Сценарий исходящего: общий outbound_crm для провайдеров, которые он
            # умеет, и свой сценарий у каскада и Fish (см. _outbound_rule_name).
            rule_name, rule_id = _resolve_outbound_rule(child_account.vox_rule_ids, assistant_type)

            if not rule_id:
                logger.error(f"[TASK-SCHEDULER] ❌ Rule '{rule_name}' not found in child account")
                logger.error(f"   Available rules: {list(child_account.vox_rule_ids.keys()) if child_account.vox_rule_ids else 'None'}")
                task.status = TaskStatus.FAILED
                task.call_result = (
                    f"Outbound rule '{rule_name}' not configured. Run the matching admin "
                    f"endpoint (/api/telephony/admin/setup-crm-rules for outbound_crm, "
                    f"/admin/setup-fish-scenarios or /admin/setup-cascade-scenarios for "
                    f"provider rules) to create it."
                )
                db.commit()
                return

            # Активный агент пользователя: его default_caller_id служит запасным
            # номером, а после успешного старта звонка — ключом для PostCall.
            # Читать эту переменную ДО присваивания (как было раньше) нельзя:
            # любая задача без явного task.caller_id падала с UnboundLocalError.
            agent_config = db.query(AgentConfig).filter(
                AgentConfig.user_id == contact.user_id,
                AgentConfig.is_active == True
            ).first()

            # ✅ v4.1: Выбор caller_id — из задачи, агента или автоматически
            caller_id = None

            # 1. Если в задаче указан конкретный caller_id — используем его
            if task.caller_id:
                caller_id_valid = False
                if child_account.phone_numbers:
                    for phone in child_account.phone_numbers:
                        if phone.phone_number == task.caller_id and phone.is_active:
                            caller_id = task.caller_id
                            caller_id_valid = True
                            logger.info(f"   ✅ Using task-specified caller_id: {caller_id}")
                            break

                if not caller_id_valid:
                    logger.warning(f"[TASK-SCHEDULER] ⚠️ Task caller_id '{task.caller_id}' is not active or not found")
                    logger.warning(f"   Falling back to agent/auto-select...")

            # 2. AgentConfig.default_caller_id (если есть активный агент)
            if not caller_id and agent_config and agent_config.default_caller_id:
                if child_account.phone_numbers:
                    for phone in child_account.phone_numbers:
                        if phone.phone_number == agent_config.default_caller_id and phone.is_active:
                            caller_id = agent_config.default_caller_id
                            logger.info(f"   📞 Using agent default_caller_id: {caller_id}")
                            break

            # 3. Если caller_id не указан или не валиден — берём первый активный
            if not caller_id:
                if child_account.phone_numbers:
                    for phone in child_account.phone_numbers:
                        if phone.is_active:
                            caller_id = phone.phone_number
                            logger.info(f"   📞 Auto-selected caller_id: {caller_id}")
                            break

            # 4. Если вообще нет активных номеров — ошибка
            if not caller_id:
                logger.error(f"[TASK-SCHEDULER] ❌ No active phone numbers for caller_id")
                task.status = TaskStatus.FAILED
                task.call_result = "No active phone numbers available for caller ID. Check that your phone numbers are not expired."
                db.commit()
                return
            
            logger.info(f"   Rule ID: {rule_id}")
            logger.info(f"   Caller ID: {caller_id}")
            
            # Вызываем VoximplantPartnerService
            service = get_voximplant_partner_service()
            
            result = await service.start_outbound_call(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key,
                rule_id=int(rule_id),
                phone_number=contact.phone,
                assistant_id=assistant_id,
                caller_id=caller_id,
                # ✅ v3.1: CRM контекст
                contact_name=contact.name or "",
                task_title=task.title or "",
                task_description=task.description or "",
                custom_greeting=task.custom_greeting or "",
                timezone=DEFAULT_TIMEZONE,
                assistant_type=assistant_type
            )
            
            if result.get("success"):
                call_session_id = result.get("call_session_history_id")
                
                task.status = TaskStatus.COMPLETED
                task.call_completed_at = datetime.utcnow()
                task.call_session_id = str(call_session_id) if call_session_id else None
                task.call_result = f"Call initiated successfully via Partner API. Session ID: {call_session_id}"
                
                logger.info(f"[TASK-SCHEDULER] ✅ Task {task.id} completed successfully (Partner API)")
                logger.info(f"   Call session ID: {call_session_id}")

                # ✅ v5.0: Launch PostCall if agent is active (agent_config найден выше)
                if agent_config and task.pre_call_response_id:
                    user = db.query(User).filter(User.id == contact.user_id).first()
                    if user and user.openai_api_key:
                        asyncio.create_task(
                            PostCallOrchestrator.poll_and_run(
                                task_id=str(task.id),
                                agent_config_id=str(agent_config.id),
                                user_openai_key=user.openai_api_key
                            )
                        )
                        logger.info(f"[TASK-SCHEDULER] 🤖 PostCall polling started for task {task.id}")
            else:
                error_msg = result.get("error", "Unknown error")
                task.status = TaskStatus.FAILED
                task.call_result = f"Partner API error: {error_msg}"

                logger.error(f"[TASK-SCHEDULER] ❌ Partner API error for task {task.id}: {error_msg}")

            db.commit()
            
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Partner API exception: {e}", exc_info=True)
            safe_rollback(db)  # иначе при ошибке SQL пометка FAILED ниже тоже упадёт
            task.status = TaskStatus.FAILED
            task.call_result = f"Partner API exception: {str(e)}"
            db.commit()
    
    async def _execute_via_legacy_api(
        self,
        task: Task,
        contact: Contact,
        user: User,
        assistant_id: str,
        assistant_name: str,
        assistant_type: str,
        db: Session
    ):
        """
        ✅ v4.0: Выполнение звонка через СТАРУЮ (Legacy) интеграцию.
        
        Использует прямой вызов Voximplant API с настройками из user модели.
        Это оригинальный код из v3.4, вынесенный в отдельный метод.
        """
        try:
            logger.info(f"[TASK-SCHEDULER] 📦 LEGACY API CALL")
            logger.info(f"   Contact: {contact.name or contact.phone}")
            logger.info(f"   Assistant: {assistant_name} ({assistant_type})")
            logger.info(f"   Task: {task.title}")
            if task.custom_greeting:
                logger.info(f"   💬 Custom Greeting: {task.custom_greeting[:80]}...")
            
            # Получаем настройки Voximplant из user модели
            voximplant_config = user.get_voximplant_config()
            
            if not voximplant_config:
                logger.error(f"[TASK-SCHEDULER] ❌ User {user.id} has no Voximplant settings")
                task.status = TaskStatus.FAILED
                task.call_result = "User has no Voximplant settings. Please configure in Settings."
                db.commit()
                return
            
            # Для Gemini добавляем префикс к assistant_id
            final_assistant_id = assistant_id
            if assistant_type == "gemini":
                final_assistant_id = f"gemini_{assistant_id}"
            
            # Формируем script_custom_data с контекстом задачи
            script_custom_data_dict = {
                "phone_number": contact.phone,
                "assistant_id": final_assistant_id,
                "caller_id": voximplant_config["caller_id"],
                # Контекст задачи
                "task_title": task.title or "",
                "task_description": task.description or "",
                "contact_name": contact.name or "",
                # Персонализированное приветствие
                "custom_greeting": task.custom_greeting or "",
                # Timezone
                "timezone": DEFAULT_TIMEZONE
            }
            
            logger.info(f"[TASK-SCHEDULER] 📦 Script custom data:")
            logger.info(f"   phone_number: {script_custom_data_dict['phone_number']}")
            logger.info(f"   assistant_id: {script_custom_data_dict['assistant_id']}")
            logger.info(f"   caller_id: {script_custom_data_dict['caller_id']}")
            logger.info(f"   task_title: {script_custom_data_dict['task_title']}")
            logger.info(f"   contact_name: {script_custom_data_dict['contact_name']}")
            if script_custom_data_dict['custom_greeting']:
                logger.info(f"   💬 custom_greeting: {script_custom_data_dict['custom_greeting'][:80]}...")
            
            script_custom_data = json.dumps(script_custom_data_dict, ensure_ascii=False)
            
            # Отправляем запрос в Voximplant API
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    VOXIMPLANT_API_URL,
                    data={
                        "account_id": voximplant_config["account_id"],
                        "api_key": voximplant_config["api_key"],
                        "rule_id": voximplant_config["rule_id"],
                        "script_custom_data": script_custom_data
                    }
                )
                
                response_data = response.json()
                
                logger.info(f"[TASK-SCHEDULER] Voximplant API response: {response_data}")
                
                if response.status_code == 200 and response_data.get("result") == 1:
                    # Успешно запущен звонок
                    call_session_raw = response_data.get("call_session_history_id")
                    
                    if isinstance(call_session_raw, list):
                        call_session_id = call_session_raw[0] if call_session_raw else None
                    else:
                        call_session_id = call_session_raw
                    
                    task.status = TaskStatus.COMPLETED
                    task.call_completed_at = datetime.utcnow()
                    task.call_session_id = str(call_session_id) if call_session_id else None
                    task.call_result = f"Call initiated successfully via Legacy API. Session ID: {call_session_id}"

                    logger.info(f"[TASK-SCHEDULER] ✅ Task {task.id} completed successfully (Legacy API)")
                    logger.info(f"   Call session ID: {call_session_id}")

                    # ✅ v5.0: Launch PostCall if agent is active
                    agent_config = db.query(AgentConfig).filter(
                        AgentConfig.user_id == user.id,
                        AgentConfig.is_active == True
                    ).first()
                    if agent_config and task.pre_call_response_id:
                        if user.openai_api_key:
                            asyncio.create_task(
                                PostCallOrchestrator.poll_and_run(
                                    task_id=str(task.id),
                                    agent_config_id=str(agent_config.id),
                                    user_openai_key=user.openai_api_key
                                )
                            )
                            logger.info(f"[TASK-SCHEDULER] 🤖 PostCall polling started for task {task.id}")
                else:
                    # Ошибка от Voximplant
                    error_msg = response_data.get("error", {}).get("msg", "Unknown Voximplant error")
                    error_code = response_data.get("error", {}).get("code", "N/A")
                    
                    task.status = TaskStatus.FAILED
                    task.call_result = f"Voximplant error [{error_code}]: {error_msg}"
                    
                    logger.error(f"[TASK-SCHEDULER] ❌ Voximplant error for task {task.id}")
                    logger.error(f"   Error code: {error_code}")
                    logger.error(f"   Error message: {error_msg}")
                
                db.commit()
                
        except httpx.TimeoutException as e:
            logger.error(f"[TASK-SCHEDULER] Timeout calling Voximplant API: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Timeout error: Request to Voximplant took too long"
            db.commit()
            
        except httpx.RequestError as e:
            logger.error(f"[TASK-SCHEDULER] Network error calling Voximplant API: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Network error: {str(e)}"
            db.commit()
            
        except json.JSONDecodeError as e:
            logger.error(f"[TASK-SCHEDULER] Invalid JSON response from Voximplant: {e}")
            task.status = TaskStatus.FAILED
            task.call_result = f"Invalid response from Voximplant API"
            db.commit()
        
        except Exception as e:
            logger.error(f"[TASK-SCHEDULER] Legacy API exception: {e}", exc_info=True)
            safe_rollback(db)  # иначе при ошибке SQL пометка FAILED ниже тоже упадёт
            task.status = TaskStatus.FAILED
            task.call_result = f"Legacy API exception: {str(e)}"
            db.commit()


# Глобальный экземпляр планировщика
_task_scheduler: Optional[TaskScheduler] = None


async def start_task_scheduler(check_interval: int = 30):
    """
    Запуск планировщика задач.
    
    Args:
        check_interval: Интервал проверки в секундах
    """
    global _task_scheduler
    
    if _task_scheduler is not None:
        logger.warning("[TASK-SCHEDULER] Already running")
        return
    
    _task_scheduler = TaskScheduler(check_interval=check_interval)
    
    try:
        await _task_scheduler.start()
    except Exception as e:
        logger.error(f"[TASK-SCHEDULER] Fatal error: {e}", exc_info=True)
        _task_scheduler = None


def stop_task_scheduler():
    """Остановка планировщика задач"""
    global _task_scheduler
    
    if _task_scheduler is not None:
        _task_scheduler.stop()
        _task_scheduler = None
