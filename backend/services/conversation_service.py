"""
Conversation service for WellcomeAI application.
Handles conversation tracking and analysis.
"""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.sql import func
from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta

from backend.core.logging import get_logger
from backend.models.conversation import Conversation
from backend.models.assistant import AssistantConfig
from backend.schemas.conversation import ConversationCreate, ConversationResponse, ConversationStats

logger = get_logger(__name__)

class ConversationService:
    """Service for conversation operations"""
    
    @staticmethod
    async def create_conversation(db: Session, conversation_data: ConversationCreate) -> ConversationResponse:
        """
        Create a new conversation record
        
        Args:
            db: Database session
            conversation_data: Conversation creation data
            
        Returns:
            ConversationResponse for the new conversation
            
        Raises:
            HTTPException: If creation fails
        """
        try:
            # Verify assistant exists
            assistant = db.query(AssistantConfig).filter(AssistantConfig.id == conversation_data.assistant_id).first()
            if not assistant:
                logger.warning(f"Attempt to create conversation for non-existent assistant: {conversation_data.assistant_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Assistant not found"
                )
            
            # Create conversation instance
            conversation = Conversation(
                assistant_id=conversation_data.assistant_id,
                session_id=conversation_data.session_id,
                user_message=conversation_data.user_message,
                assistant_message=conversation_data.assistant_message,
                duration_seconds=conversation_data.duration_seconds,
                client_info=conversation_data.client_info,
                audio_duration=conversation_data.audio_duration
            )
            
            db.add(conversation)
            
            # Increment conversation count for assistant
            assistant.total_conversations += 1
            
            db.commit()
            db.refresh(conversation)
            
            logger.info(f"Conversation created: {conversation.id} for assistant {conversation_data.assistant_id}")
            
            return ConversationResponse(
                id=str(conversation.id),
                assistant_id=str(conversation.assistant_id),
                user_message=conversation.user_message,
                assistant_message=conversation.assistant_message,
                duration_seconds=conversation.duration_seconds,
                client_info=conversation.client_info,
                created_at=conversation.created_at,
                tokens_used=conversation.tokens_used,
                feedback_rating=conversation.feedback_rating,
                feedback_text=conversation.feedback_text,
                is_flagged=conversation.is_flagged
            )
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error creating conversation: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to create conversation: {str(e)}"
            )
    
    @staticmethod
    async def get_conversations(
        db: Session, 
        assistant_id: str, 
        skip: int = 0, 
        limit: int = 50
    ) -> List[ConversationResponse]:
        """
        Get conversations for an assistant
        
        Args:
            db: Database session
            assistant_id: Assistant ID
            skip: Number of records to skip
            limit: Maximum number of records to return
            
        Returns:
            List of ConversationResponse objects
        """
        conversations = db.query(Conversation).filter(
            Conversation.assistant_id == assistant_id
        ).order_by(
            Conversation.created_at.desc()
        ).offset(skip).limit(limit).all()
        
        return [
            ConversationResponse(
                id=str(conv.id),
                assistant_id=str(conv.assistant_id),
                user_message=conv.user_message,
                assistant_message=conv.assistant_message,
                duration_seconds=conv.duration_seconds,
                client_info=conv.client_info,
                created_at=conv.created_at,
                tokens_used=conv.tokens_used,
                feedback_rating=conv.feedback_rating,
                feedback_text=conv.feedback_text,
                is_flagged=conv.is_flagged
            ) for conv in conversations
        ]
    
    @staticmethod
    async def get_conversation_stats(db: Session, assistant_id: str) -> ConversationStats:
        """
        Get conversation statistics for an assistant
        
        Args:
            db: Database session
            assistant_id: Assistant ID
            
        Returns:
            ConversationStats object
        """
        # Get total conversations and tokens
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        if not assistant:
            logger.warning(f"Attempt to get stats for non-existent assistant: {assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assistant not found"
            )
        
        total_conversations = assistant.total_conversations
        total_tokens = assistant.total_tokens
        
        # Get average duration
        avg_duration_result = db.query(func.avg(Conversation.duration_seconds)).filter(
            Conversation.assistant_id == assistant_id,
            Conversation.duration_seconds.isnot(None)
        ).scalar()
        avg_duration = float(avg_duration_result) if avg_duration_result else 0.0
        
        # Get time periods
        now = datetime.utcnow()
        today_start = datetime(now.year, now.month, now.day)
        week_start = today_start - timedelta(days=now.weekday())
        month_start = datetime(now.year, now.month, 1)
        
        # Count conversations by period
        conversations_today = db.query(Conversation).filter(
            Conversation.assistant_id == assistant_id,
            Conversation.created_at >= today_start
        ).count()
        
        conversations_this_week = db.query(Conversation).filter(
            Conversation.assistant_id == assistant_id,
            Conversation.created_at >= week_start
        ).count()
        
        conversations_this_month = db.query(Conversation).filter(
            Conversation.assistant_id == assistant_id,
            Conversation.created_at >= month_start
        ).count()
        
        return ConversationStats(
            total_conversations=total_conversations,
            total_tokens=total_tokens,
            avg_duration=avg_duration,
            conversations_today=conversations_today,
            conversations_this_week=conversations_this_week,
            conversations_this_month=conversations_this_month
        )
    
    @staticmethod
    async def add_feedback(db: Session, conversation_id: str, rating: int, feedback_text: Optional[str] = None) -> bool:
        """
        Add feedback to a conversation
        
        Args:
            db: Database session
            conversation_id: Conversation ID
            rating: Feedback rating (1-5)
            feedback_text: Optional feedback text
            
        Returns:
            True if feedback was added successfully
            
        Raises:
            HTTPException: If operation fails
        """
        try:
            conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
            
            if not conversation:
                logger.warning(f"Attempt to add feedback to non-existent conversation: {conversation_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Conversation not found"
                )
            
            conversation.feedback_rating = rating
            conversation.feedback_text = feedback_text
            
            db.commit()
            
            logger.info(f"Feedback added to conversation {conversation_id}: rating={rating}")
            return True
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error adding feedback: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to add feedback: {str(e)}"
            )
    
    @staticmethod
    async def flag_conversation(db: Session, conversation_id: str, flagged: bool = True) -> bool:
        """
        Flag or unflag a conversation
        
        Args:
            db: Database session
            conversation_id: Conversation ID
            flagged: Whether to flag or unflag
            
        Returns:
            True if operation was successful
            
        Raises:
            HTTPException: If operation fails
        """
        try:
            conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
            
            if not conversation:
                logger.warning(f"Attempt to flag non-existent conversation: {conversation_id}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Conversation not found"
                )
            
            conversation.is_flagged = flagged
            
            db.commit()
            
            logger.info(f"Conversation {conversation_id} {'flagged' if flagged else 'unflagged'}")
            return True
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Error {'flagging' if flagged else 'unflagging'} conversation: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to {'flag' if flagged else 'unflag'} conversation: {str(e)}"
            )
