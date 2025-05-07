import uuid
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional, Dict, Any
import copy
import time

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
    async def get_assistants(
        db: Session, 
        user_id: str, 
        skip: int = 0, 
        limit: int = 50
    ) -> List[AssistantResponse]:
        """
        Возвращает список всех ассистентов пользователя с пагинацией
        
        Args:
            db: Сессия базы данных
            user_id: ID пользователя
            skip: Кол-во пропускаемых записей
            limit: Максимальное кол-во возвращаемых записей
            
        Returns:
            List[AssistantResponse]: Список объектов ассистентов
        """
        start_time = time.time()
        
        assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == user_id
        ).order_by(
            AssistantConfig.created_at.desc()
        ).offset(skip).limit(limit).all()
        
        response = [
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
                temperature=a.temperature or 0.7,
                max_tokens=a.max_tokens or 500
            )
            for a in assistants
        ]
        
        execution_time = time.time() - start_time
        logger.debug(f"get_assistants выполнен за {execution_time:.4f}с. Получено {len(response)} записей.")
        
        return response

    @staticmethod
    async def get_assistant_by_id(
        db: Session,
        assistant_id: str,
        user_id: Optional[str] = None
    ) -> AssistantConfig:
        """
        Возвращает объект AssistantConfig по ID, проверяет принадлежность пользователю
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
            user_id: ID пользователя (для проверки доступа)
            
        Returns:
            AssistantConfig: Объект конфигурации ассистента
            
        Raises:
            HTTPException: Если ассистент не найден или нет доступа
        """
        try:
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_id
            ).first()
        except Exception as e:
            logger.error(f"Ошибка при запросе ассистента {assistant_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Database error while fetching assistant"
            )

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
        
        Args:
            db: Сессия базы данных
            user_id: ID пользователя
            data: Данные для создания ассистента
            
        Returns:
            AssistantResponse: Созданный ассистент
            
        Raises:
            HTTPException: При ошибке создания
        """
        try:
            # Создаем новый экземпляр ассистента
            assistant = AssistantConfig(
                user_id=user_id,
                name=data.name,
                description=data.description,
                system_prompt=data.system_prompt,
                voice=data.voice or "alloy",
                language=data.language or "ru",
                google_sheet_id=data.google_sheet_id,
                functions=data.functions or {"enabled_functions": []},
                is_active=True,
                is_public=False,
                temperature=data.temperature or 0.7,
                max_tokens=data.max_tokens or 500
            )
            
            # Если публичный, генерируем токен доступа
            if assistant.is_public:
                assistant.api_access_token = str(uuid.uuid4())

            # Сохраняем в БД
            db.add(assistant)
            db.commit()
            db.refresh(assistant)
            logger.info(f"Assistant created: {assistant.id}, name: '{assistant.name}'")

            # Формируем ответ
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
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
            user_id: ID пользователя
            data: Данные для обновления
            
        Returns:
            AssistantResponse: Обновленный ассистент
            
        Raises:
            HTTPException: При ошибке обновления
        """
        # Получаем ассистента (с проверкой доступа)
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        
        # Обновляем только переданные поля
        update_data = data.dict(exclude_unset=True)
        
        for key, value in update_data.items():
            setattr(assistant, key, value)

        # Если стала публичной и ещё нет токена — сгенерировать
        if update_data.get("is_public") and not assistant.api_access_token:
            assistant.api_access_token = str(uuid.uuid4())

        try:
            db.commit()
            db.refresh(assistant)
            logger.info(f"Assistant updated: {assistant.id}, name: '{assistant.name}'")

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
    async def duplicate_assistant(
        db: Session,
        assistant_id: str,
        user_id: str
    ) -> AssistantResponse:
        """
        Создает копию существующего ассистента
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента для копирования
            user_id: ID пользователя
            
        Returns:
            AssistantResponse: Созданная копия ассистента
            
        Raises:
            HTTPException: При ошибке копирования
        """
        # Получаем оригинальный ассистент (с проверкой доступа)
        original = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        
        try:
            # Создаем новый ассистент с данными оригинала
            new_assistant = AssistantConfig(
                user_id=user_id,
                name=f"{original.name} (Copy)",
                description=original.description,
                system_prompt=original.system_prompt,
                voice=original.voice,
                language=original.language,
                google_sheet_id=original.google_sheet_id,
                functions=copy.deepcopy(original.functions) if original.functions else None,
                is_active=True,
                is_public=False,  # Всегда создаем копию как непубличную
                temperature=original.temperature,
                max_tokens=original.max_tokens
            )
            
            # Сохраняем в БД
            db.add(new_assistant)
            db.commit()
            db.refresh(new_assistant)
            logger.info(f"Assistant duplicated: original={original.id}, new={new_assistant.id}")
            
            # Формируем ответ
            return AssistantResponse(
                id=str(new_assistant.id),
                user_id=str(new_assistant.user_id),
                name=new_assistant.name,
                description=new_assistant.description,
                system_prompt=new_assistant.system_prompt,
                voice=new_assistant.voice,
                language=new_assistant.language,
                google_sheet_id=new_assistant.google_sheet_id,
                functions=new_assistant.functions,
                is_active=new_assistant.is_active,
                is_public=new_assistant.is_public,
                created_at=new_assistant.created_at,
                updated_at=new_assistant.updated_at,
                total_conversations=new_assistant.total_conversations,
                temperature=new_assistant.temperature,
                max_tokens=new_assistant.max_tokens
            )
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error duplicating assistant: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to duplicate assistant"
            )

    @staticmethod
    async def delete_assistant(
        db: Session,
        assistant_id: str,
        user_id: str
    ) -> bool:
        """
        Удаляет ассистента
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
            user_id: ID пользователя
            
        Returns:
            bool: True при успешном удалении
            
        Raises:
            HTTPException: При ошибке удаления
        """
        # Получаем ассистента (с проверкой доступа)
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
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
            user_id: ID пользователя
            
        Returns:
            EmbedCodeResponse: Объект с кодом для встраивания
            
        Raises:
            HTTPException: При ошибке генерации кода
        """
        # Получаем ассистента (с проверкой доступа)
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
    async def toggle_assistant_function(
        db: Session,
        assistant_id: str,
        user_id: str,
        function_id: str,
        enabled: bool
    ) -> Dict[str, Any]:
        """
        Включает или выключает функцию для ассистента
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
            user_id: ID пользователя
            function_id: ID функции
            enabled: Включена ли функция
            
        Returns:
            Dict[str, Any]: Обновленная конфигурация функций
            
        Raises:
            HTTPException: При ошибке обновления
        """
        # Получаем ассистента (с проверкой доступа)
        assistant = await AssistantService.get_assistant_by_id(db, assistant_id, user_id)
        
        # Инициализируем структуру функций, если она отсутствует
        if not assistant.functions:
            assistant.functions = {"enabled_functions": []}
        elif not isinstance(assistant.functions, dict):
            assistant.functions = {"enabled_functions": []}
            
        # Получаем текущий список включенных функций
        enabled_functions = assistant.functions.get("enabled_functions", [])
        
        # Обновляем список в зависимости от операции
        if enabled and function_id not in enabled_functions:
            enabled_functions.append(function_id)
        elif not enabled and function_id in enabled_functions:
            enabled_functions.remove(function_id)
            
        # Обновляем конфигурацию
        assistant.functions["enabled_functions"] = enabled_functions
        
        try:
            db.commit()
            logger.info(f"Function {function_id} {'enabled' if enabled else 'disabled'} for assistant {assistant_id}")
            
            return {
                "success": True,
                "assistant_id": assistant_id,
                "function_id": function_id,
                "enabled": enabled,
                "functions": assistant.functions
            }
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error toggling function: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to toggle function"
            )

    @staticmethod
    async def increment_conversation_count(
        db: Session,
        assistant_id: str
    ) -> None:
        """
        Увеличивает счётчик разговоров у ассистента
        
        Args:
            db: Сессия базы данных
            assistant_id: ID ассистента
        """
        try:
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_id
            ).first()
            
            if assistant:
                assistant.total_conversations += 1
                db.commit()
                logger.debug(f"Incremented conversation count: {assistant_id}, new total: {assistant.total_conversations}")
                
        except Exception as e:
            db.rollback()
            logger.error(f"Error incrementing conversation count: {e}")
