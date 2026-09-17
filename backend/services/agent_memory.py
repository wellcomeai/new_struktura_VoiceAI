"""
Память агента (Voicyfy Agent) — собственный «блокнот» оркестратора, отдельный
от памяти контактов (`agent_contacts.memory`).

Хранится в `agent_configs.memory` (JSONB) как список коротких заметок с id по
трём секциям:
  • instructions — правила и пожелания владельца («не предлагать скидку»);
  • observations — наблюдения агента о работе в целом («утром отвечают чаще»);
  • plans        — намерения на будущее, не привязанные к контакту.

Заметки правятся ТОЧЕЧНО (add / update по id / delete по id), а не перезаписью
всего блока: так параллельные обработки событий одного агента (звонок и
сообщение у разных контактов) не затирают друг друга, а владелец может удалить
или поправить одну запись в интерфейсе. Мутации идут под `SELECT … FOR UPDATE`
строки агента (`lock_and_apply`), см. концовку файла.

Формат JSON:
{
  "notes": [
    {"id": "m1", "section": "instructions", "text": "...", "source": "owner|agent",
     "created_at": "2026-09-19T10:00:00", "updated_at": "..."}
  ],
  "next_id": 2
}
"""

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from backend.core.logging import get_logger

logger = get_logger(__name__)

# Секции: ключ → подпись для промпта и UI. Порядок = порядок вывода.
SECTIONS: List[Tuple[str, str]] = [
    ("instructions", "Инструкции владельца"),
    ("observations", "Наблюдения"),
    ("plans", "Планы"),
]
SECTION_KEYS = [k for k, _ in SECTIONS]
SECTION_LABELS = dict(SECTIONS)

# Подписи секций для интерфейса владельца (язык клиента, а не модели):
# в промпт идут SECTION_LABELS, в UI — эти.
SECTION_UI_LABELS = {
    "instructions": "Вы поручили",
    "observations": "Агент заметил",
    "plans": "Агент планирует",
}

# Лимиты — память обязана быть ограниченной, иначе она съест контекст и кэш промпта.
MAX_NOTES = 60
MAX_NOTE_CHARS = 400
MAX_TOTAL_CHARS = 8000

VALID_SOURCES = ("agent", "owner")


# ============================================================================
# Чистые функции над JSON-структурой
# ============================================================================

def normalize(raw: Any) -> Dict[str, Any]:
    """Привести значение колонки к каноническому виду {"notes": [...], "next_id": N}."""
    notes: List[Dict[str, Any]] = []
    next_id = 1
    if isinstance(raw, dict):
        for n in raw.get("notes") or []:
            if not isinstance(n, dict):
                continue
            nid = str(n.get("id") or "").strip()
            text = str(n.get("text") or "").strip()
            section = n.get("section") if n.get("section") in SECTION_KEYS else SECTION_KEYS[1]
            if not nid or not text:
                continue
            notes.append({
                "id": nid,
                "section": section,
                "text": text,
                "source": n.get("source") if n.get("source") in VALID_SOURCES else "agent",
                "created_at": n.get("created_at"),
                "updated_at": n.get("updated_at"),
            })
        try:
            next_id = max(1, int(raw.get("next_id") or 1))
        except (TypeError, ValueError):
            next_id = 1
    # next_id всегда больше любого уже занятого числового суффикса.
    for n in notes:
        if n["id"].startswith("m") and n["id"][1:].isdigit():
            next_id = max(next_id, int(n["id"][1:]) + 1)
    return {"notes": notes, "next_id": next_id}


def chars_used(memory: Dict[str, Any]) -> int:
    return sum(len(n["text"]) for n in memory.get("notes", []))


def _clean_text(text: Any) -> str:
    return " ".join(str(text or "").split()).strip()


