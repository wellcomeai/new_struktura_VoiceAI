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

# Create a main API router
api_router = APIRouter()

# Include all sub-routers
api_router.include_router(auth_router, prefix="/auth", tags=["Authentication"])
api_router.include_router(users_router, prefix="/users", tags=["Users"])
api_router.include_router(assistants_router, prefix="/assistants", tags=["Assistants"])
api_router.include_router(files_router, prefix="/files", tags=["Files"])
api_router.include_router(websocket_router, tags=["WebSocket"])

# Export all routers for use in app.py
__all__ = [
    "api_router",
    "auth_router",
    "users_router",
    "assistants_router",
    "files_router",
    "websocket_router"
]
