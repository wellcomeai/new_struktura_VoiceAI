"""
WebSocket router for Google Gemini Live API integration.
Handles real-time voice conversations with Gemini assistants.

🚀 PRODUCTION VERSION 2.0
✅ Complete WebSocket handling
✅ Database integration
✅ Subscription validation
✅ Error handling
🆕 Browser Agent integration (v2.0)
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session
import traceback

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets import (
    handle_gemini_websocket_connection,
    handle_gemini_browser_websocket_connection
)

logger = get_logger(__name__)

router = APIRouter()


# =============================================================================
# 🎤 VOICE ONLY - Original endpoint (без Browser Agent)
# =============================================================================

@router.websocket("/ws/gemini/{assistant_id}")
async def gemini_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    🎤 WebSocket endpoint for Gemini Live API voice assistants (Voice Only).
    
    Features:
    - Real-time bidirectional audio streaming (PCM 16kHz input, 24kHz output)
    - Automatic Voice Activity Detection (VAD)
    - Manual function calling support
    - Thinking mode support (configurable)
    - Screen context support
    - Google Sheets logging
    - Database conversation storage
    - Subscription validation
    
    Args:
        websocket: WebSocket connection from client
        assistant_id: UUID of Gemini assistant or "demo" for public assistant
        db: Database session
    
    Example:
        wss://api.yourserver.com/ws/gemini/550e8400-e29b-41d4-a716-446655440000
    """
    try:
        logger.info(f"[GEMINI-WS] New connection attempt: assistant_id={assistant_id}")
        
        # Delegate to handler
        await handle_gemini_websocket_connection(
            websocket=websocket,
            assistant_id=assistant_id,
            db=db
        )
        
    except WebSocketDisconnect:
        logger.info(f"[GEMINI-WS] Client disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[GEMINI-WS] WebSocket error for assistant {assistant_id}: {e}")
        logger.error(f"[GEMINI-WS] Traceback: {traceback.format_exc()}")
        
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except:
            pass


# =============================================================================
# 🤖 VOICE + BROWSER AGENT - New endpoint (v2.0)
# =============================================================================

@router.websocket("/ws/gemini-browser/{assistant_id}")
async def gemini_browser_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db)
):
    """
    🤖 WebSocket endpoint for Gemini Live API + Browser Agent (v2.0).
    
    This endpoint includes all features of the regular Gemini endpoint,
    plus autonomous browser control capabilities:
    
    Voice Features (same as /ws/gemini):
    - Real-time bidirectional audio streaming (PCM 16kHz input, 24kHz output)
    - Automatic Voice Activity Detection (VAD)
    - Manual function calling support
    - Thinking mode support (configurable)
    - Screen context support
    - Google Sheets logging
    - Database conversation storage
    - Subscription validation
    
    🆕 Browser Agent Features:
    - Autonomous DOM manipulation
    - Multi-step task execution
    - Visual element highlighting
    - Progress notifications via voice
    - Parallel execution (doesn't block voice)
    
    Browser Agent Messages:
    - browser.start_task: Start a new browser task
    - browser.cancel_task: Cancel running task
    - browser.dom_response: Widget sends DOM snapshot
    - browser.action_result: Widget sends action result
    - browser.dom_request: Server requests DOM
    - browser.action: Server requests action execution
    - browser_agent.speak: Voice notification from agent
    
    Args:
        websocket: WebSocket connection from client
        assistant_id: UUID of Gemini assistant or "demo" for public assistant
        db: Database session
    
    Example:
        wss://api.yourserver.com/ws/gemini-browser/550e8400-e29b-41d4-a716-446655440000
    
    Usage:
        1. Connect widget to this endpoint instead of /ws/gemini
        2. Widget must implement DOMController for browser.* messages
        3. Voice commands like "найди iPhone" trigger browser tasks automatically
    """
    try:
        logger.info(f"[GEMINI-BROWSER-WS] New connection attempt: assistant_id={assistant_id}")
        logger.info(f"[GEMINI-BROWSER-WS] Browser Agent: ENABLED")
        
        # Delegate to browser-enabled handler
        await handle_gemini_browser_websocket_connection(
            websocket=websocket,
            assistant_id=assistant_id,
            db=db
        )
        
    except WebSocketDisconnect:
        logger.info(f"[GEMINI-BROWSER-WS] Client disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[GEMINI-BROWSER-WS] WebSocket error for assistant {assistant_id}: {e}")
        logger.error(f"[GEMINI-BROWSER-WS] Traceback: {traceback.format_exc()}")
        
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except:
            pass


# =============================================================================
# 📊 HEALTH & INFO ENDPOINTS
# =============================================================================

@router.get("/gemini/health")
async def gemini_health_check():
    """
    Health check endpoint for Gemini WebSocket service.
    
    Returns:
        dict: Service status information
    """
    return {
        "status": "healthy",
        "service": "gemini_websocket",
        "version": "2.0",
        "model": "gemini-2.5-flash-native-audio-preview-09-2025",
        "browser_agent_model": "gemini-2.0-flash",
        "features": [
            "real_time_audio",
            "automatic_vad",
            "function_calling",
            "thinking_mode",
            "screen_context",
            "google_sheets_logging",
            "browser_agent"
        ]
    }


@router.get("/gemini/info")
async def gemini_info():
    """
    Get information about Gemini Live API integration.
    
    Returns:
        dict: Detailed service information
    """
    return {
        "service": "Google Gemini Live API",
        "version": "2.0",
        "models": {
            "voice": "gemini-2.5-flash-native-audio-preview-09-2025",
            "browser_agent": "gemini-2.0-flash"
        },
        "audio": {
            "input_format": "PCM 16kHz mono 16-bit",
            "output_format": "PCM 24kHz mono 16-bit",
            "vad": "automatic (built-in)"
        },
        "features": {
            "function_calling": "manual (handler-controlled)",
            "thinking_mode": "configurable per assistant",
            "screen_context": "supported (silent mode)",
            "interruptions": "automatic via VAD",
            "multi_language": "24 languages supported",
            "voices": "30 HD voices available",
            "browser_agent": "autonomous DOM control"
        },
        "browser_agent": {
            "capabilities": [
                "click elements",
                "type text into inputs",
                "scroll pages",
                "extract data",
                "multi-step tasks",
                "visual highlighting"
            ],
            "max_iterations": 25,
            "action_timeout": "15s",
            "parallel_execution": True
        },
        "endpoints": {
            "websocket_voice": "/ws/gemini/{assistant_id}",
            "websocket_browser": "/ws/gemini-browser/{assistant_id}",
            "health": "/gemini/health",
            "info": "/gemini/info"
        }
    }
