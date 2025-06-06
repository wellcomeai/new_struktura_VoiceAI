"""
ПРАВИЛЬНЫЙ Subscription service for WellcomeAI application.
Полная версия с отслеживанием, логированием и уведомлениями.
ИСПРАВЛЯЕТ ошибку 500 И сохраняет всю функциональность!
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
    """Service for subscription operations - ПОЛНАЯ ВЕРСИЯ с отслеживанием"""
    
    @staticmethod
    async def activate_trial(db: Session, user_id: str, trial_days: int = 3) -> Optional[User]:
        """
        ✅ ПРАВИЛЬНАЯ версия активации триального периода с ПОЛНЫМ логированием
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
                
            # Пытаемся получить пользователя
            user = None
            try:
                user = await UserService.get_user_by_id(db, user_id)
            except HTTPException as he:
                logger.error(f"Error getting user: {str(he)}")
                user = db.query(User).get(user_id)
                
            if not user:
                logger.error(f"User not found: {user_id}")
                return None
            
            # ✅ НЕ ПЕРЕЗАПИСЫВАЕМ даты, если они уже есть!
            if user.subscription_start_date and user.subscription_end_date:
                logger.info(f"User {user_id} already has subscription dates (start={user.subscription_start_date}, end={user.subscription_end_date}), not overwriting")
                
                # Только убеждаемся, что план подписки установлен
                if not user.subscription_plan_id:
                    trial_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == "free").first()
                    if trial_plan:
                        user.subscription_plan_id = trial_plan.id
                        db.commit()
                        logger.info(f"Set trial plan for user {user_id} without changing dates")
                
                return user
            
            # Продолжаем только если дат действительно нет
            logger.info(f"🚀 Setting up trial for user {user_id} - no existing subscription dates found")
            
            # ✅ ПРАВИЛЬНО: Получаем или создаем план из таблицы subscription_plans
            trial_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == "free").first()
            
            # Если план не найден, создаем его
            if not trial_plan:
                logger.warning("Trial plan (code='free') not found, creating one")
                trial_plan = SubscriptionPlan(
                    code="free",
                    name="Free Trial",
                    price=0,
                    max_assistants=1,
                    description="Бесплатный пробный период с базовыми функциями",
                    is_active=True
                )
                db.add(trial_plan)
                db.flush()  # Получаем ID без коммита
                logger.info(f"✅ Created trial plan: {trial_plan.id}")
            
            # Set trial period ТОЛЬКО если дат нет
            now = datetime.now(timezone.utc)
            user.is_trial = True
            user.subscription_start_date = now
            user.subscription_end_date = now + timedelta(days=trial_days)
            user.subscription_plan_id = trial_plan.id
            
            # Логируем изменения
            logger.info(f"📅 Setting trial: start={now}, end={user.subscription_end_date}, plan_id={trial_plan.id}")
            
            db.commit()
            db.refresh(user)
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Логируем активацию пробного периода в БД
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=str(user.id),
                action="trial_activate",
                plan_id=str(trial_plan.id),
                plan_code="free",
                details=f"Trial activated for {trial_days} days until {user.subscription_end_date.strftime('%Y-%m-%d')}",
                amount=0
            )
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Отправляем уведомление о начале триала
            try:
                from backend.services.notification_service import NotificationService
                await NotificationService.send_subscription_started_notice(
                    user=user,
                    plan_name=trial_plan.name,
                    end_date=user.subscription_end_date,
                    is_trial=True
                )
                logger.info(f"📧 Trial start notification sent to {user.email}")
            except Exception as notif_error:
                logger.error(f"⚠️ Failed to send trial notification: {str(notif_error)}")
            
            logger.info(f"✅ Trial activated for user {user_id} until {user.subscription_end_date}")
            return user
            
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error activating trial: {str(e)}")
            # Не выбрасываем исключение, чтобы не блокировать регистрацию
            return None
    
    @staticmethod
    async def check_expired_subscriptions(db: Session) -> int:
        """
        ✅ ПРАВИЛЬНАЯ проверка и обновление истекших подписок с ПОЛНЫМ логированием
        """
        try:
            now = datetime.now(timezone.utc)
            
            # Находим пользователей с истекшими подписками
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
                # Сбрасываем только флаг активности, НЕ ТРОГАЕМ даты!
                user.is_trial = False
                # НЕ ОБНУЛЯЕМ subscription_end_date - оставляем для истории!
                
                # ✅ КРИТИЧЕСКИ ВАЖНО: Логируем истечение подписки в БД
                await SubscriptionService.log_subscription_event(
                    db=db,
                    user_id=str(user.id),
                    action="trial_expired",
                    plan_id=str(user.subscription_plan_id) if user.subscription_plan_id else None,
                    plan_code="free",
                    details=f"Trial period expired on {user.subscription_end_date.strftime('%Y-%m-%d')}"
                )
                
                # ✅ КРИТИЧЕСКИ ВАЖНО: Отправляем уведомление об истечении
                try:
                    from backend.services.notification_service import NotificationService
                    await NotificationService.send_subscription_expired_notice(user)
                    logger.info(f"📧 Expiration notification sent to {user.email}")
                except Exception as notif_error:
                    logger.error(f"⚠️ Failed to send expiration notification: {notif_error}")
                
                logger.info(f"⏰ Trial period expired for user {user.id}, email: {user.email}")
                updated_count += 1
            
            if updated_count > 0:
                db.commit()
                logger.info(f"✅ Updated {updated_count} expired subscriptions")
                
            return updated_count
                
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error checking expired subscriptions: {str(e)}")
            return 0
    
    @staticmethod
    async def log_subscription_event(
        db: Session, 
        user_id: str, 
        action: str, 
        plan_id: Optional[str] = None, 
        plan_code: Optional[str] = None, 
        details: Optional[str] = None,
        amount: Optional[float] = None,
        payment_id: Optional[str] = None
    ) -> Optional[SubscriptionLog]:
        """
        ✅ КРИТИЧЕСКИ ВАЖНАЯ функция логирования событий подписки в БД
        Эта функция обеспечивает ПОЛНОЕ отслеживание всех действий!
        """
        try:
            log_entry = SubscriptionLog(
                user_id=user_id,
                action=action,
                plan_id=plan_id,
                plan_code=plan_code,
                amount=amount,
                payment_id=payment_id,
                details=details,
                created_at=datetime.now(timezone.utc)
            )
            
            db.add(log_entry)
            db.commit()
            db.refresh(log_entry)
            
            logger.info(f"📝 Subscription event logged: {action} for user {user_id} (log_id: {log_entry.id})")
            return log_entry
            
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error logging subscription event: {str(e)}")
            return None
    
    @staticmethod
    async def get_subscription_logs(db: Session, user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        ✅ КРИТИЧЕСКИ ВАЖНАЯ функция получения истории подписки пользователя
        """
        try:
            logs = db.query(SubscriptionLog).filter(
                SubscriptionLog.user_id == user_id
            ).order_by(SubscriptionLog.created_at.desc()).limit(limit).all()
            
            result = []
            for log in logs:
                result.append({
                    "id": str(log.id),
                    "user_id": str(log.user_id),
                    "action": log.action,
                    "plan_id": str(log.plan_id) if log.plan_id else None,
                    "plan_code": log.plan_code,
                    "amount": float(log.amount) if log.amount else None,
                    "payment_id": log.payment_id,
                    "details": log.details,
                    "created_at": log.created_at
                })
                
            logger.info(f"📋 Retrieved {len(result)} subscription logs for user {user_id}")
            return result
            
        except Exception as e:
            logger.error(f"❌ Error getting subscription logs: {str(e)}")
            return []
    
    @staticmethod
    async def get_upcoming_expirations(db: Session, days_ahead: int = 3) -> List[User]:
        """
        ✅ НОВАЯ КРИТИЧЕСКИ ВАЖНАЯ функция для уведомлений об истечении подписки
        """
        try:
            now = datetime.now(timezone.utc)
            deadline = now + timedelta(days=days_ahead)
            
            # Находим пользователей, у которых подписка истекает в ближайшие дни
            expiring_users = db.query(User).filter(
                User.subscription_end_date.isnot(None),
                User.subscription_end_date > now,
                User.subscription_end_date <= deadline,
                User.is_active.is_(True)
            ).all()
            
            # Фильтруем с учетом таймзон
            filtered_users = []
            for user in expiring_users:
                end_date = user.subscription_end_date
                if end_date.tzinfo is None:
                    end_date = end_date.replace(tzinfo=timezone.utc)
                
                if now < end_date <= deadline:
                    filtered_users.append(user)
            
            logger.info(f"📅 Found {len(filtered_users)} users with subscriptions expiring in {days_ahead} days")
            return filtered_users
            
        except Exception as e:
            logger.error(f"❌ Error getting upcoming expirations: {str(e)}")
            return []
    
    @staticmethod
    async def send_expiration_reminders(db: Session) -> int:
        """
        ✅ НОВАЯ КРИТИЧЕСКИ ВАЖНАЯ функция отправки напоминаний об истечении
        """
        try:
            # Напоминания за 3 дня
            users_3_days = await SubscriptionService.get_upcoming_expirations(db, 3)
            
            # Напоминания за 1 день
            users_1_day = await SubscriptionService.get_upcoming_expirations(db, 1)
            
            sent_count = 0
            
            # Отправляем напоминания
            try:
                from backend.services.notification_service import NotificationService
                
                for user in users_3_days:
                    try:
                        await NotificationService.send_subscription_expiring_soon_notice(user, days_left=3)
                        logger.info(f"📧 3-day reminder sent to {user.email}")
                        sent_count += 1
                    except Exception as e:
                        logger.error(f"⚠️ Failed to send 3-day reminder to {user.email}: {e}")
                
                for user in users_1_day:
                    try:
                        await NotificationService.send_subscription_expiring_soon_notice(user, days_left=1)
                        logger.info(f"📧 1-day reminder sent to {user.email}")
                        sent_count += 1
                    except Exception as e:
                        logger.error(f"⚠️ Failed to send 1-day reminder to {user.email}: {e}")
                        
            except ImportError:
                logger.warning("⚠️ NotificationService not available, skipping reminders")
            
            logger.info(f"✅ Sent {sent_count} expiration reminders")
            return sent_count
            
        except Exception as e:
            logger.error(f"❌ Error sending expiration reminders: {str(e)}")
            return 0
