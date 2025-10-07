# backend/api/websocket.py
"""
WebSocket API endpoints for WellcomeAI application.
Includes both production (old API) and testing (new GA API) endpoints.
"""

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets.handler import handle_websocket_connection  # СТАРЫЙ production handler
from backend.websockets.handler_realtime_new import handle_websocket_connection_new  # 🆕 НОВЫЙ GA handler

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()


# ==================================================================================
# 🏭 PRODUCTION ENDPOINTS - OLD REALTIME API (НЕ ТРОГАЕМ)
# ==================================================================================

@router.websocket("/ws/{assistant_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    🏭 PRODUCTION WebSocket endpoint for real-time communication with assistants.
    Uses OLD OpenAI Realtime API (beta version, gpt-4o-realtime-preview).
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID to connect to
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[OLD-API] New WebSocket connection request from client {client_id} for assistant {assistant_id}")
    
    try:
        await handle_websocket_connection(websocket, assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"[OLD-API] WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[OLD-API] Error in WebSocket connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred",
                        "api_version": "old"
                    }
                })
        except Exception:
            pass


@router.websocket("/ws/demo")
async def demo_websocket_endpoint(
    websocket: WebSocket,
    db: Session = Depends(get_db)
):
    """
    🏭 PRODUCTION Demo WebSocket endpoint for the demo assistant.
    Uses OLD OpenAI Realtime API (beta version).
    
    Args:
        websocket: WebSocket connection
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[OLD-API-DEMO] New demo WebSocket connection from client {client_id}")
    
    # Use a hardcoded demo assistant ID
    demo_assistant_id = "demo"
    
    try:
        await handle_websocket_connection(websocket, demo_assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"[OLD-API-DEMO] Demo WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[OLD-API-DEMO] Error in demo WebSocket connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred",
                        "api_version": "old",
                        "mode": "demo"
                    }
                })
        except Exception:
            pass


# ==================================================================================
# 🆕 TESTING ENDPOINTS - NEW REALTIME GA API
# ==================================================================================

@router.websocket("/ws-test/{assistant_id}")
async def websocket_endpoint_new(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    🆕 TESTING WebSocket endpoint for new OpenAI Realtime GA API.
    Uses NEW gpt-realtime model with updated event format.
    
    ⚠️ This is a testing endpoint! Use /ws/{assistant_id} for production.
    
    Changes from old API:
    - Model: gpt-realtime (instead of gpt-4o-realtime-preview)
    - Events: output_text, output_audio, output_audio_transcript
    - New: conversation.item.added/done events
    - Required: session type parameter
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID to connect to
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[NEW-API] 🆕 Testing WebSocket connection from client {client_id} for assistant {assistant_id}")
    logger.info(f"[NEW-API] Using NEW Realtime GA API (gpt-realtime model)")
    
    try:
        await handle_websocket_connection_new(websocket, assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"[NEW-API] WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[NEW-API] Error in WebSocket connection: {str(e)}")
        logger.error(f"[NEW-API] Exception type: {type(e).__name__}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred",
                        "api_version": "new-ga",
                        "model": "gpt-realtime",
                        "details": str(e) if not isinstance(e, WebSocketDisconnect) else "Connection closed"
                    }
                })
        except Exception as send_error:
            logger.error(f"[NEW-API] Failed to send error message: {send_error}")


@router.websocket("/ws-test/demo")
async def demo_websocket_endpoint_new(
    websocket: WebSocket,
    db: Session = Depends(get_db)
):
    """
    🆕 TESTING Demo WebSocket endpoint for new OpenAI Realtime GA API.
    Uses NEW gpt-realtime model.
    
    ⚠️ This is a testing endpoint! Use /ws/demo for production.
    
    Args:
        websocket: WebSocket connection
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[NEW-API-DEMO] 🆕 Testing demo WebSocket connection from client {client_id}")
    logger.info(f"[NEW-API-DEMO] Using NEW Realtime GA API (gpt-realtime model)")
    
    # Use a hardcoded demo assistant ID
    demo_assistant_id = "demo"
    
    try:
        await handle_websocket_connection_new(websocket, demo_assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"[NEW-API-DEMO] Demo WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[NEW-API-DEMO] Error in demo WebSocket connection: {str(e)}")
        logger.error(f"[NEW-API-DEMO] Exception type: {type(e).__name__}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred",
                        "api_version": "new-ga",
                        "model": "gpt-realtime",
                        "mode": "demo",
                        "details": str(e) if not isinstance(e, WebSocketDisconnect) else "Connection closed"
                    }
                })
        except Exception as send_error:
            logger.error(f"[NEW-API-DEMO] Failed to send error message: {send_error}")


# ==================================================================================
# 📊 UTILITY ENDPOINTS
# ==================================================================================

@router.get("/ws/status")
async def websocket_status():
    """
    Get WebSocket endpoints status and information.
    
    Returns:
        dict: Available WebSocket endpoints and their status
    """
    return {
        "status": "operational",
        "endpoints": {
            "production": {
                "path": "/ws/{assistant_id}",
                "api_version": "old-beta",
                "model": "gpt-4o-realtime-preview",
                "status": "stable",
                "description": "Production endpoint with old Realtime API"
            },
            "production_demo": {
                "path": "/ws/demo",
                "api_version": "old-beta",
                "model": "gpt-4o-realtime-preview",
                "status": "stable",
                "description": "Production demo endpoint"
            },
            "testing": {
                "path": "/ws-test/{assistant_id}",
                "api_version": "new-ga",
                "model": "gpt-realtime",
                "status": "testing",
                "description": "Testing endpoint with NEW Realtime GA API"
            },
            "testing_demo": {
                "path": "/ws-test/demo",
                "api_version": "new-ga",
                "model": "gpt-realtime",
                "status": "testing",
                "description": "Testing demo endpoint with new API"
            }
        },
        "migration_notes": {
            "new_events": [
                "response.output_text.delta",
                "response.output_audio.delta",
                "response.output_audio_transcript.delta",
                "conversation.item.added",
                "conversation.item.done"
            ],
            "deprecated_events": [
                "response.text.delta",
                "response.audio.delta",
                "response.audio_transcript.delta"
            ],
            "changes": [
                "Model changed: gpt-4o-realtime-preview → gpt-realtime",
                "Session type parameter now required",
                "New conversation.item events for better lifecycle tracking"
            ]
        }
    }


# ==================================================================================
# 📝 INFO
# ==================================================================================

"""
USAGE EXAMPLES:

🏭 Production (Old API):
---------------------------
const ws = new WebSocket('wss://your-domain.com/ws/assistant-123');
const wsDemo = new WebSocket('wss://your-domain.com/ws/demo');

🆕 Testing (New GA API):
---------------------------
const wsTest = new WebSocket('wss://your-domain.com/ws-test/assistant-123');
const wsDemoTest = new WebSocket('wss://your-domain.com/ws-test/demo');


MIGRATION PATH:
---------------------------
1. Test new API on /ws-test/{assistant_id}
2. Verify all features work correctly
3. Update production to use new handler
4. Deprecate old endpoints

"""