def apply_ops(
    memory: Dict[str, Any],
    add: Optional[List[Dict[str, Any]]] = None,
    update: Optional[List[Dict[str, Any]]] = None,
    delete: Optional[List[str]] = None,
    source: str = "agent",
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Применить точечные операции к памяти. Возвращает (новая память, отчёт).

    Порядок: delete → update → add (чтобы «заменить заметку» = delete + add
    укладывалось в лимиты). Ошибки по отдельным элементам не прерывают остальные:
    что удалось — применяется, что нет — попадает в report["errors"].
    """
    mem = normalize(memory)
    notes = mem["notes"]
    by_id = {n["id"]: n for n in notes}
    now = datetime.utcnow().isoformat(timespec="seconds")
    source = source if source in VALID_SOURCES else "agent"

    report: Dict[str, Any] = {"ok": True, "added": [], "updated": [], "deleted": [], "errors": []}

    # ── delete ──
    for raw_id in delete or []:
        nid = str(raw_id or "").strip()
        if nid in by_id:
            notes.remove(by_id.pop(nid))
            report["deleted"].append(nid)
        else:
            report["errors"].append({"op": "delete", "id": nid, "error": "not_found"})

    # ── update ──
    for item in update or []:
        if not isinstance(item, dict):
            report["errors"].append({"op": "update", "error": "bad_item"})
            continue
        nid = str(item.get("id") or "").strip()
        note = by_id.get(nid)
        if not note:
            report["errors"].append({"op": "update", "id": nid, "error": "not_found"})
            continue
        text = _clean_text(item.get("text"))
        if not text:
            report["errors"].append({"op": "update", "id": nid, "error": "empty_text"})
            continue
        if len(text) > MAX_NOTE_CHARS:
            report["errors"].append({"op": "update", "id": nid, "error": f"note_too_long (max {MAX_NOTE_CHARS} chars)"})
            continue
        section = item.get("section")
        if section is not None and section not in SECTION_KEYS:
            report["errors"].append({"op": "update", "id": nid, "error": f"bad_section (use one of {SECTION_KEYS})"})
            continue
        note["text"] = text
        if section:
            note["section"] = section
        note["updated_at"] = now
        report["updated"].append(nid)

    # ── add ──
    for item in add or []:
        if not isinstance(item, dict):
            report["errors"].append({"op": "add", "error": "bad_item"})
            continue
        section = item.get("section")
        text = _clean_text(item.get("text"))
        if section not in SECTION_KEYS:
            report["errors"].append({"op": "add", "error": f"bad_section (use one of {SECTION_KEYS})", "text": text[:60]})
            continue
        if not text:
            report["errors"].append({"op": "add", "error": "empty_text"})
            continue
        if len(text) > MAX_NOTE_CHARS:
            report["errors"].append({"op": "add", "error": f"note_too_long (max {MAX_NOTE_CHARS} chars)", "text": text[:60]})
            continue
        if len(notes) >= MAX_NOTES:
            report["errors"].append({"op": "add", "error": f"limit_notes ({MAX_NOTES}) — delete something first", "text": text[:60]})
            continue
        if chars_used(mem) + len(text) > MAX_TOTAL_CHARS:
            report["errors"].append({"op": "add", "error": f"limit_chars ({MAX_TOTAL_CHARS}) — delete something first", "text": text[:60]})
            continue
        # Дубликат по тексту в той же секции — не плодим.
        dup = next((n for n in notes if n["section"] == section and n["text"].lower() == text.lower()), None)
        if dup:
            report["errors"].append({"op": "add", "error": "duplicate", "id": dup["id"]})
            continue
        nid = f"m{mem['next_id']}"
        mem["next_id"] += 1
        note = {
            "id": nid, "section": section, "text": text, "source": source,
            "created_at": now, "updated_at": now,
        }
        notes.append(note)
        by_id[nid] = note
        report["added"].append({"id": nid, "section": section})

    report["ok"] = not report["errors"] or bool(report["added"] or report["updated"] or report["deleted"])
    report["notes_count"] = len(notes)
    report["chars_used"] = chars_used(mem)
    report["chars_limit"] = MAX_TOTAL_CHARS
    report["notes_limit"] = MAX_NOTES
    return mem, report


def render_block(memory: Any) -> str:
    """
    Блок «ПАМЯТЬ АГЕНТА» для промпта. Динамический — приклеивается к
    user-сообщению рядом с блоком времени, чтобы system-промпт оставался
    статичным (кэш провайдера).
    """
    mem = normalize(memory)
    notes = mem["notes"]
    used = chars_used(mem)
    head = (
        f"\n\n# ПАМЯТЬ АГЕНТА (твой блокнот: {len(notes)} из {MAX_NOTES} заметок, "
        f"{used} из {MAX_TOTAL_CHARS} символов)"
    )
    if not notes:
        return head + "\n(пока пусто — веди её через update_agent_memory)"
    lines = [head]
    for key, label in SECTIONS:
        rows = [n for n in notes if n["section"] == key]
        lines.append(f"## {label} ({key})")
        if not rows:
            lines.append("(пусто)")
            continue
        for n in rows:
            who = " (от владельца)" if n.get("source") == "owner" else ""
            lines.append(f"- [{n['id']}]{who} {n['text']}")
    return "\n".join(lines)


def to_api(memory: Any) -> Dict[str, Any]:
    """Представление для фронтенда."""
    mem = normalize(memory)
    return {
        "notes": mem["notes"],
        "sections": [
            {"key": k, "label": v, "ui_label": SECTION_UI_LABELS.get(k, v)} for k, v in SECTIONS
        ],
        "count": len(mem["notes"]),
        "chars_used": chars_used(mem),
        "chars_limit": MAX_TOTAL_CHARS,
        "notes_limit": MAX_NOTES,
        "note_max_chars": MAX_NOTE_CHARS,
    }


# ============================================================================
# Работа с БД
# ============================================================================

def lock_and_apply(
    db: Session,
    agent_config_id,
    add: Optional[List[Dict[str, Any]]] = None,
    update: Optional[List[Dict[str, Any]]] = None,
    delete: Optional[List[str]] = None,
    source: str = "agent",
) -> Dict[str, Any]:
    """
    Атомарно применить операции к памяти агента: строка agent_configs берётся
    под FOR UPDATE, память перечитывается из БД (populate_existing — чтобы не
    работать с устаревшей копией из identity map), применяются операции,
    commit. Окно блокировки — только этот вызов.
    """
    from backend.models.agent_config import AgentConfig

    agent = (
        db.query(AgentConfig)
        .filter(AgentConfig.id == agent_config_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if not agent:
        return {"ok": False, "error": "agent_not_found"}

    new_mem, report = apply_ops(agent.memory, add=add, update=update, delete=delete, source=source)
    agent.memory = new_mem
    flag_modified(agent, "memory")
    db.commit()
    logger.info(
        f"[AGENT-MEMORY] agent {agent_config_id}: +{len(report['added'])} "
        f"~{len(report['updated'])} -{len(report['deleted'])} "
        f"(errors={len(report['errors'])}, total={report['notes_count']})"
    )
    return report
