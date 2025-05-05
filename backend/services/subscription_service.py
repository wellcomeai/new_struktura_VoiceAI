"""
Subscription service for WellcomeAI application.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from datetime import datetime, timedelta

from backend.core.logging import get_logger
from backend.models.subscription import SubscriptionPlan
from backend.models.user import User
from backend.schemas.subscription import SubscriptionPlanCreate, SubscriptionPlanUpdate

logger = get_logger(__name__)

class SubscriptionService:
    """Service for subscription operations"""
    
    @staticmethod
    async def get_subscription_plans(db: Session, include_inactive: bool = False) -> List[SubscriptionPlan]:
        """
        Get all subscription plans
        
        Args:
            db: Database session
            include_inactive: Whether to include inactive plans
            
        Returns:
            List of subscription plans
        """
        query = db.query(SubscriptionPlan)
        
        if not include_inactive:
            query = query.filter(SubscriptionPlan.is_active.is_(True))
            
        return query.all()
    
    @staticmethod
    async def get_subscription_plan_by_id(db: Session, plan_id: str) -> SubscriptionPlan:
        """
        Get subscription plan by ID
        
        Args:
            db: Database session
            plan_id: Plan ID
            
        Returns:
            Subscription plan
        """
        plan = db.query(SubscriptionPlan).get(plan_id)
        
        if not plan:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Subscription plan not found"
            )
            
        return plan
    
    @staticmethod
    async def get_subscription_plan_by_code(db: Session, plan_code: str) -> SubscriptionPlan:
        """
        Get subscription plan by code
        
        Args:
            db: Database session
            plan_code: Plan code
            
        Returns:
            Subscription plan
        """
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
        
        if not plan:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Subscription plan with code {plan_code} not found"
            )
            
        return plan
    
    @staticmethod
    async def create_subscription_plan(db: Session, plan_data: SubscriptionPlanCreate) -> SubscriptionPlan:
        """
        Create a new subscription plan
        
        Args:
            db: Database session
            plan_data: Plan creation data
            
        Returns:
            Created subscription plan
        """
        try:
            # Check if a plan with this code already exists
            existing_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_data.code).first()
            if existing_plan:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Subscription plan with code {plan_data.code} already exists"
                )
            
            # Create plan
            plan = SubscriptionPlan(**plan_data.dict())
            db.add(plan)
            db.commit()
            db.refresh(plan)
            
            logger.info(f"Created subscription plan: {plan.id}, code: {plan.code}")
            return plan
            
        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during plan creation: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Subscription plan creation failed due to database constraint"
            )
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during plan creation: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Subscription plan creation failed due to server error"
            )
    
    @staticmethod
    async def update_subscription_plan(
        db: Session, 
        plan_id: str, 
        plan_data: SubscriptionPlanUpdate
    ) -> SubscriptionPlan:
        """
        Update subscription plan
        
        Args:
            db: Database session
            plan_id: Plan ID
            plan_data: Plan update data
            
        Returns:
            Updated subscription plan
        """
        try:
            plan = await SubscriptionService.get_subscription_plan_by_id(db, plan_id)
            
            # Update only provided fields
            update_data = plan_data.dict(exclude_unset=True)
            for key, value in update_data.items():
                setattr(plan, key, value)
            
            db.commit()
            db.refresh(plan)
            
            logger.info(f"Updated subscription plan: {plan.id}")
            return plan
            
        except IntegrityError as e:
            db.rollback()
            logger.error(f"Database integrity error during plan update: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Subscription plan update failed due to database constraint"
            )
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Unexpected error during plan update: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Subscription plan update failed due to server error"
            )
    
    @staticmethod
    async def delete_subscription_plan(db: Session, plan_id: str) -> bool:
        """
        Delete subscription plan
        
        Args:
            db: Database session
            plan_id: Plan ID
            
        Returns:
            True if deletion was successful
        """
        try:
            plan = await SubscriptionService.get_subscription_plan_by_id(db, plan_id)
            
            # Check if any users are using this plan
            users_with_plan = db.query(User).filter(User.subscription_plan_id == plan.id).count()
            if users_with_plan > 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot delete plan with active users. Deactivate it instead."
                )
            
            db.delete(plan)
            db.commit()
            
            logger.info(f"Deleted subscription plan: {plan_id}")
            return True
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting subscription plan: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete subscription plan"
            )
    
    @staticmethod
    async def activate_trial(db: Session, user_id: str, trial_days: int = 3) -> User:
        """
        Activate trial period for user
        
        Args:
            db: Database session
            user_id: User ID
            trial_days: Trial period duration in days
            
        Returns:
            Updated user object
        """
        from backend.services.user_service import UserService
        
        try:
            user = await UserService.get_user_by_id(db, user_id)
            
            # Get trial plan
            trial_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == "free").first()
            if not trial_plan:
                logger.warning("Trial plan (code='free') not found, setting no plan for trial")
            
            # Set trial period
            now = datetime.now()
            user.is_trial = True
            user.subscription_start_date = now
            user.subscription_end_date = now + timedelta(days=trial_days)
            
            if trial_plan:
                user.subscription_plan_id = trial_plan.id
            
            db.commit()
            db.refresh(user)
            
            logger.info(f"Activated trial for user {user_id} until {user.subscription_end_date}")
            return user
            
        except Exception as e:
            db.rollback()
            logger.error(f"Error activating trial: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to activate trial"
            )
