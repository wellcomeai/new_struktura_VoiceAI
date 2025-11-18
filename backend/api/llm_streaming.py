"""
LLM Streaming API endpoint.
Provides real-time streaming responses from ChatGPT.
Client manages conversation history via localStorage.
"""

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Optional
import openai
import asyncio

from backend.core.config import settings
from backend.core.logging import get_logger
from backend.services.llm_streaming.streaming_client import ChatGPTStreamingClient

logger = get_logger(__name__)
router = APIRouter()


# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================

class Message(BaseModel):
    """Single message in conversation"""
    role: str = Field(..., description="Message role: system/user/assistant")
    content: str = Field(..., description="Message content")


class LLMStreamRequest(BaseModel):
    """Request for LLM streaming"""
    messages: List[Message] = Field(..., description="Full conversation history")
    session_id: str = Field(..., description="Client session ID")
    model: Optional[str] = Field("gpt-4o-mini", description="Model to use")
    max_tokens: Optional[int] = Field(2000, description="Max tokens in response")
    temperature: Optional[float] = Field(0.7, description="Temperature (0-1)")


# ============================================================================
# STREAMING ENDPOINT
# ============================================================================

@router.post("/api/llm/stream")
async def stream_llm_response(request: LLMStreamRequest):
    """
    Stream ChatGPT response in real-time.
    
    Client sends full conversation history from localStorage.
    Server streams response back character by character.
    
    Args:
        request: LLMStreamRequest with messages and session_id
        
    Returns:
        StreamingResponse with text/plain chunks
        
    Example:
        POST /api/llm/stream
        {
            "messages": [
                {"role": "system", "content": "Ты ассистент"},
                {"role": "user", "content": "Привет!"}
            ],
            "session_id": "abc-123",
            "model": "gpt-4o-mini"
        }
    """
    
    session_id = request.session_id
    messages_count = len(request.messages)
    
    logger.info(f"[LLM-STREAM] 🚀 Starting stream for session {session_id}")
    logger.info(f"[LLM-STREAM] 📝 Messages: {messages_count}, Model: {request.model}")
    
    # Validate messages
    if not request.messages:
        raise HTTPException(status_code=400, detail="Messages cannot be empty")
    
    # Convert Pydantic models to dicts
    messages_dict = [msg.dict() for msg in request.messages]
    
    try:
        # Create streaming client
        client = ChatGPTStreamingClient(
            api_key=settings.OPENAI_API_KEY,
            model=request.model,
            max_tokens=request.max_tokens,
            temperature=request.temperature
        )
        
        # Stream generator
        async def generate():
            """Generate streaming chunks"""
            chunk_count = 0
            total_chars = 0
            
            try:
                async for chunk in client.stream_response(messages_dict):
                    chunk_count += 1
                    total_chars += len(chunk)
                    
                    # Log first chunk (latency measurement)
                    if chunk_count == 1:
                        logger.info(f"[LLM-STREAM] ⚡ First chunk delivered (latency OK)")
                    
                    yield chunk
                
                logger.info(f"[LLM-STREAM] ✅ Stream complete: {chunk_count} chunks, {total_chars} chars")
                
            except Exception as e:
                logger.error(f"[LLM-STREAM] ❌ Stream error: {str(e)}")
                yield f"\n\n[ERROR: {str(e)}]"
        
        return StreamingResponse(
            generate(),
            media_type="text/plain",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"  # Disable nginx buffering
            }
        )
        
    except Exception as e:
        logger.error(f"[LLM-STREAM] ❌ Error: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to stream response: {str(e)}"
        )


# ============================================================================
# UTILITY ENDPOINTS
# ============================================================================

@router.get("/api/llm/models")
async def get_available_models():
    """
    Get list of available ChatGPT models.
    
    Returns:
        List of model names with descriptions
    """
    return {
        "models": [
            {
                "id": "gpt-4o-mini",
                "name": "GPT-4o Mini",
                "description": "Fast and efficient, great for most tasks",
                "recommended": True,
                "speed": "very_fast",
                "cost": "low"
            },
            {
                "id": "gpt-4o",
                "name": "GPT-4o",
                "description": "Most capable model, best quality",
                "recommended": False,
                "speed": "fast",
                "cost": "medium"
            },
            {
                "id": "gpt-4-turbo",
                "name": "GPT-4 Turbo",
                "description": "Balanced performance and quality",
                "recommended": False,
                "speed": "medium",
                "cost": "high"
            }
        ],
        "default": "gpt-4o-mini"
    }


@router.get("/api/llm/status")
async def get_streaming_status():
    """
    Get streaming service status.
    
    Returns:
        Service health and configuration
    """
    return {
        "status": "operational",
        "service": "llm-streaming",
        "version": "1.0.0",
        "features": {
            "streaming": True,
            "client_history": True,
            "server_history": False,
            "storage": "localStorage (client-side)"
        },
        "performance": {
            "target_first_token": "< 2 seconds",
            "streaming_mode": "real-time",
            "buffering": "disabled"
        }
    }
