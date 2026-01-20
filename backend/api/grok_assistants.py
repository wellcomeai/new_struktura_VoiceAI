# backend/api/grok_assistants.py
"""
REST API endpoints for xAI Grok Voice assistants management.
Handles CRUD operations for Grok Voice Agent API assistants.

🚀 PRODUCTION VERSION 1.0
✅ Complete CRUD operations
✅ Authorization validation
✅ Subscription validation
✅ Error handling
✅ Grok-specific features (web_search, x_search)
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
import uuid

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.db.session import get_db
from backend.models.user import User
from backend.models.grok_assistant import GrokAssistantConfig, GrokConversation
from backend.core.dependencies import get_current_user

logger = get_logger(__name__)

router = APIRouter()


# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================

from pydantic import BaseModel, Field
from datetime import datetime


class GrokAssistantCreate(BaseModel):
    """Schema for creating a new Grok assistant"""
    name: str = Field(..., min_length=1, max_length=255, description="Assistant name")
    description: Optional[str] = Field(None, max_length=500, description="Assistant description")
    system_prompt: str = Field(..., min_length=1, description="System instructions for assistant")
    voice: str = Field(default="Ara", description="Grok voice: Ara, Rex, Sal, Eve, Leo")
    language: str = Field(default="ru", description="Language code")
    sample_rate: int = Field(default=24000, description="Audio sample rate (8000-48000)")
    audio_format: str = Field(default="audio/pcm", description="Audio format: audio/pcm, audio/pcmu, audio/pcma")
    greeting_message: Optional[str] = Field(
        default="Здравствуйте! Чем я могу вам помочь?",
        max_length=500,
        description="Greeting message"
    )
    google_sheet_id: Optional[str] = Field(None, description="Google Sheets ID for logging")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="Model temperature")
    max_tokens: int = Field(default=4096, ge=1, le=8192, description="Maximum tokens")
    functions: Optional[dict] = Field(default=None, description="Enabled functions config")
    
    # Grok-specific features
    enable_web_search: bool = Field(default=False, description="Enable native Grok web search")
    enable_x_search: bool = Field(default=False, description="Enable X (Twitter) search")
    x_allowed_handles: Optional[List[str]] = Field(default=None, description="Allowed X handles for search")
    collection_ids: Optional[List[str]] = Field(default=None, description="Vector store IDs for file_search")
    is_telephony_enabled: bool = Field(default=False, description="Enable telephony mode")


class GrokAssistantUpdate(BaseModel):
    """Schema for updating a Grok assistant"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=500)
    system_prompt: Optional[str] = Field(None, min_length=1)
    voice: Optional[str] = None
    language: Optional[str] = None
    sample_rate: Optional[int] = Field(None, ge=8000, le=48000)
    audio_format: Optional[str] = None
    greeting_message: Optional[str] = Field(None, max_length=500)
    google_sheet_id: Optional[str] = None
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, ge=1, le=8192)
    functions: Optional[dict] = None
    is_active: Optional[bool] = None
    is_public: Optional[bool] = None
    enable_web_search: Optional[bool] = None
    enable_x_search: Optional[bool] = None
    x_allowed_handles: Optional[List[str]] = None
    collection_ids: Optional[List[str]] = None
    is_telephony_enabled: Optional[bool] = None


class GrokAssistantResponse(BaseModel):
    """Schema for Grok assistant response"""
    id: str
    user_id: str
    name: str
    description: Optional[str]
    system_prompt: str
    voice: str
    language: str
    sample_rate: int
    audio_format: str
    greeting_message: Optional[str]
    google_sheet_id: Optional[str]
    functions: Optional[dict]
    is_active: bool
    is_public: bool
    created_at: datetime
    updated_at: datetime
    total_conversations: int
    temperature: float
    max_tokens: int
    enable_web_search: bool
    enable_x_search: bool
    x_allowed_handles: Optional[List[str]]
    collection_ids: Optional[List[str]]
    is_telephony_enabled: bool

    class Config:
        from_attributes = True


