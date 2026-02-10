"""
WebSocket router for Google Gemini Live API integration.
Handles real-time voice conversations with Gemini assistants.

🚀 PRODUCTION VERSION 3.3 - DUAL WEBSOCKET ARCHITECTURE + VOX BRIDGE
✅ Complete WebSocket handling
✅ Database integration
✅ Subscription validation
✅ Error handling
✅ Browser Agent integration (v2.0)
🆕 LLM Stream isolated channel (v3.0)
🔧 FIX v3.1: Changed LLM stream path to /llm-stream to avoid conflict with /ws/{assistant_id}
🔧 FIX v3.2: OpenAI API key from User model via assistant_id parameter
🆕 v3.3: Voximplant ↔ Gemini bridge endpoint (fallback when Vox Gemini module fails)

ARCHITECTURE:
┌─────────────┐     WS1 (voice)     ┌──────────────────┐
│   Browser   │◄───────────────────►│ Gemini Handler   │
│             │     WS2 (text)      │                  │
│             │◄───────────────────►│ LLM Stream       │
└─────────────┘                     └──────────────────┘

┌─────────────┐   Vox WS Protocol   ┌──────────────────┐  Native WS  ┌─────────┐
│  Voximplant  │◄──────────────────►│ Vox-Gemini Bridge│◄───────────►│  Gemini  │
│ (telephony)  │ start/media/stop    │  (NEW v3.3)      │  PCM audio   │ Live API │
└─────────────┘                     └──────────────────┘              └─────────┘
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, Query
from sqlalchemy.orm import Session
import traceback
from typing import Optional

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets import (
    handle_gemini_websocket_connection,
    handle_gemini_browser_websocket_connection
)
# 🆕 v3.0: Isolated LLM streaming
from backend.websockets.openai_client_streaming import handle_openai_streaming_websocket
# 🆕 v3.3: Voximplant ↔ Gemini bridge
from backend.websockets.handler_vox_gemini import handle_vox_gemini_websocket

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
    🤖 WebSocket endpoint for Gemini Live API + Browser Agent (v3.2).
    
    This endpoint includes all features of the regular Gemini endpoint,
    plus autonomous browser control capabilities.
    
    🆕 v3.2: LLM текстовый стриминг использует OpenAI ключ из модели User.
    
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
    
    🆕 LLM Integration (v3.2):
    - query_llm function triggers llm.request event
    - Client connects to /llm-stream?assistant_id=xxx for text
    - OpenAI API key fetched from User model via assistant chain
    - Voice and text channels are isolated
    
    Args:
        websocket: WebSocket connection from client
        assistant_id: UUID of Gemini assistant or "demo" for public assistant
        db: Database session
    
    Example:
        wss://api.yourserver.com/ws/gemini-browser/550e8400-e29b-41d4-a716-446655440000
    """
    try:
        logger.info(f"[GEMINI-BROWSER-WS] New connection attempt: assistant_id={assistant_id}")
        logger.info(f"[GEMINI-BROWSER-WS] Browser Agent: ENABLED")
        logger.info(f"[GEMINI-BROWSER-WS] LLM Streaming: DUAL WEBSOCKET MODE (v3.2 - User API key)")
        
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
# 📞 VOXIMPLANT ↔ GEMINI BRIDGE (v3.3)
# Fallback: когда встроенный Gemini модуль Voximplant не работает
# =============================================================================

