# backend/services/email_service.py
"""
Email service for WellcomeAI application.
Handles email verification codes and SMTP operations.
"""

import smtplib
import random
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional, Dict, Any

from sqlalchemy.orm import Session
from fastapi import HTTPException, status

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.email_verification import EmailVerification
from backend.models.user import User

# Initialize logger
logger = get_logger(__name__)


class EmailService:
    """Service for handling email verification and SMTP operations"""
    
    # ✅ ИСПРАВЛЕНО: Email configuration from settings
    SMTP_HOST = settings.EMAIL_HOST
    SMTP_PORT = settings.EMAIL_PORT
    SMTP_USERNAME = settings.EMAIL_USERNAME
    SMTP_PASSWORD = settings.EMAIL_PASSWORD
    SMTP_USE_SSL = settings.EMAIL_USE_SSL
    SMTP_USE_TLS = settings.EMAIL_USE_TLS
    FROM_EMAIL = settings.EMAIL_FROM
    FROM_NAME = "Voicyfy"
    
    # ✅ ИСПРАВЛЕНО: Verification settings from config
    CODE_LENGTH = settings.VERIFICATION_CODE_LENGTH
    CODE_EXPIRY_MINUTES = settings.VERIFICATION_CODE_EXPIRY_MINUTES
    MAX_ATTEMPTS = settings.VERIFICATION_MAX_ATTEMPTS
    RESEND_COOLDOWN_SECONDS = settings.VERIFICATION_RESEND_COOLDOWN_SECONDS
    
    @classmethod
    def _generate_verification_code(cls) -> str:
        """
        Generate a random 6-digit verification code.
        
        Returns:
            6-digit string code
        """
        return ''.join([str(random.randint(0, 9)) for _ in range(cls.CODE_LENGTH)])
    
    @classmethod
    def _create_verification_email_html(cls, code: str, user_email: str) -> str:
        """
        Create HTML email template for verification code.
        
        Args:
            code: 6-digit verification code
            user_email: User's email address
        
        Returns:
            HTML email content
        """
        return f"""
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Подтверждение Email - Voicyfy</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8fafc;">
            <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                <!-- Header -->
                <div style="text-align: center; margin-bottom: 30px;">
                    <h1 style="color: #2563eb; font-size: 28px; margin: 0;">Voicyfy</h1>
                    <p style="color: #64748b; font-size: 16px; margin: 10px 0 0 0;">
                        Ваш голосовой ИИ. Говорит. Слушает. Понимает.
                    </p>
                </div>
                
                <!-- Main Content -->
                <div style="background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <h2 style="color: #0f172a; font-size: 24px; margin: 0 0 20px 0;">
                        Подтверждение Email
                    </h2>
                    
                    <p style="color: #64748b; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">
                        Здравствуйте! Вы регистрируетесь на платформе Voicyfy. 
                        Для завершения регистрации введите код подтверждения:
                    </p>
                    
                    <!-- Verification Code Box -->
                    <div style="background: linear-gradient(135deg, #4a86e8, #2563eb); border-radius: 8px; padding: 30px; text-align: center; margin: 30px 0;">
                        <div style="font-size: 42px; font-weight: 700; color: white; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                            {code}
                        </div>
                    </div>
                    
                    <!-- Important Info -->
                    <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 15px 20px; margin: 30px 0; border-radius: 4px;">
                        <p style="color: #1e40af; font-size: 14px; margin: 0; line-height: 1.6;">
                            <strong>⏰ Важно:</strong> Код действителен <strong>10 минут</strong>. 
                            У вас есть <strong>3 попытки</strong> для ввода.
                        </p>
                    </div>
                    
                    <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 20px 0 0 0;">
                        Если вы не регистрировались на Voicyfy, просто проигнорируйте это письмо.
                    </p>
                </div>
                
                <!-- Footer -->
                <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                    <p style="color: #94a3b8; font-size: 14px; margin: 0 0 10px 0;">
                        С уважением, команда Voicyfy
                    </p>
                    <p style="color: #cbd5e1; font-size: 12px; margin: 0;">
                        ИП Шишкин Валерий Сергеевич | ИНН: 385101159652
                    </p>
                    <p style="color: #cbd5e1; font-size: 12px; margin: 5px 0 0 0;">
                        <a href="https://t.me/voicyfy" style="color: #2563eb; text-decoration: none;">Telegram</a> | 
                        <a href="mailto:well96well@gmail.com" style="color: #2563eb; text-decoration: none;">Поддержка</a>
                    </p>
                </div>
            </div>
        </body>
        </html>
        """
    
    @classmethod
    def _send_email_smtp(cls, to_email: str, subject: str, html_content: str) -> bool:
        """
        Send email via Mail.ru SMTP with SSL/TLS support.
        
        Args:
            to_email: Recipient email address
            subject: Email subject
            html_content: HTML email content
        
        Returns:
            True if sent successfully, False otherwise
        
        Raises:
            HTTPException: If SMTP configuration is missing or send fails
        """
        try:
            # Check SMTP configuration
            if not cls.SMTP_USERNAME or not cls.SMTP_PASSWORD:
                logger.error("SMTP credentials not configured in settings")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Email service not configured"
                )
            
            # Create message
            msg = MIMEMultipart('alternative')
            msg['From'] = f"{cls.FROM_NAME} <{cls.FROM_EMAIL}>"
            msg['To'] = to_email
            msg['Subject'] = subject
            
            # Attach HTML content
            html_part = MIMEText(html_content, 'html', 'utf-8')
            msg.attach(html_part)
            
            # Connect to SMTP server and send
            logger.info(f"Connecting to SMTP: {cls.SMTP_HOST}:{cls.SMTP_PORT} (SSL={cls.SMTP_USE_SSL}, TLS={cls.SMTP_USE_TLS})")
            
            # ✅ ИСПРАВЛЕНО: Поддержка SSL и TLS
            if cls.SMTP_USE_SSL:
                # Use SSL (port 465)
                with smtplib.SMTP_SSL(cls.SMTP_HOST, cls.SMTP_PORT) as server:
                    logger.info(f"Authenticating as {cls.SMTP_USERNAME}")
                    server.login(cls.SMTP_USERNAME, cls.SMTP_PASSWORD)
                    
                    logger.info(f"Sending email to {to_email}")
                    server.send_message(msg)
            else:
                # Use STARTTLS (port 587) or no encryption (port 25)
                with smtplib.SMTP(cls.SMTP_HOST, cls.SMTP_PORT) as server:
                    if cls.SMTP_USE_TLS:
                        logger.info("Starting TLS...")
                        server.starttls()
                    
                    logger.info(f"Authenticating as {cls.SMTP_USERNAME}")
                    server.login(cls.SMTP_USERNAME, cls.SMTP_PASSWORD)
                    
                    logger.info(f"Sending email to {to_email}")
                    server.send_message(msg)
            
            logger.info(f"✅ Email sent successfully to {to_email}")
            return True
            
        except smtplib.SMTPAuthenticationError as e:
            logger.error(f"SMTP authentication failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email authentication failed"
            )
        
        except smtplib.SMTPException as e:
            logger.error(f"SMTP error: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email sending failed"
            )
        
        except Exception as e:
            logger.error(f"Unexpected error sending email: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Email sending failed"
            )
    
    @classmethod
    async def send_verification_code(
        cls, 
        db: Session, 
        user_id: str, 
        user_email: str
    ) -> Dict[str, Any]:
        """
        Generate and send verification code to user's email.
        
        Args:
            db: Database session
            user_id: User UUID
            user_email: User's email address
        
        Returns:
            Dictionary with success status and message
        
        Raises:
            HTTPException: If user not found or send fails
        """
        try:
            # Verify user exists
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"User not found: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Check if user already verified
            if user.email_verified:
                logger.info(f"User {user_email} already verified")
                return {
                    "success": True,
                    "message": "Email already verified",
                    "already_verified": True
                }
            
            # Generate new verification code
            code = cls._generate_verification_code()
            logger.info(f"Generated verification code for {user_email}: {code[:2]}****")
            
            # Create verification record
            verification = EmailVerification.create_verification_code(
                user_id=user_id,
                code=code,
                expiration_minutes=cls.CODE_EXPIRY_MINUTES
            )
            
            db.add(verification)
            db.commit()
            db.refresh(verification)
            
            logger.info(f"Created verification record for user {user_id}")
            
            # Create and send email
            html_content = cls._create_verification_email_html(code, user_email)
            subject = f"Код подтверждения Voicyfy: {code}"
            
            cls._send_email_smtp(user_email, subject, html_content)
            
            return {
                "success": True,
                "message": "Verification code sent successfully",
                "expires_in_minutes": cls.CODE_EXPIRY_MINUTES,
                "max_attempts": cls.MAX_ATTEMPTS
            }
            
        except HTTPException:
            raise
        
        except Exception as e:
            db.rollback()
            logger.error(f"Error sending verification code: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to send verification code"
            )
    
    @classmethod
    async def resend_verification_code(
        cls, 
        db: Session, 
        user_id: str, 
        user_email: str
    ) -> Dict[str, Any]:
        """
        Resend verification code with cooldown check.
        
        Args:
            db: Database session
            user_id: User UUID
            user_email: User's email address
        
        Returns:
            Dictionary with success status and message
        
        Raises:
            HTTPException: If cooldown not passed or send fails
        """
        try:
            # Get most recent verification code
            last_verification = EmailVerification.get_active_code_for_user(db, user_id)
            
            # Check cooldown period
            if last_verification:
                time_since_last = datetime.now(timezone.utc) - last_verification.created_at
                
                # Ensure created_at is timezone-aware
                created_at = last_verification.created_at
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                
                time_since_last = datetime.now(timezone.utc) - created_at
                
                if time_since_last.total_seconds() < cls.RESEND_COOLDOWN_SECONDS:
                    remaining_seconds = cls.RESEND_COOLDOWN_SECONDS - int(time_since_last.total_seconds())
                    logger.warning(f"Resend cooldown active for user {user_id}: {remaining_seconds}s remaining")
                    
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail=f"Please wait {remaining_seconds} seconds before requesting a new code"
                    )
            
            # Send new code
            logger.info(f"Resending verification code to {user_email}")
            return await cls.send_verification_code(db, user_id, user_email)
            
        except HTTPException:
            raise
        
        except Exception as e:
            logger.error(f"Error resending verification code: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to resend verification code"
            )
    
    @classmethod
    async def verify_code(
        cls, 
        db: Session, 
        user_id: str, 
        code: str
    ) -> Dict[str, Any]:
        """
        Verify the entered code and update user's email_verified status.
        
        Args:
            db: Database session
            user_id: User UUID
            code: 6-digit verification code
        
        Returns:
            Dictionary with success status and user data
        
        Raises:
            HTTPException: If code invalid, expired, or max attempts reached
        """
        try:
            # Get user
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"User not found: {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Check if already verified
            if user.email_verified:
                logger.info(f"User {user.email} already verified")
                return {
                    "success": True,
                    "message": "Email already verified",
                    "user": user.to_dict()
                }
            
            # Get active verification code
            verification = EmailVerification.get_active_code_for_user(db, user_id)
            
            if not verification:
                logger.warning(f"No active verification code for user {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="No active verification code found. Please request a new code."
                )
            
            # Check if expired
            if verification.is_expired:
                logger.warning(f"Verification code expired for user {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Verification code has expired. Please request a new code."
                )
            
            # Check max attempts
            if verification.attempts >= cls.MAX_ATTEMPTS:
                logger.warning(f"Max verification attempts reached for user {user_id}")
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Maximum verification attempts exceeded. Please request a new code."
                )
            
            # Increment attempts
            verification.increment_attempts()
            
            # Verify code
            if verification.code != code:
                db.commit()
                
                remaining_attempts = cls.MAX_ATTEMPTS - verification.attempts
                logger.warning(
                    f"Invalid verification code for user {user_id}. "
                    f"Attempts: {verification.attempts}/{cls.MAX_ATTEMPTS}"
                )
                
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid verification code. {remaining_attempts} attempts remaining."
                )
            
            # ✅ CODE VERIFIED SUCCESSFULLY!
            logger.info(f"✅ Verification code verified successfully for user {user.email}")
            
            # Mark verification as used
            verification.mark_as_used()
            
            # Update user's email_verified status
            user.email_verified = True
            
            db.commit()
            db.refresh(user)
            
            logger.info(f"✅ User {user.email} email verified successfully")
            
            return {
                "success": True,
                "message": "Email verified successfully",
                "user": user.to_dict()
            }
            
        except HTTPException:
            raise
        
        except Exception as e:
            db.rollback()
            logger.error(f"Error verifying code: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to verify code"
            )
    
    @classmethod
    async def get_verification_status(
        cls, 
        db: Session, 
        user_id: str
    ) -> Dict[str, Any]:
        """
        Get user's email verification status.
        
        Args:
            db: Database session
            user_id: User UUID
        
        Returns:
            Dictionary with verification status
        
        Raises:
            HTTPException: If user not found
        """
        try:
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Get active verification code if exists
            active_verification = EmailVerification.get_active_code_for_user(db, user_id)
            
            status_data = {
                "email_verified": user.email_verified,
                "email": user.email,
                "has_active_code": active_verification is not None
            }
            
            if active_verification:
                status_data.update({
                    "code_expires_in_seconds": active_verification.time_remaining_seconds,
                    "attempts_remaining": cls.MAX_ATTEMPTS - active_verification.attempts,
                    "max_attempts": cls.MAX_ATTEMPTS
                })
            
            return status_data
            
        except HTTPException:
            raise
        
        except Exception as e:
            logger.error(f"Error getting verification status: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to get verification status"
            )
    
    @classmethod
    async def cleanup_expired_codes(cls, db: Session) -> int:
        """
        Clean up expired verification codes from database.
        
        Args:
            db: Database session
        
        Returns:
            Number of codes deleted
        """
        try:
            deleted_count = EmailVerification.cleanup_expired_codes(db)
            logger.info(f"Cleaned up {deleted_count} expired verification codes")
            return deleted_count
            
        except Exception as e:
            logger.error(f"Error cleaning up expired codes: {e}")
            return 0
