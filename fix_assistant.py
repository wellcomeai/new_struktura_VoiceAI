"""
Скрипт для исправления формата functions в базе данных
"""
import asyncio
import sys
import os

# Добавляем текущий каталог в путь, чтобы импорты работали
sys.path.append(os.getcwd())

from sqlalchemy.orm import Session
from sqlalchemy import create_engine
from backend.core.config import settings
from backend.models.assistant import AssistantConfig

async def fix_assistant_functions():
    # Создаем подключение к базе данных
    engine = create_engine(settings.DATABASE_URL)
    db = Session(engine)
    
    try:
        # Получаем ассистента по ID
        assistant_id = "84480767-76f3-491f-8c76-8181bdfe8c5a"
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        
        if not assistant:
            print(f"Ассистент с ID {assistant_id} не найден")
            return
        
        # Проверяем текущий формат functions
        print(f"Текущий формат functions: {assistant.functions}")
        
        # Если functions - словарь с enabled_functions, преобразуем в список
        if isinstance(assistant.functions, dict) and "enabled_functions" in assistant.functions:
            new_functions = assistant.functions["enabled_functions"]
            assistant.functions = new_functions
            db.commit()
            print(f"Functions обновлены: {assistant.functions}")
        else:
            print("Формат functions уже правильный или непредвиденный")
        
    except Exception as e:
        print(f"Ошибка: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(fix_assistant_functions())
