"""
Authentication service for WellcomeAI application.
Handles user authentication, registration, and token management.
"""

import uuid
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
import traceback

from backend.core.logging import get_logger
from backend.core.security import hash_password, verify_password, create_jwt_token
from backend.models.user import User
from backend.schemas.auth import LoginRequest, RegisterRequest
from backend.schemas.user import UserCreate, UserResponse

logger = get_logger(__name__)

class AuthService:
    """Service for authentication operations"""
    
    @staticmethod
    async def register(db: Session, user_data: RegisterRequest) -> dict:
        """
        Register a new user
        
        Args:
            db: Database session
            user_data: User registration data
            
        Returns:
            Dictionary with token and user info
            
        Raises:
            HTTPException: If registration fails
        """
        try:
            # Check if user with this email already exists
            existing_user = db.query(User).filter(User.email == user_data.email).first()
            if existing_user:
                logger.warning(f"Registration attempt with existing email: {user_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="User with this email already exists"
                )
            
            # Hash the password
            hashed_password = hash_password(user_data.password)
            
            # Устанавливаем даты подписки прямо при создании пользователя
            now = datetime.now(timezone.utc)
            trial_end = now + timedelta(days=3)
            
            # Create new user
            new_user = User(
                email=user_data.email,
                password_hash=hashed_password,
                first_name=user_data.first_name,
                last_name=user_data.last_name,
                company_name=user_data.company_name,
                subscription_plan="free",
                # Устанавливаем даты подписки сразу
                subscription_start_date=now,
                subscription_end_date=trial_end,
                is_trial=True
            )
            
            # Set admin flag for special email
            if user_data.email == "well96well@gmail.com":
                new_user.is_admin = True
                logger.info(f"Admin privileges granted to {user_data.email}")
            
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            
            # Activate trial for non-admin users
            # Это установит связь с таблицей планов подписки
            if not new_user.is_admin:
                try:
                    # Подключаем сервис подписок для активации пробного периода
                    from backend.services.subscription_service import SubscriptionService
                    await SubscriptionService.activate_trial(db, str(new_user.id), trial_days=3)
                    logger.info(f"Trial period activated for user {new_user.email}")
                except Exception as e:
                    # Логируем ошибку, но продолжаем процесс регистрации
                    # Даты уже установлены выше
                    logger.error(f"Error activating trial (continuing registration): {str(e)}")
            
            # Create token
            token = create_jwt_token(str(new_user.id))
            
            # Log successful registration
            logger.info(f"User registered successfully: {user_data.email}")
            
            # Return token and user info
            return {
                "token": token,
                "user": UserResponse(
                    id=str(new_user.id),
                    email=new_user.email,
                    first_name=new_user.first_name,
                    last_name=new_user.last_name,
                    company_name=new_user.company_name,
                    subscription_plan=new_user.subscription_plan,
                    has_api_key=bool(new_user.openai_api_key),
                    google_sheets_authorized=new_user.google_sheets_authorized,
                    created_at=new_user.created_at,
                    updated_at=new_user.updated_at,
                    is_trial=new_user.is_trial,
                    is_admin=new_user.is_admin,
                    subscription_end_date=new_user.subscription_end_date
                )
            }
        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during registration: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Registration failed due to database constraint"
            )
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during registration: {str(e)}")
            logger.error(traceback.format_exc())
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Registration failed due to server error"
            )
    
    @staticmethod
    async def login(db: Session, login_data: LoginRequest) -> dict:
        """
        Authenticate a user and return a token
        
        Args:
            db: Database session
            login_data: User login data
            
        Returns:
            Dictionary with token and user info
            
        Raises:
            HTTPException: If authentication fails
        """
        try:
            # Find user by email
            user = db.query(User).filter(User.email == login_data.email).first()
            
            # Check if user exists and password is correct
            if not user or not verify_password(login_data.password, user.password_hash):
                logger.warning(f"Failed login attempt for email: {login_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Incorrect email or password"
                )
            
            # Check if user is active
            if not user.is_active:
                logger.warning(f"Login attempt for inactive account: {login_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Account is disabled"
                )
            
            # Проверяем, есть ли у пользователя даты подписки
            # Если нет, устанавливаем триальный период
            now = datetime.now(timezone.utc)
            if not user.subscription_start_date or not user.subscription_end_date:
                logger.warning(f"User {user.id} logged in without subscription dates, setting trial period")
                
                user.subscription_start_date = now
                user.subscription_end_date = now + timedelta(days=3)
                user.is_trial = True
                
                # Пытаемся активировать триальную подписку через сервис
                try:
                    from backend.services.subscription_service import SubscriptionService
                    await SubscriptionService.activate_trial(db, str(user.id), trial_days=3)
                except Exception as e:
                    logger.error(f"Error activating trial during login (continuing): {str(e)}")
                    # Продолжаем вход без активации
            
            # Update last login timestamp
            user.last_login = now
            db.commit()
            
            # Create token
            token = create_jwt_token(str(user.id))
            
            # Log successful login
            logger.info(f"User logged in successfully: {login_data.email}")
            
            # Return token and user info
            return {
                "token": token,
                "user": UserResponse(
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
                    is_trial=user.is_trial,
                    is_admin=user.is_admin,
                    subscription_end_date=user.subscription_end_date
                )
            }
        
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Unexpected error during login: {str(e)}")
            logger.error(traceback.format_exc())
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Login failed due to server error"
            )
    
    @staticmethod
    async def reset_password_request(db: Session, email: str) -> bool:
        """
        Request a password reset for a user
        
        Args:
            db: Database session
            email: User email
            
        Returns:
            True if request was successful
            
        Note:
            Always returns True for security reasons, even if email doesn't exist
        """
        try:
            # Find user by email
            user = db.query(User).filter(User.email == email).first()
            
            # If user doesn't exist, still return success (for security)
            if not user:
                logger.info(f"Password reset requested for non-existent email: {email}")
                return True
            
            # TODO: Implement actual password reset email sending
            # For now, just log the request
            logger.info(f"Password reset requested for: {email}")
            
            return True
        
        except Exception as e:
            logger.error(f"Error in password reset request: {str(e)}")
            logger.error(traceback.format_exc())
            # Still return True to not reveal if email exists
            return True
    
    @staticmethod
    async def change_password(db: Session, user_id: str, current_password: str, new_password: str) -> bool:
        """
        Change a user's password
        
        Args:
            db: Database session
            user_id: User ID
            current_password: Current password
            new_password: New password
            
        Returns:
            True if password was changed successfully
            
        Raises:
            HTTPException: If password change fails
        """
        try:
            # Find user by ID
            user = db.query(User).filter(User.id == user_id).first()
            
            if not user:
                logger.warning(f"Password change attempted for non-existent user ID: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Verify current password
            if not verify_password(current_password, user.password_hash):
                logger.warning(f"Password change with incorrect current password for user ID: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Current password is incorrect"
                )
            
            # Hash and set new password
            user.password_hash = hash_password(new_password)
            db.commit()
            
            logger.info(f"Password changed successfully for user ID: {user_id}")
            return True
        
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error changing password: {str(e)}")
            logger.error(traceback.format_exc())
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to change password"
            )
