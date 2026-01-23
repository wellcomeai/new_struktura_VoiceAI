# backend/api/conversations.py
"""
Conversations API endpoints для WellcomeAI application.
Управление диалогами и историей разговоров.

Version: 3.4 - Fix duplicate cards by caller_number
🆕 v2.0: Added OpenAI + Gemini support
🆕 v3.0: Added call_cost (стоимость звонка) и record_url (ссылка на запись) в ответы API
🆕 v3.1: STRUCTURED DIALOG - каждая реплика отдельным пузырьком в UI (backward compatible)
🆕 v3.2: Function calls загружаются в список сессий + привязываются к сообщениям по времени
🆕 v3.3: FIX - function_logs теперь ищутся и в gemini_conversations (не только в conversations)
🆕 v3.4: FIX - убран caller_number из GROUP BY, теперь используется MAX() агрегация
         Исправлено дублирование карточек когда caller_number меняется в рамках сессии
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, desc, case, or_, text
from sqlalchemy.dialects.postgresql import JSONB
from typing import Optional, List
from datetime import datetime
from uuid import UUID
from collections import defaultdict

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.services.conversation_service import ConversationService
from backend.services.auth_service import AuthService
from backend.models.user import User
from backend.models.conversation import Conversation
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig, GeminiConversation  # 🆕 v2.0, v3.3
from backend.models.function_log import FunctionLog

logger = get_logger(__name__)

# Create router
router = APIRouter()


# =============================================================================
# 🆕 v2.0: Helper functions for OpenAI + Gemini support
# =============================================================================

def get_user_assistant_ids(db: Session, user_id: UUID) -> List[UUID]:
    """
    Получить все ID ассистентов пользователя (OpenAI + Gemini).
    
    Returns:
        List[UUID]: Список всех assistant_id
    """
    # OpenAI assistants
    openai_ids = db.query(AssistantConfig.id).filter(
        AssistantConfig.user_id == user_id
    ).all()
    
    # Gemini assistants
    gemini_ids = db.query(GeminiAssistantConfig.id).filter(
        GeminiAssistantConfig.user_id == user_id
    ).all()
    
    all_ids = [a.id for a in openai_ids] + [a.id for a in gemini_ids]
    
    return all_ids


def find_assistant_by_id(db: Session, assistant_id: UUID):
    """
    🆕 v2.0: Найти ассистента по ID в обеих таблицах.
    
    Returns:
        tuple: (assistant, assistant_type) где type = 'openai' | 'gemini' | None
    """
    # Try OpenAI first
    assistant = db.query(AssistantConfig).filter(
        AssistantConfig.id == assistant_id
    ).first()
    
    if assistant:
        return assistant, 'openai'
    
    # Try Gemini
    assistant = db.query(GeminiAssistantConfig).filter(
        GeminiAssistantConfig.id == assistant_id
    ).first()
    
    if assistant:
        return assistant, 'gemini'
    
    return None, None


def attach_functions_to_messages(messages: List[dict], function_calls: List[dict]) -> List[dict]:
    """
    🆕 v3.2: Привязывает функции к ближайшему предшествующему сообщению ассистента.
    
    Логика:
    - Каждая функция привязывается к последнему сообщению ассистента,
      которое было ДО или ВО ВРЕМЯ вызова функции
    - Если такого нет - привязываем к первому сообщению ассистента
    
    Args:
        messages: Список сообщений с полями type, timestamp
        function_calls: Список вызовов функций с полем created_at
    
    Returns:
        messages с добавленным полем function_calls для каждого сообщения
    """
    # Инициализируем function_calls для всех сообщений
    for msg in messages:
        msg['function_calls'] = []
    
    if not function_calls:
        return messages
    
    # Сортируем функции по времени
    sorted_functions = sorted(
        function_calls, 
        key=lambda f: f.get('created_at') or ''
    )
    
    # Находим сообщения ассистента
    assistant_messages = [m for m in messages if m['type'] == 'assistant']
    
    if not assistant_messages:
        return messages
    
    for func in sorted_functions:
        func_time = func.get('created_at')
        if not func_time:
            # Если нет времени - привязываем к первому сообщению ассистента
            assistant_messages[0]['function_calls'].append(func)
            continue
        
        # Находим последнее сообщение ассистента ДО или ВО ВРЕМЯ вызова функции
        best_match = None
        for msg in assistant_messages:
            msg_time = msg.get('timestamp')
            if msg_time and msg_time <= func_time:
                best_match = msg
        
        # Если не нашли - привязываем к первому сообщению ассистента
        if best_match is None:
            best_match = assistant_messages[0]
        
        best_match['function_calls'].append(func)
    
    return messages


# =============================================================================
# API Endpoints
# =============================================================================

@router.get("/sessions")
async def get_conversation_sessions(
    assistant_id: Optional[str] = Query(None, description="Фильтр по ID ассистента"),
    caller_number: Optional[str] = Query(None, description="Фильтр по номеру телефона"),
    date_from: Optional[str] = Query(None, description="Фильтр: диалоги после даты (ISO format)"),
    date_to: Optional[str] = Query(None, description="Фильтр: диалоги до даты (ISO format)"),
    limit: int = Query(50, ge=1, le=100, description="Количество записей (макс 100)"),
    offset: int = Query(0, ge=0, description="Смещение для пагинации"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    🆕 v3.4: Получить список СЕССИЙ (группированных диалогов).
    Поддерживает OpenAI И Gemini ассистентов.
    Включает call_cost (стоимость), record_url (запись звонка) и function_calls.
    
    Каждая сессия = одна карточка диалога на фронте.
    Группирует все сообщения по session_id.
    
    🆕 v3.4 FIX: caller_number теперь агрегируется через MAX(), 
    чтобы избежать дублирования карточек когда caller_number 
    меняется в рамках одной сессии (NULL -> "unknown").
    
    Требуется авторизация.
    
    **Фильтры:**
    - assistant_id: Показать только диалоги конкретного ассистента
    - caller_number: Показать диалоги с конкретным номером телефона
    - date_from/date_to: Временной диапазон
    
    **Пагинация:**
    - limit: Количество записей на странице (1-100)
    - offset: Смещение (для следующих страниц)
    
    **Возвращает:**
    - conversations: Список сессий (группированных диалогов)
    - total: Общее количество сессий
    - page: Текущая страница
    - page_size: Размер страницы
    
    🆕 v3.0: Каждая сессия теперь включает:
    - call_cost: Общая стоимость звонка (рубли) или null
    - record_url: Ссылка на запись звонка или null
    
    🆕 v3.2: Каждая сессия теперь включает:
    - function_calls: Список вызовов функций для сессии
    """
    try:
        logger.info(f"[CONVERSATIONS-API-v3.4] Get sessions request from user {current_user.id}")
        logger.info(f"   Filters: assistant_id={assistant_id}, caller={caller_number}, "
                   f"date_from={date_from}, date_to={date_to}")
        logger.info(f"   Pagination: limit={limit}, offset={offset}")
        
        # Парсим даты если указаны
        date_from_parsed = None
        date_to_parsed = None
        
        if date_from:
            try:
                date_from_parsed = datetime.fromisoformat(date_from.replace('Z', '+00:00'))
            except ValueError:
                logger.warning(f"Invalid date_from format: {date_from}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid date_from format. Use ISO format (YYYY-MM-DDTHH:MM:SS)"
                )
        
        if date_to:
            try:
                date_to_parsed = datetime.fromisoformat(date_to.replace('Z', '+00:00'))
            except ValueError:
                logger.warning(f"Invalid date_to format: {date_to}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid date_to format. Use ISO format (YYYY-MM-DDTHH:MM:SS)"
                )
        
        # 🆕 v2.0: Получаем ВСЕ assistant_id пользователя (OpenAI + Gemini)
        user_assistant_ids = get_user_assistant_ids(db, current_user.id)
        
        if not user_assistant_ids:
            logger.info("   User has no assistants")
            return {
                "conversations": [],
                "total": 0,
                "page": 0,
                "page_size": limit
            }
        
        logger.info(f"   User has {len(user_assistant_ids)} assistants (OpenAI + Gemini)")
        
        # 🆕 v2.0: Создаём set Gemini ID для быстрого определения типа
        gemini_ids = db.query(GeminiAssistantConfig.id).filter(
            GeminiAssistantConfig.user_id == current_user.id
        ).all()
        gemini_id_set = {str(g.id) for g in gemini_ids}
        
        # Подзапрос для preview (первое непустое сообщение)
        preview_subquery = (
            db.query(
                Conversation.session_id,
                func.coalesce(
                    func.nullif(func.min(Conversation.user_message), ''),
                    func.nullif(func.min(Conversation.assistant_message), '')
                ).label('preview')
            )
            .filter(Conversation.assistant_id.in_(user_assistant_ids))
            .group_by(Conversation.session_id)
            .subquery()
        )
        
        # =============================================================================
        # Основной запрос - группировка по session_id
        # 🆕 v3.0: Добавлена агрегация call_cost
        # 🆕 v3.4 FIX: caller_number теперь через MAX() агрегацию, убран из GROUP BY
        # NOTE: record_url получаем только в детальном просмотре (слишком сложный подзапрос)
        # =============================================================================
        query = (
            db.query(
                Conversation.session_id,
                Conversation.assistant_id,
                func.max(Conversation.caller_number).label('caller_number'),  # 🆕 v3.4 FIX: MAX() вместо прямого поля
                func.count(Conversation.id).label('messages_count'),
                func.min(Conversation.created_at).label('created_at'),
                func.max(Conversation.created_at).label('updated_at'),
                func.sum(Conversation.tokens_used).label('total_tokens'),
                func.sum(Conversation.duration_seconds).label('total_duration'),
                func.sum(Conversation.call_cost).label('total_cost'),  # 🆕 v3.0
                preview_subquery.c.preview
            )
            .outerjoin(
                preview_subquery,
                Conversation.session_id == preview_subquery.c.session_id
            )
            .group_by(
                Conversation.session_id,
                Conversation.assistant_id,
                # 🆕 v3.4 FIX: caller_number УБРАН из GROUP BY
                preview_subquery.c.preview
            )
        )
        
        # 🆕 v2.0: Фильтр по пользователю (OpenAI + Gemini)
        query = query.filter(Conversation.assistant_id.in_(user_assistant_ids))
        
        # Фильтр по конкретному assistant_id
        if assistant_id:
            try:
                assistant_uuid = UUID(assistant_id)
                query = query.filter(Conversation.assistant_id == assistant_uuid)
            except ValueError:
                logger.warning(f"Invalid assistant_id format: {assistant_id}")
                return {
                    "conversations": [],
                    "total": 0,
                    "page": 0,
                    "page_size": limit
                }
        
        # Фильтр по номеру телефона
        if caller_number:
            query = query.having(func.max(Conversation.caller_number) == caller_number)
        
        # Фильтр по датам (используем created_at первого сообщения в сессии)
        if date_from_parsed:
            query = query.having(func.min(Conversation.created_at) >= date_from_parsed)
        if date_to_parsed:
            query = query.having(func.max(Conversation.created_at) <= date_to_parsed)
        
        # Подсчет общего количества
        from sqlalchemy import select
        count_query = select(func.count()).select_from(query.subquery())
        total = db.execute(count_query).scalar()
        
        # Сортировка и пагинация
        sessions = (
            query.order_by(desc(func.max(Conversation.created_at)))
            .limit(limit)
            .offset(offset)
            .all()
        )
        
        logger.info(f"✅ Found {len(sessions)} sessions (total: {total})")
        
        # =============================================================================
        # 🆕 v3.2: Загружаем function_calls для всех сессий одним запросом
        # 🆕 v3.3: Поддержка Gemini conversations для function_logs
        # =============================================================================
        session_ids = [s.session_id for s in sessions]
        
        # Получаем все conversation_id для этих сессий (OpenAI)
        conv_ids_query = db.query(Conversation.id, Conversation.session_id).filter(
            Conversation.session_id.in_(session_ids)
        ).all()
        
        # Маппинг conversation_id -> session_id
        conv_to_session = {str(c.id): c.session_id for c in conv_ids_query}
        conv_ids = [c.id for c in conv_ids_query]
        
        # 🆕 v3.3 FIX: Также получаем conversation_id из gemini_conversations
        gemini_conv_query = db.query(GeminiConversation.id, GeminiConversation.session_id).filter(
            GeminiConversation.session_id.in_(session_ids)
        ).all()
        
        for gc in gemini_conv_query:
            conv_to_session[str(gc.id)] = gc.session_id
            conv_ids.append(gc.id)
        
        logger.info(f"   🔧 Total conversation IDs for function lookup: {len(conv_ids)} (OpenAI: {len(conv_ids_query)}, Gemini: {len(gemini_conv_query)})")
        
        # Загружаем все function_logs для этих conversations
        function_logs = []
        if conv_ids:
            function_logs = db.query(FunctionLog).filter(
                FunctionLog.conversation_id.in_(conv_ids)
            ).order_by(FunctionLog.created_at).all()
        
        # Группируем function_logs по session_id
        logs_by_session = defaultdict(list)
        for log in function_logs:
            session_id = conv_to_session.get(str(log.conversation_id))
            if session_id:
                logs_by_session[session_id].append({
                    "id": str(log.id),
                    "function_name": log.function_name,
                    "arguments": log.arguments,
                    "result": log.result,
                    "status": log.status,
                    "execution_time_ms": log.execution_time_ms,
                    "error_message": log.error_message,
                    "created_at": log.created_at.isoformat() if log.created_at else None
                })
        
        logger.info(f"   Loaded {len(function_logs)} function logs for {len(logs_by_session)} sessions")
        
        # =============================================================================
        # Форматируем результат в формате совместимом с фронтом
        # 🆕 v3.0: Добавлен call_cost
        # 🆕 v3.2: Добавлен function_calls
        # NOTE: record_url доступен только в детальном просмотре
        # =============================================================================
        conversations = []
        for s in sessions:
            # 🆕 v2.0: Определяем тип по ID ассистента
            assistant_type = 'gemini' if str(s.assistant_id) in gemini_id_set else 'openai'
            
            # 🆕 v3.0: Форматируем стоимость
            call_cost = None
            if s.total_cost is not None and s.total_cost > 0:
                call_cost = round(float(s.total_cost), 2)
            
            conversations.append({
                "id": s.session_id,  # session_id используется как ID карточки
                "session_id": s.session_id,
                "assistant_id": str(s.assistant_id),
                "caller_number": s.caller_number,  # 🆕 v3.4: Теперь из MAX() агрегации
                "messages_count": s.messages_count,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                "user_message": (s.preview or "")[:200],  # Preview для карточки
                "assistant_message": "",  # Оставляем пустым
                "tokens_used": s.total_tokens or 0,
                "duration_seconds": s.total_duration or 0,
                "call_cost": call_cost,  # 🆕 v3.0: Стоимость звонка в рублях
                "record_url": None,  # 🆕 v3.0: Доступно только в детальном просмотре
                "client_info": {"assistant_type": assistant_type},  # 🆕 Добавляем тип
                "function_calls": logs_by_session.get(s.session_id, [])  # 🆕 v3.2
            })
        
        return {
            "conversations": conversations,
            "total": total,
            "page": offset // limit if limit > 0 else 0,
            "page_size": limit
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting sessions: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get conversation sessions: {str(e)}"
        )


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
    
    ⚠️ DEPRECATED: Используйте /sessions для группировки по сессиям.
    Этот endpoint возвращает отдельные записи сообщений.
    
    🆕 v2.0: Поддерживает OpenAI и Gemini ассистентов.
    
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
        logger.info(f"[CONVERSATIONS-API-v3.4] Get conversations request from user {current_user.id}")
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
        
        # 🆕 v2.0: ConversationService.get_conversations_advanced уже поддерживает оба типа
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
    
    🆕 v2.0: Поддерживает OpenAI и Gemini ассистентов.
    🆕 v3.0: Включает call_cost и record_url.
    🆕 v3.1: STRUCTURED DIALOG - если в client_info есть dialog[], 
             каждая реплика возвращается отдельным пузырьком.
             Backward compatible со старыми записями.
    🆕 v3.2: Function calls привязываются к сообщениям по времени.
             Каждое сообщение теперь содержит поле function_calls[].
    
    Требуется авторизация. Можно получить только свои диалоги.
    
    **Параметры:**
    - conversation_id: UUID любого сообщения из диалога ИЛИ session_id
    - include_functions: Включить список вызванных функций (по умолчанию true)
    
    **Возвращает:**
    - messages: Массив всех сообщений из сессии (отсортировано по времени)
      - Каждое сообщение содержит function_calls[] привязанные по времени (🆕 v3.2)
    - assistant_id: ID ассистента
    - assistant_name: Имя ассистента
    - assistant_type: Тип ассистента (openai/gemini)
    - session_id: ID сессии
    - caller_number: Номер телефона (если есть)
    - total_tokens: Сумма токенов
    - total_duration: Сумма длительности
    - call_cost: Стоимость звонка в рублях (🆕 v3.0)
    - record_url: Ссылка на запись звонка (🆕 v3.0)
    - function_calls: Все вызовы функций из сессии (общий список)
    - has_structured_dialog: Флаг наличия структурированного диалога (🆕 v3.1)
    """
    try:
        logger.info(f"[CONVERSATIONS-API-v3.4] Get full dialog for: {conversation_id}")
        logger.info(f"   User: {current_user.id}")
        
        # Пробуем найти по session_id напрямую (для нового API /sessions)
        conversation = db.query(Conversation).filter(
            Conversation.session_id == conversation_id
        ).first()
        
        # Если не нашли, пробуем как UUID conversation_id
        if not conversation:
            try:
                conv_uuid = UUID(conversation_id)
                conversation = db.query(Conversation).filter(
                    Conversation.id == conv_uuid
                ).first()
            except ValueError:
                pass
        
        if not conversation:
            logger.warning(f"Conversation not found: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found"
            )
        
        # 🆕 v2.0: Проверяем права доступа (OpenAI ИЛИ Gemini)
        assistant, assistant_type = find_assistant_by_id(db, conversation.assistant_id)
        
        if not assistant:
            logger.warning(f"Assistant not found for conversation: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )
        
        if str(assistant.user_id) != str(current_user.id):
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
        
        logger.info(f"   Found {len(all_messages)} DB records in session {session_id}")
        logger.info(f"   Assistant type: {assistant_type}")
        
        # =============================================================================
        # 🆕 v3.1: STRUCTURED DIALOG SUPPORT
        # Проверяем наличие dialog[] в client_info для каждой записи
        # Если есть - используем его, если нет - fallback на legacy формат
        # =============================================================================
        messages = []
        total_tokens = 0
        total_duration = 0
        total_cost = 0.0
        record_url = None
        has_structured_dialog = False
        
        for msg in all_messages:
            client_info = msg.client_info or {}
            dialog = client_info.get('dialog', [])
            
            # 🆕 v3.1: Проверяем наличие структурированного диалога
            if dialog and isinstance(dialog, list) and len(dialog) > 0:
                has_structured_dialog = True
                logger.info(f"   📝 Found structured dialog with {len(dialog)} turns in record {msg.id}")
                
                # Используем structured dialog - каждая реплика отдельно
                for turn in dialog:
                    role = turn.get('role', 'unknown')
                    text = turn.get('text', '')
                    ts = turn.get('ts')
                    
                    # Конвертируем timestamp (миллисекунды) в ISO формат
                    timestamp = None
                    if ts:
                        try:
                            timestamp = datetime.fromtimestamp(ts / 1000).isoformat()
                        except (ValueError, TypeError, OSError):
                            timestamp = msg.created_at.isoformat() if msg.created_at else None
                    else:
                        timestamp = msg.created_at.isoformat() if msg.created_at else None
                    
                    # Добавляем реплику как отдельное сообщение
                    if text:  # Пропускаем пустые реплики
                        messages.append({
                            "id": str(msg.id),  # ID записи БД для reference
                            "type": "user" if role == "user" else "assistant",
                            "text": text,
                            "timestamp": timestamp
                        })
            else:
                # =============================================================================
                # LEGACY FORMAT: Fallback для старых записей без structured dialog
                # Каждая запись БД содержит user_message и assistant_message как единые блоки
                # =============================================================================
                logger.info(f"   📄 Using legacy format for record {msg.id}")
                
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
            
            # Суммируем метрики (независимо от формата)
            total_tokens += msg.tokens_used or 0
            total_duration += msg.duration_seconds or 0
            
            # 🆕 v3.0: Суммируем стоимость
            if msg.call_cost:
                total_cost += float(msg.call_cost)
            
            # 🆕 v3.0: Берём record_url из client_info (последний непустой)
            if client_info.get('record_url'):
                record_url = client_info.get('record_url')
        
        logger.info(f"   Total messages after processing: {len(messages)}")
        logger.info(f"   Has structured dialog: {has_structured_dialog}")
        
        # Загружаем function calls если нужно
        function_calls = []
        if include_functions:
            # Собираем все ID сообщений из сессии
            message_ids = [msg.id for msg in all_messages]
            
            # 🆕 v3.3 FIX: Для Gemini ассистентов также ищем в gemini_conversations
            if assistant_type == 'gemini':
                gemini_messages = db.query(GeminiConversation.id).filter(
                    GeminiConversation.session_id == session_id
                ).all()
                gemini_ids = [m.id for m in gemini_messages]
                message_ids.extend(gemini_ids)
                logger.info(f"   🔧 Added {len(gemini_ids)} Gemini conversation IDs for function lookup")
            
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
        
        # =============================================================================
        # 🆕 v3.2: Привязываем function_calls к сообщениям по времени
        # Каждое сообщение ассистента получает список своих function_calls
        # =============================================================================
        if include_functions and function_calls:
            messages = attach_functions_to_messages(messages, function_calls)
            logger.info(f"   Attached function calls to messages")
        else:
            # Инициализируем пустые function_calls для всех сообщений
            for msg in messages:
                msg['function_calls'] = []
        
        # 🆕 v2.0: Извлекаем assistant_type из client_info или используем определённый
        main_client_info = conversation.client_info or {}
        detected_type = main_client_info.get('assistant_type', assistant_type)
        
        # 🆕 v3.0: Форматируем стоимость
        call_cost = round(total_cost, 2) if total_cost > 0 else None
        
        # Формируем ответ
        result = {
            "session_id": session_id,
            "assistant_id": str(conversation.assistant_id),
            "assistant_name": assistant.name,
            "assistant_type": detected_type,  # 🆕 v2.0
            "caller_number": conversation.caller_number,
            "created_at": all_messages[0].created_at.isoformat() if all_messages else None,
            "messages": messages,
            "total_messages": len(messages),
            "total_tokens": total_tokens,
            "total_duration": total_duration,
            "call_cost": call_cost,  # 🆕 v3.0: Стоимость в рублях
            "record_url": record_url,  # 🆕 v3.0: Ссылка на запись
            "has_structured_dialog": has_structured_dialog,  # 🆕 v3.1: Флаг формата
            "function_calls": function_calls if include_functions else [],
            "client_info": main_client_info  # 🆕 v2.0
        }
        
        logger.info(f"✅ Full dialog returned: {len(messages)} messages, type: {detected_type}")
        logger.info(f"   Call cost: {call_cost}, Record URL: {'✅' if record_url else '❌'}")
        logger.info(f"   Structured dialog: {'✅' if has_structured_dialog else '❌ (legacy)'}")
        
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


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    🆕 v2.0: Удалить диалог (всю сессию со всеми сообщениями).
    Поддерживает OpenAI и Gemini ассистентов.
    
    Удаляет ВСЕ сообщения из session_id и связанные FunctionLog записи.
    
    Требуется авторизация. Можно удалить только свои диалоги.
    
    **Параметры:**
    - conversation_id: UUID любого сообщения из диалога ИЛИ session_id
    
    **Возвращает:**
    - message: Сообщение об успешном удалении
    - deleted_messages: Количество удаленных сообщений
    - deleted_functions: Количество удаленных логов функций
    - assistant_type: Тип ассистента (openai/gemini)
    """
    try:
        logger.info(f"[CONVERSATIONS-API-v3.4] Delete conversation request: {conversation_id}")
        logger.info(f"   User: {current_user.id}")
        
        # Пробуем найти по session_id напрямую
        conversation = db.query(Conversation).filter(
            Conversation.session_id == conversation_id
        ).first()
        
        # Если не нашли, пробуем как UUID conversation_id
        if not conversation:
            try:
                conv_uuid = UUID(conversation_id)
                conversation = db.query(Conversation).filter(
                    Conversation.id == conv_uuid
                ).first()
            except ValueError:
                pass
        
        if not conversation:
            logger.warning(f"Conversation not found: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found"
            )
        
        # 🆕 v2.0: Проверяем права доступа (OpenAI ИЛИ Gemini)
        assistant, assistant_type = find_assistant_by_id(db, conversation.assistant_id)
        
        if not assistant:
            logger.warning(f"Assistant not found for conversation: {conversation_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )
        
        if str(assistant.user_id) != str(current_user.id):
            logger.warning(f"Access denied: conversation {conversation_id} doesn't belong to user {current_user.id}")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: this conversation doesn't belong to you"
            )
        
        session_id = conversation.session_id
        
        # Получаем все сообщения из сессии для подсчета
        all_messages = db.query(Conversation).filter(
            Conversation.session_id == session_id,
            Conversation.assistant_id == conversation.assistant_id
        ).all()
        
        message_ids = [msg.id for msg in all_messages]
        messages_count = len(message_ids)
        
        logger.info(f"   Found {messages_count} messages to delete in session {session_id}")
        logger.info(f"   Assistant type: {assistant_type}")
        
        # Удаляем связанные FunctionLog записи
        deleted_functions = 0
        if message_ids:
            deleted_functions = db.query(FunctionLog).filter(
                FunctionLog.conversation_id.in_(message_ids)
            ).delete(synchronize_session=False)
            logger.info(f"   Deleted {deleted_functions} function logs")
        
        # Удаляем ВСЕ сообщения из сессии
        deleted_messages = db.query(Conversation).filter(
            Conversation.session_id == session_id,
            Conversation.assistant_id == conversation.assistant_id
        ).delete(synchronize_session=False)
        
        db.commit()
        
        logger.info(f"✅ Successfully deleted conversation session {session_id}")
        logger.info(f"   Deleted {deleted_messages} messages and {deleted_functions} function logs")
        
        return {
            "message": "Conversation deleted successfully",
            "session_id": session_id,
            "deleted_messages": deleted_messages,
            "deleted_functions": deleted_functions,
            "assistant_type": assistant_type  # 🆕 v2.0
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error deleting conversation: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete conversation: {str(e)}"
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
    
    🆕 v3.0: Добавлена статистика по стоимости звонков.
    
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
    - total_call_cost: Общая стоимость звонков (🆕 v3.0)
    """
    try:
        logger.info(f"[CONVERSATIONS-API-v3.4] Get stats for user {current_user.id}")
        logger.info(f"   Assistant ID: {assistant_id}")
        logger.info(f"   Days: {days}")
        
        # Получаем статистику
        stats = ConversationService.get_conversation_stats(
            db=db,
            assistant_id=assistant_id,
            user_id=str(current_user.id),
            days=days
        )
        
        # 🆕 v3.0: Добавляем статистику по стоимости
        user_assistant_ids = get_user_assistant_ids(db, current_user.id)
        
        if user_assistant_ids:
            from datetime import timedelta
            start_date = datetime.utcnow() - timedelta(days=days)
            
            cost_query = db.query(
                func.sum(Conversation.call_cost)
            ).filter(
                Conversation.assistant_id.in_(user_assistant_ids),
                Conversation.call_cost.isnot(None)
            )
            
            if assistant_id:
                try:
                    cost_query = cost_query.filter(Conversation.assistant_id == UUID(assistant_id))
                except ValueError:
                    pass
            
            total_cost = cost_query.scalar() or 0.0
            stats["total_call_cost"] = round(float(total_cost), 2)
        else:
            stats["total_call_cost"] = 0.0
        
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
    
    🆕 v2.0: Поддерживает OpenAI и Gemini ассистентов.
    
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
        logger.info(f"[CONVERSATIONS-API-v3.4] Get conversations by caller: {caller_number}")
        logger.info(f"   User: {current_user.id}")
        logger.info(f"   Assistant filter: {assistant_id}")
        
        # 🆕 v2.0: ConversationService.get_conversations_advanced уже поддерживает оба типа
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
