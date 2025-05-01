"""
WebSocket API endpoints for WellcomeAI application.
"""

"""
WebSocket API endpoints for WellcomeAI application.
"""
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, HTTPException, Query
from sqlalchemy.orm import Session
from backend.core.logging import get_logger  # Изменен импорт core
from backend.db.session import get_db  # Уже корректный импорт
from backend.websockets.handler import handle_websocket_connection  # Изменен импорт websockets

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
    WebSocket endpoint for real-time communication with assistants.
    
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

@router.websocket("/ws/demo")
async def demo_websocket_endpoint(
    websocket: WebSocket,
    db: Session = Depends(get_db)
):
    """
    Demo WebSocket endpoint for the demo assistant.
    
    Args:
        websocket: WebSocket connection
        db: Database session dependency
    """
    client_id = id(websocket)
    logger.info(f"New demo WebSocket connection from client {client_id}")
    
    # Use a hardcoded demo assistant ID
    demo_assistant_id = "demo"  # Replace with your actual demo assistant ID
    
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
