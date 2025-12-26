"""
FastAPI dependencies for WellcomeAI application.
Contains reusable dependency functions that can be used across API endpoints.
✅ FIXED: UUID conversion for database queries
"""

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid
from typing import Optional
from datetime import datetime, timezone

from backend.core.security import get_current_user_id
from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.db.session import get_db
from backend.core.config import settings

# Initialize logger
logger = get_logger(__name__)

async def get_current_user(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
) -> User:
    """
    Get the current user from the database
    ✅ FIXED: Properly converts string user_id to UUID
    
    Args:
        user_id: User ID from token (string)
        db: Database session
        
    Returns:
        User object
        
    Raises:
        HTTPException: If user not found or invalid ID format
    """
    try:
        # ✅ ИСПРАВЛЕНИЕ: Конвертируем строку в UUID
        user_uuid = uuid.UUID(user_id)
        user = db.query(User).filter(User.id == user_uuid).first()
        
        if not user:
            logger.warning(f"User not found: {user_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        logger.debug(f"✅ User retrieved: {user.email} (ID: {user_id})")
        return user
        
    except ValueError as e:
        logger.error(f"Invalid user ID format: {user_id} - {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid user ID format"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_current_user: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve user information"
        )

async def get_assistant_by_id(
    assistant_id: str,
    db: Session = Depends(get_db)
) -> AssistantConfig:
    """
    Get an assistant by ID
    ✅ FIXED: Properly converts string assistant_id to UUID
    
    Args:
        assistant_id: Assistant ID (string)
        db: Database session
        
    Returns:
        AssistantConfig object
        
    Raises:
        HTTPException: If assistant not found or invalid ID format
    """
    try:
        # ✅ ИСПРАВЛЕНИЕ: Конвертируем строку в UUID
        assistant_uuid = uuid.UUID(assistant_id)
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id == assistant_uuid
        ).first()
        
        if not assistant:
            logger.warning(f"Assistant not found: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )
        
        return assistant
        
    except ValueError as e:
        logger.error(f"Invalid assistant ID format: {assistant_id} - {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid assistant ID format"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_assistant_by_id: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve assistant"
        )

async def check_admin_access(
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Check if the current user has admin access
    
    Args:
        current_user: Current authenticated user
        
    Returns:
        Current user if they have admin access
        
    Raises:
        HTTPException: If user doesn't have admin access
    """
    if not current_user.is_admin:
        logger.warning(f"Admin access denied for user: {current_user.email}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return current_user

async def check_subscription_active(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Check if the current user has an active subscription
    
    Args:
        db: Database session
        current_user: Current authenticated user
        
    Returns:
        Current user if they have an active subscription
        
    Raises:
        HTTPException: If user doesn't have an active subscription
    """
    from backend.services.user_service import UserService
    
    # Администраторы и привилегированные пользователи всегда имеют доступ
    if current_user.is_admin or current_user.email == "well96well@gmail.com" or current_user.email == "stas@gmail.com":
        return current_user
    
    # Check subscription status
    subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
    
    if not subscription_status["active"]:
        logger.warning(f"User {current_user.id} attempted to access protected resource with inactive subscription")
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "subscription_expired",
                "message": "Your trial period has expired. Please upgrade your subscription to continue using this service.",
                "code": "TRIAL_EXPIRED",
                "subscription_status": subscription_status
            }
        )
    
    return current_user

async def check_subscription_active_for_assistants(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Специальная СТРОГАЯ проверка для работы с ассистентами
    Блокирует доступ если подписка неактивна
    
    Args:
        db: Database session
        current_user: Current authenticated user
        
    Returns:
        Current user if they have an active subscription
        
    Raises:
        HTTPException: If user doesn't have an active subscription
    """
    from backend.services.user_service import UserService
    
    # Администраторы и привилегированные пользователи всегда имеют доступ
    if current_user.is_admin or current_user.email == "well96well@gmail.com" or current_user.email == "stas@gmail.com":
        return current_user
    
    # Проверяем статус подписки
    subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
    
    if not subscription_status["active"]:
        logger.warning(f"User {current_user.id} blocked from using assistants - subscription expired")
        
        # Определяем тип блокировки для детального сообщения
        if subscription_status.get("is_trial", False):
            error_code = "TRIAL_EXPIRED"
            error_message = "Ваш пробный период истек. Пожалуйста, оплатите подписку для продолжения использования ассистентов."
        else:
            error_code = "SUBSCRIPTION_EXPIRED" 
            error_message = "Ваша подписка истекла. Пожалуйста, продлите подписку для продолжения использования ассистентов."
        
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "subscription_required",
                "message": error_message,
                "code": error_code,
                "subscription_status": subscription_status,
                "requires_payment": True
            }
        )
    
    return current_user

async def check_assistant_limit(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Check if the current user has reached their assistant limit
    
    Args:
        db: Database session
        current_user: Current authenticated user
        
    Returns:
        Current user if they haven't reached their assistant limit
        
    Raises:
        HTTPException: If user has reached their assistant limit or subscription expired
    """
    from backend.models.assistant import AssistantConfig
    from backend.services.user_service import UserService
    
    # Admin и привилегированные пользователи имеют неограниченное количество ассистентов
    if current_user.is_admin or current_user.email == "well96well@gmail.com" or current_user.email == "stas@gmail.com":
        return current_user
    
    # Get subscription status
    subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
    
    # Сначала проверяем активность подписки - СТРОГАЯ ПРОВЕРКА
    if not subscription_status["active"]:
        logger.warning(f"User {current_user.id} blocked from creating assistants - subscription expired")
        
        # Определяем тип ошибки
        if subscription_status.get("is_trial", False):
            error_code = "TRIAL_EXPIRED"
            error_message = "Ваш пробный период истек. Пожалуйста, оплатите подписку для создания ассистентов."
        else:
            error_code = "SUBSCRIPTION_EXPIRED"
            error_message = "Ваша подписка истекла. Пожалуйста, продлите подписку для создания ассистентов."
        
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "subscription_required", 
                "message": error_message,
                "code": error_code,
                "subscription_status": subscription_status,
                "requires_payment": True
            }
        )
    
    # Count user's assistants
    assistant_count = db.query(AssistantConfig).filter(
        AssistantConfig.user_id == current_user.id
    ).count()
    
    # Check if limit reached
    max_assistants = subscription_status.get("max_assistants", 0)
    if assistant_count >= max_assistants:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "assistant_limit_reached",
                "message": f"Вы достигли лимита в {max_assistants} ассистентов. Пожалуйста, обновите подписку для создания большего количества ассистентов.",
                "current_count": assistant_count,
                "max_assistants": max_assistants
            }
        )
    
    return current_user

async def check_subscription_or_show_popup(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> User:
    """
    Проверка подписки для функций, которые должны показывать поп-ап
    Вместо блокировки возвращает пользователя, но фронтенд сам решает показывать ли поп-ап
    
    Args:
        db: Database session
        current_user: Current authenticated user
        
    Returns:
        Current user (всегда возвращает пользователя)
    """
    from backend.services.user_service import UserService
    
    # Администраторы и привилегированные пользователи всегда имеют доступ
    if current_user.is_admin or current_user.email == "well96well@gmail.com" or current_user.email == "stas@gmail.com":
        return current_user
    
    # Для других пользователей просто возвращаем - проверку делает фронтенд
    return current_user
