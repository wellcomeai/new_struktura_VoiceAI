"""
Knowledge Base API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Path
from sqlalchemy.orm import Session
from typing import Dict, Any, Optional

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.models.pinecone_config import PineconeConfig

# Initialize logger
logger = get_logger(__name__)

# Create router
router = APIRouter(prefix="/knowledge-base", tags=["Knowledge Base"])

@router.get("/", response_model=Dict[str, Any])
async def get_knowledge_base_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Get knowledge base status for the current user
    
    Args:
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Status information about the knowledge base
    """
    try:
        # Get knowledge base config for the user
        config = db.query(PineconeConfig).filter(
            PineconeConfig.user_id == current_user.id
        ).first()
        
        if not config:
            return {
                "has_knowledge_base": False,
                "namespace": None,
                "char_count": 0,
                "updated_at": None,
                "content_preview": None
            }
            
        return {
            "has_knowledge_base": True,
            "namespace": config.namespace,
            "char_count": config.char_count,
            "updated_at": config.updated_at,
            "content_preview": config.content_preview
        }
        
    except Exception as e:
        logger.error(f"Error getting knowledge base status: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get knowledge base status: {str(e)}"
        )

@router.post("/", response_model=Dict[str, Any])
async def create_or_update_knowledge_base(
    content_data: Dict[str, str],
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Create or update knowledge base for the current user
    
    Args:
        content_data: Dictionary with content for knowledge base
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Status information including namespace
    """
    try:
        # Check for API key
        api_key = current_user.openai_api_key
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="OpenAI API key is required for knowledge base creation"
            )
        
        content = content_data.get("content", "")
        
        # Get existing config if any
        existing_config = db.query(PineconeConfig).filter(
            PineconeConfig.user_id == current_user.id
        ).first()
        
        existing_namespace = existing_config.namespace if existing_config else None
        
        # Create or update knowledge base in Pinecone
        from backend.services.pinecone_service import PineconeService
        namespace, char_count = await PineconeService.create_or_update_knowledge_base(
            content=content, 
            api_key=api_key,
            namespace=existing_namespace
        )
        
        # Create or update PineconeConfig
        if existing_config:
            existing_config.namespace = namespace
            existing_config.char_count = char_count
            existing_config.content_preview = content[:200] + "..." if len(content) > 200 else content
            existing_config.updated_at = func.now()
        else:
            new_config = PineconeConfig(
                user_id=current_user.id,
                namespace=namespace,
                char_count=char_count,
                content_preview=content[:200] + "..." if len(content) > 200 else content
            )
            db.add(new_config)
        
        db.commit()
        
        return {
            "success": True,
            "namespace": namespace,
            "char_count": char_count,
            "message": "Knowledge base created/updated successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating/updating knowledge base: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create/update knowledge base: {str(e)}"
        )

@router.delete("/", response_model=Dict[str, Any])
async def delete_knowledge_base(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete knowledge base for the current user
    
    Args:
        current_user: Current authenticated user
        db: Database session dependency
    
    Returns:
        Status information about the deletion
    """
    try:
        # Get knowledge base config
        config = db.query(PineconeConfig).filter(
            PineconeConfig.user_id == current_user.id
        ).first()
        
        if not config:
            return {
                "success": True,
                "message": "No knowledge base found for this user"
            }
        
        # Delete from Pinecone
        from backend.services.pinecone_service import PineconeService
        await PineconeService.delete_knowledge_base(config.namespace)
        
        # Delete config from database
        db.delete(config)
        db.commit()
        
        return {
            "success": True,
            "message": "Knowledge base deleted successfully"
        }
        
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting knowledge base: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete knowledge base: {str(e)}"
        )
