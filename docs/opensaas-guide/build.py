#!/usr/bin/env python3
"""Собирает PDF-гайд из index.html.

Запуск:  python3 docs/opensaas-guide/build.py
Зависимости: pip install playwright pypdf
(браузер Chromium должен быть уже установлен в системе)

Документ рендерится дважды: без колонтитула и с колонтитулом.
В итоговый файл берётся обложка из первого прогона и все остальные
страницы из второго — так на титульной странице не остаётся номера.
"""
import pathlib
import sys
import tempfile

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "index.html"
OUT = HERE / "OpenSaaS-Amvera-Chast-1.pdf"

CHROME_CANDIDATES = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
]

FOOTER = """
<div style="width:100%;font-family:sans-serif;font-size:7.5pt;color:#94a3b8;
            padding:0 17mm;display:flex;justify-content:space-between;align-items:center;">
  <span>OpenSaaS на Amvera · Часть 1: запуск за 30 минут</span>
  <span class="pageNumber"></span>
</div>"""

EMPTY = '<div style="display:none"></div>'

MARGIN = {"top": "19mm", "bottom": "20mm", "left": "17mm", "right": "17mm"}


def find_chrome():
    for path in CHROME_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    return None  # playwright возьмёт браузер по умолчанию


def render(page, path, with_footer):
    page.pdf(
        path=path,
        format="A4",
        print_background=True,
        display_header_footer=with_footer,
        header_template=EMPTY,
        footer_template=FOOTER if with_footer else EMPTY,
        margin=MARGIN,
    )


def main():
    if not SRC.exists():
        sys.exit(f"не найден {SRC}")

    tmp = pathlib.Path(tempfile.mkdtemp())
    plain, numbered = tmp / "plain.pdf", tmp / "numbered.pdf"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=find_chrome())
        page = browser.new_page()
        page.goto(SRC.as_uri(), wait_until="networkidle")
        page.emulate_media(media="print")
        render(page, str(plain), with_footer=False)
        render(page, str(numbered), with_footer=True)
        browser.close()

    merge(plain, numbered, OUT)
    print(f"готово: {OUT}  ({OUT.stat().st_size / 1024:.0f} КБ)")


def merge(plain, numbered, out):
    """Обложка — из версии без колонтитула, остальное — из версии с номерами."""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        pathlib.Path(numbered).replace(out)
        print("pypdf не установлен — номер страницы останется и на обложке")
        return

    writer = PdfWriter()
    writer.add_page(PdfReader(str(plain)).pages[0])
    for pg in PdfReader(str(numbered)).pages[1:]:
        writer.add_page(pg)
    with open(out, "wb") as fh:
        writer.write(fh)


if __name__ == "__main__":
    main()
