"""
FastAPI dependencies for WellcomeAI application.
Contains reusable dependency functions that can be used across API endpoints.
"""

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid
from typing import Optional

from .security import get_current_user_id
from .logging import get_logger
from models.user import User
from models.assistant import AssistantConfig
from db.session import get_db

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

async def get_user_assistant(
    assistant_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
) -> AssistantConfig:
    """
    Get an assistant by ID and verify it belongs to the current user
    
    Args:
        assistant_id: Assistant ID
        current_user: Current authenticated user
        db: Database session
        
    Returns:
        AssistantConfig object
        
    Raises:
        HTTPException: If assistant not found or doesn't belong to user
    """
    try:
        assistant = db.query(AssistantConfig).filter(
            AssistantConfig.id == assistant_id,
            AssistantConfig.user_id == current_user.id
        ).first()
        
        if not assistant:
            logger.warning(f"Assistant not found or doesn't belong to user: {assistant_id}, user: {current_user.id}")
            raise HTTPException(status_code=404, detail="Assistant not found")
            
        return assistant
    except ValueError:
        logger.error(f"Invalid assistant ID format: {assistant_id}")
        raise HTTPException(status_code=400, detail="Invalid assistant ID format")

async def get_openai_api_key(
    current_user: User = Depends(get_current_user)
) -> str:
    """
    Get OpenAI API key for the current user
    
    Args:
        current_user: Current authenticated user
        
    Returns:
        OpenAI API key
        
    Raises:
        HTTPException: If no API key available
    """
    # Try user's API key first, then fall back to the application default
    api_key = current_user.openai_api_key or settings.OPENAI_API_KEY
    
    if not api_key:
        logger.error(f"No OpenAI API key available for user {current_user.id}")
        raise HTTPException(
            status_code=400, 
            detail="OpenAI API key not configured. Please add your API key in settings."
        )
        
    return api_key
