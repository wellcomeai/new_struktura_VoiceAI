"""
FastAPI application initialization for WellcomeAI.
This file configures all application components: routes, middleware, logging, etc.
"""
import os
import asyncio
import fcntl
import time
import gc
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.core.config import settings
from backend.core.logging import setup_logging, get_logger
from backend.api import (
    auth, users, assistants, files, websocket, healthcheck, 
    subscriptions, subscription_logs, admin, partners, 
    knowledge_base, payments, voximplant, elevenlabs
)
from backend.models.base import create_tables
from backend.db.session import engine
from backend.core.scheduler import start_subscription_checker

# Alembic для миграций
from alembic.config import Config as AlembicConfig
from alembic import command as alembic_command

# ✅ ОПЦИОНАЛЬНЫЙ ИМПОРТ psutil
try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

# Инициализация модульной системы функций
from backend.functions import discover_functions
discover_functions()

# Setup logging system
setup_logging()
logger = get_logger(__name__)

# Create and configure FastAPI application
app = FastAPI(
    title="WellcomeAI - SaaS Voice Assistant",
    description="API for managing personalized voice assistants based on OpenAI",
    version="1.0.0",
    docs_url="/api/docs" if not settings.PRODUCTION else None,
    redoc_url="/api/redoc" if not settings.PRODUCTION else None
)

# ✅ ДОБАВЛЕНО: Обработчики ошибок для продакшена
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"message": exc.detail}
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"message": "Validation error", "details": exc.errors()}
    )

@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"message": "Internal server error"}
    )

# Setup CORS
origins = settings.CORS_ORIGINS.split(",") if isinstance(settings.CORS_ORIGINS, str) else settings.CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# ✅ ДОБАВЛЕНО: Middleware для мониторинга ресурсов (только если psutil доступен)
if PSUTIL_AVAILABLE:
    @app.middleware("http")
    async def monitor_resources(request: Request, call_next):
        """Monitor memory usage for each request"""
        # Пропускаем health checks и статику
        if request.url.path in ["/health", "/api/health"] or request.url.path.startswith("/static"):
            return await call_next(request)
        
        try:
            # Проверяем память перед запросом
            process = psutil.Process()
            memory_before = process.memory_info().rss / 1024 / 1024  # MB
            
            response = await call_next(request)
            
            # Проверяем память после запроса
            memory_after = process.memory_info().rss / 1024 / 1024  # MB
            memory_diff = memory_after - memory_before
            
            # Логируем если использование памяти высокое
            if memory_after > 500:  # 500 MB
                logger.warning(f"High memory usage: {memory_after:.2f} MB (diff: {memory_diff:.2f} MB)")
                # Принудительная сборка мусора
                gc.collect()
            
            # Добавляем заголовок с информацией о памяти (только в development)
            if not settings.PRODUCTION:
                response.headers["X-Memory-Usage"] = f"{memory_after:.2f} MB"
            
            return response
        except Exception as e:
            logger.error(f"Error in resource monitoring: {e}")
            return await call_next(request)
else:
    logger.warning("psutil not available - memory monitoring disabled")

