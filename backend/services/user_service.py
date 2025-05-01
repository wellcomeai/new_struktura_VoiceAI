"""
User service for WellcomeAI application.
Handles user account management operations.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional

from core.logging import get_logger
from models.user import User
from schemas.user import UserUpdate, UserResponse, UserDetailResponse

logger = get_logger(__name__)

class UserService:
    """Service for user operations"""
    
    @staticmethod
    async def get_user_by_id(db: Session, user_id: str) -> User:
        """
        Get user by ID
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            User object
            
        Raises:
            HTTPException: If user not found
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.warning(f"User not found: {user_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        return user
    
    @staticmethod
    async def get_user_profile(db: Session, user_id: str) -> UserResponse:
        """
        Get user profile information
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            UserResponse with user profile information
        """
        user = await UserService.get_user_by_id(db, user_id)
        
        return UserResponse(
            id=str(user.id),
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            company_name=user.company_name,
            subscription_plan=user.subscription_plan,
            has_api_key=bool(user.openai_api_key),
            google_sheets_authorized=user.google_sheets_authorized,
            created_at=user.created_at,
            updated_at=user.updated_at
        )
    
    @staticmethod
    async def get_user_details(db: Session, user_id: str) -> UserDetailResponse:
        """
        Get detailed user information including usage stats
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            UserDetailResponse with detailed user information
        """
        user = await UserService.get_user_by_id(db, user_id)
        
        # Count user's assistants
        total_assistants = db.query(models.assistant.AssistantConfig).filter(
            models.assistant.AssistantConfig.user_id == user.id
        ).count()
        
        # Get total conversations count
        total_conversations = 0
        for assistant in user.assistants:
            total_conversations += assistant.total_conversations
        
        return UserDetailResponse(
            id=str(user.id),
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            company_name=user.company_name,
            subscription_plan=user.subscription_plan,
            has_api_key=bool(user.openai_api_key),
            google_sheets_authorized=user.google_sheets_authorized,
            created_at=user.created_at,
            updated_at=user.updated_at,
            total_assistants=total_assistants,
            total_conversations=total_conversations,
            usage_tokens=user.usage_tokens,
            last_login=user.last_login
        )
    
    @staticmethod
    async def update_user(db: Session, user_id: str, user_data: UserUpdate) -> UserResponse:
        """
        Update user information
        
        Args:
            db: Database session
            user_id: User ID
            user_data: Updated user data
            
        Returns:
            Updated UserResponse
            
        Raises:
            HTTPException: If update fails
        """
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            # Update only provided fields
            update_data = user_data.dict(exclude_unset=True)
            for key, value in update_data.items():
                setattr(user, key, value)
            
            db.commit()
            db.refresh(user)
            
            logger.info(f"User updated successfully: {user_id}")
            
            return UserResponse(
                id=str(user.id),
                email=user.email,
                first_name=user.first_name,
                last_name=user.last_name,
                company_name=user.company_name,
                subscription_plan=user.subscription_plan,
                has_api_key=bool(user.openai_api_key),
                google_sheets_authorized=user.google_sheets_authorized,
                created_at=user.created_at,
                updated_at=user.updated_at
            )
            
        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during user update: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Update failed due to database constraint"
            )
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during user update: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Update failed due to server error"
            )
    
    @staticmethod
    async def deactivate_user(db: Session, user_id: str) -> bool:
        """
        Deactivate a user account
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            True if deactivation was successful
        """
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            user.is_active = False
            db.commit()
            
            logger.info(f"User deactivated: {user_id}")
            return True
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error deactivating user: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to deactivate user"
            )
    
    @staticmethod
    async def add_usage_tokens(db: Session, user_id: str, token_count: int) -> None:
        """
        Add usage tokens to a user's account
        
        Args:
            db: Database session
            user_id: User ID
            token_count: Number of tokens to add
        """
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            user.usage_tokens += token_count
            db.commit()
            
            logger.debug(f"Added {token_count} tokens to user {user_id}, total: {user.usage_tokens}")
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error adding usage tokens: {str(e)}")
