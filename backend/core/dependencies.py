"""
FastAPI dependencies for WellcomeAI application.
Contains reusable dependency functions that can be used across API endpoints.
"""

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid
from typing import Optional

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
