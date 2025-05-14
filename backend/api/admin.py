"""
Admin API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
import uuid
from datetime import datetime, timedelta, timezone

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_admin_access
from backend.db.session import get_db
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.services.user_service import UserService
from backend.services.subscription_service import SubscriptionService

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

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
    
    Args:
        skip: Number of users to skip
        limit: Maximum number of users to return
        search: Optional search string for email or name
        subscription_status: Filter by subscription status (active, expired, trial)
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        List of users with subscription info
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
            now = datetime.now(timezone.utc)  # Используем UTC для согласованности
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
            # Get assistant count
            assistant_count = db.query(AssistantConfig).filter(
                AssistantConfig.user_id == user.id
            ).count()
            
            # Check subscription status
            subscription_status = await UserService.check_subscription_status(db, str(user.id))
            
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
                "subscription_active": subscription_status["active"],
                "days_left": subscription_status.get("days_left", 0),
                "assistant_count": assistant_count
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
    
    Args:
        user_id: User ID
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        Detailed user information
    """
    try:
        # Get user with validation
        user = await UserService.get_user_by_id(db, user_id)
        
        # Get subscription details
        subscription_status = await UserService.check_subscription_status(db, user_id)
        
        # Get assistants for this user
        assistants = db.query(AssistantConfig).filter(
            AssistantConfig.user_id == user.id
        ).all()
        
        assistant_data = []
        for assistant in assistants:
            assistant_data.append({
                "id": str(assistant.id),
                "name": assistant.name,
                "description": assistant.description,
                "created_at": assistant.created_at,
                "total_conversations": assistant.total_conversations
            })
        
        # Get subscription logs
        from backend.models.subscription_log import SubscriptionLog
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
                "usage_tokens": user.usage_tokens
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
                "count": len(assistant_data),
                "list": assistant_data
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
    plan_code: str = Query(..., description="Subscription plan code"),
    duration_days: int = Query(30, ge=1, le=365, description="Duration in days"),
    is_trial: bool = Query(False, description="Whether this is a trial subscription"),
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Update subscription for a specific user.
    Admin only endpoint.
    
    Args:
        user_id: User ID
        plan_code: Subscription plan code
        duration_days: Duration of subscription in days
        is_trial: Whether this is a trial subscription
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        Updated user subscription information
    """
    try:
        # Get user with validation
        user = await UserService.get_user_by_id(db, user_id)
        
        # Find subscription plan
        from backend.models.subscription import SubscriptionPlan
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
        
        if not plan:
            # Create default plan if not found
            plan = SubscriptionPlan(
                code=plan_code,
                name=plan_code.capitalize(),
                price=0 if plan_code == "free" else (19.99 if plan_code == "start" else 49.99),
                max_assistants=1 if plan_code == "free" else 3,
                description=f"{plan_code.capitalize()} subscription plan",
                is_active=True
            )
            db.add(plan)
            db.flush()
            
        # Set start date (either now or extend from current subscription)
        now = datetime.now(timezone.utc)  # Используем UTC для согласованности
        start_date = now
        
        if user.subscription_end_date and user.subscription_end_date > now:
            start_date = user.subscription_end_date
            
        # Update user subscription
        user.subscription_plan_id = plan.id
        user.subscription_start_date = start_date
        user.subscription_end_date = start_date + timedelta(days=duration_days)
        user.is_trial = is_trial
        
        db.commit()
        
        # Log subscription change
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(user.id),
            action="admin_update",
            plan_id=str(plan.id),
            plan_code=plan_code,
            details=f"Admin {current_user.email} updated subscription to {plan_code} for {duration_days} days until {user.subscription_end_date.strftime('%Y-%m-%d')}"
        )
        
        # Return updated subscription info
        subscription_status = await UserService.check_subscription_status(db, user_id)
        
        return {
            "success": True,
            "message": f"Subscription updated for user {user.email}",
            "subscription": {
                "plan": plan_code,
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
            detail="Failed to update user subscription"
        )

@router.get("/stats", response_model=Dict[str, Any])
async def get_admin_statistics(
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Get system-wide statistics for admin dashboard.
    Admin only endpoint.
    
    Args:
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        System statistics
    """
    try:
        # Get user counts
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.is_active.is_(True)).count()
        
        now = datetime.now(timezone.utc)  # Используем UTC для согласованности
        users_with_active_subscription = db.query(User).filter(
            User.subscription_end_date > now
        ).count()
        
        trial_users = db.query(User).filter(User.is_trial.is_(True)).count()
        
        # Get assistant counts
        total_assistants = db.query(AssistantConfig).count()
        
        # Get recent users
        recent_users = db.query(User).order_by(
            User.created_at.desc()
        ).limit(5).all()
        
        recent_user_data = []
        for user in recent_users:
            recent_user_data.append({
                "id": str(user.id),
                "email": user.email,
                "created_at": user.created_at,
                "is_trial": user.is_trial
            })
        
        # Assistant statistics by user
        # This is a more complex query that groups by user
        from sqlalchemy import func
        assistant_stats = db.query(
            AssistantConfig.user_id,
            func.count(AssistantConfig.id).label("assistant_count")
        ).group_by(AssistantConfig.user_id).all()
        
        max_assistants = 0
        if assistant_stats:
            max_assistants = max(stat[1] for stat in assistant_stats)
        
        avg_assistants = 0
        if total_users > 0:
            avg_assistants = total_assistants / total_users
        
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
                "max_per_user": max_assistants,
                "avg_per_user": round(avg_assistants, 2)
            },
            "timestamp": datetime.now(timezone.utc)
        }
    except Exception as e:
        logger.error(f"Error in get_admin_statistics: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve admin statistics"
        )
