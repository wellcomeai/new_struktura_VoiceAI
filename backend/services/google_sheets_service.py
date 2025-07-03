"""
Google Sheets service для WellcomeAI application.
Использует сервисный аккаунт из переменной окружения GOOGLE_SERVICE_ACCOUNT_JSON.
"""

import os
import json
import asyncio
import time
import traceback
import google.auth.transport.requests
from datetime import datetime
from typing import Dict, Any, Optional, List

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from backend.core.logging import get_logger

logger = get_logger(__name__)

# Загрузка информации о сервисном аккаунте из переменной окружения
try:
    GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if GOOGLE_SERVICE_ACCOUNT_JSON:
        SERVICE_ACCOUNT_INFO = json.loads(GOOGLE_SERVICE_ACCOUNT_JSON)
        
        # Исправление формата private_key - замена \\n на реальные переносы строк
        if "private_key" in SERVICE_ACCOUNT_INFO:
            # Удаляем экранирование обратных слешей в приватном ключе
            SERVICE_ACCOUNT_INFO["private_key"] = SERVICE_ACCOUNT_INFO["private_key"].replace('\\n', '\n')
            logger.info("Формат приватного ключа скорректирован")
    else:
        logger.error("Переменная окружения GOOGLE_SERVICE_ACCOUNT_JSON не найдена")
        SERVICE_ACCOUNT_INFO = {}
except json.JSONDecodeError as e:
    logger.error(f"Ошибка декодирования JSON из переменной окружения: {str(e)}")
    logger.error(f"Первые 100 символов переменной: {GOOGLE_SERVICE_ACCOUNT_JSON[:100] if GOOGLE_SERVICE_ACCOUNT_JSON else 'None'}")
    SERVICE_ACCOUNT_INFO = {}
except Exception as e:
    logger.error(f"Непредвиденная ошибка при загрузке данных сервисного аккаунта: {str(e)}")
    SERVICE_ACCOUNT_INFO = {}

