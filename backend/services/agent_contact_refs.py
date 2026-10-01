"""
Контакты, найденные в чате с оркестратором, — между сообщениями.

В историю чата сохраняется только текст ответа, результаты инструментов теряются.
Из-за этого на «а позвони ему завтра» модель не знала id контакта, найденного в
прошлом сообщении: искала заново (тратила шаги) или выдумывала id.

Теперь цикл чата собирает контакты из результатов инструментов
(collect_contact_refs), они сохраняются полем "contacts" у ответа ассистента
в истории, а к следующему сообщению владельца приклеивается блок
build_recent_contacts_block с id контактов из последних ответов.
"""

import json
import uuid
from typing import Any, Dict, List, Optional

# Контактов из одного результата инструмента (длинный список — берём начало).
REFS_PER_RESULT = 15
# Контактов, сохраняемых у одного ответа ассистента.
REFS_PER_TURN = 15
# Из скольких последних ответов ассистента собирать блок.
REFS_HISTORY_TURNS = 6
# Строк в блоке у сообщения владельца.
REFS_BLOCK_MAX = 25


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _as_ref(node: dict) -> Optional[dict]:
    """Контакт из словаря результата: строки search/find_contact, карточка, задачи."""
    if "phone" in node and ("id" in node or "contact_id" in node or "agent_contact_id" in node):
        cid = node.get("agent_contact_id") or node.get("contact_id") or node.get("id")
        name = node.get("name") or node.get("contact_name")
        phone = node.get("phone")
    elif "agent_contact_id" in node and ("contact_name" in node or "contact_phone" in node):
        cid = node.get("agent_contact_id")
        name = node.get("contact_name")
        phone = node.get("contact_phone")
    else:
        return None
    if not cid or not _is_uuid(cid):
        return None
    ref = {"id": str(cid), "name": name, "phone": phone}
    return {k: v for k, v in ref.items() if v}


def _walk(node: Any, found: List[dict], depth: int = 0) -> None:
    if depth > 6 or len(found) >= REFS_PER_RESULT:
        return
    if isinstance(node, dict):
        ref = _as_ref(node)
        if ref:
            found.append(ref)
        for value in node.values():
            if isinstance(value, (dict, list)):
                _walk(value, found, depth + 1)
    elif isinstance(node, list):
        for item in node:
            if len(found) >= REFS_PER_RESULT:
                return
            _walk(item, found, depth + 1)


def collect_contact_refs(result: Any, refs: Dict[str, dict]) -> None:
    """
    Дописывает в refs (id → {id, name, phone}) контакты из результата инструмента
    (JSON-строка или dict). Упомянутые позже переезжают в конец — самые свежие.
    """
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return
    found: List[dict] = []
    _walk(result, found)
    for ref in found:
        prev = refs.pop(ref["id"], {})
        refs[ref["id"]] = {**prev, **ref}


def refs_for_history(refs: Dict[str, dict]) -> List[dict]:
    """Список для поля "contacts" ответа в истории: последние упомянутые."""
    return list(refs.values())[-REFS_PER_TURN:]


def build_recent_contacts_block(history: Optional[list]) -> str:
    """
    Блок к сообщению владельца: контакты из последних ответов ассистента, свежие
    первыми. Пусто — пустая строка.
    """
    seen = set()
    lines = []
    assistant_turns = [m for m in (history or []) if m.get("role") == "assistant"]
    for msg in reversed(assistant_turns[-REFS_HISTORY_TURNS:]):
        for ref in reversed(msg.get("contacts") or []):
            cid = ref.get("id")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            label = ", ".join(x for x in (ref.get("name"), ref.get("phone")) if x) or "без имени"
            lines.append(f"- {label} — id {cid}")
            if len(lines) >= REFS_BLOCK_MAX:
                break
        if len(lines) >= REFS_BLOCK_MAX:
            break
    if not lines:
        return ""
    return (
        "\n\n[КОНТАКТЫ ИЗ НЕДАВНЕГО ДИАЛОГА — служебная справка, владельцу не показывай. "
        "Если владелец говорит о ком-то из них («ему», «этому клиенту», по имени) — бери id "
        "отсюда, не ищи заново]\n" + "\n".join(lines)
    )
