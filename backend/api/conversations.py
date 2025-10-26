# backend/api/conversations.py
"""
Conversations API endpoints для WellcomeAI application.
Управление диалогами и историей разговоров.
Version: 1.0 - Production Ready
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.services.conversation_service import ConversationService
from backend.services.auth_service import AuthService
from backend.models.user import User

logger = get_logger(__name__)

# Create router
router = APIRouter()


@router.get("/conversations")
async def get_conversations(
    assistant_id: Optional[str] = Query(None, description="Фильтр по ID ассистента"),
    caller_number: Optional[str] = Query(None, description="Фильтр по номеру телефона"),
    session_id: Optional[str] = Query(None, description="Фильтр по ID сессии"),
    date_from: Optional[str] = Query(None, description="Фильтр: диалоги после даты (ISO format)"),
    date_to: Optional[str] = Query(None, description="Фильтр: диалоги до даты (ISO format)"),
    limit: int = Query(50, ge=1, le=100, description="Количество записей (макс 100)"),
    offset: int = Query(0, ge=0, description="Смещение для пагинации"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить список диалогов с фильтрами и пагинацией.
    
    Требуется авторизация.
    
    **Фильтры:**
    - assistant_id: Показать только диалоги конкретного ассистента
    - caller_number: Показать диалоги с конкретным номером телефона
    - session_id: Показать диалоги из одной сессии
    - date_from/date_to: Временной диапазон
    
    **Пагинация:**
    - limit: Количество записей на странице (1-100)
    - offset: Смещение (для следующих страниц)
    
    **Возвращает:**
    - conversations: Список диалогов
    - total: Общее количество
    - page: Текущая страница
    - page_size: Размер страницы
    """
    try:
        logger.info(f"[CONVERSATIONS-API] Get conversations request from user {current_user.id}")
        logger.info(f"   Filters: assistant_id={assistant_id}, caller={caller_number}, "
                   f"session={session_id}, date_from={date_from}, date_to={date_to}")
        logger.info(f"   Pagination: limit={limit}, offset={offset}")
        
        # Парсим даты если указаны
        date_from_parsed = None
        date_to_parsed = None
        
        if date_from:
            try:
                date_from_parsed = datetime.fromisoformat(date_from.replace('Z', '+00:00'))
            except ValueError as e:
                logger.warning(f"Invalid date_from format: {date_from}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid date_from format. Use ISO format (YYYY-MM-DDTHH:MM:SS)"
                )
        
        if date_to:
            try:
                date_to_parsed = datetime.fromisoformat(date_to.replace('Z', '+00:00'))
            except ValueError as e:
                logger.warning(f"Invalid date_to format: {date_to}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid date_to format. Use ISO format (YYYY-MM-DDTHH:MM:SS)"
                )
        
        # Получаем диалоги
        result = ConversationService.get_conversations_advanced(
            db=db,
            assistant_id=assistant_id,
            user_id=str(current_user.id),  # Фильтр по текущему пользователю (только его ассистенты)
            caller_number=caller_number,
            session_id=session_id,
            date_from=date_from_parsed,
            date_to=date_to_parsed,
            limit=limit,
            offset=offset
        )
        
        logger.info(f"✅ Returned {len(result['conversations'])} conversations (total: {result['total']})")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting conversations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversations: {str(e)}"
        )


