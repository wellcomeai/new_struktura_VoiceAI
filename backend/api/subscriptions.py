"""
Subscription API endpoints for WellcomeAI application.
✅ PRODUCTION v3.0: Поддержка отображения лимитов для реферальных триалов
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta, timezone
import traceback

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.subscription import SubscriptionPlan
from backend.schemas.subscription import UserSubscriptionInfo

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.get("/my-subscription", response_model=Dict[str, Any])
async def get_my_subscription(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get current user's subscription information.
    
    ✅ ОБНОВЛЕНО v3.0: Поддержка отображения лимитов для плана referral_trial
    
    Args:
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        User subscription information
    """
    try:
        # Проверяем, что у пользователя есть даты подписки
        # Если нет - возможно, стоит создать триальную подписку
        now = datetime.now(timezone.utc)  # Используем UTC для согласованности
        if not current_user.subscription_start_date or not current_user.subscription_end_date:
            try:
                # Импортируем здесь, чтобы избежать циклических импортов
                from backend.services.subscription_service import SubscriptionService
                
                # Логируем отсутствие дат подписки
                logger.warning(f"User {current_user.id} has no subscription dates, activating trial")
                
                # Активируем триальную подписку
                await SubscriptionService.activate_trial(db, str(current_user.id), trial_days=3)
                
                # Обновляем объект пользователя из БД
                db.refresh(current_user)
            except Exception as e:
                logger.error(f"Failed to activate trial: {str(e)}")
                # Если не удалось активировать триал, продолжаем с текущими данными
        
        # Check if user has subscription plan
        subscription_plan = None
        if current_user.subscription_plan_id:
            subscription_plan = db.query(SubscriptionPlan).get(current_user.subscription_plan_id)
        
        # Calculate days left
        days_left = None
        subscription_end_date = current_user.subscription_end_date
        
        if subscription_end_date:
            # Приводим обе даты к одному типу (с таймзоной)
            # Если subscription_end_date не содержит информацию о таймзоне
            if subscription_end_date.tzinfo is None:
                subscription_end_date = subscription_end_date.replace(tzinfo=timezone.utc)
            
            # Если now не содержит информацию о таймзоне
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
                
            # Проверяем, активна ли подписка и вычисляем оставшиеся дни
            if subscription_end_date > now:
                delta = subscription_end_date - now
                days_left = delta.days
            else:
                days_left = 0
        else:
            # Если дата окончания не установлена, подписка неактивна
            days_left = 0
        
        # ========================================
        # ✅ ОБНОВЛЕНО v3.0: Правильное определение max_assistants
        # ========================================
        max_assistants = 1  # Default для тестового периода
        
        # Проверка на админа
        if current_user.is_admin or current_user.email == "well96well@gmail.com":
            max_assistants = 10
            # Форсируем активность подписки для админа
            days_left = 999  # Админу не нужно беспокоиться о сроках
        elif subscription_plan:
            # Для обычных пользователей - проверяем код плана
            if subscription_plan.code == "free":
                max_assistants = 1  # 📝 Обычный тестовый период
            elif subscription_plan.code == "referral_trial":
                max_assistants = 3  # 🎁 Реферальный тестовый период
            else:
                max_assistants = 3  # 💎 Оплаченные тарифы
        
        # Get current assistants count
        current_assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == current_user.id
        ).count()
        
        # Default trial plan if no plan is set
        plan_info = {
            "code": "free",
            "name": "Free Trial",
            "price": 0,
            "max_assistants": max_assistants
        }
        
        if subscription_plan:
            plan_info = {
                "id": str(subscription_plan.id),
                "code": subscription_plan.code,
                "name": subscription_plan.name,
                "price": float(subscription_plan.price) if hasattr(subscription_plan, "price") else 0,
                "max_assistants": max_assistants,  # Используем определенный выше max_assistants
                "description": subscription_plan.description
            }
        
        # Formatted dates for UI
        formatted_start_date = None
        formatted_end_date = None
        
        if current_user.subscription_start_date:
            formatted_start_date = current_user.subscription_start_date.strftime("%Y-%m-%d")
            
        if subscription_end_date:
            formatted_end_date = subscription_end_date.strftime("%Y-%m-%d")
            
        # Return complete subscription info
        return {
            "subscription_plan": plan_info,
            "subscription_start_date": current_user.subscription_start_date,
            "subscription_end_date": subscription_end_date,  # Может быть None
            "formatted_start_date": formatted_start_date,    # Строка для UI
            "formatted_end_date": formatted_end_date,        # Строка для UI
            "is_trial": current_user.is_trial,
            "days_left": days_left,
            "active": True if days_left > 0 or current_user.is_admin or current_user.email == "well96well@gmail.com" else False,
            "current_assistants": current_assistants
        }
    except Exception as e:
        # Полная трассировка ошибки для отладки
        logger.error(f"Unexpected error in get_my_subscription: {str(e)}")
        logger.error(traceback.format_exc())
        
        # Возвращаем базовую информацию вместо ошибки
        # Это позволит фронтенду корректно отображать что-то вместо ошибки
        now = datetime.now(timezone.utc)  # Используем UTC
        trial_end = now + timedelta(days=3)
        
        return {
            "subscription_plan": {
                "code": "free",
                "name": "Free Trial (Default)",
                "price": 0,
                "max_assistants": 1,
                "description": "Default trial plan"
            },
            "subscription_start_date": now,
            "subscription_end_date": trial_end,
            "formatted_start_date": now.strftime("%Y-%m-%d"),
            "formatted_end_date": trial_end.strftime("%Y-%m-%d"),
            "is_trial": True,
            "days_left": 3,
            "active": True,
            "current_assistants": 0,
            "error": "default_fallback_data"  # Флаг для фронтенда, что это данные по умолчанию
        }

