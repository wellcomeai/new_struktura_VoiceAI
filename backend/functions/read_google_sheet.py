# backend/functions/read_google_sheet.py
"""
Чтение открытой Google-таблицы по ссылке с поиском строк (прайс, наличие, расписание).
Логика — backend/services/google_sheet_reader.py (общая с инструментом агента).
"""
from typing import Any, Dict

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function
from backend.services import google_sheet_reader

logger = get_logger(__name__)


@register_function
class ReadGoogleSheetFunction(FunctionBase):
    """Чтение Google-таблицы по открытой ссылке"""

    @classmethod
    def get_name(cls) -> str:
        return "read_google_sheet"

    @classmethod
    def get_display_name(cls) -> str:
        return "Чтение Google Таблиц"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Читает Google-таблицу по ссылке (прайс, наличие, расписание) и находит нужные строки. "
            "url — ссылка на таблицу из инструкций, как есть. query — что ищем, так, как это "
            "записано в таблице: название товара/услуги, бренды латиницей, числа цифрами, без слов "
            "вопроса (пример: «iPhone 18 Pro 256 серый»). Маленькая таблица приходит целиком. "
            "Если found=false — переформулируй query, не придумывай ответ. "
            "Ошибка access_denied — таблица закрыта, ссылку не перебирай."
        )

    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Ссылка на Google-таблицу (docs.google.com/spreadsheets/d/...)",
                },
                "query": {
                    "type": "string",
                    "description": "Что найти в таблице: название как в таблице, например «iPhone 18 Pro 256»",
                },
                "sheet": {
                    "type": "string",
                    "description": "Название листа (вкладки), если нужно искать только в нём",
                },
            },
            "required": ["url"],
        }

    @classmethod
    def get_example_prompt(cls) -> str:
        return """
<p>Функция <code>read_google_sheet</code> читает Google-таблицу по ссылке: цены, наличие, расписание, тарифы.</p>

<p><strong>Подготовка таблицы:</strong> «Настройки доступа» → «Все, у кого есть ссылка» → «Читатель».
Читаются все видимые листы; первая строка листа — шапка (названия колонок).</p>

<p><strong>Что написать в промпте ассистента:</strong></p>
<pre>Цены и наличие товаров — в Google-таблице:
https://docs.google.com/spreadsheets/d/1AbC.../edit
Когда клиент спрашивает о цене или наличии, вызови read_google_sheet
с этой ссылкой и query — названием товара, как в таблице
(бренды латиницей, числа цифрами). Отвечай только по данным таблицы.</pre>

<p><strong>Пример вызова:</strong></p>
<pre>{
  "url": "https://docs.google.com/spreadsheets/d/1AbC.../edit",
  "query": "iPhone 18 Pro 256 серый"
}</pre>

<p><strong>Как ищет:</strong> небольшая таблица (до ~6000 символов) отдаётся целиком. В большой —
поиск по словам запроса: регистр, ё/е, падежи и опечатки не важны, числа сравниваются точно.
Возвращаются шапка листа и до 15 самых похожих строк. Данные кэшируются на 60 секунд —
изменение цены в таблице ассистент увидит через минуту.</p>

<p><strong>Ошибки:</strong> <code>access_denied</code> — таблица не открыта по ссылке;
<code>not_found</code> — неверная ссылка; <code>empty</code> — в таблице нет данных.</p>
"""

    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        url = (arguments or {}).get("url") or ""
        query = (arguments or {}).get("query")
        sheet = (arguments or {}).get("sheet")
        try:
            return await google_sheet_reader.read_sheet(
                url, query=query, sheet=sheet,
                max_chars=google_sheet_reader.VOICE_MAX_CHARS, log_prefix="[READ_GOOGLE_SHEET]",
            )
        except Exception as e:
            logger.error(f"[READ_GOOGLE_SHEET] Ошибка: {e!r}", exc_info=True)
            return {"success": False, "error": "internal_error",
                    "message": "Не удалось прочитать таблицу из-за внутренней ошибки."}
