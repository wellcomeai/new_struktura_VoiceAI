# backend/api/contacts.py
"""
Contacts API endpoints для CRM функциональности.
Управление контактами (клиентами) и их связью с диалогами.
Version: 2.0 - Production Ready + Contact Notes (лента заметок)
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, desc, or_
from typing import Optional, List
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, Field

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.services.auth_service import AuthService
from backend.models.user import User
from backend.models.contact import Contact, ContactNote
from backend.models.conversation import Conversation
from backend.models.assistant import AssistantConfig

logger = get_logger(__name__)

# Create router
router = APIRouter()


# ==================== Pydantic схемы ====================

class ContactCreate(BaseModel):
    """Схема для создания контакта"""
    phone: str = Field(..., description="Номер телефона в формате +79123456789")
    name: Optional[str] = Field(None, description="Имя контакта")
    status: str = Field(default="new", description="Статус: new, active, client, archived")
    notes: Optional[str] = Field(None, description="Заметки")


class ContactUpdate(BaseModel):
    """Схема для обновления контакта"""
    name: Optional[str] = Field(None, description="Имя контакта")
    status: Optional[str] = Field(None, description="Статус: new, active, client, archived")
    notes: Optional[str] = Field(None, description="Заметки")


class ContactStatusUpdate(BaseModel):
    """Схема для обновления только статуса"""
    status: str = Field(..., description="Новый статус: new, active, client, archived")


class ContactNoteCreate(BaseModel):
    """Схема для создания заметки"""
    note_text: str = Field(..., description="Текст заметки", min_length=1)


# ==================== Вспомогательные функции ====================

def get_or_create_contact(db: Session, user_id: UUID, phone: str) -> Contact:
    """
    Получить существующий контакт или создать новый (автоматически).
    Используется при сохранении диалога.
    """
    contact = db.query(Contact).filter(
        Contact.user_id == user_id,
        Contact.phone == phone
    ).first()
    
    if not contact:
        contact = Contact(
            user_id=user_id,
            phone=phone,
            status="new",
            last_interaction=datetime.utcnow()
        )
        db.add(contact)
        db.flush()
        logger.info(f"[CRM] Auto-created contact for phone {phone}, user {user_id}")
    else:
        # Обновляем время последнего контакта
        contact.last_interaction = datetime.utcnow()
    
    return contact


# ==================== CONTACTS API Endpoints ====================

@router.get("/")
async def get_contacts(
    status: Optional[str] = Query(None, description="Фильтр по статусу"),
    search: Optional[str] = Query(None, description="Поиск по имени или номеру"),
    limit: int = Query(50, ge=1, le=100, description="Количество записей"),
    offset: int = Query(0, ge=0, description="Смещение для пагинации"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить список контактов (CRM).
    
    Возвращает контакты пользователя с количеством диалогов и датой последнего контакта.
    
    **Фильтры:**
    - status: Фильтр по статусу (new, active, client, archived)
    - search: Поиск по имени или номеру телефона
    
    **Пагинация:**
    - limit: Количество записей (1-100)
    - offset: Смещение
    
    **Возвращает:**
    - contacts: Список контактов с метриками
    - total: Общее количество
    """
    try:
        logger.info(f"[CRM-API] Get contacts for user {current_user.id}")
        logger.info(f"   Filters: status={status}, search={search}")
        logger.info(f"   Pagination: limit={limit}, offset={offset}")
        
        # Подзапрос для подсчета диалогов
        conversations_count_subquery = (
            db.query(
                Conversation.contact_id,
                func.count(Conversation.id).label('total_conversations')
            )
            .group_by(Conversation.contact_id)
            .subquery()
        )
        
        # Основной запрос
        query = (
            db.query(
                Contact,
                func.coalesce(conversations_count_subquery.c.total_conversations, 0).label('conversations_count')
            )
            .outerjoin(
                conversations_count_subquery,
                Contact.id == conversations_count_subquery.c.contact_id
            )
            .filter(Contact.user_id == current_user.id)
        )
        
        # Фильтр по статусу
        if status:
            query = query.filter(Contact.status == status)
        
        # Поиск
        if search:
            search_pattern = f"%{search}%"
            query = query.filter(
                or_(
                    Contact.name.ilike(search_pattern),
                    Contact.phone.ilike(search_pattern)
                )
            )
        
        # Подсчет общего количества
        total = query.count()
        
        # Сортировка и пагинация
        contacts_with_counts = (
            query.order_by(desc(Contact.last_interaction))
            .limit(limit)
            .offset(offset)
            .all()
        )
        
        logger.info(f"✅ Found {len(contacts_with_counts)} contacts (total: {total})")
        
        # Формируем результат
        result = []
        for contact, conversations_count in contacts_with_counts:
            contact_dict = contact.to_dict()
            contact_dict['total_conversations'] = conversations_count
            result.append(contact_dict)
        
        return {
            "contacts": result,
            "total": total,
            "page": offset // limit if limit > 0 else 0,
            "page_size": limit
        }
        
    except Exception as e:
        logger.error(f"❌ Error getting contacts: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get contacts: {str(e)}"
        )


