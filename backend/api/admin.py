"""
Admin API endpoints for WellcomeAI application.
✅ v2.0: Добавлена поддержка Gemini и Grok ассистентов
✅ v2.1: Добавлена статистика доходов и звонков
✅ v2.2: Исправлен эндпоинт смены тарифа (Body вместо Query)
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session
from sqlalchemy import func as sql_func
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import uuid
from datetime import datetime, timedelta, timezone
from calendar import monthrange

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_admin_access
from backend.db.session import get_db
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.grok_assistant import GrokAssistantConfig
from backend.models.conversation import Conversation
from backend.models.subscription import PaymentTransaction
from backend.services.user_service import UserService
from backend.services.subscription_service import SubscriptionService

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()


# ✅ v2.2: Pydantic модель для обновления подписки
class SubscriptionUpdateRequest(BaseModel):
    """Модель запроса на обновление подписки"""
    plan_code: str
    duration_days: int = 30
    is_trial: bool = False


@router.get("/users", response_model=List[Dict[str, Any]])
async def get_all_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    search: Optional[str] = None,
    subscription_status: Optional[str] = None,
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Get all users with pagination and filtering options.
    Admin only endpoint.
    
    ✅ v2.0: Теперь подсчитывает все типы ассистентов (OpenAI + Gemini + Grok)
    """
    try:
        query = db.query(User)
        
        # Apply search filter
        if search:
            search_term = f"%{search}%"
            query = query.filter(
                (User.email.ilike(search_term)) |
                (User.first_name.ilike(search_term)) |
                (User.last_name.ilike(search_term)) |
                (User.company_name.ilike(search_term))
            )
        
        # Apply subscription status filter
        if subscription_status:
            now = datetime.now(timezone.utc)
            if subscription_status == "active":
                query = query.filter(User.subscription_end_date > now)
            elif subscription_status == "expired":
                query = query.filter(
                    (User.subscription_end_date < now) | 
                    (User.subscription_end_date.is_(None))
                )
            elif subscription_status == "trial":
                query = query.filter(User.is_trial.is_(True))
        
        # Get total count before pagination
        total_count = query.count()
                
        # Apply pagination
        users = query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()
        
        # Prepare result with subscription info
        result = []
        for user in users:
            # ✅ v2.0: Подсчёт всех типов ассистентов
            openai_count = db.query(AssistantConfig).filter(
                AssistantConfig.user_id == user.id
            ).count()
            
            gemini_count = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.user_id == user.id
            ).count()
            
            grok_count = db.query(GrokAssistantConfig).filter(
                GrokAssistantConfig.user_id == user.id
            ).count()
            
            total_assistants = openai_count + gemini_count + grok_count
            
            # Check subscription status
            subscription_status_info = await UserService.check_subscription_status(db, str(user.id))
            
            # Format user data
            user_data = {
                "id": str(user.id),
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "company_name": user.company_name,
                "created_at": user.created_at,
                "last_login": user.last_login,
                "is_active": user.is_active,
                "is_admin": user.is_admin,
                "is_trial": user.is_trial,
                "subscription_plan": user.subscription_plan,
                "subscription_start_date": user.subscription_start_date,
                "subscription_end_date": user.subscription_end_date,
                "subscription_active": subscription_status_info["active"],
                "days_left": subscription_status_info.get("days_left", 0),
                # ✅ v2.0: Детализация по типам ассистентов
                "assistant_count": total_assistants,
                "openai_assistants": openai_count,
                "gemini_assistants": gemini_count,
                "grok_assistants": grok_count
            }
            
            result.append(user_data)
        
        return result
    except Exception as e:
        logger.error(f"Error in get_all_users: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve users"
        )