@router.websocket("/ws/vox-gemini/{assistant_id}")
async def vox_gemini_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    caller: Optional[str] = Query(None, description="Caller phone number"),
    call_id: Optional[str] = Query(None, description="Voximplant call ID"),
    db: Session = Depends(get_db)
):
    """
    📞 Voximplant ↔ Gemini Live API bridge (v3.3).
    
    Используется как FALLBACK когда встроенный модуль Gemini в Voximplant
    не получает SetupComplete в течение таймаута.
    
    Voximplant подключается сюда через VoxEngine.createWebSocket() и шлёт
    аудио в стандартном Voximplant WebSocket протоколе (start/media/stop).
    Сервер мостит аудио в Gemini Live API и обратно.
    
    Протокол:
      Voximplant → Server: {"event":"start"}, {"event":"media","media":{"payload":"base64pcm"}}, {"event":"stop"}
      Server → Voximplant: тот же формат + {"customEvent":"transcription",...}
    
    Аудио:
      Вход: PCM16 16kHz (от Voximplant sendMediaTo с encoding PCM16)
      Выход: PCM16 16kHz (даунсэмплинг с 24kHz от Gemini)
    
    Query Parameters:
      caller: Номер звонящего (опционально)
      call_id: ID звонка в Voximplant (опционально)
    
    Voximplant script usage:
      const ws = VoxEngine.createWebSocket("wss://voicyfy.ru/ws/vox-gemini/{assistant_id}?caller=..." );
      ws.addEventListener(WebSocketEvents.OPEN, function() {
          call.sendMediaTo(ws, {encoding: "PCM16"});
          ws.sendMediaTo(call);
      });
    
    Example:
        wss://voicyfy.ru/ws/vox-gemini/550e8400-e29b-41d4-a716-446655440000?caller=+79001234567
    """
    try:
        logger.info(f"[VOX-GEMINI-WS] New Voximplant bridge connection")
        logger.info(f"[VOX-GEMINI-WS] Assistant: {assistant_id}")
        logger.info(f"[VOX-GEMINI-WS] Caller: {caller}")
        logger.info(f"[VOX-GEMINI-WS] Call ID: {call_id}")
        
        await handle_vox_gemini_websocket(
            websocket=websocket,
            assistant_id=assistant_id,
            db=db,
            caller_number=caller,
            call_id=call_id,
        )
        
    except WebSocketDisconnect:
        logger.info(f"[VOX-GEMINI-WS] Voximplant disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[VOX-GEMINI-WS] Error for assistant {assistant_id}: {e}")
        logger.error(f"[VOX-GEMINI-WS] Traceback: {traceback.format_exc()}")
        
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except:
            pass


# =============================================================================
# 📝 LLM STREAM - Isolated text streaming endpoint (v3.2)
# 🔧 v3.2: OpenAI API key from User model via assistant_id parameter
# =============================================================================

