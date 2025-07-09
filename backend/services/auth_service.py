"""
Authentication service for WellcomeAI application.
Handles user authentication operations with partner referral system.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
import re

from backend.core.logging import get_logger
from backend.core.security import hash_password, verify_password, create_jwt_token as create_access_token
from backend.models.user import User
from backend.schemas.auth import LoginRequest, RegisterRequest

logger = get_logger(__name__)

class AuthService:
    """Service for authentication operations with partner referral integration"""
    
    @staticmethod
    async def register(db: Session, user_data: RegisterRequest) -> Dict[str, Any]:
        """
        Register a new user with optional referral tracking
        
        Args:
            db: Database session
            user_data: User registration data with optional referral_code and utm_data
            
        Returns:
            Dictionary with user data, access token, and referral info
        """
        try:
            logger.info(f"🚀 Starting registration for email: {user_data.email}")
            
            # Check if user already exists
            existing_user = db.query(User).filter(User.email == user_data.email).first()
            if existing_user:
                logger.warning(f"❌ Registration attempt with existing email: {user_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already registered"
                )
            
            # Validate email format (additional check)
            email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
            if not re.match(email_pattern, user_data.email):
                logger.warning(f"❌ Invalid email format: {user_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid email format"
                )
            
            # Hash password
            password_hash = hash_password(user_data.password)
            logger.info(f"✅ Password hashed for user: {user_data.email}")
            
            # Create new user
            user = User(
                email=user_data.email,
                password_hash=password_hash,
                first_name=user_data.first_name,
                last_name=user_data.last_name,
                company_name=user_data.company_name,
                subscription_plan="free",
                is_active=True,
                is_trial=True
            )
            
            db.add(user)
            db.commit()
            db.refresh(user)
            
            logger.info(f"✅ New user created with ID: {user.id}")
            
            # 🆕 ОБРАБОТКА РЕФЕРАЛЬНОЙ ССЫЛКИ
            referral_processed = False
            referrer_info = None
            partner_bonus_info = None
            
            if user_data.referral_code:
                try:
                    logger.info(f"🔗 Processing referral code: {user_data.referral_code}")
                    
                    # Импортируем здесь чтобы избежать циклических импортов
                    from backend.services.partner_service import PartnerService
                    
                    # Обрабатываем реферальную регистрацию
                    referral_result = await PartnerService.process_referral_registration(
                        db=db,
                        new_user_id=str(user.id),
                        referral_code=user_data.referral_code,
                        utm_data=user_data.utm_data
                    )
                    
                    if referral_result["success"]:
                        referral_processed = True
                        referrer_info = referral_result["referrer_info"]
                        partner_bonus_info = {
                            "message": "🎉 Вы зарегистрировались по партнерской ссылке!",
                            "referral_code": user_data.referral_code,
                            "partner_name": referrer_info.get("name", "Партнер"),
                            "commission_rate": referral_result.get("commission_rate", 30.0)
                        }
                        
                        logger.info(f"✅ Referral processed successfully for user {user.email}")
                        logger.info(f"   Partner: {referrer_info.get('email', 'Unknown')}")
                        logger.info(f"   UTM data: {user_data.utm_data}")
                    else:
                        logger.warning(f"❌ Failed to process referral code: {user_data.referral_code}")
                        logger.warning(f"   Reason: {referral_result.get('message', 'Unknown error')}")
                        
                except Exception as ref_error:
                    logger.error(f"❌ Error processing referral: {str(ref_error)}")
                    # Не прерываем регистрацию из-за ошибки реферальной системы
                    # Продолжаем обычную регистрацию
            
            # Activate trial subscription (3 days)
            try:
                from backend.services.subscription_service import SubscriptionService
                await SubscriptionService.activate_trial(db, str(user.id), trial_days=3)
                logger.info(f"✅ Trial subscription activated for user: {user.email}")
            except Exception as sub_error:
                logger.error(f"❌ Error activating trial subscription: {str(sub_error)}")
                # Не прерываем регистрацию, но логируем ошибку
            
            # Generate access token - ИСПРАВЛЕНО
            token = create_access_token(str(user.id))
            logger.info(f"✅ Access token generated for user: {user.email}")
            
            # Prepare base response
            response = {
                "success": True,
                "message": "Registration successful",
                "token": token,
                "token_type": "bearer",
                "user": {
                    "id": str(user.id),
                    "email": user.email,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "company_name": user.company_name,
                    "subscription_plan": user.subscription_plan,
                    "is_trial": user.is_trial,
                    "created_at": user.created_at
                }
            }
            
            # 🎉 Добавляем информацию о партнерской программе если есть
            if partner_bonus_info:
                response["referral_info"] = partner_bonus_info
                response["message"] = "Регистрация завершена! Вы были приглашены партнером."
                
                # Дополнительная информация для фронтенда
                response["partner_program"] = {
                    "is_referred": True,
                    "show_welcome_bonus": True,
                    "referrer_gets_commission": True,
                    "commission_rate": partner_bonus_info["commission_rate"]
                }
            else:
                # Предлагаем стать партнером
                response["partner_program"] = {
                    "is_referred": False,
                    "can_become_partner": True,
                    "commission_rate": 30.0,
                    "message": "Хотите зарабатывать, приглашая друзей? Станьте партнером!"
                }
            
            logger.info(f"🎯 Registration completed successfully for: {user.email}")
            logger.info(f"   Referral processed: {referral_processed}")
            logger.info(f"   Trial activated: Trial subscription")
            
            return response
            
        except IntegrityError as e:
            db.rollback()
            logger.error(f"❌ Database integrity error during registration: {str(e)}")
            
            # Определяем тип ошибки
            if "duplicate key" in str(e).lower() and "email" in str(e).lower():
                detail = "Email already registered"
            else:
                detail = "Registration failed due to database constraint"
                
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail
            )
        except HTTPException:
            # Перебрасываем HTTP исключения без изменений
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Unexpected error during registration: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Registration failed due to server error"
            )
    
    @staticmethod
    async def login(db: Session, login_data: LoginRequest) -> Dict[str, Any]:
        """
        Authenticate a user and generate a token
        
        Args:
            db: Database session
            login_data: User login credentials
            
        Returns:
            Dictionary with user data and access token
        """
        try:
            logger.info(f"🔐 Login attempt for email: {login_data.email}")
            
            # Find user by email
            user = db.query(User).filter(User.email == login_data.email).first()
            if not user:
                logger.warning(f"❌ Login failed - user not found: {login_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid email or password"
                )
            
            # Check if user is active
            if not user.is_active:
                logger.warning(f"❌ Login failed - user inactive: {login_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Account is inactive"
                )
            
            # Verify password
            if not verify_password(login_data.password, user.password_hash):
                logger.warning(f"❌ Login failed - invalid password: {login_data.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid email or password"
                )
            
            # Update last login timestamp
            user.last_login = datetime.now(timezone.utc)
            db.commit()
            
            # Generate access token - ИСПРАВЛЕНО
            token = create_access_token(str(user.id))
            
            logger.info(f"✅ Login successful for user: {login_data.email}")
            
            # Check subscription status
            from backend.services.user_service import UserService
            subscription_status = await UserService.check_subscription_status(db, str(user.id))
            
            # Check if user is a partner
            partner_info = None
            try:
                from backend.models.partner import Partner
                partner = db.query(Partner).filter(Partner.user_id == user.id).first()
                if partner:
                    partner_info = {
                        "is_partner": True,
                        "referral_code": partner.referral_code,
                        "total_referrals": partner.total_referrals,
                        "total_earnings": float(partner.total_earnings)
                    }
            except Exception as partner_error:
                logger.error(f"❌ Error getting partner info: {str(partner_error)}")
                partner_info = {"is_partner": False}
            
            return {
                "success": True,
                "message": "Login successful",
                "token": token,
                "token_type": "bearer",
                "user": {
                    "id": str(user.id),
                    "email": user.email,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "company_name": user.company_name,
                    "subscription_plan": user.subscription_plan,
                    "is_trial": user.is_trial,
                    "is_admin": user.is_admin,
                    "last_login": user.last_login,
                    "subscription_status": subscription_status,
                    "partner_info": partner_info
                }
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Unexpected error during login: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Login failed due to server error"
            )
    
    @staticmethod
    async def change_password(
        db: Session, 
        user_id: str, 
        current_password: str, 
        new_password: str
    ) -> bool:
        """
        Change user password
        
        Args:
            db: Database session
            user_id: User ID
            current_password: Current password
            new_password: New password
            
        Returns:
            True if password changed successfully
        """
        try:
            logger.info(f"🔑 Password change request for user: {user_id}")
            
            # Get user
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.warning(f"❌ Password change failed - user not found: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Verify current password
            if not verify_password(current_password, user.password_hash):
                logger.warning(f"❌ Password change failed - invalid current password: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Current password is incorrect"
                )
            
            # Hash new password
            new_password_hash = hash_password(new_password)
            
            # Update password
            user.password_hash = new_password_hash
            user.updated_at = datetime.now(timezone.utc)
            db.commit()
            
            logger.info(f"✅ Password changed successfully for user: {user_id}")
            return True
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error changing password: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to change password"
            )
    
    @staticmethod
    async def reset_password_request(db: Session, email: str) -> bool:
        """
        Request password reset (placeholder for future implementation)
        
        Args:
            db: Database session
            email: User email
            
        Returns:
            True if request processed
        """
        logger.info(f"📧 Password reset requested for email: {email}")
        
        # TODO: Implement password reset functionality
        # 1. Generate reset token
        # 2. Send email with reset link
        # 3. Store reset token in database
        
        return True
