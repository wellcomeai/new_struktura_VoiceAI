# backend/services/assistant_service.py

import uuid
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.assistant import AssistantConfig
from backend.schemas.assistant import (
    AssistantCreate,
    AssistantUpdate,
    AssistantResponse,
    EmbedCodeResponse,
)

logger = get_logger(__name__)

class AssistantService:
    """Сервис для операций с ассистентами"""

    @staticmethod
    async def get_assistants(db: Session, user_id: str) -> List[AssistantResponse]:
        """
        Получить всех ассистентов пользователя.
        """
        assistants = (
            db
            .query(AssistantConfig)
            .filter(AssistantConfig.user_id == user_id)
            .all()
        )
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
                functions=a.functions,
                is_active=a.is_active,
                is_public=a.is_public,
                created_at=a.created_at,
                updated_at=a.updated_at,
                total_conversations=a.total_conversations,
                temperature=a.temperature,
                max_tokens=a.max_tokens,
            )
            for a in assistants
        ]

    @staticmethod
    async def get_assistant_by_id(
        db: Session,
        assistant_id: str,
        user_id: Optional[str] = None
    ) -> AssistantConfig:
        """
        Получить ассистента по ID и проверить, что он принадлежит user_id (если указан).
        """
        assistant = (
            db
            .query(AssistantConfig)
            .filter(AssistantConfig.id == assistant_id)
            .first()
        )
        if not assistant:
            logger.warning(f"Assistant not found: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )
        if user_id and str(assistant.user_id) != user_id:
            logger.warning(f"Unauthorized access to assistant {assistant_id} by user {user_id}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized to access this assistant"
            )
        return assistant

    @staticmethod
    async def create_assistant(
        db: Session,
        user_id: str,
        assistant_data: AssistantCreate
    ) -> AssistantResponse:
        """
        Создать нового ассистента.
        """
        try:
            assistant = AssistantConfig(
                user_id=user_id,
                name=assistant_data.name,
                description=assistant_data.description,
                system_prompt=assistant_data.system_prompt,
                voice=assistant_data.voice,
                language=assistant_data.language,
                google_sheet_id=assistant_data.google_sheet_id,
                functions=assistant_data.functions,
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
                max_tokens=assistant.max_tokens,
            )

        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during assistant creation: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Creation failed due to database constraint"
            )
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during assistant creation: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Creation failed due to server error"
            )

    @staticmethod
    async def update_assistant(
        db: Session,
        assistant_id: str,
        user_id: str,
        assistant_data: AssistantUpdate
    ) -> AssistantResponse:
        """
        Обновить существующего ассистента.
        """
        try:
            assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
            update_data = assistant_data.dict(exclude_unset=True)
            for key, value in update_data.items():
                setattr(assistant, key, value)

            if update_data.get("is_public") and not assistant.api_access_token:
                assistant.api_access_token = str(uuid.uuid4())

            db.commit()
            db.refresh(assistant)
            logger.info(f"Assistant updated: {assistant_id}")

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
                max_tokens=assistant.max_tokens,
            )

        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during assistant update: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Update failed due to database constraint"
            )
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during assistant update: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Update failed due to server error"
            )

    @staticmethod
    async def delete_assistant(
        db: Session,
        assistant_id: str,
        user_id: str
    ) -> bool:
        """
        Удалить ассистента.
        """
        try:
            assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
            db.delete(assistant)
            db.commit()
            logger.info(f"Assistant deleted: {assistant_id}")
            return True

        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting assistant: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete assistant"
            )

    @staticmethod
    async def get_embed_code(
        db: Session,
        assistant_id: str,
        user_id: str
    ) -> EmbedCodeResponse:
        """
        Сгенерировать HTML-виджет для встраивания.
        """
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)

        if not assistant.is_active:
            logger.warning(f"Attempt to get embed code for inactive assistant: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This assistant is not active. Please activate it first."
            )

        host_url = settings.HOST_URL
        embed_code = f"""<!-- WellcomeAI Voice Assistant -->
<script>
    (function() {{
        var script = document.createElement('script');
        script.src = '{host_url}/static/widget.js';
        script.dataset.assistantId = '{assistant_id}';
        script.dataset.server = '{host_url}';
        script.dataset.position = 'bottom-right';
        script.async = true;
        document.head.appendChild(script);
    }})();
</script>
<!-- End WellcomeAI -->"""

        return EmbedCodeResponse(
            embed_code=embed_code,
            assistant_id=assistant_id
        )

    @staticmethod
    async def increment_conversation_count(
        db: Session,
        assistant_id: str
    ) -> None:
        """
        Увеличить счётчик диалогов ассистента.
        """
        try:
            assistant = (
                db
                .query(AssistantConfig)
                .filter(AssistantConfig.id == assistant_id)
                .first()
            )
            if assistant:
                assistant.total_conversations += 1
                db.commit()
                logger.debug(f"Incremented conversation count for assistant {assistant_id}")
        except Exception as e:
            db.rollback()
            logger.error(f"Error incrementing conversation count: {e}")
