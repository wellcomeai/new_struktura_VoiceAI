"""
Чтение открытой Google-таблицы по ссылке и поиск строк по запросу.

Используют функция голосового ассистента `read_google_sheet`
(backend/functions/read_google_sheet.py), `read_google_doc` для ссылок на таблицы
и инструмент агента `read_google_sheet` (backend/services/agent_tools.py).

- Ссылка в любом виде: /edit, ?gid=, #gid=, ?usp=sharing, без хвоста или просто ID —
  ID берётся регуляркой `/d/([a-zA-Z0-9_-]+)`. Запрос всегда уходит только на
  docs.google.com/spreadsheets/d/{id}/export — произвольный URL не скачиваем.
- Таблица скачивается целиком в xlsx (все видимые листы одним запросом, без ключей
  и сервисного аккаунта: доступ «Все, у кого есть ссылка»). Закрытая таблица у
  Google отвечает не 403, а редиректом на страницу входа (HTML с кодом 200) —
  это тоже `access_denied`.
- Кэш CACHE_TTL_SECONDS на таблицу: первый вызов в звонке ~0.5–1 с, повторные —
  из памяти; правка цены видна через минуту. Кэш в памяти процесса.
- Маленькая таблица (текст до max_chars) отдаётся целиком. Большая — поиск по
  словам запроса: регистр и ё/е не важны, падежи и опечатки через
  `contact_search._word_similarity`, числа сравниваются точно (256 ≠ 2560).
  Строки ранжируются по доле совпавших слов, в ответ — шапка листа и лучшие
  строки; слова, которых нет нигде в таблице («цена», «сколько»), не учитываются.
- Ошибки — код + текст для модели: invalid_url, access_denied, not_found, empty,
  too_large, http_error, network_error, bad_file.
"""

import asyncio
import io
import re
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx

from backend.core.logging import get_logger
from backend.services.contact_search import FUZZY_MIN_SCORE, _word_similarity, normalize_text

logger = get_logger(__name__)

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{id}/export?format=xlsx"

CACHE_TTL_SECONDS = 60
CACHE_MAX_ENTRIES = 64
DOWNLOAD_TIMEOUT_SECONDS = 20
MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024
MAX_ROWS_PER_SHEET = 20000
MAX_COLUMNS = 40
MAX_CELL_CHARS = 300

# Ответ модели: голосовому ассистенту — компактно (контекст звонка), агенту — больше.
VOICE_MAX_CHARS = 6000
AGENT_MAX_CHARS = 12000
SEARCH_MAX_ROWS = 15
MIN_ROW_SCORE = 0.5

_SHEET_ID_RE = re.compile(r"/d/([a-zA-Z0-9_-]{10,})")
_BARE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{25,}$")
_GID_RE = re.compile(r"[?#&]gid=(\d+)")
_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?|[^\W\d_]+", re.UNICODE)

# Слова вопроса, а не товара: модели часто передают «цена iPhone 15».
STOP_WORDS = {
    "цена", "цены", "цену", "стоимость", "сколько", "стоит", "стоят", "есть", "ли",
    "наличие", "наличии", "в", "во", "на", "и", "или", "по", "для", "с", "со", "а",
    "у", "вас", "мне", "нужен", "нужна", "нужно", "какой", "какая", "какие", "какое",
    "the", "price", "of", "a",
}

ERROR_MESSAGES = {
    "invalid_url": "Не удалось распознать ссылку на Google-таблицу. Нужна ссылка вида "
                   "https://docs.google.com/spreadsheets/d/<ID>/...",
    "access_denied": "Нет доступа к таблице: владелец должен открыть её «Все, у кого есть ссылка» "
                     "(хотя бы просмотр). Ссылку не перебирай — дело не в ней.",
    "not_found": "Таблица не найдена: ID в ссылке неверный или таблицу удалили.",
    "empty": "Таблица пустая — в ней нет данных.",
    "too_large": "Таблица слишком большая для чтения (больше 15 МБ).",
    "network_error": "Google не ответил вовремя — попробуй ещё раз чуть позже.",
    "http_error": "Google вернул ошибку при выгрузке таблицы.",
    "bad_file": "Не удалось разобрать файл таблицы.",
}

_client: Optional[httpx.AsyncClient] = None
_cache: Dict[str, Tuple[float, List[dict]]] = {}
_locks: Dict[str, asyncio.Lock] = {}


# =============================================================================
# ССЫЛКА
# =============================================================================

