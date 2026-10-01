"""
Умный поиск контакта агента по имени / телефону / компании.

Раньше query был одной подстрокой `ILIKE '%запрос%'`, и «Петров Иван» не находил
«Иван Петров», «Алёна» — «Алена», «8 999 123-45-67» — «+79991234567», «Петрову» —
«Петров». Модель тратила шаги на перебор вариантов и листание базы.

Теперь:
- query похож на телефон → сравнение только по цифрам (последние 10, 8/7 в начале
  не важны);
- иначе query бьётся на слова, каждое слово ищется в имени или компании (условия
  через «И», порядок слов не важен), ё = е, регистр не важен;
- если точных совпадений нет — fuzzy_candidates: падежи, опечатки, похожий номер
  (без LLM и без расширений Postgres, считается в Python по строкам агента).
"""

import re
from difflib import SequenceMatcher
from typing import Iterable, List, Optional, Tuple

from sqlalchemy import and_, func, or_

from backend.models.agent_contact import AgentContact

# Символы, из которых может состоять номер телефона в запросе.
_PHONE_RE = re.compile(r"^[\d\s()+\-.]+$")
_WORD_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)
# Сколько контактов агента читаем для нечёткого поиска (лимит импорта — 10 000).
FUZZY_SCAN_LIMIT = 20000
FUZZY_MIN_SCORE = 0.72
PHONE_MIN_SCORE = 0.85


def normalize_text(value: Optional[str]) -> str:
    """Нижний регистр, ё → е, схлопнутые пробелы."""
    return " ".join((value or "").lower().replace("ё", "е").split())


def phone_digits(value: Optional[str]) -> str:
    """Только цифры; российский номер из 11 цифр на 7/8 → последние 10."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits[0] in "78":
        return digits[1:]
    return digits


def parse_query(query: Optional[str]) -> Tuple[Optional[str], List[str]]:
    """
    Разбирает запрос: (цифры телефона, слова). Телефон — если запрос состоит только
    из цифр и телефонных символов и цифр не меньше 3; тогда слов нет.
    """
    q = (query or "").strip()
    if not q:
        return None, []
    if _PHONE_RE.match(q):
        digits = phone_digits(q)
        if len(digits) >= 3:
            return digits, []
    return None, _WORD_RE.findall(normalize_text(q))


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def sql_text(column):
    """Колонка без учёта регистра и ё/е (дальше — ilike по нормализованному слову)."""
    return func.translate(column, "Ёё", "Ее")


def sql_digits(column):
    return func.regexp_replace(column, r"\D", "", "g")


def text_ilike(column, word: str):
    return sql_text(column).ilike(f"%{_escape_like(word)}%", escape="\\")


def query_condition(query: Optional[str]):
    """SQL-условие для AgentContact по query; None — запрос пустой."""
    digits, words = parse_query(query)
    if digits:
        return sql_digits(AgentContact.phone).like(f"%{digits}%")
    conds = []
    for word in words:
        alts = [text_ilike(AgentContact.name, word), text_ilike(AgentContact.company, word)]
        if word.isdigit() and len(word) >= 3:
            alts.append(sql_digits(AgentContact.phone).like(f"%{word}%"))
        conds.append(or_(*alts))
    if not conds:
        return None
    return and_(*conds)


# ============================================================================
# НЕЧЁТКИЙ ПОИСК
# ============================================================================

def _word_similarity(token: str, word: str) -> float:
    if token == word:
        return 1.0
    shorter = min(len(token), len(word))
    if shorter >= 3 and (word.startswith(token) or token.startswith(word)):
        # «Петров» / «Петрову», «Ив» не считаем — слишком коротко.
        return 0.9
    # Общая основа: «Петрова» / «Петровой», «Алексей» / «Алексея».
    common = 0
    for a, b in zip(token, word):
        if a != b:
            break
        common += 1
    if shorter >= 4 and common >= 4 and common >= shorter - 2:
        return 0.85
    matcher = SequenceMatcher(None, token, word)
    if matcher.real_quick_ratio() < FUZZY_MIN_SCORE or matcher.quick_ratio() < FUZZY_MIN_SCORE:
        return 0.0
    return matcher.ratio()


def _row_score(digits: Optional[str], tokens: List[str], name: str, company: str, phone: str) -> float:
    if digits:
        contact_digits = phone_digits(phone)
        if not contact_digits:
            return 0.0
        if len(digits) >= 7 and digits[-7:] in contact_digits:
            return 0.8
        if len(digits) >= 7:
            # Одна-две ошибки в номере; случайные номера дают ~0.8 — отсекаем.
            ratio = SequenceMatcher(None, digits, contact_digits).ratio()
            return ratio if ratio >= PHONE_MIN_SCORE else 0.0
        return 0.0
    words = _WORD_RE.findall(normalize_text(f"{name} {company}"))
    if not words or not tokens:
        return 0.0
    scores = [max(_word_similarity(t, w) for w in words) for t in tokens]
    return sum(scores) / len(scores)


def fuzzy_candidates(rows: Iterable, query: str, limit: int = 5) -> List[dict]:
    """
    Похожие контакты, когда точного совпадения нет.
    rows — кортежи (id, name, phone, company, status). Чистая функция без БД:
    вызывайте через asyncio.to_thread, если строк много.
    """
    digits, tokens = parse_query(query)
    tokens = [t for t in tokens if len(t) >= 2]
    if not digits and not tokens:
        return []
    scored = []
    for row in rows:
        cid, name, phone, company, status = row
        score = _row_score(digits, tokens, name or "", company or "", phone or "")
        if score >= FUZZY_MIN_SCORE:
            scored.append((score, row))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, (cid, name, phone, company, status) in scored[:limit]:
        item = {"id": str(cid), "name": name, "phone": phone, "company": company,
                "stage": status, "score": round(score, 2)}
        out.append({k: v for k, v in item.items() if v not in (None, "")})
    return out
