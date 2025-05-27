"""
Scheduler module for background tasks in WellcomeAI application.
Contains background tasks for checking subscription expirations and other recurring tasks.
"""

import asyncio
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from backend.db.session import SessionLocal
from backend.models.user import User
from backend.core.logging import get_logger

logger = get_logger(__name__)

async def check_expired_subscriptions():
    """
    Background task to check and update expired subscription statuses
    """
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)  # Используем UTC для согласованности
        
        # Find users with expired subscriptions
        # В SQL запросе нельзя учесть таймзоны, поэтому обработаем их после
        expired_users = db.query(User).filter(
            and_(
                User.subscription_end_date.isnot(None),
                or_(User.is_trial == True, User.subscription_plan_id.isnot(None))
            )
        ).all()
        
        # Фильтруем пользователей, чьи подписки истекли, с учетом таймзон
        actual_expired = []
        for user in expired_users:
            if user.subscription_end_date:
                # Приводим дату окончания к UTC, если у нее нет таймзоны
                end_date = user.subscription_end_date
                if end_date.tzinfo is None:
                    end_date = end_date.replace(tzinfo=timezone.utc)
                
                if end_date <= now:
                    actual_expired.append(user)
        
        for user in actual_expired:
            # Log the expiration event
            from backend.services.subscription_service import SubscriptionService
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=str(user.id),
                action="expire",
                plan_id=str(user.subscription_plan_id) if user.subscription_plan_id else None,
                details=f"Subscription expired on {now.strftime('%Y-%m-%d %H:%M:%S')}"
            )
            
            # Reset subscription status
            user.is_trial = False
            user.subscription_end_date = None
            
            # Send notification about expiration
            from backend.services.notification_service import NotificationService
            await NotificationService.send_subscription_expired_notice(user)
            
            logger.info(f"Subscription expired for user {user.id}, email: {user.email}")
            
        db.commit()
        logger.info(f"Updated {len(actual_expired)} expired subscriptions")
        
        # Check for subscriptions that are about to expire and send notifications
        from backend.services.notification_service import NotificationService
        await NotificationService.check_subscription_expirations(db)
        
    except Exception as e:
        db.rollback()
        logger.error(f"Error during subscription check: {str(e)}")
    finally:
        db.close()

async def start_subscription_checker():
    """
    Start the subscription checker background task
    """
    while True:
        try:
            await check_expired_subscriptions()
        except Exception as e:
            logger.error(f"Unhandled error in subscription checker: {str(e)}")
        
        # Check every hour
        await asyncio.sleep(3600)  # 3600 seconds = 1 hour