def parse_google_url(url: Optional[str]) -> Optional[Dict[str, Any]]:
    """
    Разобрать ссылку Google Docs / Sheets / Drive.
    Возвращает {"kind": spreadsheet|document|presentation|file|unknown, "id", "gid"}
    или None, если ID не найден. Голый ID (без ссылки) → kind "unknown".
    """
    raw = (url or "").strip().strip("<>\"' ")
    if not raw:
        return None
    gid_match = _GID_RE.search(raw)
    gid = int(gid_match.group(1)) if gid_match else None
    if _BARE_ID_RE.match(raw):
        return {"kind": "unknown", "id": raw, "gid": gid}
    low = raw.lower()
    if "google.com" not in low:
        return None
    match = _SHEET_ID_RE.search(raw)
    if not match:
        return None
    if "/spreadsheets/" in low:
        kind = "spreadsheet"
    elif "/document/" in low:
        kind = "document"
    elif "/presentation/" in low:
        kind = "presentation"
    elif "/file/" in low or "drive.google.com" in low:
        kind = "file"
    else:
        kind = "unknown"
    return {"kind": kind, "id": match.group(1), "gid": gid}


def is_spreadsheet_url(url: Optional[str]) -> bool:
    parsed = parse_google_url(url)
    return bool(parsed and parsed["kind"] == "spreadsheet")


def _error(code: str, **extra) -> Dict[str, Any]:
    return {"success": False, "error": code, "message": ERROR_MESSAGES.get(code, code), **extra}


# =============================================================================
# ЗАГРУЗКА И РАЗБОР
# =============================================================================

def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=DOWNLOAD_TIMEOUT_SECONDS, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Voicyfy sheet reader)"},
        )
    return _client


async def _download(sheet_id: str) -> Tuple[Optional[bytes], Optional[Dict[str, Any]]]:
    """xlsx-выгрузка таблицы: (байты, None) или (None, ошибка)."""
    url = EXPORT_URL.format(id=sheet_id)
    started = time.monotonic()
    try:
        async with _get_client().stream("GET", url) as resp:
            status = resp.status_code
            final_host = resp.url.host or ""
            ctype = resp.headers.get("content-type", "")
            chunks, size = [], 0
            if status == 200:
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_DOWNLOAD_BYTES:
                        logger.warning(f"[GSHEET] {sheet_id}: больше {MAX_DOWNLOAD_BYTES} байт, прервано")
                        return None, _error("too_large")
                    chunks.append(chunk)
    except httpx.TimeoutException:
        logger.warning(f"[GSHEET] {sheet_id}: таймаут {DOWNLOAD_TIMEOUT_SECONDS} с")
        return None, _error("network_error")
    except httpx.HTTPError as e:
        logger.warning(f"[GSHEET] {sheet_id}: сетевая ошибка {e!r}")
        return None, _error("network_error")

    data = b"".join(chunks)
    ms = int((time.monotonic() - started) * 1000)
    logger.info(f"[GSHEET] {sheet_id}: HTTP {status}, {len(data)} байт, {ctype or '-'}, "
                f"host={final_host}, {ms} мс")
    if status in (401, 403) or "accounts.google.com" in final_host:
        return None, _error("access_denied", http_status=status)
    if status in (400, 404, 410):
        return None, _error("not_found", http_status=status)
    if status != 200:
        return None, _error("http_error", http_status=status)
    if not data.startswith(b"PK"):
        # Вместо xlsx пришла HTML-страница (вход в аккаунт / запрос доступа)
        return None, _error("access_denied", http_status=status)
    return data, None


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.10g}"
    if isinstance(value, datetime):
        if value.hour == value.minute == value.second == 0:
            return value.strftime("%d.%m.%Y")
        return value.strftime("%d.%m.%Y %H:%M")
    if isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    text = " ".join(str(value).split())
    if len(text) > MAX_CELL_CHARS:
        text = text[:MAX_CELL_CHARS] + "…"
    return text


def tokenize(text: str) -> List[str]:
    """Слова и числа в нижнем регистре, ё → е; «256GB» → ["256", "gb"], «1,5» → «1.5»."""
    return [t.replace(",", ".") for t in _TOKEN_RE.findall(normalize_text(text))]


