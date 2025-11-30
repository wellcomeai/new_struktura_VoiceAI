"""
FastAPI application initialization for WellcomeAI.
This file configures all application components: routes, middleware, logging, etc.
🆕 v2.0: Added Conversations API support
✅ v2.1: Added Email Verification API support
✅ v2.2: Added Embeds API support (embeddable pages)
✅ v2.3: Added Google Gemini Live API support
✅ v2.4: Added Gemini Assistants CRUD API support
✅ v2.5: Added CRM (Contacts) API support
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
    subscriptions, subscription_logs, admin, 
    knowledge_base, payments, voximplant, elevenlabs, conversations,
    email_verification,
    embeds,
    gemini_ws,  # ✅ Gemini WebSocket API
    gemini_assistants,  # ✅ Gemini Assistants CRUD API
    contacts,  # ✅ НОВОЕ: CRM API
    functions
)
from backend.models.base import create_tables
from backend.db.session import engine
from backend.core.scheduler import start_subscription_checker
from backend.api.partners import router as partners_router

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
    description="API for managing personalized voice assistants based on OpenAI and Google Gemini",
    version="2.5.0",  # ✅ Обновлена версия
    docs_url="/api/docs" if not settings.PRODUCTION else None,
    redoc_url="/api/redoc" if not settings.PRODUCTION else None
)

# ============================================================================
# EXCEPTION HANDLERS
# ============================================================================

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

# ============================================================================
# MIDDLEWARE
# ============================================================================

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

# Resource monitoring middleware (optional, requires psutil)
if PSUTIL_AVAILABLE:
    @app.middleware("http")
    async def monitor_resources(request: Request, call_next):
        """Monitor memory usage for each request"""
        # Пропускаем health checks и статику
        if request.url.path in ["/health", "/api/health"] or request.url.path.startswith("/static") or request.url.path.startswith("/embed"):
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

# ============================================================================
# ROUTE REGISTRATION
# ============================================================================

# Подключаем все API роутеры
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(users.router, prefix="/api/users", tags=["Users"])
app.include_router(assistants.router, prefix="/api/assistants", tags=["Assistants"])
app.include_router(gemini_assistants.router, prefix="/api/gemini-assistants", tags=["Gemini Assistants"])  # ✅ Gemini CRUD
app.include_router(files.router, prefix="/api/files", tags=["Files"])
app.include_router(websocket.router, tags=["WebSocket"])
app.include_router(gemini_ws.router, tags=["Gemini WebSocket"])
app.include_router(healthcheck.router, tags=["Health"])
app.include_router(subscriptions.router, prefix="/api/subscriptions", tags=["Subscriptions"])
app.include_router(subscription_logs.router, prefix="/api/subscription-logs", tags=["Subscription Logs"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(knowledge_base.router, prefix="/api/knowledge-base", tags=["Knowledge Base"])
app.include_router(payments.router, prefix="/api/payments", tags=["Payments"])
app.include_router(voximplant.router, prefix="/api/voximplant", tags=["Voximplant"])
app.include_router(elevenlabs.router, prefix="/api/elevenlabs", tags=["ElevenLabs"])
app.include_router(partners.router, prefix="/api/partners", tags=["Partners"])
app.include_router(conversations.router, prefix="/api/conversations", tags=["Conversations"])
app.include_router(contacts.router, prefix="/api/contacts", tags=["CRM"])  # ✅ НОВОЕ: CRM API
app.include_router(email_verification.router, prefix="/api/email-verification", tags=["Email Verification"])
app.include_router(embeds.router, tags=["Embeds"])
app.include_router(functions.router, prefix="/api/functions", tags=["Functions"])

# ============================================================================
# STATIC FILES
# ============================================================================

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

# ============================================================================
# DATABASE INITIALIZATION FUNCTIONS
# ============================================================================

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


def create_elevenlabs_tables():
    """
    Create ElevenLabs tables and automatically add missing columns
    """
    try:
        from backend.models.elevenlabs import ElevenLabsAgent, ElevenLabsConversation
        from backend.models.base import Base
        from sqlalchemy import text, inspect
        
        logger.info("🔄 Creating ElevenLabs tables and checking missing columns...")
        
        # Создаем таблицы ElevenLabs
        Base.metadata.create_all(engine)
        
        # Автоматическая проверка и создание недостающих колонок
        inspector = inspect(engine)
        
        # Список колонок которые должны быть в таблице users
        required_columns = {
            'elevenlabs_api_key': 'VARCHAR NULL',
        }
        
        # Проверяем таблицу users
        try:
            if inspector.has_table('users'):
                columns = inspector.get_columns('users')
                existing_columns = {col['name']: col for col in columns}
                
                logger.info(f"📋 Found {len(existing_columns)} columns in users table")
                
                # Проверяем каждую требуемую колонку
                for column_name, column_definition in required_columns.items():
                    if column_name not in existing_columns:
                        logger.info(f"➕ Adding missing column: {column_name}")
                        
                        try:
                            with engine.connect() as conn:
                                trans = conn.begin()
                                try:
                                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {column_name} {column_definition}"))
                                    trans.commit()
                                    logger.info(f"✅ Successfully added column: {column_name}")
                                except Exception as e:
                                    trans.rollback()
                                    if "already exists" not in str(e).lower():
                                        logger.error(f"❌ Failed to add column {column_name}: {str(e)}")
                                    
                        except Exception as conn_error:
                            logger.error(f"❌ Connection error adding column {column_name}: {str(conn_error)}")
                    else:
                        logger.info(f"✅ Column {column_name} already exists")
                        
            else:
                logger.warning("⚠️ Table 'users' not found, skipping column checks")
                
        except Exception as table_error:
            logger.error(f"❌ Error checking users table: {str(table_error)}")
        
        # Проверяем другие возможные недостающие таблицы
        required_tables = {
            'elevenlabs_agents': ElevenLabsAgent,
            'elevenlabs_conversations': ElevenLabsConversation,
        }
        
        for table_name, model_class in required_tables.items():
            if not inspector.has_table(table_name):
                logger.info(f"➕ Creating missing table: {table_name}")
                try:
                    model_class.__table__.create(engine)
                    logger.info(f"✅ Successfully created table: {table_name}")
                except Exception as e:
                    logger.error(f"❌ Failed to create table {table_name}: {str(e)}")
            else:
                logger.info(f"✅ Table {table_name} already exists")
        
        logger.info("✅ ElevenLabs tables and columns setup completed")
        
    except Exception as e:
        logger.error(f"❌ Error creating ElevenLabs tables: {str(e)}")
        if not settings.PRODUCTION:
            raise


def create_gemini_tables():
    """
    Create Gemini assistant tables and check missing columns
    """
    try:
        from backend.models.gemini_assistant import GeminiAssistantConfig, GeminiConversation
        from backend.models.base import Base
        from sqlalchemy import text, inspect
        
        logger.info("🤖 Creating Gemini tables and checking missing columns...")
        
        # Создаем таблицы Gemini
        Base.metadata.create_all(engine)
        
        inspector = inspect(engine)
        
        # Проверяем таблицу users для gemini_api_key
        try:
            if inspector.has_table('users'):
                columns = inspector.get_columns('users')
                existing_columns = {col['name']: col for col in columns}
                
                if 'gemini_api_key' not in existing_columns:
                    logger.info("➕ Adding gemini_api_key column to users table...")
                    
                    try:
                        with engine.connect() as conn:
                            trans = conn.begin()
                            try:
                                conn.execute(text("ALTER TABLE users ADD COLUMN gemini_api_key VARCHAR NULL"))
                                trans.commit()
                                logger.info("✅ Successfully added gemini_api_key column")
                            except Exception as e:
                                trans.rollback()
                                if "already exists" not in str(e).lower():
                                    logger.error(f"❌ Failed to add gemini_api_key: {str(e)}")
                    except Exception as conn_error:
                        logger.error(f"❌ Connection error: {str(conn_error)}")
                else:
                    logger.info("✅ Column gemini_api_key already exists")
        except Exception as table_error:
            logger.error(f"❌ Error checking users table: {str(table_error)}")
        
        # Проверяем таблицы Gemini
        required_tables = {
            'gemini_assistant_configs': GeminiAssistantConfig,
            'gemini_conversations': GeminiConversation,
        }
        
        for table_name, model_class in required_tables.items():
            if not inspector.has_table(table_name):
                logger.info(f"➕ Creating missing table: {table_name}")
                try:
                    model_class.__table__.create(engine)
                    logger.info(f"✅ Successfully created table: {table_name}")
                except Exception as e:
                    logger.error(f"❌ Failed to create table {table_name}: {str(e)}")
            else:
                logger.info(f"✅ Table {table_name} already exists")
        
        logger.info("✅ Gemini tables and columns setup completed")
        
    except Exception as e:
        logger.error(f"❌ Error creating Gemini tables: {str(e)}")
        if not settings.PRODUCTION:
            raise


def create_crm_tables():
    """
    Create CRM (Contacts) tables and check missing columns
    """
    try:
        from backend.models.contact import Contact
        from backend.models.base import Base
        from sqlalchemy import text, inspect
        
        logger.info("📇 Creating CRM tables and checking missing columns...")
        
        # Создаем таблицы CRM
        Base.metadata.create_all(engine)
        
        inspector = inspect(engine)
        
        # Проверяем таблицу contacts
        if not inspector.has_table('contacts'):
            logger.info("➕ Creating contacts table...")
            try:
                Contact.__table__.create(engine)
                logger.info("✅ Successfully created contacts table")
            except Exception as e:
                logger.error(f"❌ Failed to create contacts table: {str(e)}")
        else:
            logger.info("✅ Table contacts already exists")
        
        # Проверяем поле contact_id в таблице conversations
        try:
            if inspector.has_table('conversations'):
                columns = inspector.get_columns('conversations')
                existing_columns = {col['name']: col for col in columns}
                
                if 'contact_id' not in existing_columns:
                    logger.info("➕ Adding contact_id column to conversations table...")
                    
                    try:
                        with engine.connect() as conn:
                            trans = conn.begin()
                            try:
                                # Добавляем колонку без FK constraint
                                conn.execute(text("ALTER TABLE conversations ADD COLUMN contact_id UUID"))
                                trans.commit()
                                logger.info("✅ Successfully added contact_id column")
                                
                                # Создаем индекс
                                trans = conn.begin()
                                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversations_contact_id ON conversations(contact_id)"))
                                trans.commit()
                                logger.info("✅ Successfully created index on contact_id")
                                
                                # Добавляем FK constraint с NOT VALID (для больших таблиц)
                                trans = conn.begin()
                                conn.execute(text("""
                                    ALTER TABLE conversations 
                                    ADD CONSTRAINT fk_conversations_contact_id 
                                    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
                                    NOT VALID
                                """))
                                trans.commit()
                                logger.info("✅ Successfully added FK constraint on contact_id")
                                
                            except Exception as e:
                                trans.rollback()
                                if "already exists" not in str(e).lower():
                                    logger.error(f"❌ Failed to add contact_id: {str(e)}")
                    except Exception as conn_error:
                        logger.error(f"❌ Connection error: {str(conn_error)}")
                else:
                    logger.info("✅ Column contact_id already exists in conversations")
        except Exception as table_error:
            logger.error(f"❌ Error checking conversations table: {str(table_error)}")
        
        logger.info("✅ CRM tables and columns setup completed")
        
    except Exception as e:
        logger.error(f"❌ Error creating CRM tables: {str(e)}")
        if not settings.PRODUCTION:
            raise


def check_and_fix_all_missing_columns():
    """
    Comprehensive check and fix for all missing columns across all tables
    """
    try:
        from sqlalchemy import text, inspect
        
        logger.info("🔧 Comprehensive database schema check and fix...")
        
        inspector = inspect(engine)
        
        # Карта всех таблиц и их обязательных колонок
        schema_fixes = {
            'users': {
                'elevenlabs_api_key': 'VARCHAR NULL',
                'gemini_api_key': 'VARCHAR NULL',
                'email_verified': 'BOOLEAN DEFAULT FALSE NOT NULL',
            },
            'conversations': {
                'caller_number': 'VARCHAR(50) NULL',
                'contact_id': 'UUID NULL',
            },
            'assistant_configs': {
                # Добавьте если нужно
            },
            'subscription_plans': {
                # Добавьте если нужно
            }
        }
        
        for table_name, required_columns in schema_fixes.items():
            if not inspector.has_table(table_name):
                logger.warning(f"⚠️ Table {table_name} not found, skipping")
                continue
                
            logger.info(f"🔍 Checking table: {table_name}")
            
            columns = inspector.get_columns(table_name)
            existing_columns = {col['name'] for col in columns}
            
            for column_name, column_definition in required_columns.items():
                if column_name not in existing_columns:
                    logger.info(f"➕ Adding missing column {table_name}.{column_name}")
                    
                    try:
                        with engine.connect() as conn:
                            trans = conn.begin()
                            try:
                                conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"))
                                trans.commit()
                                logger.info(f"✅ Successfully added {table_name}.{column_name}")
                            except Exception as e:
                                trans.rollback()
                                if "already exists" in str(e).lower():
                                    logger.info(f"ℹ️  Column {table_name}.{column_name} already exists")
                                else:
                                    logger.error(f"❌ Failed to add {table_name}.{column_name}: {str(e)}")
                                    
                    except Exception as conn_error:
                        logger.error(f"❌ Connection error adding {table_name}.{column_name}: {str(conn_error)}")
                else:
                    logger.debug(f"✅ Column {table_name}.{column_name} exists")
        
        logger.info("✅ Comprehensive schema check completed")
        
    except Exception as e:
        logger.error(f"❌ Error in comprehensive schema check: {str(e)}")


def create_email_verification_table():
    """
    Create email_verifications table if it doesn't exist
    """
    try:
        from backend.models.email_verification import EmailVerification
        from backend.models.base import Base
        from sqlalchemy import inspect
        
        logger.info("📧 Checking email_verifications table...")
        
        inspector = inspect(engine)
        
        if not inspector.has_table('email_verifications'):
            logger.info("➕ Creating email_verifications table...")
            EmailVerification.__table__.create(engine)
            logger.info("✅ email_verifications table created successfully")
        else:
            logger.info("✅ email_verifications table already exists")
            
    except Exception as e:
        logger.error(f"❌ Error creating email_verifications table: {str(e)}")
        if not settings.PRODUCTION:
            raise


def create_embed_configs_table():
    """
    Create embed_configs table if it doesn't exist
    
    This table stores configurations for embeddable pages.
    """
    try:
        from backend.models.embed_config import EmbedConfig
        from backend.models.base import Base
        from sqlalchemy import inspect, text
        
        logger.info("🎨 Checking embed_configs table...")
        
        inspector = inspect(engine)
        
        if not inspector.has_table('embed_configs'):
            logger.info("➕ Creating embed_configs table...")
            EmbedConfig.__table__.create(engine)
            logger.info("✅ embed_configs table created successfully")
            
            # Создаем функцию генерации кодов и триггер
            logger.info("➕ Creating embed_code generator function and trigger...")
            
            try:
                with engine.connect() as conn:
                    trans = conn.begin()
                    try:
                        # Функция генерации кода
                        conn.execute(text("""
                            CREATE OR REPLACE FUNCTION generate_embed_code() 
                            RETURNS TEXT AS $$
                            DECLARE
                                new_code TEXT;
                                code_exists BOOLEAN;
                            BEGIN
                                LOOP
                                    new_code := 'w_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
                                    SELECT EXISTS(SELECT 1 FROM embed_configs WHERE embed_code = new_code) INTO code_exists;
                                    EXIT WHEN NOT code_exists;
                                END LOOP;
                                RETURN new_code;
                            END;
                            $$ LANGUAGE plpgsql;
                        """))
                        
                        # Триггер функция
                        conn.execute(text("""
                            CREATE OR REPLACE FUNCTION set_embed_code() 
                            RETURNS TRIGGER AS $$
                            BEGIN
                                IF NEW.embed_code IS NULL OR NEW.embed_code = '' THEN
                                    NEW.embed_code := generate_embed_code();
                                END IF;
                                RETURN NEW;
                            END;
                            $$ LANGUAGE plpgsql;
                        """))
                        
                        # Триггер
                        conn.execute(text("""
                            DROP TRIGGER IF EXISTS trigger_set_embed_code ON embed_configs;
                        """))
                        
                        conn.execute(text("""
                            CREATE TRIGGER trigger_set_embed_code
                            BEFORE INSERT ON embed_configs
                            FOR EACH ROW
                            EXECUTE FUNCTION set_embed_code();
                        """))
                        
                        trans.commit()
                        logger.info("✅ Embed code generator and trigger created successfully")
                        
                    except Exception as e:
                        trans.rollback()
                        logger.error(f"❌ Failed to create generator/trigger: {str(e)}")
                        
            except Exception as conn_error:
                logger.error(f"❌ Connection error creating functions: {str(conn_error)}")
                
        else:
            logger.info("✅ embed_configs table already exists")
            
    except Exception as e:
        logger.error(f"❌ Error creating embed_configs table: {str(e)}")
        if not settings.PRODUCTION:
            raise

# ============================================================================
# APPLICATION LIFECYCLE EVENTS
# ============================================================================

@app.on_event("startup")
async def startup_event():
    """Application startup event"""
    try:
        logger.info("🚀 Starting WellcomeAI application v2.5...")
        
        # Простая проверка блокировки для Render
        lock_file_path = "/tmp/wellcome_migrations.lock"
        migration_completed = False
        
        try:
            # Для Render используем более простую блокировку
            if not os.path.exists(lock_file_path):
                # Создаем файл блокировки
                with open(lock_file_path, 'w') as lock_file:
                    lock_file.write(str(os.getpid()))
                
                logger.info("🔒 Running migrations and schema fixes...")
                
                # Шаг 1: Запускаем миграции
                run_migrations()
                
                # Шаг 2: Создаем базовые таблицы
                create_tables(engine)
                
                # Шаг 3: Комплексная проверка и исправление схемы
                check_and_fix_all_missing_columns()
                
                # Шаг 4: Создаем таблицы ElevenLabs и проверяем колонки
                create_elevenlabs_tables()
                
                # Шаг 5: Создаем таблицу email_verifications
                create_email_verification_table()
                
                # Шаг 6: Создаем таблицу embed_configs
                create_embed_configs_table()
                
                # Шаг 7: Создаем таблицы Gemini
                create_gemini_tables()
                
                # Шаг 8: Создаем таблицы CRM (Contacts)
                create_crm_tables()
                
                migration_completed = True
                logger.info("✅ All migrations and schema fixes completed")
                
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
        
        # Запуск планировщика только в одном процессе
        try:
            worker_id = os.environ.get("APP_WORKER_ID", "0")
            
            # Для Gunicorn проверяем переменную окружения
            if os.environ.get("SERVER_SOFTWARE", "").startswith("gunicorn"):
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
        
        # Логирование инициализации Email Verification
        try:
            logger.info("📧 Email Verification API initialized")
            logger.info(f"   Send code: {settings.HOST_URL}/api/email-verification/send")
            logger.info(f"   Resend code: {settings.HOST_URL}/api/email-verification/resend")
            logger.info(f"   Verify code: {settings.HOST_URL}/api/email-verification/verify")
            logger.info(f"   Status: {settings.HOST_URL}/api/email-verification/status/{{email}}")
        except Exception as e:
            logger.error(f"❌ Error initializing Email Verification: {str(e)}")
        
        # Логирование инициализации Voximplant интеграции
        try:
            logger.info("📞 Voximplant integration initialized")
            logger.info(f"   WebSocket endpoint: {settings.HOST_URL}/api/voximplant/ws/{{assistant_id}}")
            logger.info(f"   Demo endpoint: {settings.HOST_URL}/api/voximplant/ws/demo")
            logger.info(f"   Test endpoint: {settings.HOST_URL}/api/voximplant/test")
        except Exception as e:
            logger.error(f"❌ Error initializing Voximplant integration: {str(e)}")
        
        # Логирование инициализации ElevenLabs интеграции
        try:
            logger.info("🎙️ ElevenLabs integration initialized")
            logger.info(f"   API endpoints: {settings.HOST_URL}/api/elevenlabs/")
            logger.info(f"   WebSocket endpoint: {settings.HOST_URL}/api/elevenlabs/ws/{{agent_id}}")
            logger.info(f"   Voice generation endpoint: {settings.HOST_URL}/api/elevenlabs/generate")
        except Exception as e:
            logger.error(f"❌ Error initializing ElevenLabs integration: {str(e)}")
        
        # Логирование инициализации Conversations API
        try:
            logger.info("💬 Conversations API initialized")
            logger.info(f"   List endpoint: {settings.HOST_URL}/api/conversations")
            logger.info(f"   Sessions endpoint: {settings.HOST_URL}/api/conversations/sessions")
            logger.info(f"   Detail endpoint: {settings.HOST_URL}/api/conversations/{{id}}")
            logger.info(f"   Stats endpoint: {settings.HOST_URL}/api/conversations/stats")
            logger.info(f"   By caller endpoint: {settings.HOST_URL}/api/conversations/by-caller/{{phone}}")
        except Exception as e:
            logger.error(f"❌ Error initializing Conversations API: {str(e)}")
        
        # ✅ НОВОЕ: Логирование инициализации CRM API
        try:
            logger.info("📇 CRM API initialized")
            logger.info(f"   List contacts: GET {settings.HOST_URL}/api/contacts")
            logger.info(f"   Get contact: GET {settings.HOST_URL}/api/contacts/{{id}}")
            logger.info(f"   Create/Update: POST {settings.HOST_URL}/api/contacts")
            logger.info(f"   Update: PUT {settings.HOST_URL}/api/contacts/{{id}}")
            logger.info(f"   Update status: PATCH {settings.HOST_URL}/api/contacts/{{id}}/status")
            logger.info(f"   Delete: DELETE {settings.HOST_URL}/api/contacts/{{id}}")
            logger.info("   Features:")
            logger.info("     - Auto-create contacts from phone calls")
            logger.info("     - Link all conversations to contacts")
            logger.info("     - Contact statuses: new, active, client, archived")
            logger.info("     - Search and filtering")
        except Exception as e:
            logger.error(f"❌ Error initializing CRM API: {str(e)}")
        
        # Логирование инициализации Embeds API
        try:
            logger.info("🎨 Embeds API initialized")
            logger.info(f"   Create embed: POST {settings.HOST_URL}/api/embeds")
            logger.info(f"   List user embeds: GET {settings.HOST_URL}/api/embeds/user/me")
            logger.info(f"   Public embed page: GET {settings.HOST_URL}/embed/{{embed_code}}")
            logger.info(f"   Example: {settings.HOST_URL}/embed/w_abc123def456")
            logger.info("   Usage: <iframe src='https://voicyfy.ru/embed/w_YOUR_CODE' width='100%' height='800px'></iframe>")
        except Exception as e:
            logger.error(f"❌ Error initializing Embeds API: {str(e)}")
        
        # Логирование инициализации Gemini Live API
        try:
            logger.info("🤖 Google Gemini Live API initialized")
            logger.info(f"   WebSocket endpoint: {settings.HOST_URL}/ws/gemini/{{assistant_id}}")
            logger.info(f"   Model: gemini-2.5-flash-native-audio-preview-09-2025")
            logger.info(f"   Health check: {settings.HOST_URL}/gemini/health")
            logger.info(f"   Info: {settings.HOST_URL}/gemini/info")
            logger.info("   Features:")
            logger.info("     - Real-time audio (16kHz in, 24kHz out)")
            logger.info("     - Automatic VAD (voice activity detection)")
            logger.info("     - Manual function calling")
            logger.info("     - Thinking mode (configurable)")
            logger.info("     - Screen context support")
            logger.info("     - 30 HD voices, 24 languages")
        except Exception as e:
            logger.error(f"❌ Error initializing Gemini Live API: {str(e)}")
        
        # Логирование инициализации Gemini Assistants API
        try:
            logger.info("🤖 Gemini Assistants CRUD API initialized")
            logger.info(f"   List: GET {settings.HOST_URL}/api/gemini-assistants")
            logger.info(f"   Get: GET {settings.HOST_URL}/api/gemini-assistants/{{id}}")
            logger.info(f"   Create: POST {settings.HOST_URL}/api/gemini-assistants")
            logger.info(f"   Update: PUT {settings.HOST_URL}/api/gemini-assistants/{{id}}")
            logger.info(f"   Delete: DELETE {settings.HOST_URL}/api/gemini-assistants/{{id}}")
            logger.info(f"   Embed code: GET {settings.HOST_URL}/api/gemini-assistants/{{id}}/embed-code")
            logger.info(f"   Verify Sheet: POST {settings.HOST_URL}/api/gemini-assistants/{{id}}/verify-sheet")
        except Exception as e:
            logger.error(f"❌ Error initializing Gemini Assistants API: {str(e)}")
        
        logger.info("✅ Application started successfully (v2.5 with CRM)")
        
    except Exception as e:
        logger.error(f"❌ Startup error: {str(e)}", exc_info=True)
        if not settings.PRODUCTION:
            raise

# ============================================================================
# ROOT ROUTES
# ============================================================================

@app.get("/")
async def root():
    """Redirect to main page"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")


@app.get("/health")
async def health_check():
    """Health check for deployment platforms"""
    return {
        "status": "healthy",
        "service": "wellcome-ai",
        "version": "2.5.0",
        "features": {
            "openai_realtime": True,
            "gemini_live": True,
            "gemini_assistants_crud": True,
            "elevenlabs": True,
            "voximplant": True,
            "embeds": True,
            "email_verification": True,
            "crm": True  # ✅ НОВОЕ: CRM функциональность
        }
    }


@app.on_event("shutdown")
async def shutdown_event():
    """Application shutdown event"""
    logger.info("🛑 Application stopped")