@router.get("/{contact_id}")
async def get_contact_detail(
    contact_id: str,
    include_conversations: bool = Query(True, description="Включить список всех диалогов"),
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить детальную информацию о контакте.
    
    Возвращает информацию о контакте + все его диалоги.
    
    **Параметры:**
    - contact_id: UUID контакта
    - include_conversations: Включить список диалогов (по умолчанию true)
    
    **Возвращает:**
    - Полная информация о контакте
    - Список всех диалогов (сессий)
    - Статистика
    """
    try:
        logger.info(f"[CRM-API] Get contact detail: {contact_id}")
        logger.info(f"   User: {current_user.id}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Получаем контакт
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            logger.warning(f"Contact not found or access denied: {contact_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        result = contact.to_dict()
        
        # Статистика по диалогам
        stats = db.query(
            func.count(Conversation.id).label('total_conversations'),
            func.sum(Conversation.tokens_used).label('total_tokens'),
            func.sum(Conversation.duration_seconds).label('total_duration')
        ).filter(Conversation.contact_id == contact.id).first()
        
        result['stats'] = {
            'total_conversations': stats.total_conversations or 0,
            'total_tokens': stats.total_tokens or 0,
            'total_duration': stats.total_duration or 0
        }
        
        # Список диалогов (группированных по session_id)
        if include_conversations:
            # Группируем по session_id
            sessions = db.query(
                Conversation.session_id,
                Conversation.assistant_id,
                func.count(Conversation.id).label('messages_count'),
                func.min(Conversation.created_at).label('created_at'),
                func.max(Conversation.created_at).label('updated_at'),
                func.sum(Conversation.tokens_used).label('total_tokens'),
                func.sum(Conversation.duration_seconds).label('total_duration')
            ).filter(
                Conversation.contact_id == contact.id
            ).group_by(
                Conversation.session_id,
                Conversation.assistant_id
            ).order_by(desc(func.max(Conversation.created_at))).all()
            
            conversations = []
            for s in sessions:
                # Получаем имя ассистента
                assistant = db.query(AssistantConfig).filter(
                    AssistantConfig.id == s.assistant_id
                ).first()
                
                conversations.append({
                    "session_id": s.session_id,
                    "assistant_id": str(s.assistant_id),
                    "assistant_name": assistant.name if assistant else "Unknown",
                    "messages_count": s.messages_count,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                    "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                    "total_tokens": s.total_tokens or 0,
                    "total_duration": s.total_duration or 0
                })
            
            result['conversations'] = conversations
            logger.info(f"   Found {len(conversations)} conversation sessions")
        
        logger.info(f"✅ Contact details returned")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting contact detail: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get contact detail: {str(e)}"
        )


@router.post("/")
async def create_or_update_contact(
    contact_data: ContactCreate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создать новый контакт или обновить существующий.
    
    Если контакт с таким номером уже существует - обновляет его данные.
    
    **Body:**
    - phone: Номер телефона (обязательно)
    - name: Имя контакта (опционально)
    - status: Статус (опционально, по умолчанию "new")
    - notes: Заметки (опционально)
    
    **Возвращает:**
    - Созданный или обновленный контакт
    """
    try:
        logger.info(f"[CRM-API] Create/update contact for user {current_user.id}")
        logger.info(f"   Phone: {contact_data.phone}")
        
        # Валидация статуса
        valid_statuses = ["new", "active", "client", "archived"]
        if contact_data.status not in valid_statuses:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
            )
        
        # Проверяем существует ли контакт
        contact = db.query(Contact).filter(
            Contact.user_id == current_user.id,
            Contact.phone == contact_data.phone
        ).first()
        
        if contact:
            # Обновляем существующий
            if contact_data.name is not None:
                contact.name = contact_data.name
            if contact_data.status is not None:
                contact.status = contact_data.status
            if contact_data.notes is not None:
                contact.notes = contact_data.notes
            
            contact.updated_at = datetime.utcnow()
            
            db.commit()
            db.refresh(contact)
            
            logger.info(f"✅ Contact updated: {contact.id}")
            
            return {
                "message": "Contact updated successfully",
                "contact": contact.to_dict()
            }
        else:
            # Создаем новый
            new_contact = Contact(
                user_id=current_user.id,
                phone=contact_data.phone,
                name=contact_data.name,
                status=contact_data.status,
                notes=contact_data.notes
            )
            
            db.add(new_contact)
            db.commit()
            db.refresh(new_contact)
            
            logger.info(f"✅ Contact created: {new_contact.id}")
            
            return {
                "message": "Contact created successfully",
                "contact": new_contact.to_dict()
            }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error creating/updating contact: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create/update contact: {str(e)}"
        )


