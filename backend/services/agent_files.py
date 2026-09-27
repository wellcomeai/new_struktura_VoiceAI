"""
Файлы агента: генерация PDF и таблиц xlsx, хранение, ссылки на скачивание.

  • build_pdf(title, content)  — PDF из простой разметки (заголовки #, списки
    -, нумерация 1., таблицы |a|b|, **жирный**, разделитель ---). Кириллица —
    шрифт DejaVu из backend/assets/fonts (на сервере системных шрифтов нет).
  • build_xlsx(sheets)          — xlsx из листов {name, columns, rows}.
  • save_file(...)              — запись в agent_files (байты в Postgres).
  • public_url(file)            — публичная ссылка с токеном для клиента/владельца.

Лимиты: AGENT_FILE_MAX_BYTES на файл, строки/листы в таблицах ограничены,
чтобы модель не могла положить сервер огромным документом.
"""

import io
import os
import re
import secrets
from datetime import datetime
from typing import List, Optional, Tuple
from xml.sax.saxutils import escape

from sqlalchemy.orm import Session

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.models.agent_file import AgentFile

logger = get_logger(__name__)

AGENT_FILE_MAX_BYTES = 5 * 1024 * 1024
PDF_CONTENT_MAX_CHARS = 60_000
XLSX_MAX_SHEETS = 10
XLSX_MAX_ROWS = 5_000
XLSX_MAX_COLS = 50

MIME = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

_FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "fonts")
_FONT = "DejaVuSans"
_FONT_BOLD = "DejaVuSans-Bold"
_fonts_registered = False


# ── Имена файлов и ссылки ───────────────────────────────────────────────────

def safe_filename(name: Optional[str], ext: str, fallback: str = "document") -> str:
    """Имя файла без опасных символов (кириллица остаётся), с нужным расширением."""
    base = (name or "").strip()
    if base.lower().endswith("." + ext):
        base = base[: -(len(ext) + 1)]
    base = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", base)
    base = re.sub(r"\s+", " ", base).strip(" .")[:100]
    return f"{base or fallback}.{ext}"


def public_url(f: AgentFile) -> str:
    """Публичная ссылка на скачивание (токен в пути — ссылку можно отправить клиенту)."""
    from urllib.parse import quote
    base = (settings.PUBLIC_BASE_URL or settings.HOST_URL or "").rstrip("/")
    return f"{base}/api/agent-files/{f.id}/{f.token}/{quote(f.filename)}"