@router.websocket("/llm-stream")
async def llm_stream_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: Optional[str] = Query(None, description="Gemini Assistant ID to get OpenAI key from user"),
    db: Session = Depends(get_db)
):
    """
    📝 Isolated LLM text streaming endpoint (v3.2 Dual WebSocket Architecture).
    
    🔧 v3.2: OpenAI API key fetched from User model via assistant chain:
        assistant_id → GeminiAssistantConfig → user_id → User → openai_api_key
    
    Полностью изолирован от голосового канала для предотвращения искажения аудио.
    Используется для вывода развёрнутых текстовых ответов от OpenAI.
    
    Query Parameters:
        assistant_id: UUID of Gemini assistant (required for user API key lookup)
    
    Почему отдельный WebSocket?
    - Discord, Zoom, Teams используют такую же архитектуру
    - Голосовой трафик имеет приоритет и не блокируется текстом
    - Браузер не перегружается параллельными потоками в одном соединении
    
    Client → Server:
        {"type": "llm.query", "query": "Что такое интернет?", "request_id": "req_123"}
    
    Server → Client:
        {"type": "llm.stream.start", "request_id": "req_123", "query": "..."}
        {"type": "llm.stream.delta", "request_id": "req_123", "content": "Интернет — это..."}
        {"type": "llm.stream.delta", "request_id": "req_123", "content": " глобальная сеть..."}
        {"type": "llm.stream.done", "request_id": "req_123", "full_content": "...", "tokens_used": 150}
    
    Error:
        {"type": "llm.stream.error", "request_id": "req_123", "error": "..."}
    
    Example connection:
        wss://api.yourserver.com/llm-stream?assistant_id=550e8400-e29b-41d4-a716-446655440000
    
    Example flow:
        1. User asks Gemini: "Спроси у ИИ что такое интернет"
        2. Gemini calls query_llm function
        3. browser_handler sends {type: "llm.request"} to client via WS1 (voice)
        4. Client receives llm.request, sends query to WS2 (this endpoint) with assistant_id
        5. This endpoint loads User from assistant chain and gets openai_api_key
        6. Streams text response to client using user's OpenAI key
        7. Voice (WS1) and text (WS2) work in parallel without interference
    """
    try:
        logger.info(f"[LLM-STREAM-WS] New connection (isolated text channel)")
        logger.info(f"[LLM-STREAM-WS] Assistant ID: {assistant_id}")
        
        await handle_openai_streaming_websocket(
            websocket=websocket,
            assistant_id=assistant_id,
            db=db
        )
        
    except WebSocketDisconnect:
        logger.info(f"[LLM-STREAM-WS] Client disconnected")
    except Exception as e:
        logger.error(f"[LLM-STREAM-WS] Error: {e}")
        logger.error(f"[LLM-STREAM-WS] Traceback: {traceback.format_exc()}")
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
        "version": "3.3",
        "model": "gemini-2.5-flash-native-audio-preview-09-2025",
        "browser_agent_model": "gemini-2.0-flash",
        "llm_model": "gpt-4o-mini",
        "architecture": "dual_websocket + vox_bridge",
        "features": [
            "real_time_audio",
            "automatic_vad",
            "function_calling",
            "thinking_mode",
            "screen_context",
            "google_sheets_logging",
            "browser_agent",
            "isolated_llm_streaming",
            "user_api_keys",
            "voximplant_bridge"
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
        "version": "3.3",
        "architecture": "dual_websocket + vox_bridge",
        "models": {
            "voice": "gemini-2.5-flash-native-audio-preview-09-2025",
            "browser_agent": "gemini-2.0-flash",
            "llm_streaming": "gpt-4o-mini"
        },
        "audio": {
            "input_format": "PCM 16kHz mono 16-bit",
            "output_format": "PCM 24kHz mono 16-bit",
            "vad": "automatic (built-in)",
            "vox_bridge_output": "PCM 16kHz mono 16-bit (resampled from 24kHz)"
        },
        "features": {
            "function_calling": "manual (handler-controlled)",
            "thinking_mode": "configurable per assistant",
            "screen_context": "supported (silent mode)",
            "interruptions": "automatic via VAD",
            "multi_language": "24 languages supported",
            "voices": "30 HD voices available",
            "browser_agent": "autonomous DOM control",
            "llm_streaming": "isolated text channel (no audio distortion)",
            "api_keys": "from User model (not environment)",
            "voximplant_bridge": "fallback when Vox Gemini module fails"
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
        "llm_streaming": {
            "model": "gpt-4o-mini",
            "max_tokens": 4096,
            "buffering": "30 chars or 200ms",
            "isolation": "separate WebSocket channel",
            "api_key_source": "User.openai_api_key via assistant_id"
        },
        "voximplant_bridge": {
            "protocol": "Voximplant WebSocket (start/media/stop)",
            "input_encoding": "PCM16 16kHz",
            "output_encoding": "PCM16 16kHz (resampled from 24kHz)",
            "function_calling": True,
            "transcription": True,
            "google_sheets_logging": True,
            "use_case": "Fallback when Vox Gemini module SetupComplete timeout"
        },
        "endpoints": {
            "websocket_voice": "/ws/gemini/{assistant_id}",
            "websocket_browser": "/ws/gemini-browser/{assistant_id}",
            "websocket_llm": "/llm-stream?assistant_id={assistant_id}",
            "websocket_vox_bridge": "/ws/vox-gemini/{assistant_id}?caller=...&call_id=...",
            "health": "/gemini/health",
            "info": "/gemini/info"
        }
    }
