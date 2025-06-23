# backend/api/voximplant.py - ОБНОВЛЕННАЯ ВЕРСИЯ

"""
Voximplant API endpoints for WellcomeAI application.
Handles WebSocket connections from Voximplant telephony platform.
"""

from fastapi import APIRouter, WebSocket, Depends, Query, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any
import time

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.db.session import get_db

logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.websocket("/ws/{assistant_id}")
async def voximplant_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    caller: Optional[str] = Query(None, description="Номер звонящего"),
    session: Optional[str] = Query(None, description="ID сессии звонка"),
    call_id: Optional[str] = Query(None, description="ID звонка в Voximplant"),
    db: Session = Depends(get_db)
):
    """
    WebSocket эндпоинт для соединений от Voximplant.
    
    URL для Voximplant скрипта: 
    wss://your-backend.com/api/voximplant/ws/{assistant_id}?caller={number}&session={call_id}
    """
    
    logger.info(f"[VOXIMPLANT] Новое WebSocket соединение:")
    logger.info(f"   assistant_id: {assistant_id}")
    logger.info(f"   caller: {caller}")
    logger.info(f"   session: {session}")
    logger.info(f"   call_id: {call_id}")
    
    try:
        # ✅ ИСПРАВЛЕНО: Используем упрощенный обработчик
        from backend.websockets.voximplant_handler import handle_voximplant_websocket_simple
        await handle_voximplant_websocket_simple(websocket, assistant_id, db)
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка обработки WebSocket соединения: {e}")
        
        try:
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "server_error",
                    "message": "Внутренняя ошибка сервера при обработке звонка"
                }
            })
        except:
            pass
        
        try:
            await websocket.close()
        except:
            pass

@router.get("/test")
async def test_voximplant_integration():
    """
    Тестовый эндпоинт для проверки готовности Voximplant интеграции.
    """
    try:
        return {
            "status": "ready",
            "service": "voximplant-integration",
            "timestamp": time.time(),
            "websocket_url": f"{settings.HOST_URL}/api/voximplant/ws/{{assistant_id}}",
            "demo_url": f"{settings.HOST_URL}/api/voximplant/ws/demo",
            "supported_features": [
                "real_time_audio_streaming",
                "speech_recognition", 
                "speech_synthesis",
                "function_calling",
                "conversation_logging",
                "interruption_handling",
                "subscription_validation"
            ],
            "audio_format": {
                "encoding": "PCM16",
                "sample_rate": "16kHz", 
                "channels": "mono",
                "chunk_size": "40ms"
            },
            "voximplant_script_config": {
                "wsUrl": f"{settings.HOST_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/api/voximplant/ws",
                "assistantId": "demo",
                "audioEncoding": "PCM16",
                "sampleRate": 16000,
                "channels": 1
            }
        }
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка в тестовом эндпоинте: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ошибка проверки интеграции: {str(e)}"
        )

@router.get("/config")
async def get_voximplant_config():
    """
    Возвращает конфигурацию для настройки Voximplant скрипта.
    """
    try:
        base_ws_url = settings.HOST_URL.replace("https://", "wss://").replace("http://", "ws://")
        
        return {
            "websocket_base_url": f"{base_ws_url}/api/voximplant/ws",
            "demo_assistant_id": "demo",
            "example_urls": {
                "demo": f"{base_ws_url}/api/voximplant/ws/demo",
                "specific_assistant": f"{base_ws_url}/api/voximplant/ws/{{your_assistant_id}}"
            },
            "voximplant_script_config": {
                "wsUrl": f"{base_ws_url}/api/voximplant/ws",
                "assistantId": "demo",
                "audioEncoding": "PCM16",
                "sampleRate": 16000,
                "channels": 1
            },
            "required_parameters": [
                "assistant_id - ID вашего ассистента из WellcomeAI",
                "caller - номер звонящего (опционально)",
                "session - ID сессии звонка (опционально)"
            ],
            "setup_instructions": [
                "1. Скопируйте исправленный Voximplant скрипт",
                "2. Замените wsUrl на ваш домен с правильным путем /api/voximplant/ws",
                "3. Установите assistantId на ID вашего ассистента", 
                "4. Загрузите скрипт в Voximplant Control Panel",
                "5. Настройте маршрутизацию звонков на этот скрипт"
            ]
        }
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка получения конфигурации: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ошибка получения конфигурации: {str(e)}"
        )

@router.get("/health")
async def voximplant_health_check():
    """
    Проверка состояния Voximplant интеграции.
    """
    try:
        health_status = {
            "status": "healthy",
            "timestamp": time.time(),
            "components": {
                "websocket_handler": "operational",
                "audio_processing": "operational", 
                "assistant_integration": "operational",
                "database_connection": "operational"
            },
            "metrics": {
                "active_connections": 0,
                "total_calls_processed": 0,
                "average_response_time": 0
            },
            "configuration": {
                "host_url": settings.HOST_URL,
                "debug_mode": settings.DEBUG,
                "audio_chunk_size": 1280,
                "auto_commit_timeout": 600
            }
        }
        
        # Проверяем доступность базы данных
        try:
            from backend.db.session import SessionLocal
            db = SessionLocal()
            db.execute("SELECT 1").fetchone()
            db.close()
        except Exception as db_error:
            health_status["components"]["database_connection"] = "error"
            health_status["status"] = "degraded"
            logger.error(f"[VOXIMPLANT] Ошибка подключения к БД: {db_error}")
        
        return health_status
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка проверки состояния: {e}")
        return {
            "status": "error",
            "timestamp": time.time(),
            "error": str(e)
        }

@router.post("/webhook/status")
async def voximplant_status_webhook(request_data: Dict[Any, Any]):
    """
    Webhook для получения статусов звонков от Voximplant.
    """
    try:
        logger.info(f"[VOXIMPLANT] Получен webhook статуса звонка: {request_data}")
        
        call_id = request_data.get("call_id")
        status = request_data.get("status")
        duration = request_data.get("duration")
        
        if call_id and status:
            logger.info(f"[VOXIMPLANT] Звонок {call_id}: статус={status}, длительность={duration}")
        
        return {
            "success": True,
            "message": "Webhook processed successfully",
            "timestamp": time.time()
        }
        
    except Exception as e:
        logger.error(f"[VOXIMPLANT] Ошибка обработки webhook: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ошибка обработки webhook: {str(e)}"
        )
