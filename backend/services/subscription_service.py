"""
Subscription service for WellcomeAI application.
Handles subscription management and tracking.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional, Dict, Any
from datetime import datetime, timedelta, timezone
import uuid

from backend.core.logging import get_logger
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan
from backend.models.subscription_log import SubscriptionLog


logger = get_logger(__name__)

class SubscriptionService:
    """Service for subscription operations"""
    
    @staticmethod
    async def activate_trial(db: Session, user_id: str, trial_days: int = 3) -> Optional[User]:
        """
        Activate trial period for user
        
        Args:
            db: Database session
            user_id: User ID
            trial_days: Trial period duration in days
            
        Returns:
            Updated user object or None on error
        """
        from backend.services.user_service import UserService
        
        try:
            # Проверяем формат user_id
            user_uuid = None
            try:
                if isinstance(user_id, str):
                    user_uuid = uuid.UUID(user_id)
                    user_id = user_uuid
            except ValueError:
                logger.error(f"Invalid user_id format: {user_id}")
                # Продолжаем с оригинальным user_id
                
            # Пытаемся получить пользователя
            user = None
            try:
                user = await UserService.get_user_by_id(db, user_id)
            except HTTPException as he:
                logger.error(f"Error getting user: {str(he)}")
                # Пытаемся получить напрямую из БД, если сервис не сработал
                user = db.query(User).get(user_id)
                
            if not user:
                logger.error(f"User not found: {user_id}")
                return None
            
            # Get trial plan
            trial_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == "free").first()
            
            # Если план не найден, создаем его
            if not trial_plan:
                logger.warning("Trial plan (code='free') not found, creating one")
                trial_plan = SubscriptionPlan(
                    code="free",
                    name="Free Trial",
                    price=0,
                    max_assistants=1,
                    description="Free trial plan with basic features",
                    is_active=True
                )
                db.add(trial_plan)
                db.flush()  # Получаем ID без коммита
            
            # Set trial period
            now = datetime.now(timezone.utc)  # Используем UTC для согласованности
            user.is_trial = True
            user.subscription_start_date = now
            user.subscription_end_date = now + timedelta(days=trial_days)
            
            if trial_plan:
                user.subscription_plan_id = trial_plan.id
            
            # Логируем изменения
            logger.info(f"Setting trial: start={now}, end={user.subscription_end_date}, plan_id={trial_plan.id if trial_plan else None}")
            
            db.commit()
            db.refresh(user)
            
            # Логирование активации пробного периода
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=str(user.id),
                action="trial_activate",
                plan_id=str(trial_plan.id) if trial_plan else None,
                plan_code="free",
                details=f"Trial activated for {trial_days} days until {user.subscription_end_date.strftime('%Y-%m-%d')}"
            )
            
            # Пытаемся отправить уведомление - не критично для работы функции
            try:
                from backend.services.notification_service import NotificationService
                plan_name = trial_plan.name if trial_plan else "Free Trial"
                await NotificationService.send_subscription_started_notice(
                    user=user,
                    plan_name=plan_name,
                    end_date=user.subscription_end_date,
                    is_trial=True
                )
            except Exception as notif_error:
                logger.error(f"Failed to send notification: {str(notif_error)}")
            
            logger.info(f"Activated trial for user {user_id} until {user.subscription_end_date}")
            return user
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error activating trial: {str(e)}")
            # Не выбрасываем исключение, чтобы не блокировать регистрацию
            return None
    
    @staticmethod
    async def check_expired_subscriptions(db: Session) -> int:
        """
        Проверка и обновление истекших подписок
        
        Args:
            db: Сессия базы данных
            
        Returns:
            Количество обновленных подписок
        """
        try:
            now = datetime.now(timezone.utc)  # Используем UTC для согласованности
            
            # Находим пользователей с истекшими подписками
            # Получаем всех пользователей с подписками и фильтруем вручную из-за проблем с таймзонами
            potential_expired = db.query(User).filter(
                User.subscription_end_date.isnot(None),
                User.is_trial.is_(True)  # Пока работаем только с триальными подписками
            ).all()
            
            # Фильтруем с учетом таймзон
            expired_users = []
            for user in potential_expired:
                end_date = user.subscription_end_date
                if end_date.tzinfo is None:
                    end_date = end_date.replace(tzinfo=timezone.utc)
                    
                if end_date < now:
                    expired_users.append(user)
            
            updated_count = 0
            
            for user in expired_users:
                # Сбрасываем подписку
                user.is_trial = False
                # Оставляем дату окончания для истории
                
                # Логируем событие
                await SubscriptionService.log_subscription_event(
                    db=db,
                    user_id=str(user.id),
                    action="trial_expired",
                    plan_id=str(user.subscription_plan_id) if user.subscription_plan_id else None,
                    details=f"Trial period expired on {user.subscription_end_date.strftime('%Y-%m-%d')}"
                )
                
                updated_count += 1
            
            if updated_count > 0:
                db.commit()
                logger.info(f"Updated {updated_count} expired subscriptions")
                
            return updated_count
                
        except Exception as e:
            db.rollback()
            logger.error(f"Error checking expired subscriptions: {str(e)}")
            return 0
    
    @staticmethod
    async def log_subscription_event(
        db: Session, 
        user_id: str, 
        action: str, 
        plan_id: Optional[str] = None, 
        plan_code: Optional[str] = None, 
        details: Optional[str] = None
    ) -> Optional[SubscriptionLog]:
        """
        Log subscription event in the database
        
        Args:
            db: Database session
            user_id: User ID
            action: Action performed (subscribe, trial_activate, expire, etc)
            plan_id: Subscription plan ID if applicable
            plan_code: Subscription plan code if applicable
            details: Additional details about the event
            
        Returns:
            Created log entry or None on error
        """
        try:
            log_entry = SubscriptionLog(
                user_id=user_id,
                action=action,
                plan_id=plan_id,
                plan_code=plan_code,
                details=details,
                created_at=datetime.now(timezone.utc)  # Используем UTC для согласованности
            )
            
            db.add(log_entry)
            db.commit()
            db.refresh(log_entry)
            
            logger.debug(f"Subscription event logged: {action} for user {user_id}")
            return log_entry
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error logging subscription event: {str(e)}")
            return None
    
    @staticmethod
    async def get_subscription_logs(db: Session, user_id: str) -> List[Dict[str, Any]]:
        """
        Get subscription logs for a user
        
        Args:
            db: Database session
            user_id: User ID
            
        Returns:
            List of subscription log entries
        """
        try:
            logs = db.query(SubscriptionLog).filter(
                SubscriptionLog.user_id == user_id
            ).order_by(SubscriptionLog.created_at.desc()).all()
            
            result = []
            for log in logs:
                result.append({
                    "id": str(log.id),
                    "user_id": str(log.user_id),
                    "action": log.action,
                    "plan_id": str(log.plan_id) if log.plan_id else None,
                    "plan_code": log.plan_code,
                    "details": log.details,
                    "created_at": log.created_at
                })
                
            return result
            
        except Exception as e:
            logger.error(f"Error getting subscription logs: {str(e)}")
            return []
