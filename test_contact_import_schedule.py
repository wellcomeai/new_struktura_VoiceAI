"""
Тест распределения времени при импорте контактов агента (без БД и сети):
    python test_contact_import_schedule.py

Проверяет, что колонка «Когда звонить (МСК)» из нашего шаблона и похожие
заголовки распознаются, дата без времени ставится на начало рабочих часов,
прошедшая дата и пустые строки получают автоматическое время.
"""
import io
from datetime import datetime, timedelta, timezone

import backend.core.config  # noqa: F401
from openpyxl import Workbook

from backend.services.contact_import_service import (
    generate_template_xlsx, parse_file, assign_schedule, detect_headers, _norm_header,
)

MSK = timezone(timedelta(hours=3))
BASE = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)  # 15:00 МСК


def xlsx(rows):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def msk(iso_utc):
    return datetime.fromisoformat(iso_utc).astimezone(MSK).strftime("%Y-%m-%d %H:%M")


def check(cond, msg):
    assert cond, msg
    print("ok -", msg)


# 1. Заголовки
check(_norm_header("Когда звонить (МСК)") == "когда звонить", "скобки убираются из заголовка")
for h in ["Когда звонить (МСК)", "Дата звонка", "Время звонка, мск", "Дата/время", "Перезвонить"]:
    m = detect_headers(["Имя", "Телефон", h])
    check(m and m.get(2) == "scheduled_time", f"«{h}» → колонка времени")
for h in ["Дата рождения", "Дата создания", "Последний заказ"]:
    m = detect_headers(["Имя", "Телефон", h])
    check(m is not None and 2 not in m, f"«{h}» — не время звонка")
m = detect_headers(["Имя", "Телефон", "Задача (заголовок)", "Описание задачи"])
check(m == {0: "name", 1: "phone", 2: "task_title", 3: "task_description"}, "остальные заголовки не сломались")

# 2. Наш шаблон: время из колонки «Когда звонить (МСК)»
parsed = parse_file("t.xlsx", generate_template_xlsx())
row = parsed["rows"][0]
check(row["scheduled_dt"] == datetime(2026, 6, 10, 14, 30), "шаблон: дата берётся из файла")
check(parsed["schedule_column"] == "Когда звонить (МСК)", "шаблон: в превью видно, из какой колонки")

# 3. Распределение
content = xlsx([
    ["Имя", "Телефон", "Когда звонить (МСК)", "Дата рождения"],
    ["A", "+79001110001", "27.11.2026 14:30", datetime(1990, 1, 1)],   # из файла
    ["B", "+79001110002", "28.11.2026", datetime(1991, 1, 1)],          # дата без времени
    ["C", "+79001110003", datetime(2026, 11, 29), None],                # ячейка-дата без времени
    ["D", "+79001110004", "01.11.2026 10:00", None],                    # прошлое
    ["E", "+79001110005", None, None],                                  # пусто
    ["F", "+79001110006", "27.11.2026 23:30", None],                    # вне рабочих часов
])
parsed = parse_file("t.xlsx", content)
rows = parsed["rows"]
stats = assign_schedule(rows, 9, 21, base_utc=BASE)
by = {r["name"]: r for r in rows}
check(msk(by["A"]["scheduled_time_utc"]) == "2026-11-27 14:30", "время из файла сохраняется")
check(by["B"]["time_source"] == "date_only" and msk(by["B"]["scheduled_time_utc"]) == "2026-11-28 09:00",
      "дата без времени (текст) → начало рабочих часов")
check(by["C"]["time_source"] == "date_only" and msk(by["C"]["scheduled_time_utc"]) == "2026-11-29 09:00",
      "дата без времени (ячейка-дата) → начало рабочих часов")
check(by["D"]["time_source"] == "past" and msk(by["D"]["scheduled_time_utc"]) == "2026-11-26 16:00",
      "прошедшая дата → автоматически, через час, а не сразу")
check(by["E"]["time_source"] == "auto" and msk(by["E"]["scheduled_time_utc"]) == "2026-11-26 16:00",
      "без даты → автоматически через час")
check(msk(by["F"]["scheduled_time_utc"]) == "2026-11-28 09:00" and by["F"]["shifted"],
      "время вне рабочих часов → начало следующего рабочего дня")
check(stats == {"shifted": 1, "from_file": 2, "date_only": 2, "past": 1, "auto": 1}, f"счётчики {stats}")
check(parsed["unrecognized_date_columns"] == ["Дата рождения"], "нераспознанная колонка с датами попадает в предупреждение")

# 4. Круглосуточный агент: дата без времени → 9:00
rows = parse_file("t.xlsx", xlsx([["Имя", "Телефон", "Дата"], ["A", "+79001110001", "28.11.2026"]]))["rows"]
assign_schedule(rows, 0, 0, base_utc=BASE)
check(msk(rows[0]["scheduled_time_utc"]) == "2026-11-28 09:00", "круглосуточный агент: дата без времени → 9:00")

# 5. Без заголовков — колонка H по порядку
rows = parse_file("t.xlsx", xlsx([["A", "+79001110001", None, None, None, None, None, "27.11.2026 11:00"]]))["rows"]
assign_schedule(rows, 9, 21, base_utc=BASE)
check(msk(rows[0]["scheduled_time_utc"]) == "2026-11-27 11:00", "файл без заголовков: время из колонки H")

print("\nВсе проверки пройдены")