@router.get("/conversations/{conversation_id}")
async def get_conversation_detail(
    conversation_id: str,
    include_functions: bool = Query(True, description="Включить логи вызовов функций"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить детали конкретного диалога.
    
    Требуется авторизация. Можно получить только свои диалоги.
    
    **Параметры:**
    - conversation_id: UUID диалога
    - include_functions: Включить список вызванных функций (по умолчанию true)
    
    **Возвращает:**
    - Полную информацию о диалоге
    - Список вызванных функций (если include_functions=true)
    - Детали: user_message, assistant_message, caller_number, timestamps и т.д.
    """
    try:
        logger.info(f"[CONVERSATIONS-API] Get conversation detail: {conversation_id}")
        logger.info(f"   User: {current_user.id}")
        logger.info(f"   Include functions: {include_functions}")
        
        # Получаем детали диалога
        conversation = ConversationService.get_conversation_detail(
            db=db,
            conversation_id=conversation_id,
            include_functions=include_functions
        )
        
        if not conversation:
            logger.warning(f"Conversation not found: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found"
            )
        
        # Проверяем что диалог принадлежит пользователю
        # (через ассистента)
        from backend.models.assistant import AssistantConfig
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id == conversation['assistant_id']
        ).first()
        
        if not assistant or str(assistant.user_id) != str(current_user.id):
            logger.warning(f"Access denied: conversation {conversation_id} doesn't belong to user {current_user.id}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: this conversation doesn't belong to you"
            )
        
        logger.info(f"✅ Conversation detail returned")
        if include_functions and 'function_calls' in conversation:
            logger.info(f"   Function calls: {len(conversation['function_calls'])}")
        
        return conversation
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting conversation detail: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversation detail: {str(e)}"
        )


@router.get("/conversations/stats")
async def get_conversations_stats(
    assistant_id: Optional[str] = Query(None, description="Статистика по конкретному ассистенту"),
    days: int = Query(30, ge=1, le=365, description="За сколько дней (1-365)"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить статистику по диалогам.
    
    Требуется авторизация.
    
    **Параметры:**
    - assistant_id: ID конкретного ассистента (опционально)
    - days: За сколько дней считать статистику (по умолчанию 30)
    
    **Возвращает:**
    - total_conversations: Общее количество диалогов
    - conversations_last_X_days: Диалоги за указанный период
    - conversations_today: Диалоги за сегодня
    - avg_duration_seconds: Средняя длительность диалога
    - total_tokens_used: Общее количество использованных токенов
    """
    try:
        logger.info(f"[CONVERSATIONS-API] Get stats for user {current_user.id}")
        logger.info(f"   Assistant ID: {assistant_id}")
        logger.info(f"   Days: {days}")
        
        # Получаем статистику
        stats = ConversationService.get_conversation_stats(
            db=db,
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            days=days
        )
        
        logger.info(f"✅ Stats returned: {stats}")
        
        return stats
        
    except Exception as e:
        logger.error(f"❌ Error getting conversation stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversation stats: {str(e)}"
        )


@router.get("/conversations/by-caller/{caller_number}")
async def get_conversations_by_caller(
    caller_number: str,
    assistant_id: Optional[str] = Query(None, description="Фильтр по ID ассистента"),
    limit: int = Query(50, ge=1, le=100, description="Количество записей"),
    offset: int = Query(0, ge=0, description="Смещение"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить все диалоги с конкретным номером телефона.
    
    Полезно для просмотра истории общения с клиентом.
    
    Требуется авторизация.
    
    **Параметры:**
    - caller_number: Номер телефона (формат любой)
    - assistant_id: Дополнительный фильтр по ассистенту
    - limit/offset: Пагинация
    
    **Возвращает:**
    - Список всех диалогов с этим номером
    - Отсортировано по дате (новые первые)
    """
    try:
        logger.info(f"[CONVERSATIONS-API] Get conversations by caller: {caller_number}")
        logger.info(f"   User: {current_user.id}")
        logger.info(f"   Assistant filter: {assistant_id}")
        
        # Получаем диалоги
        result = ConversationService.get_conversations_advanced(
            db=db,
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            caller_number=caller_number,
            limit=limit,
            offset=offset
        )
        
        logger.info(f"✅ Found {len(result['conversations'])} conversations for caller {caller_number}")
        
        return result
        
    except Exception as e:
        logger.error(f"❌ Error getting conversations by caller: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversations by caller: {str(e)}"
        )
