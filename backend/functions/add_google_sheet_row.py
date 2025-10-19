# backend/functions/add_google_sheet_row.py
"""
Функция для добавления строки в Google Таблицу.
Использует Service Account для записи в публичные/доступные таблицы.
"""
import re
import asyncio
from typing import Dict, Any, Optional

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function
from backend.services.google_sheets_service import GoogleSheetsService

logger = get_logger(__name__)

def extract_spreadsheet_id(url: str) -> Optional[str]:
    """Извлекает ID таблицы из URL"""
    match = re.search(r'docs\.google\.com/spreadsheets/d/([a-zA-Z0-9-_]+)', url)
    return match.group(1) if match else None

@register_function
class AddGoogleSheetRowFunction(FunctionBase):
    """Функция для добавления строки в Google Таблицу через Service Account"""
    
    @classmethod
    def get_name(cls) -> str:
        return "add_google_sheet_row"
    
    @classmethod
    def get_description(cls) -> str:
        return "Добавляет новую строку в Google Таблицу. Таблица должна быть доступна для редактирования."
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL Google Таблицы"
                },
                "row_to_append": {
                    "type": "string",
                    "description": "Данные для добавления, разделенные ;; (например: 'Иван Петров;;ivan@mail.com;;+79991234567')"
                },
                "sheet_name": {
                    "type": "string",
                    "description": "Название листа (опционально, по умолчанию первый лист)"
                }
            },
            "required": ["url", "row_to_append"]
        }
    
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Добавляет строку в Google Таблицу через ваш Service Account.
        """
        try:
            url = arguments.get("url")
            row_to_append = arguments.get("row_to_append", "")
            sheet_name = arguments.get("sheet_name", "")
            
            # Валидация
            if not url:
                return {"error": "URL таблицы обязателен"}
            
            if not row_to_append:
                return {"error": "Данные для добавления обязательны"}
            
            # Парсим данные (разделитель ;;)
            values = [v.strip() for v in row_to_append.split(";;")]
            
            if not values:
                return {"error": "Нет данных для добавления"}
            
            # Извлекаем ID таблицы
            spreadsheet_id = extract_spreadsheet_id(url)
            
            if not spreadsheet_id:
                return {"error": "Некорректный URL Google Таблицы"}
            
            logger.info(f"[ADD_GOOGLE_SHEET_ROW] ━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📊 Spreadsheet ID: {spreadsheet_id}")
            logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📝 Values: {values}")
            logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📄 Sheet: {sheet_name or 'default'}")
            
            # Используем существующий GoogleSheetsService с вашим Service Account
            loop = asyncio.get_event_loop()
            
            def append_row_sync():
                """Синхронная функция для выполнения в thread pool"""
                try:
                    logger.info("[ADD_GOOGLE_SHEET_ROW] 🔧 Получаем Sheets service...")
                    
                    # Используем ваш GoogleSheetsService (он сам знает про Service Account)
                    service = GoogleSheetsService._get_sheets_service()
                    
                    logger.info("[ADD_GOOGLE_SHEET_ROW] ✅ Service получен")
                    
                    # Определяем диапазон для добавления
                    if sheet_name:
                        range_notation = f"{sheet_name}!A:Z"
                    else:
                        range_notation = "A:Z"  # Первый лист, все колонки
                    
                    logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📍 Range: {range_notation}")
                    
                    # Подготавливаем тело запроса
                    body = {'values': [values]}
                    
                    logger.info("[ADD_GOOGLE_SHEET_ROW] 🚀 Отправляем запрос к Google Sheets API...")
                    
                    # Добавляем строку через API
                    result = service.spreadsheets().values().append(
                        spreadsheetId=spreadsheet_id,
                        range=range_notation,
                        valueInputOption='RAW',
                        insertDataOption='INSERT_ROWS',
                        body=body
                    ).execute()
                    
                    logger.info("[ADD_GOOGLE_SHEET_ROW] ✅ Запрос выполнен успешно!")
                    
                    # Получаем информацию о добавленной строке
                    updates = result.get('updates', {})
                    updated_range = updates.get('updatedRange', '')
                    updated_rows = updates.get('updatedRows', 0)
                    updated_cells = updates.get('updatedCells', 0)
                    
                    logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📊 Updated range: {updated_range}")
                    logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📊 Updated rows: {updated_rows}")
                    logger.info(f"[ADD_GOOGLE_SHEET_ROW] 📊 Updated cells: {updated_cells}")
                    
                    # Извлекаем номер строки из updated_range
                    # Формат: "Sheet1!A10:C10" → номер строки = 10
                    row_number = None
                    if updated_range:
                        match = re.search(r'!A(\d+):', updated_range)
                        if match:
                            row_number = int(match.group(1))
                    
                    logger.info("[ADD_GOOGLE_SHEET_ROW] ━━━━━━━━━━━━━━━━━━━━━━━━━")
                    logger.info(f"[ADD_GOOGLE_SHEET_ROW] ✅ УСПЕХ! Строка {row_number} добавлена")
                    logger.info("[ADD_GOOGLE_SHEET_ROW] ━━━━━━━━━━━━━━━━━━━━━━━━━")
                    
                    return {
                        "success": True,
                        "message": f"Строка успешно добавлена в таблицу{f' (строка №{row_number})' if row_number else ''}",
                        "spreadsheet_id": spreadsheet_id,
                        "sheet_name": sheet_name or "default",
                        "row_number": row_number,
                        "values_added": values,
                        "cells_updated": updated_cells
                    }
                    
                except Exception as e:
                    error_str = str(e)
                    logger.error(f"[ADD_GOOGLE_SHEET_ROW] ❌ Ошибка: {error_str}")
                    
                    # Понятные сообщения об ошибках
                    if "403" in error_str or "PERMISSION_DENIED" in error_str:
                        return {
                            "success": False,
                            "error": "Доступ запрещен",
                            "details": "Таблица должна быть расшарена на сервисный аккаунт с правами редактора",
                            "instruction": "Откройте таблицу → кнопка 'Настроить доступ' → добавьте email сервисного аккаунта с правами 'Редактор'"
                        }
                    elif "404" in error_str or "NOT_FOUND" in error_str:
                        return {
                            "success": False,
                            "error": "Таблица не найдена",
                            "details": "Проверьте правильность URL таблицы"
                        }
                    elif "INVALID_ARGUMENT" in error_str:
                        return {
                            "success": False,
                            "error": "Некорректные параметры",
                            "details": f"Проверьте название листа: '{sheet_name}'"
                        }
                    else:
                        return {
                            "success": False,
                            "error": f"Ошибка при добавлении строки: {error_str}"
                        }
            
            # Выполняем синхронную функцию в thread pool
            logger.info("[ADD_GOOGLE_SHEET_ROW] ⏳ Запускаем выполнение...")
            result = await loop.run_in_executor(None, append_row_sync)
            
            return result
            
        except Exception as e:
            logger.error(f"[ADD_GOOGLE_SHEET_ROW] ❌ Критическая ошибка: {str(e)}")
            return {
                "success": False,
                "error": f"Критическая ошибка: {str(e)}"
            }
