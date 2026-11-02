# backend/functions/read_google_doc.py
"""
Функция для чтения текста из Google Документа по ссылке.
Ссылку на Google-таблицу передаёт в google_sheet_reader (как read_google_sheet).
"""
import aiohttp
from typing import Dict, Any, Optional

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function
from backend.services import google_sheet_reader

logger = get_logger(__name__)

def extract_document_id(url: str) -> Optional[str]:
    """
    ID Google Документа или файла Drive из ссылки (любой хвост: /edit, ?usp=, #...).
    Для ссылок на таблицы — None (их читает google_sheet_reader).
    """
    parsed = google_sheet_reader.parse_google_url(url)
    if not parsed or parsed["kind"] in ("spreadsheet", "presentation"):
        return None
    return parsed["id"]


@register_function
class ReadGoogleDocFunction(FunctionBase):
    """Функция для чтения текста из Google Документа"""
    
    @classmethod
    def get_name(cls) -> str:
        return "read_google_doc"
    
    @classmethod
    def get_display_name(cls) -> str:
        return "Чтение Google Документов"
    
    @classmethod
    def get_description(cls) -> str:
        return (
            "Читает текст из публичного Google Документа по ссылке. Ссылку на Google-таблицу "
            "тоже принимает: для таблиц передай query — что ищем (название как в таблице)."
        )
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Ссылка на Google Документ (должен быть публичным или доступным по ссылке)"
                },
                "query": {
                    "type": "string",
                    "description": "Только для Google-таблиц: что найти (название как в таблице)"
                }
            },
            "required": ["url"]
        }
    
    @classmethod
    def get_example_prompt(cls) -> str:
        return """
<p>Ты можешь использовать функцию <code>read_google_doc</code> для чтения содержимого Google Документов.</p>

<p><strong>Когда использовать:</strong></p>
<ul>
    <li>Пользователь дает ссылку на Google Document</li>
    <li>Нужно прочитать инструкцию, политику, договор из Google Docs</li>
    <li>Требуется проанализировать или резюмировать содержимое документа</li>
    <li>Пользователь просит найти информацию в документе</li>
    <li>Нужно ответить на вопросы по содержанию документа</li>
</ul>

<p><strong>Параметры функции:</strong></p>
<ul>
    <li><code>url</code> — ссылка на Google Документ</li>
</ul>

<p><strong>Пример вызова:</strong></p>
<pre>{
  "url": "https://docs.google.com/document/d/1ABC123XYZ456/edit"
}</pre>

<p><strong>Результат:</strong></p>
<pre>{
  "success": true,
  "text": "Полный текст документа...",
  "length": 2547,
  "document_id": "1ABC123XYZ456"
}</pre>

<p><strong>💡 Как работать с результатом:</strong></p>
<ul>
    <li>После получения текста ты можешь отвечать на вопросы о содержимом</li>
    <li>Резюмировать документ в несколько предложений</li>
    <li>Найти конкретную информацию (цены, даты, условия)</li>
    <li>Сравнить с другими источниками</li>
</ul>

<p><strong>⚠️ Требования к документу:</strong></p>
<ul>
    <li>Документ должен быть <strong>публичным</strong> или доступным по ссылке</li>
    <li>Настройка доступа: "Все, у кого есть ссылка, могут просматривать"</li>
    <li>Если доступ запрещен (403), попроси пользователя открыть доступ</li>
</ul>

<p><strong>Поддерживаемые форматы URL:</strong></p>
<ul>
    <li><code>https://docs.google.com/document/d/DOCUMENT_ID/edit</code></li>
    <li><code>https://drive.google.com/file/d/DOCUMENT_ID/view</code></li>
    <li><code>https://docs.google.com/spreadsheets/d/ID/edit</code> — таблица: читается как в
        <code>read_google_sheet</code> (для таблиц лучше включить её)</li>
</ul>

<p><strong>Примеры использования:</strong></p>
<ul>
    <li>"Прочитай этот документ и скажи, какие там условия"</li>
    <li>"Что написано в разделе 'Цены' в этом документе?"</li>
    <li>"Резюмируй основные пункты этого договора"</li>
</ul>
"""
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Читает текст из Google Документа. Ссылку на Google-таблицу передаёт в
        google_sheet_reader (раньше такая ссылка давала «Invalid Google Docs URL»).
        """
        url = (arguments or {}).get("url")
        try:
            if not url:
                logger.warning("[READ_GOOGLE_DOC] Пустой url")
                return {"success": False, "error": "invalid_url", "message": "URL is required"}

            if google_sheet_reader.is_spreadsheet_url(url):
                logger.info(f"[READ_GOOGLE_DOC] Ссылка на таблицу → read_google_sheet: {url}")
                return await google_sheet_reader.read_sheet(
                    url, query=(arguments or {}).get("query"),
                    max_chars=google_sheet_reader.VOICE_MAX_CHARS, log_prefix="[READ_GOOGLE_DOC]",
                )

            doc_id = extract_document_id(url)
            if not doc_id:
                logger.warning(f"[READ_GOOGLE_DOC] invalid_url: {url!r}")
                return {
                    "success": False, "error": "invalid_url",
                    "message": "Не удалось распознать ссылку на Google Документ "
                               "(нужна docs.google.com/document/d/<ID>/...)",
                }

            export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
            async with aiohttp.ClientSession() as session:
                async with session.get(export_url, timeout=30) as response:
                    status = response.status
                    ctype = response.headers.get("Content-Type", "")
                    final_host = response.url.host or ""
                    text = await response.text() if status == 200 else ""
            logger.info(f"[READ_GOOGLE_DOC] {doc_id}: HTTP {status}, {len(text)} символов, "
                        f"{ctype or '-'}, host={final_host}")

            if status in (401, 403) or "accounts.google.com" in final_host or (
                    status == 200 and "text/html" in ctype):
                # Закрытый документ: Google отвечает редиректом на страницу входа (HTML, 200)
                logger.warning(f"[READ_GOOGLE_DOC] {doc_id}: access_denied")
                return {
                    "success": False, "error": "access_denied",
                    "message": "Доступ запрещен. Документ должен быть открыт «Все, у кого есть ссылка»",
                }
            if status == 404:
                logger.warning(f"[READ_GOOGLE_DOC] {doc_id}: not_found")
                return {"success": False, "error": "not_found",
                        "message": "Документ не найден. Проверьте корректность ссылки"}
            if status != 200:
                logger.warning(f"[READ_GOOGLE_DOC] {doc_id}: HTTP {status}")
                return {"success": False, "error": "http_error",
                        "message": f"Ошибка при получении документа: HTTP {status}"}

            # Убираем лишние пустые строки
            cleaned_text = "\n".join(line for line in text.split("\n") if line.strip())
            if not cleaned_text:
                logger.warning(f"[READ_GOOGLE_DOC] {doc_id}: empty")
                return {"success": False, "error": "empty", "message": "Документ пустой"}

            logger.info(f"[READ_GOOGLE_DOC] {doc_id}: {len(cleaned_text)} символов | "
                        f"{cleaned_text[:200]!r}")
            return {
                "success": True,
                "text": cleaned_text,
                "length": len(cleaned_text),
                "document_id": doc_id,
            }

        except Exception as e:
            logger.error(f"[READ_GOOGLE_DOC] Ошибка: {str(e)}")
            return {
                "success": False, "error": "internal_error",
                "message": f"Failed to read document: {str(e)}",
            }
