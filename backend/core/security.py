"""
Security utilities for WellcomeAI application.
Handles JWT token creation/validation, password hashing, and user authentication.
"""

import jwt
from datetime import datetime, timedelta
from typing import Dict, Optional, Union, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import hashlib
import uuid

from .config import settings
from .logging import get_logger

# Initialize logger
logger = get_logger(__name__)

# Set up security scheme
security = HTTPBearer()

def create_jwt_token(
    user_id: Union[str, uuid.UUID], 
    expires_delta_minutes: int = settings.ACCESS_TOKEN_EXPIRE_MINUTES
) -> str:
    """
    Create a JWT token for the given user ID
    
    Args:
        user_id: The user ID to encode in the token
        expires_delta_minutes: Token expiration time in minutes
        
    Returns:
        The encoded JWT token
    """
    try:
        expire = datetime.utcnow() + timedelta(minutes=expires_delta_minutes)
        to_encode = {
            "sub": str(user_id),
            "exp": expire,
            "iat": datetime.utcnow(),
            "type": "access_token"
        }
        
        encoded_jwt = jwt.encode(
            to_encode, 
            settings.JWT_SECRET_KEY, 
            algorithm=settings.JWT_ALGORITHM
        )
        
        return encoded_jwt
    except Exception as e:
        logger.error(f"Error creating JWT token: {str(e)}")
        raise

def decode_jwt_token(token: str) -> Dict[str, Any]:
    """
    Decode and validate a JWT token
    
    Args:
        token: The JWT token to decode
        
    Returns:
        The decoded token data
        
    Raises:
        HTTPException: If the token is invalid or expired
    """
    try:
        payload = jwt.decode(
            token, 
            settings.JWT_SECRET_KEY, 
            algorithms=[settings.JWT_ALGORITHM]
        )
        
        user_id = payload.get("sub")
        exp = payload.get("exp")
        
        if user_id is None:
            logger.warning("Invalid token: missing user ID")
            raise HTTPException(status_code=401, detail="Invalid token: missing user ID")
            
        return {"sub": user_id, "exp": exp}
    except jwt.ExpiredSignatureError:
        logger.warning("Token expired")
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.PyJWTError as e:
        logger.warning(f"Invalid token: {str(e)}")
        raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")

def hash_password(password: str) -> str:
    """
    Create a hash of a password using SHA-256
    
    Args:
        password: Plain text password to hash
        
    Returns:
        Hashed password
    """
    return hashlib.sha256(password.encode()).hexdigest()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify a password against a hash
    
    Args:
        plain_password: Plain text password to verify
        hashed_password: Hashed password to compare against
        
    Returns:
        True if password matches hash, False otherwise
    """
    return hash_password(plain_password) == hashed_password

async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> str:
    """
    FastAPI dependency to get current user ID from token
    
    Args:
        credentials: HTTP Authorization credentials
        
    Returns:
        User ID from the token
        
    Raises:
        HTTPException: If token is invalid
    """
    token_data = decode_jwt_token(credentials.credentials)
    return token_data["sub"]
