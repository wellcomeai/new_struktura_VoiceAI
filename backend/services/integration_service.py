import uuid
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any

from backend.core.logging import get_logger
from backend.models.integration import Integration
from backend.models.assistant import AssistantConfig
from backend.schemas.integration import IntegrationCreate, IntegrationUpdate

logger = get_logger(__name__)

class IntegrationService:
    """Сервис для работы с интеграциями."""
    
    @staticmethod
    async def get_integrations(db: Session, assistant_id: str) -> List[Integration]:
        """Получить все интеграции для ассистента."""
        return db.query(Integration).filter(Integration.assistant_id == assistant_id).all()
    
    @staticmethod
    async def get_integration_by_id(db: Session, integration_id: str, assistant_id: str) -> Integration:
        """Получить интеграцию по ID."""
        integration = db.query(Integration).filter(
            Integration.id == integration_id,
            Integration.assistant_id == assistant_id
        ).first()
        
        if not integration:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Интеграция не найдена"
            )
            
        return integration
    
    @staticmethod
    async def create_integration(db: Session, assistant_id: str, integration_data: IntegrationCreate) -> Integration:
        """Создать новую интеграцию."""
        # Проверяем существование ассистента
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        if not assistant:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ассистент не найден"
            )
        
        integration = Integration(
            assistant_id=assistant_id,
            name=integration_data.name,
            type=integration_data.type,
            webhook_url=integration_data.webhook_url,
            is_active=True
        )
        
        db.add(integration)
        
        # Обновляем функции ассистента
        await IntegrationService.update_assistant_functions(db, assistant)
        
        db.commit()
        db.refresh(integration)
        
        return integration
    
    @staticmethod
    async def update_integration(db: Session, integration_id: str, assistant_id: str, integration_data: IntegrationUpdate) -> Integration:
        """Обновить интеграцию."""
        integration = await IntegrationService.get_integration_by_id(db, integration_id, assistant_id)
        
        # Обновляем данные
        update_data = integration_data.dict(exclude_unset=True)
        for key, value in update_data.items():
            setattr(integration, key, value)
        
        # Обновляем функции ассистента
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        await IntegrationService.update_assistant_functions(db, assistant)
        
        db.commit()
        db.refresh(integration)
        
        return integration
    
    @staticmethod
    async def delete_integration(db: Session, integration_id: str, assistant_id: str) -> bool:
        """Удалить интеграцию."""
        integration = await IntegrationService.get_integration_by_id(db, integration_id, assistant_id)
        
        db.delete(integration)
        
        # Обновляем функции ассистента
        assistant = db.query(AssistantConfig).filter(AssistantConfig.id == assistant_id).first()
        await IntegrationService.update_assistant_functions(db, assistant)
        
        db.commit()
        
        return True
    
    @staticmethod
    async def update_assistant_functions(db: Session, assistant: AssistantConfig) -> None:
        """Обновить функции ассистента на основе его интеграций."""
        active_integrations = db.query(Integration).filter(
            Integration.assistant_id == assistant.id,
            Integration.is_active == True
        ).all()
        
        # Базовый список функций ассистента (если есть)
        existing_functions = assistant.functions or []
        
        # Функции, не связанные с интеграциями (если есть)
        non_integration_functions = [
            f for f in existing_functions 
            if not f.get("name", "").startswith("integration_")
        ]
        
        # Создаем новые функции для интеграций
        integration_functions = []
        
        for integration in active_integrations:
            if integration.type == "n8n":
                # Создаем функцию для n8n вебхука
                n8n_function = {
                    "name": f"integration_{integration.id}",
                    "description": f"Отправить данные в n8n: {integration.name}",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "Текст для отправки в n8n вебхук"
                            }
                        },
                        "required": ["text"]
                    }
                }
                integration_functions.append(n8n_function)
        
        # Обновляем функции ассистента
        assistant.functions = non_integration_functions + integration_functions
        db.commit()
