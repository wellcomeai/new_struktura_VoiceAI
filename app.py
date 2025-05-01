"""
Инициализация FastAPI приложения WellcomeAI.
Этот файл настраивает все компоненты приложения: маршруты, middleware, логирование, и т.д.
"""

import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.core.config import settings
from backend.core.logging import setup_logging
from backend.api import auth, users, assistants, files, websocket
from backend.models.base import create_tables
from backend.db.session import engine

# Настройка логирования
logger = setup_logging()

# Создание и настройка FastAPI приложения
app = FastAPI(
    title="WellcomeAI - SaaS голосовой помощник",
    description="API для управления персонализированными голосовыми помощниками на базе OpenAI",
    version="1.0.0",
    docs_url="/api/docs" if not settings.PRODUCTION else None,
    redoc_url="/api/redoc" if not settings.PRODUCTION else None
)

# Настройка CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Подключение API маршрутов
app.include_router(auth.router, prefix="/api", tags=["Авторизация"])
app.include_router(users.router, prefix="/api", tags=["Пользователи"])
app.include_router(assistants.router, prefix="/api", tags=["Ассистенты"])
app.include_router(files.router, prefix="/api", tags=["Файлы"])
app.include_router(websocket.router, tags=["WebSocket"])

# Проверка и создание директорий для статических файлов
static_dir = os.path.join(os.getcwd(), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
    logger.info(f"Создана директория static")

# Монтирование статических файлов
app.mount("/static", StaticFiles(directory="static"), name="static")

# Обработчик запуска приложения
@app.on_event("startup")
async def startup_event():
    # Создание таблиц в базе данных, если они отсутствуют
    create_tables(engine)
    logger.info("Приложение запущено успешно")

# Главная страница (перенаправление на статическую страницу)
@app.get("/")
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")

# Обработчик остановки приложения
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Приложение остановлено")
