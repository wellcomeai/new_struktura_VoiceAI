"""
Утилиты работы со временем для Voicyfy.

Подход (РФ-рынок, без DST, жёстко МСК):
- В БД и API всё хранится/передаётся в UTC (ISO-8601 с явным маркером).
- В UI и xlsx ввод/отображение в МСК (UTC+3).
- Рабочие часы агента (working_hours_start/end) трактуются как МСК; звонки и
  сообщения клиентам вне окна не уходят (переносятся на утро), start == end —
  круглосуточно.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple

# МСК фиксированная (UTC+3, без перехода на летнее время)
MSK = timezone(timedelta(hours=3))


def msk_to_utc(dt: datetime) -> datetime:
    """МСК (naive или aware) → UTC aware."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=MSK)
    return dt.astimezone(timezone.utc)


def utc_to_msk(dt: datetime) -> datetime:
    """UTC (naive считается UTC) → МСК aware."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(MSK)


def now_msk() -> datetime:
    """Текущее время в МСК."""
    return datetime.now(MSK)


def now_utc() -> datetime:
    """Текущее время в UTC (для записи в БД)."""
    return datetime.now(timezone.utc)


def iso_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """
    Сериализация datetime для API с явным UTC-маркером.

    - naive datetime → считается UTC, добавляется +00:00.
    - aware datetime → конвертируется в UTC.
    Возвращает ISO-8601 строку или None.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat()


def in_working_hours(hour: int, wh_start: int, wh_end: int) -> bool:
    """
    Попадает ли час (МСК) в рабочее окно [wh_start, wh_end).

    wh_start == wh_end — круглосуточно (ограничения нет); wh_start > wh_end —
    окно через полночь (например 22–6).
    """
    if wh_start is None or wh_end is None or wh_start == wh_end:
        return True
    if wh_start < wh_end:
        return wh_start <= hour < wh_end
    return hour >= wh_start or hour < wh_end


def next_window_start(dt_utc: datetime, wh_start: int) -> datetime:
    """Ближайшее начало рабочего окна (wh_start:00 МСК) после dt_utc, в UTC."""
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)
    msk = dt_utc.astimezone(MSK)
    start = msk.replace(hour=wh_start, minute=0, second=0, microsecond=0)
    if start <= msk:
        start += timedelta(days=1)
    return start.astimezone(timezone.utc)


def adjust_to_working_hours(
    dt_utc: datetime,
    wh_start: int,
    wh_end: int,
) -> Tuple[datetime, bool]:
    """
    Привести UTC-время звонка к рабочим часам агента (трактуются как МСК).

    Если час по МСК попадает в рабочее окно — оставляем как есть, иначе
    переносим на ближайшее начало окна (раньше начала → этот же день,
    после конца → следующий день). wh_start == wh_end — круглосуточно.

    Возвращает (utc_dt_aware, shifted: bool).
    """
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)
    dt_utc = dt_utc.astimezone(timezone.utc)
    if in_working_hours(dt_utc.astimezone(MSK).hour, wh_start, wh_end):
        return dt_utc, False
    return next_window_start(dt_utc, wh_start), True


def defer_out_of_hours(
    scheduled_utc: datetime,
    now_utc_dt: datetime,
    wh_start: int,
    wh_end: int,
) -> datetime:
    """
    Новое время для задачи, которая наступила вне рабочих часов.

    Сдвигаем на длину нерабочего промежутка (а не на начало окна), чтобы
    задачи, разнесённые по ночи с интервалом (рассылка с шагом 12 мин против
    бана мессенджера), утром ушли с тем же интервалом, а не пачкой. Раньше
    начала окна не ставим.
    """
    if scheduled_utc.tzinfo is None:
        scheduled_utc = scheduled_utc.replace(tzinfo=timezone.utc)
    quiet_hours = (wh_start - wh_end) % 24
    window_start = next_window_start(now_utc_dt, wh_start)
    return max(scheduled_utc + timedelta(hours=quiet_hours), window_start)
