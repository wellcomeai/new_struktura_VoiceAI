"""
Authentication API endpoints for WellcomeAI application.
"""

"""
Authentication API endpoints for WellcomeAI application.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from sqlalchemy.orm import Session

from backend.core.logging import get_logger  # Уже корректный
from backend.db.session import get_db  # Уже корректный
from backend.schemas.auth import LoginRequest, RegisterRequest, Token  # Изменен импорт schemas
from backend.schemas.user import UserResponse  # Изменен импорт schemas
from backend.services.auth_service import AuthService  # Изменен импорт services

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter()

# Security scheme
security = HTTPBearer()

# Остальной код остается без изменений

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
    
    Args:
        user_data: User registration data with email, password, and optional profile info
        db: Database session dependency
    
    Returns:
        A token and the user data
    """
    try:
        result = await AuthService.register(db, user_data)
        return result
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
    
    Args:
        login_data: User login credentials
        db: Database session dependency
    
    Returns:
        A token and the user data
    """
    try:
        result = await AuthService.login(db, login_data)
        return result
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
        return {"success": True, "message": "If an account with this email exists, a password reset link has been sent"}
    except Exception as e:
        logger.error(f"Error in reset password request: {str(e)}")
        # Still return success for security reasons
        return {"success": True, "message": "If an account with this email exists, a password reset link has been sent"}

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
