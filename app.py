"""
FastAPI application initialization for WellcomeAI.
This file configures all application components: routes, middleware, logging, etc.
"""

import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.core.config import settings
from backend.core.logging import setup_logging
from backend.api import auth, users, assistants, files, websocket, healthcheck
from backend.models.base import create_tables
from backend.db.session import engine

# Setup logging
logger = setup_logging()

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

# Connect API routes
app.include_router(auth.router, prefix="/api", tags=["Authentication"])
app.include_router(users.router, prefix="/api", tags=["Users"])
app.include_router(assistants.router, prefix="/api", tags=["Assistants"])
app.include_router(files.router, prefix="/api", tags=["Files"])
app.include_router(websocket.router, tags=["WebSocket"])
app.include_router(healthcheck.router, tags=["Health"])

# Check and create directories for static files
static_dir = os.path.join(os.getcwd(), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
    logger.info(f"Created static directory")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Application startup handler
@app.on_event("startup")
async def startup_event():
    # Create database tables if they don't exist
    create_tables(engine)
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
