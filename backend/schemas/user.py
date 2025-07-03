"""
User schemas for WellcomeAI application.
Defines schemas for user-related requests and responses.
"""

from pydantic import BaseModel, Field, EmailStr, validator
from typing import Optional, List, Dict, Any
from datetime import datetime

class UserBase(BaseModel):
    """Base schema with common user attributes"""
    email: EmailStr = Field(..., description="User email")
    first_name: Optional[str] = Field(None, description="User first name")
    last_name: Optional[str] = Field(None, description="User last name")
    company_name: Optional[str] = Field(None, description="Company name")

class UserCreate(UserBase):
    """Schema for creating a new user"""
    password: str = Field(..., min_length=8, description="User password")

    @validator('password')
    def password_complexity(cls, v):
        """Validate password complexity"""
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters long')
        return v

class UserUpdate(BaseModel):
    """Schema for updating user information"""
    first_name: Optional[str] = Field(None, description="User first name")
    last_name: Optional[str] = Field(None, description="User last name")
    company_name: Optional[str] = Field(None, description="Company name")
    openai_api_key: Optional[str] = Field(None, description="OpenAI API key")
    
    class Config:
        json_schema_extra = {
            "example": {
                "first_name": "John",
                "last_name": "Doe",
                "company_name": "ACME Inc.",
                "openai_api_key": "sk-..."
            }
        }

class UserPasswordUpdate(BaseModel):
    """Schema for updating user password"""
    current_password: str = Field(..., description="Current password")
    new_password: str = Field(..., min_length=8, description="New password")

    @validator('new_password')
    def password_complexity(cls, v):
        """Validate password complexity"""
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters long')
        return v

class UserResponse(UserBase):
    """Schema for user response"""
    id: str = Field(..., description="User ID")
    subscription_plan: str = Field(..., description="Subscription plan")
    google_sheets_authorized: bool = Field(..., description="Google Sheets authorization status")
    created_at: datetime = Field(..., description="User creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="User update timestamp")
    
    # Добавляем сам ключ API в ответ
    openai_api_key: Optional[str] = Field(None, description="OpenAI API key")
    has_api_key: bool = Field(..., description="Whether user has OpenAI API key set")
    
    # Новые поля для тарификации
    is_trial: bool = Field(False, description="Whether user is in trial period")
    is_admin: bool = Field(False, description="Whether user is an admin")
    subscription_end_date: Optional[datetime] = Field(None, description="End date of subscription")
    
    class Config:
        from_attributes = True
        
class UserDetailResponse(UserResponse):
    """Schema for detailed user response with usage stats"""
    total_assistants: int = Field(0, description="Total number of assistants")
    total_conversations: int = Field(0, description="Total number of conversations")
    usage_tokens: int = Field(0, description="Total tokens used")
    last_login: Optional[datetime] = Field(None, description="Last login timestamp")
    
    # Дополнительная информация о подписке
    subscription_plan_name: Optional[str] = Field(None, description="Subscription plan name")
    days_left: Optional[int] = Field(None, description="Days left in subscription")
    max_assistants: Optional[int] = Field(None, description="Maximum number of assistants allowed")
    
    class Config:
        from_attributes = True
