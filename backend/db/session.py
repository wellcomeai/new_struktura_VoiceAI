"""
Управление сессиями базы данных.
Содержит функции и объекты для создания и управления сессиями SQLAlchemy.
"""

import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

from backend.core.config import settings

# Создаем URL для подключения к базе данных
DATABASE_URL = os.getenv("DATABASE_URL", settings.DATABASE_URL)

# Создаем движок SQLAlchemy для подключения к БД
# echo=True включает логирование SQL-запросов (полезно для отладки)
engine = create_engine(
    DATABASE_URL, 
    echo=settings.DEBUG,
    pool_pre_ping=True  # Проверяет соединение перед использованием
)

# Создаем фабрику сессий
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Функция для получения сессии БД
def get_db() -> Generator[Session, None, None]:
    """
    Функция-генератор для получения сессии БД.
    Используется в качестве зависимости FastAPI для инъекции сессии в эндпоинты.
    
    Yields:
        Session: Сессия SQLAlchemy для работы с БД
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
