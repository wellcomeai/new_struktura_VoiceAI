# backend/api/conversations.py
"""
Conversations API endpoints для WellcomeAI application.
Управление диалогами и историей разговоров.
Version: 1.2 - Full dialog support with session grouping
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
from backend.models.conversation import Conversation
from backend.models.assistant import AssistantConfig

logger = get_logger(__name__)

# Create router
router = APIRouter()


@router.get("/")
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


@router.get("/{conversation_id}")
async def get_conversation_detail(
    conversation_id: str,
    include_functions: bool = Query(True, description="Включить логи вызовов функций"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить ПОЛНЫЙ диалог (все сообщения из сессии).
    
    🆕 v1.2: Загружает ВСЕ сообщения из session_id для отображения чата
    
    Требуется авторизация. Можно получить только свои диалоги.
    
    **Параметры:**
    - conversation_id: UUID любого сообщения из диалога
    - include_functions: Включить список вызванных функций (по умолчанию true)
    
    **Возвращает:**
    - messages: Массив всех сообщений из сессии (отсортировано по времени)
    - assistant_id: ID ассистента
    - assistant_name: Имя ассистента
    - session_id: ID сессии
    - caller_number: Номер телефона (если есть)
    - total_tokens: Сумма токенов
    - total_duration: Сумма длительности
    - function_calls: Все вызовы функций из сессии
    """
    try:
        logger.info(f"[CONVERSATIONS-API] Get full dialog for conversation: {conversation_id}")
        logger.info(f"   User: {current_user.id}")
        
        # Получаем исходное сообщение
        from uuid import UUID
        try:
            conv_uuid = UUID(conversation_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid conversation ID format"
            )
        
        conversation = db.query(Conversation).filter(Conversation.id == conv_uuid).first()
        
        if not conversation:
            logger.warning(f"Conversation not found: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found"
            )
        
        # Проверяем права доступа
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id == conversation.assistant_id
        ).first()
        
        if not assistant or str(assistant.user_id) != str(current_user.id):
            logger.warning(f"Access denied: conversation {conversation_id} doesn't belong to user {current_user.id}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: this conversation doesn't belong to you"
            )
        
        # 🆕 Загружаем ВСЕ сообщения из этой сессии
        session_id = conversation.session_id
        
        all_messages = db.query(Conversation).filter(
            Conversation.session_id == session_id,
            Conversation.assistant_id == conversation.assistant_id
        ).order_by(Conversation.created_at.asc()).all()  # Сортировка по времени
        
        logger.info(f"   Found {len(all_messages)} messages in session {session_id}")
        
        # Формируем массив сообщений
        messages = []
        total_tokens = 0
        total_duration = 0
        
        for msg in all_messages:
            # User message
            if msg.user_message:
                messages.append({
                    "id": str(msg.id),
                    "type": "user",
                    "text": msg.user_message,
                    "timestamp": msg.created_at.isoformat() if msg.created_at else None
                })
            
            # Assistant message
            if msg.assistant_message:
                messages.append({
                    "id": str(msg.id),
                    "type": "assistant",
                    "text": msg.assistant_message,
                    "timestamp": msg.created_at.isoformat() if msg.created_at else None
                })
            
            # Суммируем метрики
            total_tokens += msg.tokens_used or 0
            total_duration += msg.duration_seconds or 0
        
        # Загружаем function calls если нужно
        function_calls = []
        if include_functions:
            from backend.models.function_log import FunctionLog
            
            # Собираем все ID сообщений из сессии
            message_ids = [msg.id for msg in all_messages]
            
            logs = db.query(FunctionLog).filter(
                FunctionLog.conversation_id.in_(message_ids)
            ).order_by(FunctionLog.created_at).all()
            
            function_calls = [
                {
                    "id": str(log.id),
                    "function_name": log.function_name,
                    "arguments": log.arguments,
                    "result": log.result,
                    "status": log.status,
                    "created_at": log.created_at.isoformat() if log.created_at else None
                }
                for log in logs
            ]
            
            logger.info(f"   Found {len(function_calls)} function calls")
        
        # Формируем ответ
        result = {
            "session_id": session_id,
            "assistant_id": str(conversation.assistant_id),
            "assistant_name": assistant.name,
            "caller_number": conversation.caller_number,
            "created_at": all_messages[0].created_at.isoformat() if all_messages else None,
            "messages": messages,
            "total_messages": len(messages),
            "total_tokens": total_tokens,
            "total_duration": total_duration,
            "function_calls": function_calls if include_functions else []
        }
        
        logger.info(f"✅ Full dialog returned: {len(messages)} messages")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting conversation detail: {e}")
        logger.error(f"   Traceback: ", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversation detail: {str(e)}"
        )


@router.get("/stats")
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


@router.get("/by-caller/{caller_number}")
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
