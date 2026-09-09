"""
VoiceBillingSession — посекундный учёт сессии веб-виджета на серверном ключе.

Жизненный цикл:
    session = VoiceBillingSession(user_id, model_code, channel="widget")
    ok, err = session.precheck()          # баланс ≥ цены одной минуты
    session.start(on_exhausted=coro)      # фоновая задача: раз в 60 с списывает минуту
    ...
    await session.stop()                  # досписание хвоста (минимум 10 с на сессию)

Когда баланс доходит до нуля при промежуточном списании, вызывается
`on_exhausted` — хендлер корректно завершает разговор. Сессия также
завершается по лимиту VOICE_MAX_WIDGET_SESSION_SEC.

Использует собственную DB-сессию (SessionLocal), чтобы не мешать сессии
хендлера. Телефония тарифицируется отдельно — по отчёту сценария в
/api/voximplant/log (см. WalletService.charge с ref_key call:<id>).
"""

import asyncio
import time
import uuid
from typing import Optional, Callable, Awaitable, Tuple

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.services.wallet_service import (
    WalletService, TariffService, WIDGET_START_MINUTES, MIN_BILLABLE_SECONDS,
)

logger = get_logger(__name__)

INTERIM_INTERVAL_SEC = 60


class VoiceBillingSession:
    def __init__(self, user_id, model_code: str, channel: str = "widget",
                 assistant_id: Optional[str] = None):
        self.user_id = user_id
        self.model_code = model_code
        self.channel = channel
        self.assistant_id = str(assistant_id) if assistant_id else None
        self.session_key = f"ws:{uuid.uuid4().hex[:16]}"
        self.started_at: Optional[float] = None
        self.charged_seconds = 0
        self.total_charged_kopeks = 0
        self.exhausted = False
        self.stopped = False
        self._task: Optional[asyncio.Task] = None
        self._on_exhausted: Optional[Callable[[], Awaitable[None]]] = None
        self.price_per_min = 0

    # ------------------------------------------------------------------
    def precheck(self) -> Tuple[bool, Optional[dict]]:
        """Проверить баланс перед стартом. Возвращает (ok, error_payload)."""
        db = SessionLocal()
        try:
            self.price_per_min = TariffService.price_per_min(db, self.model_code)
            ok, balance, required = WalletService.precheck(
                db, self.user_id, self.model_code, WIDGET_START_MINUTES
            )
            if ok:
                return True, None
            return False, {
                "code": "wallet_insufficient",
                "message": (
                    f"Недостаточно средств на кошельке Voicyfy: нужно минимум "
                    f"{required / 100:.2f} ₽, на балансе {balance / 100:.2f} ₽. "
                    f"Пополните кошелёк."
                ),
                "balance_kopeks": balance,
                "required_kopeks": required,
                "requires_topup": True,
            }
        finally:
            db.close()

    # ------------------------------------------------------------------
    def start(self, on_exhausted: Optional[Callable[[], Awaitable[None]]] = None):
        if self.price_per_min <= 0:
            # Бесплатная модель — считаем секунды, но не списываем
            self.started_at = time.time()
            return
        self.started_at = time.time()
        self._on_exhausted = on_exhausted
        self._task = asyncio.create_task(self._ticker())
        logger.info(
            f"[VOICE-BILLING] Session {self.session_key} started: user={self.user_id} "
            f"model={self.model_code} price={self.price_per_min}kop/min"
        )

    def elapsed(self) -> int:
        if self.started_at is None:
            return 0
        return int(time.time() - self.started_at)

    async def _ticker(self):
        max_sec = int(settings.VOICE_MAX_WIDGET_SESSION_SEC or 0)
        try:
            while not self.stopped:
                await asyncio.sleep(INTERIM_INTERVAL_SEC)
                if self.stopped:
                    break
                partial = await asyncio.get_event_loop().run_in_executor(
                    None, self._charge_interim
                )
                over_limit = max_sec > 0 and self.elapsed() >= max_sec
                if partial or over_limit:
                    self.exhausted = True
                    reason = "balance exhausted" if partial else "session limit reached"
                    logger.warning(f"[VOICE-BILLING] Session {self.session_key}: {reason}")
                    if self._on_exhausted:
                        try:
                            await self._on_exhausted()
                        except Exception as e:
                            logger.error(f"[VOICE-BILLING] on_exhausted error: {e}")
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[VOICE-BILLING] ticker error: {e}")

    def _charge_interim(self) -> bool:
        """Списать очередную минуту. Возвращает True, если баланс кончился."""
        db = SessionLocal()
        try:
            seconds = INTERIM_INTERVAL_SEC
            tx = WalletService.charge(
                db, self.user_id, self.model_code, seconds,
                channel=self.channel, ref_type="voice_session",
                ref_key=f"{self.session_key}:{self.charged_seconds + seconds}",
                notes=f"interim, assistant={self.assistant_id}",
                apply_minimum=False,
            )
            self.charged_seconds += seconds
            if tx is not None:
                self.total_charged_kopeks += -tx.amount_kopeks
                return tx.balance_after <= 0
            return False
        except Exception as e:
            logger.error(f"[VOICE-BILLING] interim charge failed: {e}")
            return False
        finally:
            db.close()

    # ------------------------------------------------------------------
    async def stop(self, prompt_tokens: Optional[int] = None,
                   completion_tokens: Optional[int] = None):
        """Финальное досписание хвоста. Безопасно вызывать повторно."""
        if self.stopped:
            return
        self.stopped = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
        if self.started_at is None or self.price_per_min <= 0:
            return
        total = self.elapsed()
        # Минимальная тарификация 10 секунд на сессию
        if total < MIN_BILLABLE_SECONDS:
            total = MIN_BILLABLE_SECONDS
        tail = max(0, total - self.charged_seconds)
        if tail <= 0:
            return
        await asyncio.get_event_loop().run_in_executor(
            None, self._charge_tail, tail, prompt_tokens, completion_tokens
        )

    def _charge_tail(self, tail: int, prompt_tokens, completion_tokens):
        db = SessionLocal()
        try:
            tx = WalletService.charge(
                db, self.user_id, self.model_code, tail,
                channel=self.channel, ref_type="voice_session",
                ref_key=f"{self.session_key}:final",
                prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
                notes=f"final, total={self.elapsed()}s, assistant={self.assistant_id}",
                apply_minimum=False,
            )
            if tx is not None:
                self.total_charged_kopeks += -tx.amount_kopeks
            logger.info(
                f"[VOICE-BILLING] Session {self.session_key} closed: {self.elapsed()}s, "
                f"charged {self.total_charged_kopeks} kop"
            )
        except Exception as e:
            logger.error(f"[VOICE-BILLING] final charge failed: {e}")
        finally:
            db.close()
