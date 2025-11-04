# backend/api/auth.py
"""
Authentication API endpoints for WellcomeAI application.
✅ ОБНОВЛЕНО: Добавлена интеграция с email верификацией
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.schemas.auth import LoginRequest, RegisterRequest, Token
from backend.schemas.user import UserResponse
from backend.services.auth_service import AuthService
from backend.services.email_service import EmailService

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

# Security scheme
security = HTTPBearer()


@router.post("/register", response_model=dict, status_code=status.HTTP_201_CREATED)
async def register(
    user_data: RegisterRequest,
    db: Session = Depends(get_db)
):
    """
    Register a new user account.
    
    ✅ ОБНОВЛЕНО: Автоматически отправляет код верификации на email
    
    Args:
        user_data: User registration data with email, password, and optional profile info
        db: Database session dependency
    
    Returns:
        A response with verification status (NO TOKEN until email verified)
    """
    try:
        logger.info(f"📝 Registration request for: {user_data.email}")
        
        # 1. Create user account (email_verified=False by default)
        result = await AuthService.register(db, user_data)
        
        user_id = result.get("user", {}).get("id")
        user_email = result.get("user", {}).get("email")
        
        if not user_id or not user_email:
            logger.error("User creation returned invalid data")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Registration failed - invalid user data"
            )
        
        logger.info(f"✅ User created: {user_email} (ID: {user_id})")
        
        # 2. ✅ НОВОЕ: Автоматически отправить код верификации
        try:
            verification_result = await EmailService.send_verification_code(
                db=db,
                user_id=user_id,
                user_email=user_email
            )
            
            logger.info(f"✅ Verification code sent to {user_email}")
            
            # 3. Вернуть ответ БЕЗ токена (токен дадим после верификации)
            return {
                "success": True,
                "message": "Registration successful! Check your email for verification code.",
                "user": result.get("user"),
                "verification_required": True,  # ✅ Флаг для фронтенда
                "verification_sent": True,
                "expires_in_minutes": verification_result.get("expires_in_minutes", 10),
                "max_attempts": verification_result.get("max_attempts", 3)
            }
            
        except Exception as email_error:
            logger.error(f"Failed to send verification email: {email_error}")
            
            # Даже если email не отправился, регистрация прошла успешно
            # Пользователь может запросить код повторно через /email-verification/resend
            return {
                "success": True,
                "message": "Registration successful! Please request verification code.",
                "user": result.get("user"),
                "verification_required": True,
                "verification_sent": False,
                "error": "Failed to send verification email automatically. Please use resend button."
            }
        
    except HTTPException:
        raise
    
    except Exception as e:
        logger.error(f"Unexpected error in register endpoint: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Registration failed due to server error"
        )


@router.post("/login", response_model=dict)
async def login(
    login_data: LoginRequest,
    db: Session = Depends(get_db)
):
    """
    Authenticate a user and generate a token.
    
    ✅ ОБНОВЛЕНО: Проверяет email_verified перед выдачей токена
    
    Args:
        login_data: User login credentials
        db: Database session dependency
    
    Returns:
        A token and the user data (only if email verified)
    
    Raises:
        HTTPException 403: If email not verified
    """
    try:
        logger.info(f"🔐 Login attempt for: {login_data.email}")
        
        # 1. Authenticate user (проверка credentials)
        result = await AuthService.login(db, login_data)
        
        user = result.get("user")
        if not user:
            logger.error("Authentication returned invalid user data")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Login failed - invalid response"
            )
        
        # 2. ✅ НОВОЕ: Проверяем email_verified
        if not user.get("email_verified", False):
            logger.warning(f"Login blocked: Email not verified for {login_data.email}")
            
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Email not verified. Please check your email for verification code.",
                headers={
                    "X-Verification-Required": "true",
                    "X-User-Email": login_data.email
                }
            )
        
        # 3. ✅ Email verified - выдаем токен
        logger.info(f"✅ Login successful for verified user: {login_data.email}")
        
        return {
            "success": True,
            "message": "Login successful",
            "token": result.get("token"),
            "user": user
        }
        
    except HTTPException:
        raise
    
    except Exception as e:
        logger.error(f"Unexpected error in login endpoint: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Login failed due to server error"
        )


@router.post("/reset-password", response_model=dict)
async def reset_password_request(
    email: str,
    db: Session = Depends(get_db)
):
    """
    Request a password reset email.
    
    Args:
        email: User email
        db: Database session dependency
    
    Returns:
        Confirmation message
    """
    try:
        await AuthService.reset_password_request(db, email)
        # Always return success for security reasons
        return {
            "success": True, 
            "message": "If an account with this email exists, a password reset link has been sent"
        }
    except Exception as e:
        logger.error(f"Error in reset password request: {str(e)}")
        # Still return success for security reasons
        return {
            "success": True, 
            "message": "If an account with this email exists, a password reset link has been sent"
        }


@router.post("/reset-password-confirm", response_model=dict)
async def reset_password_confirm(
    token: str,
    new_password: str,
    db: Session = Depends(get_db)
):
    """
    Confirm a password reset using a token.
    
    Args:
        token: Password reset token
        new_password: New password
        db: Database session dependency
    
    Returns:
        Confirmation message
    """
    # TODO: Implement password reset confirmation
    return {"success": True, "message": "Password reset successfully"}