def parse_workbook(data: bytes) -> List[dict]:
    """
    xlsx → [{"name", "header": [...], "rows": [[...]], "tokens": [set, ...]}].
    Скрытые листы пропускаются; шапка — первая непустая строка листа.
    """
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheets = []
    try:
        for ws in wb.worksheets:
            if getattr(ws, "sheet_state", "visible") != "visible":
                continue
            rows: List[List[str]] = []
            for raw in ws.iter_rows(values_only=True):
                cells = [_cell_text(v) for v in raw[:MAX_COLUMNS]]
                while cells and not cells[-1]:
                    cells.pop()
                if cells:
                    rows.append(cells)
                if len(rows) > MAX_ROWS_PER_SHEET:
                    break
            if not rows:
                continue
            header, body = rows[0], rows[1:]
            width = max(len(r) for r in rows)
            header = header + [""] * (width - len(header))
            header = [h or f"Колонка {i + 1}" for i, h in enumerate(header)]
            sheets.append({
                "name": ws.title,
                "header": header,
                "rows": body,
                "tokens": [set(tokenize(" ".join(r))) for r in body],
            })
    finally:
        wb.close()
    return sheets


async def load_sheets(sheet_id: str) -> Tuple[Optional[List[dict]], Optional[Dict[str, Any]], bool]:
    """Листы таблицы из кэша или Google: (листы, ошибка, из_кэша)."""
    now = time.monotonic()
    cached = _cache.get(sheet_id)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1], None, True
    lock = _locks.setdefault(sheet_id, asyncio.Lock())
    async with lock:
        cached = _cache.get(sheet_id)
        if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1], None, True
        data, err = await _download(sheet_id)
        if err:
            return None, err, False
        try:
            sheets = await asyncio.to_thread(parse_workbook, data)
        except Exception as e:
            logger.warning(f"[GSHEET] {sheet_id}: не разобрать xlsx: {e!r}")
            return None, _error("bad_file"), False
        if len(_cache) >= CACHE_MAX_ENTRIES:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest, None)
            _locks.pop(oldest, None)
        _cache[sheet_id] = (time.monotonic(), sheets)
        return sheets, None, False


def clear_cache() -> None:
    _cache.clear()


# =============================================================================
# ПОИСК
# =============================================================================

def query_tokens(query: Optional[str]) -> List[str]:
    return [t for t in tokenize(query or "") if t not in STOP_WORDS]


def _token_scores(token: str, vocab: set) -> Dict[str, float]:
    """Похожесть слова запроса на каждое слово таблицы (только ненулевые)."""
    if token.replace(".", "").isdigit():
        return {token: 1.0} if token in vocab else {}
    out = {}
    for word in vocab:
        if word[0].isdigit():
            continue
        score = _word_similarity(token, word)
        if score >= FUZZY_MIN_SCORE:
            out[word] = score
    return out


def search_rows(sheets: List[dict], query: str, limit: int = SEARCH_MAX_ROWS) -> Dict[str, Any]:
    """
    Ранжированный поиск строк по словам запроса.
    Возвращает {"hits": [(score, sheet_index, row_index)], "total", "used", "ignored"}.
    """
    tokens = list(dict.fromkeys(query_tokens(query)))
    vocab = set()
    for sheet in sheets:
        for row_tokens in sheet["tokens"]:
            vocab |= row_tokens
    scores_by_token = {t: _token_scores(t, vocab) for t in tokens}
    used = [t for t in tokens if scores_by_token[t]]
    ignored = [t for t in tokens if not scores_by_token[t]]
    if not used:
        return {"hits": [], "total": 0, "used": used, "ignored": ignored}

    hits = []
    for si, sheet in enumerate(sheets):
        for ri, row_tokens in enumerate(sheet["tokens"]):
            total = 0.0
            for t in used:
                best = scores_by_token[t]
                total += max((best[w] for w in row_tokens if w in best), default=0.0)
            score = total / len(used)
            if score >= MIN_ROW_SCORE:
                hits.append((score, si, ri))
    hits.sort(key=lambda h: (-h[0], h[1], h[2]))
    return {"hits": hits[:limit], "total": len(hits), "used": used, "ignored": ignored}


# =============================================================================
# ОТВЕТ МОДЕЛИ
# =============================================================================

def _line(cells: List[str]) -> str:
    return " | ".join(cells)


def render_sheet(sheet: dict, rows: List[List[str]]) -> str:
    return "\n".join([f"Лист «{sheet['name']}»", _line(sheet["header"])] + [_line(r) for r in rows])


def _overview(sheets: List[dict]) -> List[dict]:
    return [{"name": s["name"], "rows": len(s["rows"]), "columns": s["header"]} for s in sheets]


def _pick_sheets(sheets: List[dict], sheet: Optional[str]) -> Tuple[List[dict], Optional[str]]:
    if not sheet:
        return sheets, None
    want = normalize_text(sheet)
    picked = [s for s in sheets if want in normalize_text(s["name"])]
    if picked:
        return picked, None
    return sheets, f"Листа «{sheet}» нет, искал по всем листам."


