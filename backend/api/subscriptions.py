"""
Subscription API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user, check_admin_access
from backend.db.session import get_db
from backend.models.user import User
from backend.schemas.subscription import (
    SubscriptionPlanCreate, 
    SubscriptionPlanUpdate, 
    SubscriptionPlanResponse,
    UserSubscriptionInfo
)
from backend.services.subscription_service import SubscriptionService
from backend.services.user_service import UserService

logger = get_logger(__name__)

router = APIRouter()

@router.get("/plans", response_model=List[SubscriptionPlanResponse])
async def get_subscription_plans(
    include_inactive: bool = Query(False, description="Include inactive plans"),
    db: Session = Depends(get_db)
):
    """
    Get all subscription plans
    
    Args:
        include_inactive: Whether to include inactive plans
        db: Database session dependency
    
    Returns:
        List of subscription plans
    """
    try:
        return await SubscriptionService.get_subscription_plans(db, include_inactive)
    except Exception as e:
        logger.error(f"Unexpected error in get_subscription_plans: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve subscription plans"
        )

@router.get("/my-subscription", response_model=UserSubscriptionInfo)
async def get_user_subscription(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get current user's subscription information
    
    Args:
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        User subscription information
    """
    try:
        subscription_status = await UserService.check_subscription_status(db, str(current_user.id))
        
        # Get subscription plan if exists
        subscription_plan = None
        if current_user.subscription_plan_id:
            plan = await SubscriptionService.get_subscription_plan_by_id(db, str(current_user.subscription_plan_id))
            if plan:
                subscription_plan = SubscriptionPlanResponse.from_orm(plan)
        
        return UserSubscriptionInfo(
            subscription_plan=subscription_plan,
            subscription_start_date=current_user.subscription_start_date,
            subscription_end_date=current_user.subscription_end_date,
            is_trial=current_user.is_trial,
            days_left=subscription_status.get("days_left")
        )
    except Exception as e:
        logger.error(f"Unexpected error in get_user_subscription: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve subscription information"
        )

# Admin-only endpoints

@router.post("/plans", response_model=SubscriptionPlanResponse, status_code=status.HTTP_201_CREATED)
async def create_subscription_plan(
    plan_data: SubscriptionPlanCreate,
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Create a new subscription plan (admin only)
    
    Args:
        plan_data: Subscription plan creation data
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        Created subscription plan
    """
    try:
        return await SubscriptionService.create_subscription_plan(db, plan_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in create_subscription_plan: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create subscription plan"
        )

@router.put("/plans/{plan_id}", response_model=SubscriptionPlanResponse)
async def update_subscription_plan(
    plan_data: SubscriptionPlanUpdate,
    plan_id: str = Path(..., description="The ID of the subscription plan to update"),
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Update a subscription plan (admin only)
    
    Args:
        plan_data: Subscription plan update data
        plan_id: Plan ID
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        Updated subscription plan
    """
    try:
        return await SubscriptionService.update_subscription_plan(db, plan_id, plan_data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in update_subscription_plan: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update subscription plan"
        )

@router.delete("/plans/{plan_id}", response_model=dict)
async def delete_subscription_plan(
    plan_id: str = Path(..., description="The ID of the subscription plan to delete"),
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Delete a subscription plan (admin only)
    
    Args:
        plan_id: Plan ID
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        Confirmation message
    """
    try:
        await SubscriptionService.delete_subscription_plan(db, plan_id)
        return {"success": True, "message": "Subscription plan deleted successfully", "id": plan_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in delete_subscription_plan: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete subscription plan"
        )

@router.post("/users/{user_id}/activate-plan", response_model=UserSubscriptionInfo)
async def activate_plan_for_user(
    plan_code: str,
    duration_days: int = Query(30, description="Subscription duration in days"),
    user_id: str = Path(..., description="The ID of the user"),
    current_user: User = Depends(check_admin_access),
    db: Session = Depends(get_db)
):
    """
    Activate subscription plan for user (admin only)
    
    Args:
        plan_code: Subscription plan code
        duration_days: Subscription duration in days
        user_id: User ID
        current_user: Current authenticated admin user
        db: Database session dependency
    
    Returns:
        User subscription information
    """
    try:
        user = await UserService.set_subscription_plan(db, user_id, plan_code, duration_days)
        
        subscription_status = await UserService.check_subscription_status(db, user_id)
        
        # Get subscription plan
        subscription_plan = None
        if user.subscription_plan_id:
            plan = await SubscriptionService.get_subscription_plan_by_id(db, str(user.subscription_plan_id))
            if plan:
                subscription_plan = SubscriptionPlanResponse.from_orm(plan)
        
        return UserSubscriptionInfo(
            subscription_plan=subscription_plan,
            subscription_start_date=user.subscription_start_date,
            subscription_end_date=user.subscription_end_date,
            is_trial=user.is_trial,
            days_left=subscription_status.get("days_left")
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in activate_plan_for_user: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to activate subscription plan"
        )