@router.get("/users/{user_id}", response_model=Dict[str, Any])
async def get_user_details(
    user_id: str = Path(..., description="User ID"),
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Get detailed information about a specific user.
    Admin only endpoint.
    
    ✅ v2.0: Теперь возвращает все типы ассистентов (OpenAI + Gemini + Grok)
    """
    try:
        # Get user with validation
        user = await UserService.get_user_by_id(db, user_id)
        
        # Get subscription details
        subscription_status = await UserService.check_subscription_status(db, user_id)
        
        # ✅ v2.0: Получаем ВСЕ типы ассистентов
        
        # OpenAI ассистенты
        openai_assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == user.id
        ).all()
        
        openai_data = []
        for assistant in openai_assistants:
            openai_data.append({
                "id": str(assistant.id),
                "name": assistant.name,
                "description": assistant.description,
                "type": "openai",
                "voice": assistant.voice,
                "created_at": assistant.created_at,
                "total_conversations": assistant.total_conversations
            })
        
        # Gemini ассистенты
        gemini_assistants = db.query(GeminiAssistantConfig).filter(
            GeminiAssistantConfig.user_id == user.id
        ).all()
        
        gemini_data = []
        for assistant in gemini_assistants:
            gemini_data.append({
                "id": str(assistant.id),
                "name": assistant.name,
                "description": assistant.description,
                "type": "gemini",
                "voice": assistant.voice,
                "created_at": assistant.created_at,
                "total_conversations": assistant.total_conversations
            })
        
        # Grok ассистенты
        grok_assistants = db.query(GrokAssistantConfig).filter(
            GrokAssistantConfig.user_id == user.id
        ).all()
        
        grok_data = []
        for assistant in grok_assistants:
            grok_data.append({
                "id": str(assistant.id),
                "name": assistant.name,
                "description": assistant.description,
                "type": "grok",
                "voice": assistant.voice,
                "created_at": assistant.created_at,
                "total_conversations": assistant.total_conversations
            })
        
        # Объединяем все ассистенты
        all_assistants = openai_data + gemini_data + grok_data
        # Сортируем по дате создания (новые первыми)
        all_assistants.sort(key=lambda x: x["created_at"] or datetime.min, reverse=True)
        
        # Subscription logs
        from backend.models.subscription import SubscriptionLog
        logs = db.query(SubscriptionLog).filter(
            SubscriptionLog.user_id == user.id
        ).order_by(SubscriptionLog.created_at.desc()).limit(20).all()
        
        subscription_logs = []
        for log in logs:
            subscription_logs.append({
                "id": str(log.id),
                "action": log.action,
                "plan_code": log.plan_code,
                "details": log.details,
                "created_at": log.created_at
            })
        
        # Return combined user details
        return {
            "user": {
                "id": str(user.id),
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "company_name": user.company_name,
                "created_at": user.created_at,
                "last_login": user.last_login,
                "is_active": user.is_active,
                "is_admin": user.is_admin,
                "is_trial": user.is_trial,
                "usage_tokens": user.usage_tokens,
                "subscription_plan": user.subscription_plan
            },
            "subscription": {
                "plan": user.subscription_plan,
                "plan_id": str(user.subscription_plan_id) if user.subscription_plan_id else None,
                "start_date": user.subscription_start_date,
                "end_date": user.subscription_end_date,
                "is_active": subscription_status["active"],
                "max_assistants": subscription_status.get("max_assistants", 1),
                "days_left": subscription_status.get("days_left", 0)
            },
            "assistants": {
                "count": len(all_assistants),
                "openai_count": len(openai_data),
                "gemini_count": len(gemini_data),
                "grok_count": len(grok_data),
                "list": all_assistants
            },
            "subscription_logs": subscription_logs
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_user_details: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve user details"
        )


@router.post("/users/{user_id}/subscription", response_model=Dict[str, Any])
async def update_user_subscription(
    user_id: str = Path(..., description="User ID"),
    request: SubscriptionUpdateRequest = ...,  # ✅ v2.2: Body вместо Query
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Update subscription for a specific user.
    Admin only endpoint.
    
    ✅ v2.2: Исправлено - теперь принимает JSON body вместо query параметров
    """
    try:
        # Get user with validation
        user = await UserService.get_user_by_id(db, user_id)
        
        # Find subscription plan
        from backend.models.subscription import SubscriptionPlan
        plan = db.query(SubscriptionPlan).filter(
            SubscriptionPlan.code == request.plan_code
        ).first()
        
        if not plan:
            # Create default plan if not found
            plan = SubscriptionPlan(
                code=request.plan_code,
                name=request.plan_code.capitalize(),
                price=0 if request.plan_code == "free" else (1490 if request.plan_code == "start" else 4990),
                max_assistants=1 if request.plan_code == "free" else (3 if request.plan_code == "start" else 10),
                description=f"{request.plan_code.capitalize()} subscription plan",
                is_active=True
            )
            db.add(plan)
            db.flush()
            
        # Set start date (either now or extend from current subscription)
        now = datetime.now(timezone.utc)
        start_date = now
        
        if user.subscription_end_date and user.subscription_end_date > now:
            start_date = user.subscription_end_date
            
        # Update user subscription
        user.subscription_plan = request.plan_code  # ✅ Обновляем и текстовое поле
        user.subscription_plan_id = plan.id
        user.subscription_start_date = start_date
        user.subscription_end_date = start_date + timedelta(days=request.duration_days)
        user.is_trial = request.is_trial
        
        db.commit()
        
        # Log subscription event
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(user.id),
            action="admin_update",
            plan_id=str(plan.id),
            plan_code=request.plan_code,
            details=f"Admin {current_user.email} updated subscription to {request.plan_code} for {request.duration_days} days until {user.subscription_end_date.strftime('%Y-%m-%d')}"
        )
        
        # Return updated subscription info
        subscription_status = await UserService.check_subscription_status(db, user_id)
        
        return {
            "success": True,
            "message": f"Subscription updated for user {user.email}",
            "subscription": {
                "plan": request.plan_code,
                "plan_id": str(plan.id),
                "start_date": user.subscription_start_date,
                "end_date": user.subscription_end_date,
                "is_trial": user.is_trial,
                "is_active": subscription_status["active"],
                "days_left": subscription_status.get("days_left", 0)
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error in update_user_subscription: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user subscription: {str(e)}"
        )


@router.get("/stats", response_model=Dict[str, Any])
async def get_admin_statistics(
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Get system-wide statistics for admin dashboard.
    Admin only endpoint.
    
    ✅ v2.0: Добавлена статистика по всем типам ассистентов
    ✅ v2.1: Добавлена статистика доходов и звонков
    """
    try:
        now = datetime.now(timezone.utc)
        
        # ========== ПОЛЬЗОВАТЕЛИ ==========
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.is_active.is_(True)).count()
        
        users_with_active_subscription = db.query(User).filter(
            User.subscription_end_date > now
        ).count()
        
        trial_users = db.query(User).filter(User.is_trial.is_(True)).count()
        
        # Недавние пользователи
        recent_users = db.query(User).order_by(
            User.created_at.desc()
        ).limit(5).all()
        
        recent_user_data = []
        for user in recent_users:
            recent_user_data.append({
                "id": str(user.id),
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "created_at": user.created_at,
                "is_trial": user.is_trial
            })
        
        # ========== АССИСТЕНТЫ (все типы) ==========
        openai_assistants = db.query(AssistantConfig).count()
        gemini_assistants = db.query(GeminiAssistantConfig).count()
        grok_assistants = db.query(GrokAssistantConfig).count()
        total_assistants = openai_assistants + gemini_assistants + grok_assistants
        
        # Статистика ассистентов по пользователям
        # OpenAI
        openai_stats = db.query(
            AssistantConfig.user_id,
            sql_func.count(AssistantConfig.id).label("count")
        ).group_by(AssistantConfig.user_id).all()
        
        # Gemini
        gemini_stats = db.query(
            GeminiAssistantConfig.user_id,
            sql_func.count(GeminiAssistantConfig.id).label("count")
        ).group_by(GeminiAssistantConfig.user_id).all()
        
        # Grok
        grok_stats = db.query(
            GrokAssistantConfig.user_id,
            sql_func.count(GrokAssistantConfig.id).label("count")
        ).group_by(GrokAssistantConfig.user_id).all()
        
        # Максимум ассистентов у одного пользователя
        user_assistant_counts = {}
        for stat in openai_stats:
            user_assistant_counts[str(stat[0])] = user_assistant_counts.get(str(stat[0]), 0) + stat[1]
        for stat in gemini_stats:
            user_assistant_counts[str(stat[0])] = user_assistant_counts.get(str(stat[0]), 0) + stat[1]
        for stat in grok_stats:
            user_assistant_counts[str(stat[0])] = user_assistant_counts.get(str(stat[0]), 0) + stat[1]
        
        max_assistants = max(user_assistant_counts.values()) if user_assistant_counts else 0
        avg_assistants = total_assistants / total_users if total_users > 0 else 0
        
        # ========== ДОХОДЫ ==========
        # Начало текущего месяца
        current_month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        
        # Начало прошлого месяца
        if now.month == 1:
            prev_month_start = now.replace(year=now.year - 1, month=12, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            prev_month_start = now.replace(month=now.month - 1, day=1, hour=0, minute=0, second=0, microsecond=0)
        
        # Доход за текущий месяц (только успешные платежи)
        current_month_revenue = db.query(
            sql_func.coalesce(sql_func.sum(PaymentTransaction.amount), 0)
        ).filter(
            PaymentTransaction.status == "success",
            PaymentTransaction.paid_at >= current_month_start
        ).scalar() or 0
        
        # Доход за прошлый месяц
        prev_month_revenue = db.query(
            sql_func.coalesce(sql_func.sum(PaymentTransaction.amount), 0)
        ).filter(
            PaymentTransaction.status == "success",
            PaymentTransaction.paid_at >= prev_month_start,
            PaymentTransaction.paid_at < current_month_start
        ).scalar() or 0
        
        # Общий доход за всё время
        total_revenue = db.query(
            sql_func.coalesce(sql_func.sum(PaymentTransaction.amount), 0)
        ).filter(
            PaymentTransaction.status == "success"
        ).scalar() or 0
        
        # Количество успешных платежей
        total_payments = db.query(PaymentTransaction).filter(
            PaymentTransaction.status == "success"
        ).count()
        
        # ========== СТАТИСТИКА ЗВОНКОВ ==========
        # Входящие звонки
        inbound_calls = db.query(Conversation).filter(
            Conversation.call_direction == "inbound"
        ).count()
        
        # Исходящие звонки
        outbound_calls = db.query(Conversation).filter(
            Conversation.call_direction == "outbound"
        ).count()
        
        # Общая длительность звонков (в секундах)
        total_call_duration = db.query(
            sql_func.coalesce(sql_func.sum(Conversation.duration_seconds), 0)
        ).filter(
            Conversation.duration_seconds.isnot(None)
        ).scalar() or 0
        
        # Общая стоимость звонков
        total_call_cost = db.query(
            sql_func.coalesce(sql_func.sum(Conversation.call_cost), 0)
        ).filter(
            Conversation.call_cost.isnot(None)
        ).scalar() or 0
        
        # Звонки за текущий месяц
        calls_this_month = db.query(Conversation).filter(
            Conversation.created_at >= current_month_start,
            Conversation.call_direction.isnot(None)
        ).count()
        
        # Стоимость звонков за текущий месяц
        call_cost_this_month = db.query(
            sql_func.coalesce(sql_func.sum(Conversation.call_cost), 0)
        ).filter(
            Conversation.created_at >= current_month_start,
            Conversation.call_cost.isnot(None)
        ).scalar() or 0
        
        return {
            "users": {
                "total": total_users,
                "active": active_users,
                "with_subscription": users_with_active_subscription,
                "trial": trial_users,
                "recent": recent_user_data
            },
            "assistants": {
                "total": total_assistants,
                "openai": openai_assistants,
                "gemini": gemini_assistants,
                "grok": grok_assistants,
                "max_per_user": max_assistants,
                "avg_per_user": round(avg_assistants, 2)
            },
            # ✅ v2.1: Статистика доходов
            "revenue": {
                "current_month": float(current_month_revenue),
                "previous_month": float(prev_month_revenue),
                "total": float(total_revenue),
                "total_payments": total_payments,
                "currency": "RUB"
            },
            # ✅ v2.1: Статистика звонков
            "calls": {
                "inbound": inbound_calls,
                "outbound": outbound_calls,
                "total": inbound_calls + outbound_calls,
                "this_month": calls_this_month,
                "total_duration_seconds": float(total_call_duration),
                "total_duration_minutes": round(float(total_call_duration) / 60, 1),
                "total_cost": float(total_call_cost),
                "cost_this_month": float(call_cost_this_month)
            },
            "timestamp": now
        }
    except Exception as e:
        logger.error(f"Error in get_admin_statistics: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve admin statistics"
        )