def _fit(blocks: List[str], max_chars: int) -> Tuple[str, bool]:
    """Склеить блоки листов, обрезав по строкам до max_chars."""
    out, size, cut = [], 0, False
    for block in blocks:
        for line in block.split("\n"):
            if size + len(line) + 1 > max_chars:
                cut = True
                break
            out.append(line)
            size += len(line) + 1
        if cut:
            break
        out.append("")
        size += 1
    return "\n".join(out).strip(), cut


def build_answer(sheets: List[dict], query: Optional[str], sheet: Optional[str],
                 max_chars: int) -> Dict[str, Any]:
    picked, sheet_note = _pick_sheets(sheets, sheet)
    full_text = "\n\n".join(render_sheet(s, s["rows"]) for s in picked)
    total_rows = sum(len(s["rows"]) for s in picked)
    result: Dict[str, Any] = {"success": True, "sheets": _overview(picked)}
    if sheet_note:
        result["note"] = sheet_note

    if len(full_text) <= max_chars:
        result.update({"mode": "full", "rows_total": total_rows, "text": full_text})
        return result

    if not query_tokens(query):
        text, _ = _fit([render_sheet(s, s["rows"]) for s in picked], max_chars)
        result.update({
            "mode": "preview", "rows_total": total_rows, "text": text, "truncated": True,
            "hint": f"Таблица большая ({total_rows} строк), показано начало. Чтобы найти нужное, "
                    "вызови ещё раз с query — название товара/услуги как в таблице.",
        })
        return result

    found = search_rows(picked, query)
    result.update({"mode": "search", "query": query, "matches": found["total"]})
    if found["ignored"]:
        result["ignored_words"] = found["ignored"]
    if not found["hits"]:
        result.update({
            "found": False,
            "message": f"По запросу «{query}» в таблице ничего не найдено.",
            "hint": "Переформулируй query: название как в таблице (бренды латиницей, числа "
                    "цифрами, без слов вопроса). Колонки листов — в sheets. Не придумывай ответ.",
        })
        return result

    grouped: Dict[int, List[List[str]]] = {}
    for _, si, ri in found["hits"]:
        grouped.setdefault(si, []).append(picked[si]["rows"][ri])
    text, cut = _fit([render_sheet(picked[si], rows) for si, rows in grouped.items()], max_chars)
    shown = len(found["hits"])
    result.update({
        "found": True, "text": text, "shown": shown,
        "has_more": found["total"] > shown or cut,
    })
    if found["total"] > shown:
        result["hint"] = (f"Совпадений {found['total']}, показаны {shown} самых похожих. "
                          "Уточни query, если нужной строки нет.")
    return result


async def read_sheet(url: str, query: Optional[str] = None, sheet: Optional[str] = None,
                     max_chars: int = VOICE_MAX_CHARS, log_prefix: str = "[GSHEET]") -> Dict[str, Any]:
    """Прочитать открытую Google-таблицу; ответ — dict для модели (success / error)."""
    parsed = parse_google_url(url)
    if not parsed:
        logger.warning(f"{log_prefix} invalid_url: {url!r}")
        return _error("invalid_url", url=url)
    if parsed["kind"] not in ("spreadsheet", "unknown"):
        logger.warning(f"{log_prefix} не таблица ({parsed['kind']}): {url!r}")
        return _error("invalid_url", url=url,
                      hint="Это ссылка не на Google-таблицу. Для документов есть read_google_doc.")
    sheet_id = parsed["id"]
    started = time.monotonic()
    sheets, err, cached = await load_sheets(sheet_id)
    if err:
        logger.warning(f"{log_prefix} {sheet_id}: {err['error']} (HTTP {err.get('http_status', '-')})")
        return {**err, "spreadsheet_id": sheet_id}
    if not sheets or not any(s["rows"] for s in sheets):
        logger.warning(f"{log_prefix} {sheet_id}: empty")
        return _error("empty", spreadsheet_id=sheet_id, sheets=_overview(sheets or []))

    result = await asyncio.to_thread(build_answer, sheets, query, sheet, max_chars)
    result["spreadsheet_id"] = sheet_id
    text = result.get("text") or result.get("message") or ""
    ms = int((time.monotonic() - started) * 1000)
    logger.info(
        f"{log_prefix} {sheet_id}: mode={result.get('mode')} query={query!r} "
        f"matches={result.get('matches', '-')} chars={len(text)} cache={'hit' if cached else 'miss'} "
        f"{ms} мс | {text[:200]!r}"
    )
    return result
