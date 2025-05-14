"""
User service for WellcomeAI application.
Handles user account management operations.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional, Dict, Any
from datetime import datetime, timedelta, timezone

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.assistant import AssistantConfig  # Правильный импорт модели
from backend.models.file import File  # Добавлен импорт для файлов
from backend.models.subscription import SubscriptionPlan # Добавлен импорт для подписок
from backend.schemas.user import UserUpdate, UserResponse, UserDetailResponse

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
            openai_api_key=user.openai_api_key,  # Включаем API ключ в ответ
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
        
        # Count user's assistants - исправленный код
        total_assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == user.id
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
            openai_api_key=user.openai_api_key,  # Включаем сам API-ключ в ответ
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
            
            # Update only provided fields - совместимость с Pydantic v1 и v2
            if hasattr(user_data, 'dict'):
                # Pydantic v1
                update_data = user_data.dict(exclude_unset=True)
            else:
                # Pydantic v2
                update_data = user_data.model_dump(exclude_unset=True)
            
            # Явно обрабатываем случай с API ключом
            if 'openai_api_key' in update_data:
                # Разрешаем пустую строку или None
                user.openai_api_key = update_data.pop('openai_api_key')
            
            # Обновляем остальные поля
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
                openai_api_key=user.openai_api_key,  # Включаем сам API-ключ в ответ
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
    
    @staticmethod
    async def check_subscription_status(db: Session, user_id: str) -> Dict[str, Any]:
        """
        Проверить статус подписки пользователя
        
        Args:
            db: Сессия базы данных
            user_id: ID пользователя
            
        Returns:
            Словарь с информацией о статусе подписки
        """
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            # Администраторы всегда имеют активную подписку
            # Проверка на админа через email
            if user.is_admin or user.email == "well96well@gmail.com":
                return {
                    "active": True,
                    "is_trial": False,
                    "days_left": None,
                    "max_assistants": 10,  # Фиксированное количество для админа
                    "current_assistants": 0,  # Для корректного отображения в UI
                    "features": ["all"]      # Все функции
                }
                
            # Проверяем, есть ли активная подписка
            now = datetime.now(timezone.utc)  # Используем UTC для согласованности
            
            # Нормализуем дату окончания подписки
            subscription_end_date = user.subscription_end_date
            if subscription_end_date and subscription_end_date.tzinfo is None:
                subscription_end_date = subscription_end_date.replace(tzinfo=timezone.utc)
                
            has_active_subscription = (
                user.subscription_plan_id is not None and
                subscription_end_date is not None and
                subscription_end_date > now
            )
            
            # Получаем максимальное количество ассистентов из плана подписки
            max_assistants = 1  # Default для тестового периода

            if user.subscription_plan_id:
                plan = db.query(SubscriptionPlan).get(user.subscription_plan_id)
                if plan:
                    # Устанавливаем лимиты в зависимости от кода плана
                    if plan.code == "free":
                        max_assistants = 1  # Тестовый период
                    else:
                        max_assistants = 3  # Оплаченный период (любой, кроме free)
            
            # Вычисляем, сколько дней осталось
            days_left = None
            if subscription_end_date and has_active_subscription:
                delta = subscription_end_date - now
                days_left = max(0, delta.days)
            
            # Получаем текущее количество ассистентов
            current_assistants = db.query(AssistantConfig).filter(
                AssistantConfig.user_id == user.id
            ).count()
            
            return {
                "active": has_active_subscription,
                "is_trial": user.is_trial if has_active_subscription else False,
                "days_left": days_left,
                "max_assistants": max_assistants if has_active_subscription else 1,
                "current_assistants": current_assistants,
                "features": ["basic"]
            }
            
        except Exception as e:
            logger.error(f"Error checking subscription status: {str(e)}")
            # Возвращаем статус неактивной подписки в случае ошибки
            return {
                "active": False,
                "is_trial": False,
                "days_left": 0,
                "max_assistants": 1,
                "current_assistants": 0,
                "features": ["basic"]
            }

    @staticmethod
    async def set_subscription_plan(db: Session, user_id: str, plan_code: str, duration_days: int) -> User:
        """
        Установить план подписки для пользователя
        
        Args:
            db: Сессия базы данных
            user_id: ID пользователя
            plan_code: Код плана подписки
            duration_days: Продолжительность подписки в днях
            
        Returns:
            Обновленный объект пользователя
        """
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            # Находим план подписки по коду
            subscription_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not subscription_plan:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Subscription plan with code {plan_code} not found"
                )
            
            # Устанавливаем даты начала и окончания подписки
            now = datetime.now(timezone.utc)  # Используем UTC для согласованности
            user.subscription_plan_id = subscription_plan.id
            user.subscription_start_date = now
            user.subscription_end_date = now + timedelta(days=duration_days)
            
            # Если бесплатный план, то это пробный период
            user.is_trial = plan_code == "free"
            
            # Сохраняем изменения
            db.commit()
            db.refresh(user)
            
            logger.info(f"Set subscription plan {plan_code} for user {user_id} for {duration_days} days")
            
            return user
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error setting subscription plan: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to set subscription plan"
            )
