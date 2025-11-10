"""
API module for WellcomeAI application.
Contains FastAPI route definitions for all endpoints.
✅ ОБНОВЛЕНО: Добавлен роутер email_verification
🧪 ЭКСПЕРИМЕНТАЛЬНО: Добавлен роутер websocket_streaming
"""

from fastapi import APIRouter

from .auth import router as auth_router
from .users import router as users_router
from .assistants import router as assistants_router
from .files import router as files_router
from .websocket import router as websocket_router
from .subscriptions import router as subscriptions_router
from .admin import router as admin_router
from .knowledge_base import router as knowledge_base_router
from .payments import router as payments_router
from .subscription_status import router as subscription_status_router
from .voximplant import router as voximplant_router
from .elevenlabs import router as elevenlabs_router
from .partners import router as partners_router
from .conversations import router as conversations_router
from .email_verification import router as email_verification_router
from .embeds import router as embeds_router
# Create a main API router
api_router = APIRouter()

# Подключаем все роутеры
api_router.include_router(auth_router, tags=["Authentication"])
api_router.include_router(users_router, tags=["Users"])
api_router.include_router(assistants_router, tags=["Assistants"])
api_router.include_router(files_router, tags=["Files"])
api_router.include_router(websocket_router, tags=["WebSocket"])
api_router.include_router(websocket_streaming_router, tags=["WebSocket Streaming (Experimental)"])  # 🧪 НОВОЕ
api_router.include_router(subscriptions_router, tags=["Subscriptions"])
api_router.include_router(admin_router, prefix="/admin", tags=["Admin"])
api_router.include_router(knowledge_base_router)
api_router.include_router(payments_router, prefix="/payments", tags=["Payments"])
api_router.include_router(subscription_status_router, prefix="/subscription-status", tags=["Subscription Status"])
api_router.include_router(voximplant_router, prefix="/voximplant", tags=["Voximplant"])
api_router.include_router(elevenlabs_router, prefix="/elevenlabs", tags=["ElevenLabs"])
api_router.include_router(partners_router, prefix="/partners", tags=["Partners"])
api_router.include_router(conversations_router, tags=["Conversations"])
api_router.include_router(email_verification_router, prefix="/email-verification", tags=["Email Verification"])
api_router.include_router(embeds_router, tags=["Embeds"])

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
    "knowledge_base_router",
    "payments_router",
    "subscription_status_router",
    "voximplant_router",
    "elevenlabs_router",
    "partners_router",
    "conversations_router",
    "email_verification_router",
    "embeds_router"
]
