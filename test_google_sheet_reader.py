"""
Проверка чтения Google-таблиц (backend/services/google_sheet_reader.py) без сети:
разбор ссылок, поиск по прайсу, ошибки доступа на подставном HTTP.
Запуск: python test_google_sheet_reader.py
"""
import asyncio
import io
import logging
import warnings

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import os
import sys
import types

import httpx
from openpyxl import Workbook

# Пакет backend.services при импорте тянет все сервисы (Telegram, оплаты…) —
# для этого теста они не нужны, грузим модули напрямую.
_pkg = types.ModuleType("backend.services")
_pkg.__path__ = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", "services")]
sys.modules.setdefault("backend.services", _pkg)
from backend.services import google_sheet_reader as gs  # noqa: E402

SHEET_ID = "1wR9QIUnJ1Nyvc_G06oUR7xWhOzspxorL7Xh_mUAWmO8"
BASE = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"


def test_parse_urls():
    """Все варианты ссылок из звонков дают один и тот же ID."""
    for url in [f"{BASE}/edit?gid=0#gid=0", f"{BASE}/edit?gid=0", BASE, f"{BASE}/edit?usp=sharing",
                f"{BASE}/", f"docs.google.com/spreadsheets/d/{SHEET_ID}/edit", f" <{BASE}/edit> ",
                f"{BASE}/htmlview", f"https://docs.google.com/spreadsheets/u/0/d/{SHEET_ID}/edit"]:
        parsed = gs.parse_google_url(url)
        assert parsed and parsed["id"] == SHEET_ID and parsed["kind"] == "spreadsheet", (url, parsed)
    assert gs.parse_google_url(f"{BASE}/edit?gid=0#gid=0")["gid"] == 0
    assert gs.parse_google_url(f"{BASE}/edit#gid=12345")["gid"] == 12345
    assert gs.parse_google_url(BASE)["gid"] is None

    doc = gs.parse_google_url("https://docs.google.com/document/d/1ABC_def-123456789/edit?usp=sharing")
    assert doc == {"kind": "document", "id": "1ABC_def-123456789", "gid": None}
    assert gs.parse_google_url("https://drive.google.com/file/d/1XYZ_abc-987654321/view")["kind"] == "file"
    assert gs.parse_google_url(SHEET_ID)["kind"] == "unknown"           # голый ID
    for bad in ["", None, "https://example.com/spreadsheets/d/1wR9QIUnJ1Nyvc_G06oUR7x/edit",
                "таблица с ценами", "https://docs.google.com/spreadsheets/"]:
        assert gs.parse_google_url(bad) is None, bad
    assert gs.is_spreadsheet_url(f"{BASE}/edit") and not gs.is_spreadsheet_url("https://docs.google.com/document/d/1ABC_def-123456789")


def test_tokenize():
    assert gs.tokenize("iPhone 18 Pro 256GB Серый") == ["iphone", "18", "pro", "256", "gb", "серый"]
    assert gs.tokenize("Ёлка 1,5 м") == ["елка", "1.5", "м"]
    assert gs.query_tokens("Сколько стоит iPhone 18 Pro?") == ["iphone", "18", "pro"]


def make_xlsx(rows_by_sheet: dict, hidden=()) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in rows_by_sheet.items():
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
        if name in hidden:
            ws.sheet_state = "hidden"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


HEADER = ["Модель", "Память", "Цвет", "Цена", "Наличие"]
SMALL = {"Телефоны": [HEADER,
                      ["iPhone 18 Pro", "256GB", "Серый", 129990, "есть"],
                      ["iPhone 18 Pro", "512GB", "Серый", 149990.0, "нет"]]}


def big_price() -> dict:
    rows = [HEADER]
    colors = ["Серый", "Чёрный", "Белый", "Синий"]
    for gen in range(13, 19):
        for model in ["", " Pro", " Pro Max"]:
            for mem in ["128GB", "256GB", "512GB", "1TB"]:
                for color in colors:
                    rows.append([f"iPhone {gen}{model}", mem, color, 50000 + gen * 1000, "есть"])
    acc = [["Товар", "Цена"]] + [[f"Чехол для iPhone {g}", 1990] for g in range(13, 19)]
    return {"Телефоны": rows, "Аксессуары": acc, "Служебный": [["секрет"], ["x"]]}


def test_parse_workbook():
    sheets = gs.parse_workbook(make_xlsx(big_price(), hidden=("Служебный",)))
    assert [s["name"] for s in sheets] == ["Телефоны", "Аксессуары"]         # скрытый лист не читаем
    assert sheets[0]["header"] == HEADER
    small = gs.parse_workbook(make_xlsx(SMALL))
    assert small[0]["rows"][1] == ["iPhone 18 Pro", "512GB", "Серый", "149990", "нет"]   # 149990.0 → 149990


def test_small_table_full():
    sheets = gs.parse_workbook(make_xlsx(SMALL))
    res = gs.build_answer(sheets, "что угодно", None, gs.VOICE_MAX_CHARS)
    assert res["mode"] == "full" and "iPhone 18 Pro | 256GB | Серый | 129990 | есть" in res["text"]
    assert "Модель | Память" in res["text"]