# Подключаем все API роутеры
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(users.router, prefix="/api/users", tags=["Users"])
app.include_router(assistants.router, prefix="/api/assistants", tags=["Assistants"])
app.include_router(files.router, prefix="/api/files", tags=["Files"])
app.include_router(websocket.router, tags=["WebSocket"])
app.include_router(healthcheck.router, tags=["Health"])
app.include_router(subscriptions.router, prefix="/api/subscriptions", tags=["Subscriptions"])
app.include_router(subscription_logs.router, prefix="/api/subscription-logs", tags=["Subscription Logs"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(knowledge_base.router, prefix="/api/knowledge-base", tags=["Knowledge Base"])
app.include_router(payments.router, prefix="/api/payments", tags=["Payments"])
app.include_router(voximplant.router, prefix="/api/voximplant", tags=["Voximplant"])
app.include_router(elevenlabs.router, prefix="/api/elevenlabs", tags=["ElevenLabs"])  # ✅ ДОБАВЛЕНО: ElevenLabs роутер
app.include_router(partners.router, prefix="/api/partners", tags=["Partners"])

# ✅ ИСПРАВЛЕНО: Создание директорий для статики с обработкой ошибок
def ensure_static_directories():
    """Ensure static directories exist"""
    try:
        static_dir = os.path.join(os.getcwd(), "backend/static")
        if not os.path.exists(static_dir):
            os.makedirs(static_dir, exist_ok=True)
            logger.info(f"Created static directory at {static_dir}")

        js_dir = os.path.join(static_dir, "js")
        if not os.path.exists(js_dir):
            os.makedirs(js_dir, exist_ok=True)
            logger.info(f"Created js directory at {js_dir}")
        
        return static_dir, js_dir
    except Exception as e:
        logger.error(f"Error creating static directories: {e}")
        # Fallback to current directory
        return os.getcwd(), os.getcwd()

static_dir, js_dir = ensure_static_directories()

# Монтируем статику
try:
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.mount("/js", StaticFiles(directory=js_dir), name="js")
except Exception as e:
    logger.error(f"Error mounting static files: {e}")

# ✅ УЛУЧШЕНО: Функция для запуска Alembic миграций
def run_migrations():
    """Run database migrations"""
    try:
        # Проверяем существование alembic.ini
        alembic_ini_path = "alembic.ini"
        if not os.path.exists(alembic_ini_path):
            logger.warning(f"alembic.ini not found at {alembic_ini_path}")
            return
            
        alembic_cfg = AlembicConfig(alembic_ini_path)
        alembic_command.upgrade(alembic_cfg, "head")
        logger.info("✅ Database migrations applied successfully")
    except Exception as e:
        logger.error(f"❌ Error applying migrations: {str(e)}")
        # В продакшене не останавливаем приложение из-за ошибок миграции
        if not settings.PRODUCTION:
            raise

# ✅ ДОБАВЛЕНО: Функция создания таблиц ElevenLabs
def create_elevenlabs_tables():
    """Create ElevenLabs tables"""
    try:
        from backend.models.elevenlabs import ElevenLabsAgent, ElevenLabsConversation
        from backend.models.base import Base
        Base.metadata.create_all(engine)
        logger.info("✅ ElevenLabs tables created successfully")
    except Exception as e:
        logger.error(f"❌ Error creating ElevenLabs tables: {str(e)}")
        if not settings.PRODUCTION:
            raise

# При старте приложения
@app.on_event("startup")
async def startup_event():
    """Application startup event"""
    try:
        logger.info("🚀 Starting WellcomeAI application...")
        
        # ✅ ИСПРАВЛЕНО: Простая проверка блокировки для Render
        lock_file_path = "/tmp/wellcome_migrations.lock"
        migration_completed = False
        
        try:
            # Для Render используем более простую блокировку
            if not os.path.exists(lock_file_path):
                # Создаем файл блокировки
                with open(lock_file_path, 'w') as lock_file:
                    lock_file.write(str(os.getpid()))
                
                logger.info("🔒 Running migrations...")
                run_migrations()
                create_tables(engine)
                create_elevenlabs_tables()  # ✅ ДОБАВЛЕНО: Создание таблиц ElevenLabs
                migration_completed = True
                logger.info("✅ Migrations completed")
            else:
                logger.info("⏳ Waiting for migrations to complete...")
                # Ждем завершения миграций
                max_wait = 60
                waited = 0
                while os.path.exists(lock_file_path) and waited < max_wait:
                    await asyncio.sleep(1)
                    waited += 1
                
                if waited >= max_wait:
                    logger.warning("⚠️ Migration timeout, proceeding anyway")
                
        except Exception as e:
            logger.error(f"❌ Migration error: {str(e)}")
            if not settings.PRODUCTION:
                raise
        finally:
            # Удаляем файл блокировки
            if migration_completed:
                try:
                    if os.path.exists(lock_file_path):
                        os.remove(lock_file_path)
                except Exception as e:
                    logger.error(f"Error removing lock file: {e}")
        
        # ✅ ИСПРАВЛЕНО: Запуск планировщика только в одном процессе
        try:
            # Запускаем планировщик только в одном процессе
            worker_id = os.environ.get("APP_WORKER_ID", "0")
            
            # Для Gunicorn проверяем переменную окружения
            if os.environ.get("SERVER_SOFTWARE", "").startswith("gunicorn"):
                # В Gunicorn запускаем только в первом worker
                if worker_id == "0" or not os.environ.get("GUNICORN_WORKER_ID"):
                    asyncio.create_task(start_subscription_checker())
                    logger.info(f"🔄 Subscription checker started in worker {worker_id}")
                else:
                    logger.info(f"⏭️ Skipping subscription checker in worker {worker_id}")
            else:
                # В режиме разработки (uvicorn) всегда запускаем
                asyncio.create_task(start_subscription_checker())
                logger.info("🔄 Subscription checker started (development mode)")
        except Exception as e:
            logger.error(f"❌ Error starting subscription checker: {str(e)}")
        
        # ✅ ДОБАВЛЕНО: Логирование инициализации Voximplant интеграции
        try:
            logger.info("📞 Voximplant integration initialized")
            logger.info(f"   WebSocket endpoint: {settings.HOST_URL}/api/voximplant/ws/{{assistant_id}}")
            logger.info(f"   Demo endpoint: {settings.HOST_URL}/api/voximplant/ws/demo")
            logger.info(f"   Test endpoint: {settings.HOST_URL}/api/voximplant/test")
        except Exception as e:
            logger.error(f"❌ Error initializing Voximplant integration: {str(e)}")
        
        # ✅ ДОБАВЛЕНО: Логирование инициализации ElevenLabs интеграции
        try:
            logger.info("🎙️ ElevenLabs integration initialized")
            logger.info(f"   API endpoints: {settings.HOST_URL}/api/elevenlabs/")
            logger.info(f"   WebSocket endpoint: {settings.HOST_URL}/api/elevenlabs/ws/{{agent_id}}")
            logger.info(f"   Voice generation endpoint: {settings.HOST_URL}/api/elevenlabs/generate")
        except Exception as e:
            logger.error(f"❌ Error initializing ElevenLabs integration: {str(e)}")
        
        logger.info("✅ Application started successfully")
        
    except Exception as e:
        logger.error(f"❌ Startup error: {str(e)}", exc_info=True)
        if not settings.PRODUCTION:
            raise

# Главная страница (редирект на frontend)
@app.get("/")
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")

# Health check для Render
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "wellcome-ai"}

# При выключении приложения
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("🛑 Application stopped")