@router.get("/plans", response_model=List[Dict[str, Any]])
async def get_subscription_plans(
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get available subscription plans.
    
    Args:
        include_inactive: Whether to include inactive plans
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        List of subscription plans
    """
    try:
        # Get plans from database
        query = db.query(SubscriptionPlan)
        if not include_inactive:
            query = query.filter(SubscriptionPlan.is_active.is_(True))
            
        plans = query.all()
        
        # If no plans in database, provide defaults
        if not plans:
            return [
                {
                    "code": "free",
                    "name": "Free Trial",
                    "price": 0,
                    "max_assistants": 1,
                    "description": "Free trial plan with basic features",
                    "is_active": True
                },
                {
                    "code": "referral_trial",
                    "name": "Referral Trial",
                    "price": 0,
                    "max_assistants": 3,
                    "description": "Extended trial for referrals (5 days, 3 assistants)",
                    "is_active": True
                },
                {
                    "code": "start",
                    "name": "Start",
                    "price": 19.99,
                    "max_assistants": 3,
                    "description": "Start plan with extended features",
                    "is_active": True
                },
                {
                    "code": "pro",
                    "name": "Professional",
                    "price": 49.99,
                    "max_assistants": 10,
                    "description": "Professional plan with all features",
                    "is_active": True
                }
            ]
            
        # Format plans
        result = []
        for plan in plans:
            # Определяем max_assistants в зависимости от кода плана
            if plan.code == "free":
                max_assistants = 1
            elif plan.code == "referral_trial":
                max_assistants = 3
            else:
                max_assistants = 3
                
            result.append({
                "id": str(plan.id),
                "code": plan.code,
                "name": plan.name,
                "price": float(plan.price) if hasattr(plan, "price") else 0,
                "max_assistants": max_assistants,  # Используем определенный выше max_assistants
                "description": plan.description,
                "is_active": plan.is_active
            })
            
        return result
    except Exception as e:
        logger.error(f"Unexpected error in get_subscription_plans: {str(e)}")
        logger.error(traceback.format_exc())
        
        # Возвращаем базовые планы вместо ошибки
        return [
            {
                "code": "free",
                "name": "Free Trial (Default)",
                "price": 0,
                "max_assistants": 1,
                "description": "Free trial plan with basic features",
                "is_active": True
            },
            {
                "code": "referral_trial",
                "name": "Referral Trial (Default)",
                "price": 0,
                "max_assistants": 3,
                "description": "Extended trial for referrals",
                "is_active": True
            },
            {
                "code": "start",
                "name": "Start (Default)",
                "price": 19.99,
                "max_assistants": 3,
                "description": "Start plan with extended features",
                "is_active": True
            }
        ]

@router.post("/subscribe/{plan_code}", response_model=Dict[str, Any])
async def subscribe_to_plan(
    plan_code: str,
    duration_days: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Subscribe user to a plan.
    
    Args:
        plan_code: Plan code to subscribe to
        duration_days: Duration of subscription in days
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Updated user subscription information
    """
    try:
        # Find plan by code
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
        
        # If plan not found in database, use defaults
        if not plan:
            if plan_code == "free":
                is_trial = True
                max_assistants = 1
            elif plan_code == "referral_trial":
                is_trial = True
                max_assistants = 3
            elif plan_code == "start":
                is_trial = False
                max_assistants = 3
            elif plan_code == "pro":
                is_trial = False
                max_assistants = 10
            else:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Plan with code {plan_code} not found"
                )
                
            # Создаем план, если он не существует
            plan = SubscriptionPlan(
                code=plan_code,
                name=plan_code.capitalize(),
                price=0 if plan_code in ["free", "referral_trial"] else (19.99 if plan_code == "start" else 49.99),
                max_assistants=max_assistants,
                description=f"{plan_code.capitalize()} subscription plan",
                is_active=True
            )
            db.add(plan)
            db.flush()  # Получаем ID без коммита
        else:
            is_trial = plan_code in ["free", "referral_trial"]
        
        # Если пользователь уже имеет активную подписку, продлеваем её
        now = datetime.now(timezone.utc)  # Используем UTC для согласованности
        start_date = now
        
        # Если есть действующая подписка - продлеваем от её даты окончания
        if current_user.subscription_end_date:
            # Нормализуем дату
            end_date = current_user.subscription_end_date
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)
                
            if end_date > now:
                start_date = end_date
        
        # Update user subscription
        current_user.subscription_start_date = start_date
        current_user.subscription_end_date = start_date + timedelta(days=duration_days)
        current_user.is_trial = is_trial
        
        if plan:
            current_user.subscription_plan_id = plan.id
        
        db.commit()
        
        # Log subscription change
        from backend.services.subscription_service import SubscriptionService
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(current_user.id),
            action="subscribe",
            plan_id=str(plan.id) if plan else None,
            plan_code=plan_code,
            details=f"Subscription activated for {duration_days} days until {current_user.subscription_end_date.strftime('%Y-%m-%d')}"
        )
        
        # Get updated subscription info
        return await get_my_subscription(current_user, db)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Unexpected error in subscribe_to_plan: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to subscribe to plan"
        )

@router.post("/check-expired", response_model=Dict[str, Any])
async def check_expired_subscriptions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Manually trigger check for expired subscriptions.
    Admin only endpoint.
    
    Args:
        current_user: Current authenticated user (must be admin)
        db: Database session dependency
    
    Returns:
        Result of the check
    """
    # Проверяем, что пользователь - админ
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can perform this action"
        )
        
    try:
        # Импорт сервиса здесь для избежания циклических импортов
        from backend.services.subscription_service import SubscriptionService
        
        # Проверяем истекшие подписки
        updated_count = await SubscriptionService.check_expired_subscriptions(db)
        
        return {
            "success": True,
            "updated_count": updated_count,
            "message": f"Successfully updated {updated_count} expired subscriptions"
        }
    except Exception as e:
        logger.error(f"Error checking expired subscriptions: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error checking expired subscriptions: {str(e)}"
        )