@router.put("/{contact_id}")
async def update_contact(
    contact_id: str,
    contact_data: ContactUpdate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Обновить существующий контакт.
    
    **Параметры:**
    - contact_id: UUID контакта
    
    **Body:**
    - name: Имя контакта (опционально)
    - status: Статус (опционально)
    - notes: Заметки (опционально)
    
    **Возвращает:**
    - Обновленный контакт
    """
    try:
        logger.info(f"[CRM-API] Update contact: {contact_id}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Получаем контакт
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            logger.warning(f"Contact not found: {contact_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        # Валидация статуса
        if contact_data.status:
            valid_statuses = ["new", "active", "client", "archived"]
            if contact_data.status not in valid_statuses:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
                )
        
        # Обновляем поля
        if contact_data.name is not None:
            contact.name = contact_data.name
        if contact_data.status is not None:
            contact.status = contact_data.status
        if contact_data.notes is not None:
            contact.notes = contact_data.notes
        
        contact.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(contact)
        
        logger.info(f"✅ Contact updated: {contact.id}")
        
        return {
            "message": "Contact updated successfully",
            "contact": contact.to_dict()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error updating contact: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update contact: {str(e)}"
        )


@router.patch("/{contact_id}/status")
async def update_contact_status(
    contact_id: str,
    status_data: ContactStatusUpdate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Обновить только статус контакта.
    
    Быстрый endpoint для изменения статуса без изменения других полей.
    
    **Параметры:**
    - contact_id: UUID контакта
    
    **Body:**
    - status: Новый статус (new, active, client, archived)
    
    **Возвращает:**
    - Обновленный контакт
    """
    try:
        logger.info(f"[CRM-API] Update contact status: {contact_id} -> {status_data.status}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Валидация статуса
        valid_statuses = ["new", "active", "client", "archived"]
        if status_data.status not in valid_statuses:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
            )
        
        # Получаем контакт
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            logger.warning(f"Contact not found: {contact_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        # Обновляем статус
        contact.status = status_data.status
        contact.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(contact)
        
        logger.info(f"✅ Contact status updated: {contact.id}")
        
        return {
            "message": "Contact status updated successfully",
            "contact": contact.to_dict()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error updating contact status: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update contact status: {str(e)}"
        )


@router.delete("/{contact_id}")
async def delete_contact(
    contact_id: str,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Удалить контакт.
    
    ⚠️ ВНИМАНИЕ: Это также удалит все диалоги и заметки связанные с контактом!
    
    **Параметры:**
    - contact_id: UUID контакта
    
    **Возвращает:**
    - Сообщение об успешном удалении
    """
    try:
        logger.info(f"[CRM-API] Delete contact: {contact_id}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Получаем контакт
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            logger.warning(f"Contact not found: {contact_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        # Подсчитываем количество связанных данных
        conversations_count = db.query(Conversation).filter(
            Conversation.contact_id == contact.id
        ).count()
        
        notes_count = db.query(ContactNote).filter(
            ContactNote.contact_id == contact.id
        ).count()
        
        # Удаляем контакт (диалоги и заметки удалятся автоматически благодаря cascade)
        db.delete(contact)
        db.commit()
        
        logger.info(f"✅ Contact deleted: {contact_id}")
        logger.info(f"   Also deleted {conversations_count} conversations and {notes_count} notes")
        
        return {
            "message": "Contact deleted successfully",
            "deleted_conversations": conversations_count,
            "deleted_notes": notes_count
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error deleting contact: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete contact: {str(e)}"
        )


# ==================== CONTACT NOTES API Endpoints ====================

@router.get("/{contact_id}/notes")
async def get_contact_notes(
    contact_id: str,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить все заметки по контакту (лента заметок).
    
    Возвращает список всех заметок отсортированных по дате (новые сверху).
    
    **Параметры:**
    - contact_id: UUID контакта
    
    **Возвращает:**
    - notes: Список заметок с датами и авторами
    - total: Количество заметок
    """
    try:
        logger.info(f"[CRM-API] Get notes for contact {contact_id}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Проверяем что контакт принадлежит пользователю
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        # Получаем заметки (новые сверху)
        notes = db.query(ContactNote).filter(
            ContactNote.contact_id == contact_uuid
        ).order_by(desc(ContactNote.created_at)).all()
        
        result = []
        for note in notes:
            note_dict = note.to_dict()
            # Добавляем информацию об авторе
            author = db.query(User).filter(User.id == note.user_id).first()
            note_dict['author_email'] = author.email if author else "Unknown"
            result.append(note_dict)
        
        logger.info(f"✅ Returned {len(result)} notes")
        
        return {
            "notes": result,
            "total": len(result)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting notes: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get notes: {str(e)}"
        )


@router.post("/{contact_id}/notes")
async def create_contact_note(
    contact_id: str,
    note_data: ContactNoteCreate,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создать новую заметку для контакта.
    
    Добавляет заметку в ленту заметок контакта.
    
    **Параметры:**
    - contact_id: UUID контакта
    
    **Body:**
    - note_text: Текст заметки (обязательно, минимум 1 символ)
    
    **Возвращает:**
    - note: Созданная заметка с ID и датой создания
    """
    try:
        logger.info(f"[CRM-API] Create note for contact {contact_id}")
        
        # Проверяем UUID
        try:
            contact_uuid = UUID(contact_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid contact ID format"
            )
        
        # Проверяем что контакт принадлежит пользователю
        contact = db.query(Contact).filter(
            Contact.id == contact_uuid,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Contact not found"
            )
        
        # Валидация
        note_text = note_data.note_text.strip()
        if not note_text:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Note text cannot be empty"
            )
        
        # Создаем заметку
        new_note = ContactNote(
            contact_id=contact_uuid,
            user_id=current_user.id,
            note_text=note_text
        )
        
        db.add(new_note)
        db.commit()
        db.refresh(new_note)
        
        result = new_note.to_dict()
        result['author_email'] = current_user.email
        
        logger.info(f"✅ Note created: {new_note.id}")
        
        return {
            "message": "Note created successfully",
            "note": result
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error creating note: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create note: {str(e)}"
        )


@router.delete("/notes/{note_id}")
async def delete_contact_note(
    note_id: str,
    current_user: User = Depends(AuthService.get_current_user),
    db: Session = Depends(get_db)
):
    """
    Удалить заметку из ленты заметок.
    
    Можно удалить только заметки контактов, которые принадлежат пользователю.
    
    **Параметры:**
    - note_id: UUID заметки
    
    **Возвращает:**
    - Сообщение об успешном удалении
    """
    try:
        logger.info(f"[CRM-API] Delete note {note_id}")
        
        # Проверяем UUID
        try:
            note_uuid = UUID(note_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid note ID format"
            )
        
        # Получаем заметку
        note = db.query(ContactNote).filter(ContactNote.id == note_uuid).first()
        
        if not note:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Note not found"
            )
        
        # Проверяем что контакт принадлежит пользователю
        contact = db.query(Contact).filter(
            Contact.id == note.contact_id,
            Contact.user_id == current_user.id
        ).first()
        
        if not contact:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
        
        # Удаляем
        db.delete(note)
        db.commit()
        
        logger.info(f"✅ Note deleted: {note_id}")
        
        return {"message": "Note deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error deleting note: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete note: {str(e)}"
        )