def save_file(
    db: Session, *, user_id, agent_config_id, kind: str, filename: str,
    content: bytes, title: Optional[str] = None, agent_contact_id=None,
) -> AgentFile:
    if len(content) > AGENT_FILE_MAX_BYTES:
        raise ValueError(f"Файл больше {AGENT_FILE_MAX_BYTES // (1024 * 1024)} МБ — сократи содержимое")
    f = AgentFile(
        user_id=user_id,
        agent_config_id=agent_config_id,
        agent_contact_id=agent_contact_id,
        kind=kind,
        filename=filename,
        title=(title or "")[:255] or None,
        mime_type=MIME[kind],
        size_bytes=len(content),
        content=content,
        token=secrets.token_urlsafe(24),
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    logger.info(f"[AGENT-FILES] Saved {kind} {f.id} ({len(content)} bytes) for agent {agent_config_id}")
    return f


def get_agent_file(db: Session, file_id, agent_config_id) -> Optional[AgentFile]:
    """Файл этого агента по id (изоляция агентов) или None."""
    try:
        return db.query(AgentFile).filter(
            AgentFile.id == file_id,
            AgentFile.agent_config_id == agent_config_id,
        ).first()
    except Exception:
        return None


def file_result(f: AgentFile) -> dict:
    """Ответ тулзы о созданном файле."""
    return {
        "ok": True,
        **f.to_dict(),
        "url": public_url(f),
        "note": (
            "Файл готов. Отправить вложением: telegram_send_message / max_send_message "
            "с file_id, владельцу — send_telegram_notification с file_id; в SMS или "
            "чате — давай ссылку url."
        ),
    }


# ── PDF ─────────────────────────────────────────────────────────────────────

def _register_fonts():
    global _fonts_registered
    if _fonts_registered:
        return
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.fonts import addMapping
    pdfmetrics.registerFont(TTFont(_FONT, os.path.join(_FONTS_DIR, "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont(_FONT_BOLD, os.path.join(_FONTS_DIR, "DejaVuSans-Bold.ttf")))
    addMapping(_FONT, 0, 0, _FONT)
    addMapping(_FONT, 1, 0, _FONT_BOLD)
    addMapping(_FONT, 0, 1, _FONT)
    addMapping(_FONT, 1, 1, _FONT_BOLD)
    _fonts_registered = True


_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_TABLE_SEP_RE = re.compile(r"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$")
_NUM_RE = re.compile(r"^(\d{1,3})[.)]\s+(.*)$")


def _inline(text: str) -> str:
    """Экранирование XML + **жирный** → <b> (разметка Paragraph reportlab)."""
    return _BOLD_RE.sub(r"<b>\1</b>", escape(text.strip()))


def _table_cells(line: str) -> List[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def build_pdf(title: str, content: str) -> bytes:
    """PDF (A4) из простой разметки. Бросает ValueError на пустом содержимом."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, ListFlowable,
        ListItem, HRFlowable,
    )

    content = (content or "").strip()
    if not content:
        raise ValueError("Пустое содержимое документа")
    if len(content) > PDF_CONTENT_MAX_CHARS:
        raise ValueError(f"Слишком длинный документ (больше {PDF_CONTENT_MAX_CHARS} символов)")

    _register_fonts()
    base = ParagraphStyle("base", fontName=_FONT, fontSize=10.5, leading=15, spaceAfter=5)
    styles = {
        "title": ParagraphStyle("title", parent=base, fontName=_FONT_BOLD, fontSize=18, leading=23, spaceAfter=10),
        1: ParagraphStyle("h1", parent=base, fontName=_FONT_BOLD, fontSize=15, leading=20, spaceBefore=8, spaceAfter=6),
        2: ParagraphStyle("h2", parent=base, fontName=_FONT_BOLD, fontSize=13, leading=17, spaceBefore=6, spaceAfter=4),
        3: ParagraphStyle("h3", parent=base, fontName=_FONT_BOLD, fontSize=11.5, leading=15, spaceBefore=4, spaceAfter=3),
        "cell": ParagraphStyle("cell", parent=base, fontSize=9.5, leading=12.5, spaceAfter=0),
        "cellh": ParagraphStyle("cellh", parent=base, fontName=_FONT_BOLD, fontSize=9.5, leading=12.5, spaceAfter=0),
    }

    story = []
    if title and title.strip():
        story.append(Paragraph(_inline(title), styles["title"]))

    lines = content.splitlines()
    i = 0
    para: List[str] = []

    def flush_para():
        if para:
            story.append(Paragraph(_inline(" ".join(para)), base))
            para.clear()

    width = A4[0] - 36 * mm
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()

        if not line:
            flush_para()
            i += 1
            continue

        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            flush_para()
            story.append(Paragraph(_inline(m.group(2)), styles[len(m.group(1))]))
            i += 1
            continue

        if re.fullmatch(r"-{3,}|\*{3,}|_{3,}", line):
            flush_para()
            story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#CBD5E1"),
                                    spaceBefore=4, spaceAfter=6))
            i += 1
            continue

        if line.startswith("|"):
            flush_para()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cur = lines[i].strip()
                if not _TABLE_SEP_RE.match(cur):
                    rows.append(_table_cells(cur))
                i += 1
            if rows:
                ncols = max(len(r) for r in rows)
                data = []
                for ri, r in enumerate(rows):
                    r = r + [""] * (ncols - len(r))
                    st = styles["cellh"] if ri == 0 else styles["cell"]
                    data.append([Paragraph(_inline(c), st) for c in r])
                t = Table(data, colWidths=[width / ncols] * ncols, repeatRows=1)
                t.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF9")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                story.append(t)
                story.append(Spacer(1, 6))
            continue

        bullet = re.match(r"^[-*•]\s+(.*)$", line)
        num = _NUM_RE.match(line)
        if bullet or num:
            flush_para()
            items = []
            numbered = bool(num) and not bullet
            while i < len(lines):
                cur = lines[i].strip()
                b = re.match(r"^[-*•]\s+(.*)$", cur)
                n = _NUM_RE.match(cur)
                if numbered and n:
                    items.append(n.group(2))
                elif not numbered and b:
                    items.append(b.group(1))
                else:
                    break
                i += 1
            story.append(ListFlowable(
                [ListItem(Paragraph(_inline(t), base), leftIndent=12) for t in items],
                bulletType="1" if numbered else "bullet",
                bulletFontName=_FONT, bulletFontSize=9 if not numbered else 10,
                start=None if not numbered else 1,
                bulletFormat="%s." if numbered else None,
                leftIndent=14,
            ))
            continue

        para.append(line)
        i += 1
    flush_para()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=16 * mm,
        title=(title or "").strip() or "Документ", author="Voicyfy Agent",
    )
    doc.build(story)
    return buf.getvalue()


# ── XLSX ────────────────────────────────────────────────────────────────────

def _xlsx_value(v):
    """Числа и булевы — как есть (Excel посчитает), остальное — строкой."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "Да" if v else "Нет"
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, (dict, list)):
        import json
        v = json.dumps(v, ensure_ascii=False)
    return str(v)[:32_000]


def build_xlsx(sheets: List[dict]) -> Tuple[bytes, int]:
    """xlsx из [{name, columns, rows}]. Возвращает (байты, число строк данных)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    if not sheets:
        raise ValueError("Нет листов: передай sheets=[{name, columns, rows}]")
    if len(sheets) > XLSX_MAX_SHEETS:
        raise ValueError(f"Максимум {XLSX_MAX_SHEETS} листов")

    wb = Workbook()
    wb.remove(wb.active)
    used_names = set()
    total_rows = 0
    fill = PatternFill("solid", fgColor="E8EEF9")
    for idx, sh in enumerate(sheets, start=1):
        name = re.sub(r"[\[\]:*?/\\]", " ", str(sh.get("name") or f"Лист {idx}")).strip()[:31] or f"Лист {idx}"
        while name in used_names:
            name = (name[:28] + f" {idx}")[:31]
        used_names.add(name)
        ws = wb.create_sheet(name)

        columns = [str(c) for c in (sh.get("columns") or [])][:XLSX_MAX_COLS]
        rows = sh.get("rows") or []
        if len(rows) > XLSX_MAX_ROWS:
            raise ValueError(f"Максимум {XLSX_MAX_ROWS} строк на лист")
        if columns:
            ws.append(columns)
        widths = [len(c) for c in columns]
        for r in rows:
            if isinstance(r, dict):
                vals = [r.get(c) for c in columns] if columns else list(r.values())
            elif isinstance(r, (list, tuple)):
                vals = list(r)
            else:
                vals = [r]
            vals = [_xlsx_value(v) for v in vals[:XLSX_MAX_COLS]]
            ws.append(vals)
            # Защита от формул: текст модели/клиента, начинающийся с «=», —
            # строка, а не формула Excel.
            for cell in ws[ws.max_row]:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    cell.data_type = "s"
            for ci, v in enumerate(vals):
                ln = min(len(str(v)), 60)
                if ci >= len(widths):
                    widths.append(ln)
                elif ln > widths[ci]:
                    widths[ci] = ln
            total_rows += 1

        for ci, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(ci)].width = max(8, min(w + 2, 62))
        if columns:
            for ci in range(1, len(columns) + 1):
                cell = ws.cell(row=1, column=ci)
                cell.font = Font(bold=True)
                cell.fill = fill
                cell.alignment = Alignment(vertical="center")
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), total_rows


def default_filename(prefix: str) -> str:
    return f"{prefix} {datetime.utcnow().strftime('%Y-%m-%d')}"
