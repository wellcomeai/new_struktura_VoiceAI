"""
WebSocket handler for WellcomeAI application.
Handles WebSocket connections and message processing.
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
from typing import Dict, Any, Optional, List

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation

logger = get_logger(__name__)

# Store active connections for each assistant
active_connections: Dict[str, List[WebSocket]] = {}

async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    WebSocket connection handler
    
    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID
        db: Database session
    """
    # Client identifier
    client_id = str(uuid.uuid4())
    
    try:
        # Accept connection
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")
        
        # Register connection
        if assistant_id not in active_connections:
            active_connections[assistant_id] = []
        active_connections[assistant_id].append(websocket)
        
        # Send welcome message
        await websocket.send_json({
            "type": "connection_status",
            "status": "connected",
            "message": "Connection established"
        })
        
        # Load assistant from database
        assistant = None
        try:
            assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
            if not assistant:
                logger.warning(f"Assistant not found: {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "assistant_not_found",
                        "message": "Assistant not found"
                    }
                })
                await websocket.close(code=1008)  # Policy violation
                return
        except Exception as e:
            logger.error(f"Error loading assistant: {str(e)}")
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "database_error",
                    "message": "Error loading assistant"
                }
            })
            await websocket.close(code=1011)  # Internal server error
            return
        
        # Main message processing loop
        while True:
            # Get message
            try:
                data = await websocket.receive_text()
                
                # Parse JSON
                message = json.loads(data)
                
                # Process message
                if message.get("type") == "ping":
                    # Respond to ping
                    await websocket.send_text("pong")
                    continue
                
                # Main message processing logic will go here
                # For now just send echo
                await websocket.send_json({
                    "type": "echo",
                    "message": message
                })
                
            except json.JSONDecodeError:
                logger.warning(f"Received invalid JSON message: {data}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "invalid_json",
                        "message": "Invalid JSON format"
                    }
                })
            except Exception as e:
                logger.error(f"Error processing message: {str(e)}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "processing_error",
                        "message": f"Error processing message: {str(e)}"
                    }
                })
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket connection closed: client_id={client_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
        try:
            await websocket.close(code=1011)  # Internal server error
        except:
            pass
    finally:
        # Remove connection from active list
        if assistant_id in active_connections and websocket in active_connections[assistant_id]:
            active_connections[assistant_id].remove(websocket)
            if not active_connections[assistant_id]:
                del active_connections[assistant_id]
