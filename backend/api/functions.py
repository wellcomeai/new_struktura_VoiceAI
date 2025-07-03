from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Dict, Any

from backend.core.dependencies import get_current_user, check_subscription_active
from backend.db.session import get_db
from backend.models.user import User
from backend.functions import get_all_definitions, get_all_openai_definitions
from backend.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter()

@router.get("/", response_model=List[Dict[str, Any]])
async def get_functions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить список доступных функций.
    
    Returns:
        List[Dict[str, Any]]: Список определений функций
    """
    try:
        # Получаем все определения функций
        definitions = get_all_definitions()
        
        # Преобразуем в список
        functions_list = list(definitions.values())
        
        # Дополнительно можно здесь фильтровать по доступности для пользователя
        # например, проверять premium-функции
        
        return functions_list
    except Exception as e:
        logger.error(f"Error getting functions: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve functions"
        )

@router.get("/openai-format", response_model=List[Dict[str, Any]])
async def get_functions_openai_format(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить список функций в формате для OpenAI API.
    
    Returns:
        List[Dict[str, Any]]: Список определений функций для OpenAI
    """
    try:
        # Получаем определения функций для OpenAI
        definitions = get_all_openai_definitions()
        return definitions
    except Exception as e:
        logger.error(f"Error getting OpenAI functions: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve OpenAI functions"
        )