class GoogleSheetsService:
    """Сервис для работы с Google Sheets"""
    
    _service = None
    
    @classmethod
    def _get_sheets_service(cls):
        """
        Получить сервис Google Sheets API с минимальным логированием
        
        Returns:
            Resource object для взаимодействия с Google Sheets API
        """
        if cls._service is not None:
            return cls._service
            
        try:
            logger.info("Инициализация Google Sheets сервиса...")
            
            # Проверка наличия данных сервисного аккаунта
            if not SERVICE_ACCOUNT_INFO or "private_key" not in SERVICE_ACCOUNT_INFO:
                logger.error("Отсутствуют необходимые данные сервисного аккаунта")
                if SERVICE_ACCOUNT_INFO:
                    logger.error(f"Доступные ключи: {', '.join(SERVICE_ACCOUNT_INFO.keys())}")
                raise ValueError("Отсутствуют данные сервисного аккаунта. Проверьте переменную GOOGLE_SERVICE_ACCOUNT_JSON")
            
            # Логируем информацию о ключе для отладки (без приватного ключа)
            safe_info = {k: v for k, v in SERVICE_ACCOUNT_INFO.items() if k != "private_key"}
            safe_info["private_key"] = "[HIDDEN]"
            logger.info(f"Данные сервисного аккаунта: {json.dumps(safe_info)}")
            
            # Создаем учетные данные из загруженного ключа
            try:
                credentials = service_account.Credentials.from_service_account_info(
                    SERVICE_ACCOUNT_INFO,
                    scopes=['https://www.googleapis.com/auth/spreadsheets']
                )
                logger.info(f"Учетные данные созданы для: {credentials.service_account_email}")
            except Exception as e:
                logger.error(f"Ошибка создания учетных данных: {str(e)}")
                # Попробуем вывести дополнительную информацию о ключе для отладки
                key_start = SERVICE_ACCOUNT_INFO.get("private_key", "")[:50]
                key_end = SERVICE_ACCOUNT_INFO.get("private_key", "")[-50:] if SERVICE_ACCOUNT_INFO.get("private_key", "") else ""
                logger.error(f"Начало приватного ключа: {key_start}...")
                logger.error(f"Конец приватного ключа: ...{key_end}")
                raise
            
            # Получаем токен
            request = google.auth.transport.requests.Request()
            credentials.refresh(request)
            logger.info("Токен получен успешно!")
            
            # Создаем сервис
            service = build('sheets', 'v4', credentials=credentials, cache_discovery=False)
            cls._service = service
            logger.info("Google Sheets API сервис инициализирован успешно")
            
            return service
        except Exception as e:
            logger.error(f"Ошибка при инициализации Google Sheets API: {str(e)}")
            raise
    
    @staticmethod
    async def log_conversation(
        sheet_id: str,
        user_message: str,
        assistant_message: str,
        function_result: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Записать диалог в Google таблицу
        
        Args:
            sheet_id: ID Google таблицы
            user_message: Сообщение пользователя
            assistant_message: Ответ ассистента
            function_result: Результат выполнения функции (опционально)
            
        Returns:
            True в случае успеха, False в случае ошибки
        """
        if not sheet_id:
            logger.warning("[DEBUG-SHEETS] ID таблицы не указан")
            return False
        
        try:
            # Изменено: разрешаем запись, если хотя бы одно из сообщений есть
            if not user_message and not assistant_message:
                logger.warning("[DEBUG-SHEETS] Пустые сообщения, запись пропущена")
                return False
            
            # Установка значений по умолчанию, если нет данных
            user_message = user_message or "(пустое сообщение)"
            assistant_message = assistant_message or "(пустой ответ)"
            
            logger.info(f"[DEBUG-SHEETS] Подготовка записи диалога в таблицу: {sheet_id}")
            logger.info(f"[DEBUG-SHEETS] Сообщение пользователя ({len(user_message)} символов): '{user_message[:50]}...'")
            logger.info(f"[DEBUG-SHEETS] Ответ ассистента ({len(assistant_message)} символов): '{assistant_message[:50]}...'")
            
            # Подготовка данных для записи
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            
            # Подготовка текста результата функции
            function_text = "none"
            if function_result:
                try:
                    # Преобразуем в строку, если это словарь
                    if isinstance(function_result, dict):
                        function_text = json.dumps(function_result, ensure_ascii=False)
                    else:
                        function_text = str(function_result)
                    logger.info(f"[DEBUG-SHEETS] Результат функции: {function_text[:50]}...")
                except Exception as e:
                    logger.error(f"[DEBUG-SHEETS] Ошибка форматирования результата функции: {str(e)}")
                    function_text = f"Ошибка форматирования: {str(e)}"
            
            # Данные для записи
            values = [[now, user_message, assistant_message, function_text]]
            
            # Вызываем в отдельном потоке, так как это блокирующая операция
            loop = asyncio.get_event_loop()
            
            def append_values():
                try:
                    logger.info(f"[DEBUG-SHEETS] Запись диалога в таблицу: {sheet_id}")
                    
                    # Добавляем проверку сервисного аккаунта
                    if not SERVICE_ACCOUNT_INFO or "private_key" not in SERVICE_ACCOUNT_INFO:
                        logger.error("[DEBUG-SHEETS] Отсутствуют необходимые данные сервисного аккаунта")
                        if SERVICE_ACCOUNT_INFO:
                            logger.error(f"[DEBUG-SHEETS] Доступные ключи: {', '.join(SERVICE_ACCOUNT_INFO.keys())}")
                        return False, "Отсутствуют данные сервисного аккаунта"
                    
                    # Пытаемся получить сервис
                    try:
                        service = GoogleSheetsService._get_sheets_service()
                        logger.info("[DEBUG-SHEETS] Сервис Google Sheets API успешно получен")
                    except Exception as e:
                        logger.error(f"[DEBUG-SHEETS] Ошибка получения сервиса Sheets API: {str(e)}")
                        return False, f"Ошибка сервиса: {str(e)}"
                    
                    body = {
                        'values': values
                    }
                    
                    # Отправляем запрос
                    try:
                        result = service.spreadsheets().values().append(
                            spreadsheetId=sheet_id,
                            range='A:D',
                            valueInputOption='RAW',
                            insertDataOption='INSERT_ROWS',
                            body=body
                        ).execute()
                        
                        logger.info(f"[DEBUG-SHEETS] Диалог успешно записан в таблицу. Ответ API: {result}")
                        return True, None
                    except HttpError as http_error:
                        status_code = http_error.resp.status if hasattr(http_error, 'resp') else 'unknown'
                        error_content = http_error.content.decode('utf-8') if hasattr(http_error, 'content') else 'unknown'
                        logger.error(f"[DEBUG-SHEETS] HTTP ошибка {status_code} при записи в таблицу: {str(http_error)}")
                        logger.error(f"[DEBUG-SHEETS] Содержимое ошибки: {error_content}")
                        
                        if status_code == 403:
                            logger.error("[DEBUG-SHEETS] Доступ запрещен. Проверьте настройки доступа к таблице.")
                        elif status_code == 404:
                            logger.error("[DEBUG-SHEETS] Таблица не найдена. Проверьте ID таблицы.")
                        
                        return False, f"HTTP ошибка {status_code}: {str(http_error)}"
                except Exception as e:
                    logger.error(f"[DEBUG-SHEETS] Непредвиденная ошибка при записи в таблицу: {str(e)}")
                    logger.error(f"[DEBUG-SHEETS] Трассировка: {traceback.format_exc()}")
                    return False, f"Ошибка: {str(e)}"
            
            try:
                logger.info("[DEBUG-SHEETS] Запуск асинхронной задачи для записи в таблицу")
                success, error_message = await loop.run_in_executor(None, append_values)
                
                if success:
                    logger.info("[DEBUG-SHEETS] Диалог успешно записан в таблицу")
                    return True
                else:
                    logger.error(f"[DEBUG-SHEETS] Не удалось записать диалог в таблицу: {error_message}")
                    
                    # Локальное логирование при ошибке
                    logger.info(f"[DEBUG-SHEETS] [ЛОКАЛЬНЫЙ ЛОГ] Пользователь: {user_message[:100]}...")
                    logger.info(f"[DEBUG-SHEETS] [ЛОКАЛЬНЫЙ ЛОГ] Ассистент: {assistant_message[:100]}...")
                    
                    # Возвращаем False, чтобы показать ошибку
                    return False
            except Exception as e:
                logger.error(f"[DEBUG-SHEETS] Ошибка при запуске executor: {str(e)}")
                logger.error(f"[DEBUG-SHEETS] Трассировка: {traceback.format_exc()}")
                return False
                
        except Exception as e:
            logger.error(f"[DEBUG-SHEETS] Ошибка при логировании диалога: {str(e)}")
            logger.error(f"[DEBUG-SHEETS] Трассировка: {traceback.format_exc()}")
            # Возвращаем False, чтобы показать ошибку
            return False
    
    @staticmethod
    async def verify_sheet_access(sheet_id: str) -> Dict[str, Any]:
        """
        Проверить доступ к Google таблице
        
        Args:
            sheet_id: ID Google таблицы
            
        Returns:
            Dict с статусом и сообщением
        """
        if not sheet_id:
            return {"success": False, "message": "ID таблицы не указан"}
        
        try:
            loop = asyncio.get_event_loop()
            
            def verify_access():
                try:
                    logger.info(f"Проверка доступа к таблице: {sheet_id}")
                    
                    # Получаем сервис
                    service = GoogleSheetsService._get_sheets_service()
                    
                    # Проверяем доступ к метаданным
                    logger.info("Получение метаданных таблицы...")
                    sheet = service.spreadsheets().get(
                        spreadsheetId=sheet_id,
                        fields='properties.title'
                    ).execute()
                    
                    title = sheet.get('properties', {}).get('title', 'Untitled Spreadsheet')
                    logger.info(f"Метаданные таблицы получены. Название: {title}")
                    
                    # Проверяем возможность записи
                    logger.info("Проверка возможности записи...")
                    test_values = [["ТЕСТ - Проверка доступа (будет удалено)"]]
                    
                    append_result = service.spreadsheets().values().append(
                        spreadsheetId=sheet_id,
                        range='Z:Z',  # Используем отдаленный столбец для теста
                        valueInputOption='RAW',
                        insertDataOption='INSERT_ROWS',
                        body={'values': test_values}
                    ).execute()
                    
                    logger.info(f"Тестовая запись добавлена")
                    
                    # Очищаем тестовую запись
                    update_range = append_result.get('updates', {}).get('updatedRange', 'Z1')
                    clear_result = service.spreadsheets().values().clear(
                        spreadsheetId=sheet_id,
                        range=update_range,
                        body={}
                    ).execute()
                    
                    logger.info(f"Тестовая запись удалена")
                    
                    return {
                        "success": True,
                        "message": f"Успешно подключено к таблице: {title}. Таблица доступна для записи.",
                        "title": title
                    }
                except HttpError as http_error:
                    status_code = http_error.resp.status if hasattr(http_error, 'resp') else 'unknown'
                    error_details = f"HTTP ошибка {status_code}: {str(http_error)}"
                    logger.error(f"HTTP ошибка при проверке доступа: {error_details}")
                    
                    if status_code == 403:
                        return {
                            "success": False,
                            "message": "Отказано в доступе. Убедитесь, что таблица доступна для редактирования по ссылке."
                        }
                    elif status_code == 404:
                        return {
                            "success": False,
                            "message": "Таблица не найдена. Пожалуйста, проверьте ID таблицы."
                        }
                    else:
                        return {
                            "success": False,
                            "message": f"Ошибка доступа к таблице: {error_details}"
                        }
                except Exception as e:
                    logger.error(f"Непредвиденная ошибка при проверке доступа: {str(e)}")
                    return {
                        "success": False,
                        "message": f"Непредвиденная ошибка: {str(e)}"
                    }
            
            try:
                result = await loop.run_in_executor(None, verify_access)
                return result
            except Exception as e:
                logger.error(f"Ошибка при запуске executor для проверки доступа: {str(e)}")
                return {
                    "success": False,
                    "message": f"Ошибка проверки доступа: {str(e)}"
                }
            
        except Exception as e:
            logger.error(f"Ошибка при проверке доступа к таблице: {str(e)}")
            return {
                "success": False,
                "message": f"Ошибка: {str(e)}"
            }

    @staticmethod
    async def setup_sheet(sheet_id: str) -> bool:
        """
        Настройка заголовков таблицы
        
        Args:
            sheet_id: ID Google таблицы
            
        Returns:
            True в случае успеха, False в случае ошибки
        """
        if not sheet_id:
            return False
            
        try:
            loop = asyncio.get_event_loop()
            
            def check_and_setup():
                try:
                    logger.info(f"Настройка таблицы: {sheet_id}")
                    service = GoogleSheetsService._get_sheets_service()
                    
                    # Проверяем существующие данные
                    logger.info("Проверка наличия заголовков...")
                    result = service.spreadsheets().values().get(
                        spreadsheetId=sheet_id,
                        range='A1:D1'
                    ).execute()
                    
                    values = result.get('values', [])
                    
                    if not values:
                        logger.info("Заголовки не найдены. Добавление заголовков...")
                        headers = [["Дата и время", "Пользователь", "Ассистент", "Результат функции"]]
                        body = {
                            'values': headers
                        }
                        update_result = service.spreadsheets().values().update(
                            spreadsheetId=sheet_id,
                            range='A1:D1',
                            valueInputOption='RAW',
                            body=body
                        ).execute()
                        logger.info(f"Заголовки добавлены успешно")
                    else:
                        logger.info(f"Заголовки уже существуют")
                        
                    return True
                except HttpError as http_error:
                    status_code = http_error.resp.status if hasattr(http_error, 'resp') else 'unknown'
                    logger.error(f"HTTP ошибка при настройке таблицы: {status_code} - {str(http_error)}")
                    return False
                except Exception as e:
                    logger.error(f"Непредвиденная ошибка при настройке таблицы: {str(e)}")
                    return False
            
            try:
                result = await loop.run_in_executor(None, check_and_setup)
                return result
            except Exception as e:
                logger.error(f"Ошибка при запуске executor для настройки таблицы: {str(e)}")
                return False
                
        except Exception as e:
            logger.error(f"Ошибка при настройке таблицы: {str(e)}")
            return False
