"""
Authentication schemas for WellcomeAI application.
Defines schemas for authentication-related requests and responses.
"""

from pydantic import BaseModel, Field, EmailStr, validator
from typing import Optional
from datetime import datetime

class TokenData(BaseModel):
    """Schema for JWT token data"""
    sub: str
    exp: int

class Token(BaseModel):
    """Schema for authentication token response"""
    token: str
    token_type: str = "bearer"

class LoginRequest(BaseModel):
    """Schema for user login request"""
    email: EmailStr = Field(..., description="User email")
    password: str = Field(..., min_length=8, description="User password")

    class Config:
        schema_extra = {
            "example": {
                "email": "user@example.com",
                "password": "password123"
            }
        }

class RegisterRequest(BaseModel):
    """Schema for user registration request"""
    email: EmailStr = Field(..., description="User email")
    password: str = Field(..., min_length=8, description="User password")
    first_name: Optional[str] = Field(None, description="User first name")
    last_name: Optional[str] = Field(None, description="User last name")
    company_name: Optional[str] = Field(None, description="Company name")

    @validator('password')
    def password_complexity(cls, v):
        """Validate password complexity"""
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters long')
        return v

    class Config:
        schema_extra = {
            "example": {
                "email": "user@example.com",
                "password": "password123",
                "first_name": "John",
                "last_name": "Doe",
                "company_name": "ACME Inc."
            }
        }

class PasswordResetRequest(BaseModel):
    """Schema for password reset request"""
    email: EmailStr = Field(..., description="User email")

class PasswordResetConfirm(BaseModel):
    """Schema for password reset confirmation"""
    token: str = Field(..., description="Password reset token")
    new_password: str = Field(..., min_length=8, description="New password")

    @validator('new_password')
    def password_complexity(cls, v):
        """Validate password complexity"""
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters long')
        return v

class AuthResponse(BaseModel):
    """Schema for general authentication response"""
    success: bool
    message: str
    token: Optional[str] = None
    user_id: Optional[str] = None