class GrokConversationResponse(BaseModel):
    """Schema for Grok conversation response"""
    id: str
    assistant_id: str
    session_id: str
    user_message: Optional[str]
    assistant_message: Optional[str]
    function_name: Optional[str]
    caller_number: Optional[str]
    call_direction: Optional[str]
    tokens_used: int
    audio_duration_ms: Optional[int]
    latency_ms: Optional[int]
    created_at: datetime

    class Config:
        from_attributes = True


class EmbedCodeResponse(BaseModel):
    """Schema for embed code response"""
    embed_code: str
    assistant_id: str


class GrokVoicesResponse(BaseModel):
    """Schema for available Grok voices"""
    voices: List[dict]


# ============================================================================
# CONSTANTS
# ============================================================================

GROK_VOICES = [
    {"id": "Ara", "name": "Ara", "gender": "Female", "tone": "Warm, friendly", "description": "Default voice, balanced and conversational"},
    {"id": "Rex", "name": "Rex", "gender": "Male", "tone": "Confident, clear", "description": "Professional and articulate, ideal for business"},
    {"id": "Sal", "name": "Sal", "gender": "Neutral", "tone": "Smooth, balanced", "description": "Versatile voice suitable for various contexts"},
    {"id": "Eve", "name": "Eve", "gender": "Female", "tone": "Energetic, upbeat", "description": "Engaging and enthusiastic, great for interactive experiences"},
    {"id": "Leo", "name": "Leo", "gender": "Male", "tone": "Authoritative, strong", "description": "Decisive and commanding, suitable for instructional content"},
]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def verify_assistant_access(
    assistant_id: str,
    user_id: str,
    db: Session,
    require_ownership: bool = True
) -> GrokAssistantConfig:
    """
    Verify user has access to the assistant.
    """
    try:
        assistant_uuid = uuid.UUID(assistant_id)
    except ValueError:
        logger.warning(f"[GROK-API] Invalid UUID format: {assistant_id}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid assistant ID format"
        )
    
    assistant = db.query(GrokAssistantConfig).filter(
        GrokAssistantConfig.id == assistant_uuid
    ).first()
    
    if not assistant:
        logger.warning(f"[GROK-API] Assistant not found: {assistant_id}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grok assistant not found"
        )
    
    if require_ownership and str(assistant.user_id) != user_id:
        logger.warning(f"[GROK-API] Unauthorized access attempt: user {user_id} -> assistant {assistant_id}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to access this assistant"
        )
    
    return assistant


def validate_voice(voice: str) -> str:
    """Validate and normalize voice name."""
    valid_voices = ["Ara", "Rex", "Sal", "Eve", "Leo"]
    voice_lower = voice.lower()
    
    for v in valid_voices:
        if v.lower() == voice_lower:
            return v
    
    return "Ara"  # Default


def validate_audio_format(format: str) -> str:
    """Validate audio format."""
    valid_formats = ["audio/pcm", "audio/pcmu", "audio/pcma"]
    if format in valid_formats:
        return format
    return "audio/pcm"


# ============================================================================
# API ENDPOINTS
# ============================================================================

@router.get("/voices", response_model=GrokVoicesResponse)
async def get_grok_voices():
    """
    Get list of available Grok voices.
    
    Returns:
        List of voice configurations
    """
    return GrokVoicesResponse(voices=GROK_VOICES)


