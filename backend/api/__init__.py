# backend/api/__init__.py
"""
API module for WellcomeAI application.
Contains FastAPI route definitions for all endpoints.
✅ ОБНОВЛЕНО: Добавлен роутер email_verification
✅ ОБНОВЛЕНО: Добавлен роутер embeds
✅ ОБНОВЛЕНО: Добавлен роутер gemini_ws для Google Gemini Live API
✅ ОБНОВЛЕНО: Добавлен роутер gemini_assistants для Gemini CRUD
✅ ОБНОВЛЕНО: Добавлен роутер contacts для CRM функциональности
✅ ОБНОВЛЕНО: Добавлен роутер functions для динамической загрузки функций
✅ ОБНОВЛЕНО v2.8: Добавлен роутер voximplant_settings для настроек Voximplant
🆕 ОБНОВЛЕНО v3.0: Добавлены роутеры grok_assistants и grok_ws для xAI Grok Voice API
"""

from fastapi import APIRouter

from .auth import router as auth_router
from .users import router as users_router
from .assistants import router as assistants_router
from .gemini_assistants import router as gemini_assistants_router
from .grok_assistants import router as grok_assistants_router  # 🆕 v3.0: Grok CRUD
from .cartesia_assistants import router as cartesia_assistants_router  # 🆕 v4.0: Cartesia CRUD
from .files import router as files_router
from .websocket import router as websocket_router
from .gemini_ws import router as gemini_ws_router
from .grok_ws import router as grok_ws_router  # 🆕 v3.0: Grok WebSocket
from .subscriptions import router as subscriptions_router
from .admin import router as admin_router
from .knowledge_base import router as knowledge_base_router
from .payments import router as payments_router
from .subscription_status import router as subscription_status_router
from .voximplant import router as voximplant_router
from .voximplant_settings import router as voximplant_settings_router
from .elevenlabs import router as elevenlabs_router
from .partners import router as partners_router
from .conversations import router as conversations_router
from .email_verification import router as email_verification_router
from .embeds import router as embeds_router
from .llm_streaming import router as llm_streaming_router
from .contacts import router as contacts_router
from .functions import router as functions_router
from .telephony import router as telephony_router

# Create a main API router
api_router = APIRouter()

# Подключаем все роутеры
api_router.include_router(auth_router, tags=["Authentication"])
api_router.include_router(users_router, tags=["Users"])
api_router.include_router(gemini_assistants_router, prefix="/gemini-assistants", tags=["Gemini Assistants"])
api_router.include_router(grok_assistants_router, prefix="/grok-assistants", tags=["Grok Assistants"])  # 🆕 v3.0
api_router.include_router(cartesia_assistants_router, prefix="/cartesia-assistants", tags=["Cartesia Assistants"])  # 🆕 v4.0
api_router.include_router(files_router, tags=["Files"])
api_router.include_router(websocket_router, tags=["WebSocket"])
api_router.include_router(gemini_ws_router, tags=["Gemini WebSocket"])
api_router.include_router(grok_ws_router, tags=["Grok WebSocket"])  # 🆕 v3.0
api_router.include_router(subscriptions_router, tags=["Subscriptions"])
api_router.include_router(admin_router, prefix="/admin", tags=["Admin"])
api_router.include_router(knowledge_base_router)
api_router.include_router(payments_router, prefix="/payments", tags=["Payments"])
api_router.include_router(subscription_status_router, prefix="/subscription-status", tags=["Subscription Status"])
api_router.include_router(voximplant_router, prefix="/voximplant", tags=["Voximplant"])
api_router.include_router(voximplant_settings_router, prefix="/users", tags=["Voximplant Settings"])
api_router.include_router(elevenlabs_router, prefix="/elevenlabs", tags=["ElevenLabs"])
api_router.include_router(partners_router, prefix="/partners", tags=["Partners"])
api_router.include_router(conversations_router, tags=["Conversations"])
api_router.include_router(email_verification_router, prefix="/email-verification", tags=["Email Verification"])
api_router.include_router(embeds_router, tags=["Embeds"])
api_router.include_router(llm_streaming_router, tags=["LLM Streaming"])
api_router.include_router(contacts_router, tags=["CRM"])
api_router.include_router(functions_router, prefix="/functions", tags=["Functions"])

# Export all routers for use in app.py
__all__ = [
    "api_router",
    "auth_router",
    "users_router",
    "assistants_router",
    "gemini_assistants_router",
    "grok_assistants_router",  # 🆕 v3.0
    "cartesia_assistants_router",  # 🆕 v4.0
    "files_router",
    "websocket_router",
    "gemini_ws_router",
    "grok_ws_router",  # 🆕 v3.0
    "subscriptions_router",
    "admin_router",
    "knowledge_base_router",
    "payments_router",
    "subscription_status_router",
    "voximplant_router",
    "voximplant_settings_router",
    "elevenlabs_router",
    "partners_router",
    "conversations_router",
    "email_verification_router",
    "embeds_router",
    "llm_streaming_router",
    "contacts_router",
    "functions_router",
    "telephony_router"
]
