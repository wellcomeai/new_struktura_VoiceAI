"""
API module for WellcomeAI application.
Contains FastAPI route definitions for all endpoints.
"""

from fastapi import APIRouter

from .auth import router as auth_router
from .users import router as users_router
from .assistants import router as assistants_router
from .files import router as files_router
from .websocket import router as websocket_router
from .subscriptions import router as subscriptions_router
from .admin import router as admin_router
from .knowledge_base import router as knowledge_base_router  # New import

# Create a main API router
api_router = APIRouter()

# Исправлено: удалены префиксы, будут добавлены в app.py
api_router.include_router(auth_router, tags=["Authentication"])
api_router.include_router(users_router, tags=["Users"])
api_router.include_router(assistants_router, tags=["Assistants"])
api_router.include_router(files_router, tags=["Files"])
api_router.include_router(websocket_router, tags=["WebSocket"])
api_router.include_router(subscriptions_router, tags=["Subscriptions"])
api_router.include_router(admin_router, prefix="/admin", tags=["Admin"])
api_router.include_router(knowledge_base_router)  # Added new router

# Export all routers for use in app.py
__all__ = [
    "api_router",
    "auth_router",
    "users_router",
    "assistants_router",
    "files_router",
    "websocket_router",
    "subscriptions_router",
    "admin_router",
    "knowledge_base_router"  # Added to exports
]