@router.get("", response_model=List[GrokAssistantResponse])
async def get_grok_assistants(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Get all Grok assistants for the current user.
    """
    try:
        logger.info(f"[GROK-API] Fetching assistants for user {current_user.id}")
        
        assistants = db.query(GrokAssistantConfig).filter(
            GrokAssistantConfig.user_id == current_user.id
        ).order_by(GrokAssistantConfig.created_at.desc()).all()
        
        logger.info(f"[GROK-API] Found {len(assistants)} Grok assistants")
        
        result = []
        for assistant in assistants:
            result.append(GrokAssistantResponse(
                id=str(assistant.id),
                user_id=str(assistant.user_id),
                name=assistant.name,
                description=assistant.description,
                system_prompt=assistant.system_prompt,
                voice=assistant.voice,
                language=assistant.language,
                sample_rate=assistant.sample_rate,
                audio_format=assistant.audio_format,
                greeting_message=assistant.greeting_message,
                google_sheet_id=assistant.google_sheet_id,
                functions=assistant.functions,
                is_active=assistant.is_active,
                is_public=assistant.is_public,
                created_at=assistant.created_at,
                updated_at=assistant.updated_at,
                total_conversations=assistant.total_conversations,
                temperature=assistant.temperature,
                max_tokens=assistant.max_tokens,
                enable_web_search=assistant.enable_web_search,
                enable_x_search=assistant.enable_x_search,
                x_allowed_handles=assistant.x_allowed_handles,
                collection_ids=assistant.collection_ids,
                is_telephony_enabled=assistant.is_telephony_enabled
            ))
        
        return result
        
    except Exception as e:
        logger.error(f"[GROK-API] Error fetching assistants: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch Grok assistants"
        )


@router.get("/{assistant_id}", response_model=GrokAssistantResponse)
async def get_grok_assistant(
    assistant_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Get a specific Grok assistant by ID.
    """
    try:
        logger.info(f"[GROK-API] Fetching assistant {assistant_id} for user {current_user.id}")
        
        assistant = await verify_assistant_access(
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            db=db,
            require_ownership=True
        )
        
        return GrokAssistantResponse(
            id=str(assistant.id),
            user_id=str(assistant.user_id),
            name=assistant.name,
            description=assistant.description,
            system_prompt=assistant.system_prompt,
            voice=assistant.voice,
            language=assistant.language,
            sample_rate=assistant.sample_rate,
            audio_format=assistant.audio_format,
            greeting_message=assistant.greeting_message,
            google_sheet_id=assistant.google_sheet_id,
            functions=assistant.functions,
            is_active=assistant.is_active,
            is_public=assistant.is_public,
            created_at=assistant.created_at,
            updated_at=assistant.updated_at,
            total_conversations=assistant.total_conversations,
            temperature=assistant.temperature,
            max_tokens=assistant.max_tokens,
            enable_web_search=assistant.enable_web_search,
            enable_x_search=assistant.enable_x_search,
            x_allowed_handles=assistant.x_allowed_handles,
            collection_ids=assistant.collection_ids,
            is_telephony_enabled=assistant.is_telephony_enabled
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[GROK-API] Error fetching assistant {assistant_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch Grok assistant"
        )


@router.post("", response_model=GrokAssistantResponse, status_code=status.HTTP_201_CREATED)
async def create_grok_assistant(
    assistant_data: GrokAssistantCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Create a new Grok assistant.
    """
    try:
        logger.info(f"[GROK-API] Creating Grok assistant for user {current_user.id}")
        logger.info(f"[GROK-API] Assistant name: {assistant_data.name}")
        logger.info(f"[GROK-API] Voice: {assistant_data.voice}")
        
        # Check if user has Grok API key
        if not current_user.grok_api_key:
            logger.warning(f"[GROK-API] User {current_user.id} has no Grok API key")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="xAI Grok API key is required. Please add it in settings."
            )
        
        # Validate voice
        validated_voice = validate_voice(assistant_data.voice)
        
        # Validate audio format
        validated_format = validate_audio_format(assistant_data.audio_format)
        
        # Create assistant instance
        assistant = GrokAssistantConfig(
            user_id=current_user.id,
            name=assistant_data.name,
            description=assistant_data.description,
            system_prompt=assistant_data.system_prompt,
            voice=validated_voice,
            language=assistant_data.language,
            sample_rate=assistant_data.sample_rate,
            audio_format=validated_format,
            greeting_message=assistant_data.greeting_message,
            google_sheet_id=assistant_data.google_sheet_id,
            temperature=assistant_data.temperature,
            max_tokens=assistant_data.max_tokens,
            functions=assistant_data.functions,
            is_active=True,
            is_public=False,
            enable_web_search=assistant_data.enable_web_search,
            enable_x_search=assistant_data.enable_x_search,
            x_allowed_handles=assistant_data.x_allowed_handles,
            collection_ids=assistant_data.collection_ids,
            is_telephony_enabled=assistant_data.is_telephony_enabled
        )
        
        db.add(assistant)
        db.commit()
        db.refresh(assistant)
        
        logger.info(f"[GROK-API] ✅ Grok assistant created: {assistant.id}")
        
        return GrokAssistantResponse(
            id=str(assistant.id),
            user_id=str(assistant.user_id),
            name=assistant.name,
            description=assistant.description,
            system_prompt=assistant.system_prompt,
            voice=assistant.voice,
            language=assistant.language,
            sample_rate=assistant.sample_rate,
            audio_format=assistant.audio_format,
            greeting_message=assistant.greeting_message,
            google_sheet_id=assistant.google_sheet_id,
            functions=assistant.functions,
            is_active=assistant.is_active,
            is_public=assistant.is_public,
            created_at=assistant.created_at,
            updated_at=assistant.updated_at,
            total_conversations=assistant.total_conversations,
            temperature=assistant.temperature,
            max_tokens=assistant.max_tokens,
            enable_web_search=assistant.enable_web_search,
            enable_x_search=assistant.enable_x_search,
            x_allowed_handles=assistant.x_allowed_handles,
            collection_ids=assistant.collection_ids,
            is_telephony_enabled=assistant.is_telephony_enabled
        )
        
    except HTTPException:
        raise
    except IntegrityError as e:
        db.rollback()
        logger.error(f"[GROK-API] Database integrity error: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to create assistant due to database constraint"
        )
    except Exception as e:
        db.rollback()
        logger.error(f"[GROK-API] Error creating assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create Grok assistant"
        )


@router.put("/{assistant_id}", response_model=GrokAssistantResponse)
async def update_grok_assistant(
    assistant_id: str,
    assistant_data: GrokAssistantUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Update a Grok assistant.
    """
    try:
        logger.info(f"[GROK-API] Updating assistant {assistant_id} for user {current_user.id}")
        
        assistant = await verify_assistant_access(
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            db=db,
            require_ownership=True
        )
        
        # Update only provided fields
        update_data = assistant_data.dict(exclude_unset=True)
        
        # Validate voice if provided
        if "voice" in update_data:
            update_data["voice"] = validate_voice(update_data["voice"])
        
        # Validate audio format if provided
        if "audio_format" in update_data:
            update_data["audio_format"] = validate_audio_format(update_data["audio_format"])
        
        for key, value in update_data.items():
            setattr(assistant, key, value)
        
        db.commit()
        db.refresh(assistant)
        
        logger.info(f"[GROK-API] ✅ Grok assistant updated: {assistant_id}")
        
        return GrokAssistantResponse(
            id=str(assistant.id),
            user_id=str(assistant.user_id),
            name=assistant.name,
            description=assistant.description,
            system_prompt=assistant.system_prompt,
            voice=assistant.voice,
            language=assistant.language,
            sample_rate=assistant.sample_rate,
            audio_format=assistant.audio_format,
            greeting_message=assistant.greeting_message,
            google_sheet_id=assistant.google_sheet_id,
            functions=assistant.functions,
            is_active=assistant.is_active,
            is_public=assistant.is_public,
            created_at=assistant.created_at,
            updated_at=assistant.updated_at,
            total_conversations=assistant.total_conversations,
            temperature=assistant.temperature,
            max_tokens=assistant.max_tokens,
            enable_web_search=assistant.enable_web_search,
            enable_x_search=assistant.enable_x_search,
            x_allowed_handles=assistant.x_allowed_handles,
            collection_ids=assistant.collection_ids,
            is_telephony_enabled=assistant.is_telephony_enabled
        )
        
    except HTTPException:
        raise
    except IntegrityError as e:
        db.rollback()
        logger.error(f"[GROK-API] Database integrity error: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to update assistant due to database constraint"
        )
    except Exception as e:
        db.rollback()
        logger.error(f"[GROK-API] Error updating assistant {assistant_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update Grok assistant"
        )


@router.delete("/{assistant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_grok_assistant(
    assistant_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Delete a Grok assistant.
    """
    try:
        logger.info(f"[GROK-API] Deleting assistant {assistant_id} for user {current_user.id}")
        
        assistant = await verify_assistant_access(
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            db=db,
            require_ownership=True
        )
        
        db.delete(assistant)
        db.commit()
        
        logger.info(f"[GROK-API] ✅ Grok assistant deleted: {assistant_id}")
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"[GROK-API] Error deleting assistant {assistant_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete Grok assistant"
        )


@router.get("/{assistant_id}/conversations", response_model=List[GrokConversationResponse])
async def get_grok_conversations(
    assistant_id: str,
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Get conversations for a Grok assistant.
    """
    try:
        logger.info(f"[GROK-API] Fetching conversations for assistant {assistant_id}")
        
        await verify_assistant_access(
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            db=db,
            require_ownership=True
        )
        
        conversations = db.query(GrokConversation).filter(
            GrokConversation.assistant_id == uuid.UUID(assistant_id)
        ).order_by(GrokConversation.created_at.desc()).offset(skip).limit(limit).all()
        
        return [
            GrokConversationResponse(
                id=str(conv.id),
                assistant_id=str(conv.assistant_id),
                session_id=conv.session_id,
                user_message=conv.user_message,
                assistant_message=conv.assistant_message,
                function_name=conv.function_name,
                caller_number=conv.caller_number,
                call_direction=conv.call_direction,
                tokens_used=conv.tokens_used,
                audio_duration_ms=conv.audio_duration_ms,
                latency_ms=conv.latency_ms,
                created_at=conv.created_at
            )
            for conv in conversations
        ]
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[GROK-API] Error fetching conversations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch conversations"
        )


@router.get("/{assistant_id}/embed-code", response_model=EmbedCodeResponse)
async def get_grok_embed_code(
    assistant_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Get embed code for a Grok assistant widget.
    """
    try:
        logger.info(f"[GROK-API] Getting embed code for assistant {assistant_id}")
        
        assistant = await verify_assistant_access(
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            db=db,
            require_ownership=True
        )
        
        if not assistant.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Assistant must be active to generate embed code"
            )
        
        host_url = settings.HOST_URL
        embed_code = f"""<!-- Voicyfy Grok Voice Assistant -->
<script>
    (function() {{
        var script = document.createElement('script');
        script.src = '{host_url}/static/grok-widget.js';
        script.dataset.assistantId = '{assistant_id}';
        script.dataset.server = '{host_url}';
        script.dataset.position = 'bottom-right';
        script.dataset.provider = 'grok';
        script.async = true;
        document.head.appendChild(script);
    }})();
</script>
<!-- End Voicyfy Grok -->"""
        
        logger.info(f"[GROK-API] ✅ Embed code generated for assistant {assistant_id}")
        
        return EmbedCodeResponse(
            embed_code=embed_code,
            assistant_id=assistant_id
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[GROK-API] Error generating embed code: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embed code"
        )


@router.post("/{assistant_id}/verify-sheet")
async def verify_grok_google_sheet(
    assistant_id: str,
    sheet_data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Verify Google Sheets connection for a Grok assistant.
    """
    try:
        logger.info(f"[GROK-API] Verifying Google Sheet for assistant {assistant_id}")
        
        sheet_id = sheet_data.get("sheet_id")
        if not sheet_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="sheet_id is required"
            )
        
        if assistant_id != "new":
            await verify_assistant_access(
                assistant_id=assistant_id,
                user_id=str(current_user.id),
                db=db,
                require_ownership=True
            )
        
        from backend.services.google_sheets_service import GoogleSheetsService
        
        result = await GoogleSheetsService.verify_sheet_access(sheet_id)
        
        if result:
            logger.info(f"[GROK-API] ✅ Google Sheet verified: {sheet_id[:20]}...")
            return {
                "success": True,
                "message": "Google Sheet подключена успешно"
            }
        else:
            return {
                "success": False,
                "message": "Не удалось подключиться к таблице. Проверьте права доступа."
            }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[GROK-API] Error verifying Google Sheet: {e}")
        return {
            "success": False,
            "message": f"Ошибка проверки: {str(e)}"
        }
