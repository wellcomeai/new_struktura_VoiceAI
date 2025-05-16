"""
FastAPI application initialization for WellcomeAI.
This file configures all application components: routes, middleware, logging, etc.
"""
import os
import asyncio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from backend.core.config import settings
from backend.core.logging import setup_logging, get_logger
from backend.api import auth, users, assistants, files, websocket, healthcheck, subscriptions, subscription_logs, admin
from backend.models.base import create_tables
from backend.db.session import engine
from backend.core.scheduler import start_subscription_checker
from backend.api import knowledge_base 
# Setup logging system
setup_logging()
# Get module logger
logger = get_logger(__name__)
# Create and configure FastAPI application
app = FastAPI(
    title="WellcomeAI - SaaS Voice Assistant",
    description="API for managing personalized voice assistants based on OpenAI",
    version="1.0.0",
    docs_url="/api/docs" if not settings.PRODUCTION else None,
    redoc_url="/api/redoc" if not settings.PRODUCTION else None
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
# Connect API routes with CORRECTED PREFIXES
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(users.router, prefix="/api/users", tags=["Users"])
app.include_router(assistants.router, prefix="/api/assistants", tags=["Assistants"])
app.include_router(files.router, prefix="/api/files", tags=["Files"])
app.include_router(websocket.router, tags=["WebSocket"])
app.include_router(healthcheck.router, tags=["Health"])
app.include_router(subscriptions.router, prefix="/api/subscriptions", tags=["Subscriptions"])
app.include_router(subscription_logs.router, prefix="/api/subscription-logs", tags=["Subscription Logs"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])  # Убедитесь, что этот роутер подключен
app.include_router(knowledge_base.router, prefix="/api/knowledge-base", tags=["Knowledge Base"])

# Check and create directories for static files
static_dir = os.path.join(os.getcwd(), "backend/static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
    logger.info(f"Created static directory at {static_dir}")

# Проверка наличия директории /js для решения проблемы с twint_ch.js
js_dir = os.path.join(static_dir, "js")
if not os.path.exists(js_dir):
    os.makedirs(js_dir)
    logger.info(f"Created js directory at {js_dir}")

# Mount static files from backend/static directory
app.mount("/static", StaticFiles(directory="backend/static"), name="static")

# Можно также примонтировать /js напрямую для решения проблемы с twint_ch.js
app.mount("/js", StaticFiles(directory=js_dir), name="js")

# Application startup handler
@app.on_event("startup")
async def startup_event():
    # Create database tables if they don't exist
    create_tables(engine)
    
    # Start the subscription checker background task
    asyncio.create_task(start_subscription_checker())
    logger.info("Subscription checker started")
    
    logger.info("Application started successfully")
# Main page (redirects to static page)
@app.get("/")
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")
# Application shutdown handler
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Application stopped")
