from fastapi import APIRouter, Depends, HTTPException, status, Query, Path, BackgroundTasks
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_assistant_limit
from backend.db.session import get_db
from backend.models.user import User
from backend.schemas.assistant import AssistantCreate, AssistantUpdate, AssistantResponse, EmbedCodeResponse
from backend.schemas.conversation import ConversationResponse, ConversationStats
from backend.services.assistant_service import AssistantService
from backend.services.conversation_service import ConversationService
from backend.functions.registry import (
    get_function, 
    get_all_functions, 
    format_function_for_api, 
    get_all_categories,
    get_function_by_category
)

logger = get_logger(__name__)
router = APIRouter()

@router.get("/", response_model=List[AssistantResponse])
async def get_assistants(
    skip: int = Query(0, ge=0, description="Количество пропускаемых записей"),
    limit: int = Query(50, ge=1, le=100, description="Максимальное количество возвращаемых записей"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает список всех ассистентов текущего пользователя с пагинацией.
    """
    try:
        return await AssistantService.get_assistants(db, str(current_user.id), skip, limit)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistants: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistants"
        )

@router.post("/", response_model=AssistantResponse, status_code=status.HTTP_201_CREATED)
async def create_assistant(
    assistant_data: AssistantCreate,
    current_user: User = Depends(check_assistant_limit),
    db: Session = Depends(get_db)
):
    """
    Создает нового ассистента для текущего пользователя.
    """
    try:
        return await AssistantService.create_assistant(db, str(current_user.id), assistant_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in create_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create assistant"
        )

@router.get("/{assistant_id}", response_model=AssistantResponse)
async def get_assistant(
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает информацию о конкретном ассистенте по ID.
    """
    try:
        cfg = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        # вручную собираем ответ, чтобы не использовать from_orm
        return AssistantResponse(
            id=str(cfg.id),
            user_id=str(cfg.user_id),
            name=cfg.name,
            description=cfg.description,
            system_prompt=cfg.system_prompt,
            voice=cfg.voice,
            language=cfg.language,
            google_sheet_id=cfg.google_sheet_id,
            functions=cfg.functions,
            is_active=cfg.is_active,
            is_public=cfg.is_public,
            created_at=cfg.created_at,
            updated_at=cfg.updated_at,
            total_conversations=cfg.total_conversations,
            temperature=cfg.temperature or 0.7,
            max_tokens=cfg.max_tokens or 500
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistant"
        )

@router.put("/{assistant_id}", response_model=AssistantResponse)
async def update_assistant(
    assistant_data: AssistantUpdate,
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Обновляет информацию о существующем ассистенте.
    """
    try:
        return await AssistantService.update_assistant(db, assistant_id, str(current_user.id), assistant_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in update_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update assistant"
        )

@router.delete("/{assistant_id}", response_model=dict)
async def delete_assistant(
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Удаляет ассистента по ID.
    """
    try:
        await AssistantService.delete_assistant(db, assistant_id, str(current_user.id))
        return {"success": True, "message": "Assistant deleted successfully", "id": assistant_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete assistant"
        )

@router.post("/{assistant_id}/duplicate", response_model=AssistantResponse)
async def duplicate_assistant(
    assistant_id: str = Path(..., description="Assistant ID to duplicate"),
    current_user: User = Depends(check_assistant_limit),
    db: Session = Depends(get_db)
):
    """
    Создает копию существующего ассистента.
    """
    try:
        return await AssistantService.duplicate_assistant(db, assistant_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in duplicate_assistant: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to duplicate assistant"
        )

@router.get("/{assistant_id}/embed-code", response_model=EmbedCodeResponse)
async def get_embed_code(
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает HTML-код для встраивания ассистента на веб-страницу.
    """
    try:
        return await AssistantService.get_embed_code(db, assistant_id, str(current_user.id))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_embed_code: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embed code"
        )

@router.get("/{assistant_id}/conversations", response_model=List[ConversationResponse])
async def get_conversations(
    assistant_id: str = Path(..., description="Assistant ID"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает список разговоров для конкретного ассистента.
    """
    try:
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        return await ConversationService.get_conversations(db, assistant_id, skip, limit)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversations"
        )

@router.delete("/{assistant_id}/conversations", response_model=dict)
async def delete_all_conversations(
    assistant_id: str = Path(..., description="Assistant ID"),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Удаляет все разговоры для конкретного ассистента.
    """
    try:
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        # Запускаем удаление в фоновом режиме для больших объемов данных
        background_tasks.add_task(
            ConversationService.delete_all_conversations,
            db, assistant_id
        )
        return {
            "success": True, 
            "message": "Deletion of conversations started in background",
            "assistant_id": assistant_id
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_all_conversations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start deletion of conversations"
        )

@router.get("/{assistant_id}/stats", response_model=ConversationStats)
async def get_conversation_stats(
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает статистику разговоров для конкретного ассистента.
    """
    try:
        await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        return await ConversationService.get_conversation_stats(db, assistant_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_conversation_stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve conversation statistics"
        )

@router.get("/{assistant_id}/functions", response_model=List[Dict[str, Any]])
async def get_available_functions(
    assistant_id: str = Path(..., description="Assistant ID"),
    category: Optional[str] = Query(None, description="Фильтр по категории функций"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получает список доступных функций для конкретного ассистента.
    Можно фильтровать по категории.
    """
    try:
        cfg = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Получаем список включенных функций
        enabled = []
        if cfg.functions and isinstance(cfg.functions, dict):
            enabled = cfg.functions.get("enabled_functions", [])
        
        # Получаем функции в зависимости от категории
        registered = {}
        if category:
            registered = get_function_by_category(category)
        else:
            registered = get_all_functions()
        
        # Формируем ответ
        out = []
        for fid, finfo in registered.items():
            out.append(format_function_for_api(fid, fid in enabled))
        
        return out
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_available_functions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve available functions"
        )

@router.get("/functions/categories", response_model=List[str])
async def get_function_categories(
    current_user: User = Depends(get_current_user)
):
    """
    Получает список всех категорий функций.
    """
    try:
        return get_all_categories()
    except Exception as e:
        logger.error(f"Unexpected error in get_function_categories: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve function categories"
        )

@router.post("/{assistant_id}/test-function", response_model=Dict[str, Any])
async def test_function(
    function_data: Dict[str, Any],
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Тестирует вызов функции для конкретного ассистента.
    """
    from backend.websockets.openai_client import OpenAIRealtimeClient
    try:
        # Проверяем обязательные поля
        if "function_name" not in function_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="function_name field is required"
            )
        
        # Получаем конфигурацию ассистента
        cfg = await AssistantService.get_assistant_by_id(db, assistant_id, str(current_user.id))
        
        # Проверяем, есть ли API ключ у пользователя
        if not current_user.openai_api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="OpenAI API key is required to test functions"
            )
        
        # Создаем клиент для вызова функции
        client = OpenAIRealtimeClient(
            api_key=current_user.openai_api_key,
            assistant_config=cfg,
            client_id="test_function",
            db_session=db
        )
        
        # Выполняем вызов функции
        result = await client.handle_function_call(
            function_data["function_name"],
            function_data.get("arguments", {})
        )
        
        # Возвращаем результат
        return {
            "function": function_data["function_name"],
            "arguments": function_data.get("arguments", {}),
            "result": result
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in test_function: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to test function: {e}"
        )

@router.post("/{assistant_id}/toggle-function", response_model=Dict[str, Any])
async def toggle_function(
    function_data: Dict[str, Any],
    assistant_id: str = Path(..., description="Assistant ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Включает или выключает функцию для конкретного ассистента.
    """
    try:
        # Проверяем обязательные поля
        if "function_id" not in function_data or "enabled" not in function_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="function_id and enabled fields are required"
            )
        
        function_id = function_data["function_id"]
        enabled = bool(function_data["enabled"])
        
        # Проверяем, существует ли функция
        if not get_function(function_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Function {function_id} not found"
            )
        
        # Получаем и обновляем конфигурацию ассистента
        result = await AssistantService.toggle_assistant_function(
            db, 
            assistant_id, 
            str(current_user.id),
            function_id,
            enabled
        )
        
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in toggle_function: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to toggle function: {e}"
        )
