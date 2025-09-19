"""
WebSocket API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, HTTPException, Query
from sqlalchemy.orm import Session
from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets.handler import handle_websocket_connection
from backend.websockets.handler_new import handle_websocket_connection_new  # ✅ НОВЫЙ ИМПОРТ

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.websocket("/ws/{assistant_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    WebSocket endpoint for real-time communication with assistants (BETA version).
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID to connect to
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"New WebSocket connection request from client {client_id} for assistant {assistant_id}")
    
    try:
        await handle_websocket_connection(websocket, assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"Error in WebSocket connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred"
                    }
                })
        except Exception:
            pass

# ✅ НОВЫЙ GA ENDPOINT ДЛЯ ТЕСТИРОВАНИЯ
@router.websocket("/ws/{assistant_id}/ga")
async def websocket_endpoint_ga(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    WebSocket endpoint for real-time communication with assistants (GA version).
    
    🧪 TEST ENDPOINT: Uses new gpt-realtime model and GA API interface.
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID to connect to
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[GA] New WebSocket GA connection request from client {client_id} for assistant {assistant_id}")
    
    try:
        await handle_websocket_connection_new(websocket, assistant_id, db)  # ✅ НОВЫЙ ОБРАБОТЧИК
    except WebSocketDisconnect:
        logger.info(f"[GA] WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[GA] Error in WebSocket GA connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred in GA version",
                        "version": "ga"
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
    Demo WebSocket endpoint for the demo assistant (BETA version).
    
    Args:
        websocket: WebSocket connection
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"New demo WebSocket connection from client {client_id}")
    
    # Use a hardcoded demo assistant ID
    demo_assistant_id = "demo"
    
    try:
        await handle_websocket_connection(websocket, demo_assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"Demo WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"Error in demo WebSocket connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred"
                    }
                })
        except Exception:
            pass

# ✅ НОВЫЙ DEMO GA ENDPOINT
@router.websocket("/ws/demo/ga")
async def demo_websocket_endpoint_ga(
    websocket: WebSocket,
    db: Session = Depends(get_db)
):
    """
    Demo WebSocket endpoint for the demo assistant (GA version).
    
    🧪 TEST ENDPOINT: Uses new gpt-realtime model and GA API interface.
    
    Args:
        websocket: WebSocket connection
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"[GA] New demo WebSocket GA connection from client {client_id}")
    
    # Use a hardcoded demo assistant ID
    demo_assistant_id = "demo"
    
    try:
        await handle_websocket_connection_new(websocket, demo_assistant_id, db)  # ✅ НОВЫЙ ОБРАБОТЧИК
    except WebSocketDisconnect:
        logger.info(f"[GA] Demo WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"[GA] Error in demo WebSocket GA connection: {str(e)}")
        
        # Attempt to send error message to client if connection is still open
        try:
            if websocket.client_state.CONNECTED:
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "message": "Server error occurred in demo GA version",
                        "version": "ga"
                    }
                })
        except Exception:
            pass
