import uuid
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional

from backend.core.logging import get_logger
from backend.models.assistant import AssistantConfig
from backend.schemas.assistant import AssistantCreate, AssistantUpdate, AssistantResponse, EmbedCodeResponse

logger = get_logger(__name__)

class AssistantService:
    """Сервис для операций с ассистентами"""
    
    @staticmethod
    async def get_assistants(db: Session, user_id: str) -> List[AssistantResponse]:
        assistants = db.query(AssistantConfig).filter(AssistantConfig.user_id == user_id).all()
        return [
            AssistantResponse(
                id=str(a.id),
                user_id=str(a.user_id),
                name=a.name,
                description=a.description,
                system_prompt=a.system_prompt,
                voice=a.voice,
                language=a.language,
                google_sheet_id=a.google_sheet_id,
                # Здесь передаём functions как есть (оно уже список Dict)
                functions=a.functions,
                is_active=a.is_active,
                is_public=a.is_public,
                created_at=a.created_at,
                updated_at=a.updated_at,
                total_conversations=a.total_conversations,
                temperature=a.temperature,
                max_tokens=a.max_tokens
            ) for a in assistants
        ]
    
    @staticmethod
    async def create_assistant(db: Session, user_id: str, data: AssistantCreate) -> AssistantResponse:
        try:
            assistant = AssistantConfig(
                user_id=user_id,
                name=data.name,
                description=data.description,
                system_prompt=data.system_prompt,
                voice=data.voice,
                language=data.language,
                google_sheet_id=data.google_sheet_id,
                # Сохраняем список функций прямо в модель
                functions=data.functions,
                is_active=True,
                is_public=False
            )
            if assistant.is_public:
                assistant.api_access_token = str(uuid.uuid4())

            db.add(assistant)
            db.commit()
            db.refresh(assistant)
            logger.info(f"Assistant created: {assistant.id}")
            
            return AssistantResponse(
                id=str(assistant.id),
                user_id=str(assistant.user_id),
                name=assistant.name,
                description=assistant.description,
                system_prompt=assistant.system_prompt,
                voice=assistant.voice,
                language=assistant.language,
                google_sheet_id=assistant.google_sheet_id,
                functions=assistant.functions,
                is_active=assistant.is_active,
                is_public=assistant.is_public,
                created_at=assistant.created_at,
                updated_at=assistant.updated_at,
                total_conversations=assistant.total_conversations,
                temperature=assistant.temperature,
                max_tokens=assistant.max_tokens
            )
        except IntegrityError as e:
            db.rollback()
            logger.error(f"Integrity error: {e}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Creation failed due to database constraint")
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error: {e}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                detail="Creation failed due to server error")
    
    @staticmethod
    async def update_assistant(db: Session, assistant_id: str, user_id: str, data: AssistantUpdate) -> AssistantResponse:
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        update_data = data.dict(exclude_unset=True)
        for key, value in update_data.items():
            setattr(assistant, key, value)
        if update_data.get('is_public') and not assistant.api_access_token:
            assistant.api_access_token = str(uuid.uuid4())
        db.commit()
        db.refresh(assistant)
        logger.info(f"Assistant updated: {assistant.id}")
        return AssistantResponse(
            id=str(assistant.id),
            user_id=str(assistant.user_id),
            name=assistant.name,
            description=assistant.description,
            system_prompt=assistant.system_prompt,
            voice=assistant.voice,
            language=assistant.language,
            google_sheet_id=assistant.google_sheet_id,
            functions=assistant.functions,
            is_active=assistant.is_active,
            is_public=assistant.is_public,
            created_at=assistant.created_at,
            updated_at=assistant.updated_at,
            total_conversations=assistant.total_conversations,
            temperature=assistant.temperature,
            max_tokens=assistant.max_tokens
        )

    # … остальные методы (delete, get_embed_code и т. д.) аналогично работают с поля‍ми functions …