def test_big_table_search():
    sheets = gs.parse_workbook(make_xlsx(big_price()))
    res = gs.build_answer(sheets, "iPhone 18 Pro 256 серый", None, gs.VOICE_MAX_CHARS)
    assert res["mode"] == "search" and res["found"], res
    lines = res["text"].split("\n")
    assert lines[0] == "Лист «Телефоны»" and lines[1] == " | ".join(HEADER)
    assert lines[2].startswith("iPhone 18 Pro | 256GB | Серый"), lines[2]   # точное совпадение первым
    assert res["shown"] <= gs.SEARCH_MAX_ROWS and len(res["text"]) <= gs.VOICE_MAX_CHARS
    assert "| 128GB |" not in "\n".join(lines[2:4])

    # Слова вопроса, падеж, ё/е и опечатка не мешают
    res = gs.build_answer(sheets, "сколько стоит айфон iphone 17 pro max 1tb черного", None, gs.VOICE_MAX_CHARS)
    first = res["text"].split("\n")[2]
    assert first.startswith("iPhone 17 Pro Max | 1TB | Чёрный"), first
    assert "айфон" in res.get("ignored_words", [])

    # Числа точно: 25 не находит 256
    res = gs.build_answer(sheets, "iphone 15 25", None, gs.VOICE_MAX_CHARS)
    assert "ignored_words" in res and "25" in res["ignored_words"]

    res = gs.build_answer(sheets, "чехол 16", None, gs.VOICE_MAX_CHARS)
    assert res["text"].split("\n")[0] == "Лист «Аксессуары»" and "Чехол для iPhone 16 | 1990" in res["text"]

    res = gs.build_answer(sheets, "samsung galaxy", None, gs.VOICE_MAX_CHARS)
    assert res["found"] is False and "hint" in res

    res = gs.build_answer(sheets, "чехол", "аксесс", gs.VOICE_MAX_CHARS)      # фильтр по листу
    assert [s["name"] for s in res["sheets"]] == ["Аксессуары"]


def test_big_table_preview():
    sheets = gs.parse_workbook(make_xlsx(big_price()))
    res = gs.build_answer(sheets, None, None, gs.VOICE_MAX_CHARS)
    assert res["mode"] == "preview" and res["truncated"] and len(res["text"]) <= gs.VOICE_MAX_CHARS
    assert "query" in res["hint"] and len(res["sheets"]) == 3


def install(handler):
    gs._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
    gs.clear_cache()


async def test_read_sheet_http():
    xlsx = make_xlsx(SMALL)
    calls = []

    def ok(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=xlsx, headers={"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
    install(ok)
    res = await gs.read_sheet(f"{BASE}/edit?gid=0#gid=0", query="iphone")
    assert res["success"] and res["spreadsheet_id"] == SHEET_ID and "129990" in res["text"]
    assert calls == [f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx"]
    await gs.read_sheet(f"{BASE}/edit?usp=sharing")
    assert len(calls) == 1                                                  # второй раз — из кэша

    def login_redirect(request):
        if request.url.host == "docs.google.com":
            return httpx.Response(302, headers={"location": "https://accounts.google.com/ServiceLogin?continue=x"})
        return httpx.Response(200, text="<html>Вход</html>", headers={"content-type": "text/html"})
    install(login_redirect)
    res = await gs.read_sheet(BASE)
    assert res["success"] is False and res["error"] == "access_denied", res

    install(lambda r: httpx.Response(200, text="<!DOCTYPE html><html>", headers={"content-type": "text/html"}))
    assert (await gs.read_sheet(BASE))["error"] == "access_denied"
    install(lambda r: httpx.Response(403))
    assert (await gs.read_sheet(BASE))["error"] == "access_denied"
    install(lambda r: httpx.Response(404))
    assert (await gs.read_sheet(BASE))["error"] == "not_found"
    install(lambda r: httpx.Response(500))
    assert (await gs.read_sheet(BASE))["error"] == "http_error"

    def timeout(request):
        raise httpx.ReadTimeout("timeout", request=request)
    install(timeout)
    assert (await gs.read_sheet(BASE))["error"] == "network_error"

    install(lambda r: httpx.Response(200, content=make_xlsx({"Лист1": [["Только шапка"]]})))
    assert (await gs.read_sheet(BASE))["error"] == "empty"

    res = await gs.read_sheet("https://docs.google.com/document/d/1ABC_def-123456789/edit")
    assert res["error"] == "invalid_url" and "read_google_doc" in res["hint"]
    assert (await gs.read_sheet("прайс"))["error"] == "invalid_url"


def main():
    tests = [test_parse_urls, test_tokenize, test_parse_workbook, test_small_table_full,
             test_big_table_search, test_big_table_preview, test_read_sheet_http]
    for t in tests:
        if asyncio.iscoroutinefunction(t):
            asyncio.run(t())
        else:
            t()
        print(f"✅ {t.__name__}")
    print(f"\nВсе {len(tests)} тестов прошли")


if __name__ == "__main__":
    main()
