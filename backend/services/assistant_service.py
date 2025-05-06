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
    EmbedCodeResponse
)

logger = get_logger(__name__)

class AssistantService:
    """Сервис для операций с ассистентами"""

    @staticmethod
    async def get_assistants(db: Session, user_id: str) -> List[AssistantResponse]:
        """
        Возвращает список всех ассистентов пользователя
        """
        assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == user_id
        ).all()

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
                max_tokens=a.max_tokens
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
        Возвращает объект AssistantConfig по ID, проверяет принадлежность пользователю
        """
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id == assistant_id
        ).first()

        if not assistant:
            logger.warning(f"Assistant not found: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )

        if user_id and str(assistant.user_id) != user_id:
            logger.warning(f"Unauthorized access: assistant {assistant_id}, user {user_id}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized to access this assistant"
            )

        return assistant

    @staticmethod
    async def create_assistant(
        db: Session,
        user_id: str,
        data: AssistantCreate
    ) -> AssistantResponse:
        """
        Создаёт нового ассистента
        """
        try:
            assistant = AssistantConfig(
                user_id=user_id,
                name=data.name,
                description=data.description,
                system_prompt=data.system_prompt,
                voice=data.voice,
                language=data.language,
                google_sheet_id=data.google_sheet_id,
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
            logger.error(f"IntegrityError on create: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Creation failed due to database constraint"
            )
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error on create: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Creation failed due to server error"
            )

    @staticmethod
    async def update_assistant(
        db: Session,
        assistant_id: str,
        user_id: str,
        data: AssistantUpdate
    ) -> AssistantResponse:
        """
        Обновляет поля ассистента
        """
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        update_data = data.dict(exclude_unset=True)

        for key, value in update_data.items():
            setattr(assistant, key, value)

        # Если стала публичной и ещё нет токена — сгенерировать
        if update_data.get("is_public") and not assistant.api_access_token:
            assistant.api_access_token = str(uuid.uuid4())

        try:
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
        except IntegrityError as e:
            db.rollback()
            logger.error(f"IntegrityError on update: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Update failed due to database constraint"
            )
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error on update: {e}")
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
        Удаляет ассистента
        """
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        try:
            db.delete(assistant)
            db.commit()
            logger.info(f"Assistant deleted: {assistant_id}")
            return True
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
        Генерирует HTML-код виджета для встраивания
        """
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        if not assistant.is_active:
            logger.warning(f"Attempt to get embed code for inactive assistant: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This assistant is not active. Please activate it first."
            )

        host = settings.HOST_URL.rstrip("/")
        embed_code = (
            "<!-- WellcomeAI Voice Assistant -->\n"
            "<script>\n"
            "  (function() {\n"
            f"    var script = document.createElement('script');\n"
            f"    script.src = '{host}/static/widget.js';\n"
            f"    script.dataset.assistantId = '{assistant_id}';\n"
            f"    script.dataset.server = '{host}';\n"
            "    script.dataset.position = 'bottom-right';\n"
            "    script.async = true;\n"
            "    document.head.appendChild(script);\n"
            "  })();\n"
            "</script>\n"
            "<!-- End WellcomeAI -->"
        )

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
        Увеличивает счётчик разговоров у ассистента
        """
        try:
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_id
            ).first()
            if assistant:
                assistant.total_conversations += 1
                db.commit()
                logger.debug(f"Incremented conversation count: {assistant_id}")
        except Exception as e:
            db.rollback()
            logger.error(f"Error incrementing conversation count: {e}")
