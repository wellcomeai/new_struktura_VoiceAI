"""
FastAPI dependencies for WellcomeAI application.
Contains reusable dependency functions that can be used across API endpoints.
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
    
    Args:
        user_id: User ID from token
        db: Database session
        
    Returns:
        User object
        
    Raises:
        HTTPException: If user not found
    """
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.warning(f"User not found: {user_id}")
            raise HTTPException(status_code=404, detail="User not found")
        return user
    except ValueError:
        logger.error(f"Invalid user ID format: {user_id}")
        raise HTTPException(status_code=400, detail="Invalid user ID format")

async def get_assistant_by_id(
    assistant_id: str,
    db: Session = Depends(get_db)
) -> AssistantConfig:
    """
    Get an assistant by ID
    
    Args:
        assistant_id: Assistant ID
        db: Database session
        
    Returns:
        AssistantConfig object
        
    Raises:
        HTTPException: If assistant not found
    """
    try:
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        if not assistant:
            logger.warning(f"Assistant not found: {assistant_id}")
            raise HTTPException(status_code=404, detail="Assistant not found")
        return assistant
    except ValueError:
        logger.error(f"Invalid assistant ID format: {assistant_id}")
        raise HTTPException(status_code=400, detail="Invalid assistant ID format")

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
    
    # Администраторы всегда имеют доступ
    if current_user.is_admin or current_user.email == "well96well@gmail.com":
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
    Специальная проверка для работы с ассистентами
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
    
    # Администраторы всегда имеют доступ
    if current_user.is_admin or current_user.email == "well96well@gmail.com":
        return current_user
    
    # Проверяем статус подписки
    subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
    
    if not subscription_status["active"]:
        logger.warning(f"User {current_user.id} blocked from using assistants - subscription expired")
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "subscription_expired",
                "message": "Your trial period has expired. Please upgrade your subscription to continue using assistants.",
                "code": "TRIAL_EXPIRED",
                "subscription_status": subscription_status
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
    
    # Admin has unlimited assistants
    if current_user.is_admin or current_user.email == "well96well@gmail.com":
        return current_user
    
    # Get subscription status
    subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
    
    # Сначала проверяем активность подписки
    if not subscription_status["active"]:
        logger.warning(f"User {current_user.id} blocked from creating assistants - subscription expired")
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "subscription_expired", 
                "message": "Your trial period has expired. Please upgrade your subscription to create assistants.",
                "code": "TRIAL_EXPIRED",
                "subscription_status": subscription_status
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
            detail=f"You have reached your limit of {max_assistants} assistants. Please upgrade your subscription."
        )
    
    return current_user
