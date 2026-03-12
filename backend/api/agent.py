"""
Voicyfy Agent API v2.0 — CRUD, chat (with tools), contacts, calls, stats.
"""

import json
import uuid
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.core.dependencies import get_current_user

logger = get_logger(__name__)

router = APIRouter()

# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================


class AgentCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    doc_who_am_i: str = Field(..., min_length=1)
    doc_who_we_call: str = Field(..., min_length=1)
    doc_how_we_talk: str = Field(..., min_length=1)
    doc_what_we_offer: str = Field(..., min_length=1)
    doc_rules_and_goals: str = Field(..., min_length=1)
    working_hours_start: int = Field(default=9, ge=0, le=23)
    working_hours_end: int = Field(default=21, ge=0, le=23)


class AgentUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    doc_who_am_i: Optional[str] = None
    doc_who_we_call: Optional[str] = None
    doc_how_we_talk: Optional[str] = None
    doc_what_we_offer: Optional[str] = None
    doc_rules_and_goals: Optional[str] = None
    working_hours_start: Optional[int] = Field(None, ge=0, le=23)
    working_hours_end: Optional[int] = Field(None, ge=0, le=23)
    is_active: Optional[bool] = None


class AgentChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)


class AgentContactCreateRequest(BaseModel):
    name: Optional[str] = None
    phone: str = Field(..., min_length=1, max_length=50)
    company: Optional[str] = None
    position: Optional[str] = None
    notes: Optional[str] = None


# ============================================================================
# VOICE AGENT SYSTEM PROMPT TEMPLATE
# ============================================================================

VOICE_AGENT_SYSTEM_PROMPT = """Ты голосовой AI-агент компании {company_name}.
Перед каждым звонком ты получаешь задачу и стратегию от оркестратора
в поле custom_greeting — это твоё первое сообщение и контекст звонка.
Говори на русском языке. Будь вежлив, конкретен, не затягивай разговор.
Цель каждого звонка указана в задаче. Следуй стратегии оркестратора.
Если клиент просит перезвонить — уточни удобное время и заверши звонок.
Если клиент отказывается — вежливо попрощайся, не дави."""

ORCHESTRATOR_GENERATION_SYSTEM = """Ты эксперт по созданию AI-агентов для бизнеса.
На основе 5 документов создай системный промпт для AI-оркестратора,
который будет планировать звонки и анализировать их результаты.
Промпт должен быть на русском языке, конкретным и деловым.
Формат: блоки О КОМПАНИИ / ЦЕЛЕВАЯ АУДИТОРИЯ /
СТИЛЬ ОБЩЕНИЯ / ПРОДУКТЫ / ЦЕЛИ И KPI / ПРАВИЛА РАБОТЫ."""


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


async def _generate_orchestrator_prompt(
    doc_who_am_i: str,
    doc_who_we_call: str,
    doc_how_we_talk: str,
    doc_what_we_offer: str,
    doc_rules_and_goals: str,
    openai_api_key: str
) -> str:
    """Generate orchestrator prompt from 5 onboarding documents using gpt-4o-mini."""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=openai_api_key)

    user_input = f"""Документ 1 — КТО МЫ:
{doc_who_am_i}

Документ 2 — КОМУ ЗВОНИМ:
{doc_who_we_call}

Документ 3 — КАК ГОВОРИМ:
{doc_how_we_talk}

Документ 4 — ЧТО ПРЕДЛАГАЕМ:
{doc_what_we_offer}

Документ 5 — ПРАВИЛА И ЦЕЛИ:
{doc_rules_and_goals}"""

    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": ORCHESTRATOR_GENERATION_SYSTEM},
            {"role": "user", "content": user_input}
        ],
        temperature=0.7,
        max_tokens=4000
    )

    return response.choices[0].message.content


def _agent_to_dict(agent: AgentConfig) -> dict:
    """Serialize AgentConfig to dict for API response."""
    gemini_name = None
    if agent.gemini_assistant:
        gemini_name = agent.gemini_assistant.name

    return {
        "id": str(agent.id),
        "user_id": str(agent.user_id),
        "assistant_id": str(agent.assistant_id) if agent.assistant_id else None,
        "gemini_assistant_name": gemini_name,
        "name": agent.name,
        "is_active": agent.is_active,
        "orchestrator_model": agent.orchestrator_model,
        "orchestrator_prompt": agent.orchestrator_prompt,
        "doc_who_am_i": agent.doc_who_am_i,
        "doc_who_we_call": agent.doc_who_we_call,
        "doc_how_we_talk": agent.doc_how_we_talk,
        "doc_what_we_offer": agent.doc_what_we_offer,
        "doc_rules_and_goals": agent.doc_rules_and_goals,
        "working_hours_start": agent.working_hours_start,
        "working_hours_end": agent.working_hours_end,
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
        "updated_at": agent.updated_at.isoformat() if agent.updated_at else None,
    }


# ============================================================================
# ENDPOINTS — AGENT CRUD
# ============================================================================


@router.get("/")
async def get_agent(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get the current user's AgentConfig."""
    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()

    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    return _agent_to_dict(agent)


@router.post("/create")
async def create_agent(
    body: AgentCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new Voicyfy Agent (one per user)."""
    if not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    if not current_user.gemini_api_key:
        raise HTTPException(status_code=400, detail="gemini_key_required")

    existing = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="already_exists")

    try:
        orchestrator_prompt = await _generate_orchestrator_prompt(
            doc_who_am_i=body.doc_who_am_i,
            doc_who_we_call=body.doc_who_we_call,
            doc_how_we_talk=body.doc_how_we_talk,
            doc_what_we_offer=body.doc_what_we_offer,
            doc_rules_and_goals=body.doc_rules_and_goals,
            openai_api_key=current_user.openai_api_key
        )
    except Exception as e:
        logger.error(f"[AGENT] Failed to generate orchestrator prompt: {e}")
        raise HTTPException(status_code=500, detail=f"prompt_generation_failed: {str(e)}")

    company_name = body.doc_who_am_i.split('\n')[0][:50] if body.doc_who_am_i else body.name

    gemini_assistant = GeminiAssistantConfig(
        id=uuid.uuid4(),
        user_id=current_user.id,
        name=f"{body.name} Voice",
        system_prompt=VOICE_AGENT_SYSTEM_PROMPT.format(company_name=company_name),
        voice="Kore",
        language="ru-RU",
        greeting_message="",
        is_active=True,
        is_public=False,
        temperature=0.7,
        max_tokens=4000,
    )
    db.add(gemini_assistant)
    db.flush()

    agent = AgentConfig(
        id=uuid.uuid4(),
        user_id=current_user.id,
        assistant_id=gemini_assistant.id,
        name=body.name,
        is_active=True,
        orchestrator_model="gpt-5-2025-08-07",
        orchestrator_prompt=orchestrator_prompt,
        doc_who_am_i=body.doc_who_am_i,
        doc_who_we_call=body.doc_who_we_call,
        doc_how_we_talk=body.doc_how_we_talk,
        doc_what_we_offer=body.doc_what_we_offer,
        doc_rules_and_goals=body.doc_rules_and_goals,
        working_hours_start=body.working_hours_start,
        working_hours_end=body.working_hours_end,
        chat_history=[],
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)

    logger.info(f"[AGENT] Created agent '{body.name}' for user {current_user.id}")
    return _agent_to_dict(agent)


@router.put("/")
async def update_agent(
    body: AgentUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update the agent's documents and settings."""
    if not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    docs_changed = False
    doc_fields = ['doc_who_am_i', 'doc_who_we_call', 'doc_how_we_talk',
                  'doc_what_we_offer', 'doc_rules_and_goals']

    update_data = body.dict(exclude_unset=True)

    for field in doc_fields:
        if field in update_data and update_data[field] is not None:
            setattr(agent, field, update_data[field])
            docs_changed = True

    for field in ['name', 'working_hours_start', 'working_hours_end', 'is_active']:
        if field in update_data and update_data[field] is not None:
            setattr(agent, field, update_data[field])

    if docs_changed:
        try:
            agent.orchestrator_prompt = await _generate_orchestrator_prompt(
                doc_who_am_i=agent.doc_who_am_i or "",
                doc_who_we_call=agent.doc_who_we_call or "",
                doc_how_we_talk=agent.doc_how_we_talk or "",
                doc_what_we_offer=agent.doc_what_we_offer or "",
                doc_rules_and_goals=agent.doc_rules_and_goals or "",
                openai_api_key=current_user.openai_api_key
            )
        except Exception as e:
            logger.error(f"[AGENT] Failed to regenerate prompt: {e}")
            raise HTTPException(status_code=500, detail=f"prompt_generation_failed: {str(e)}")

    db.commit()
    db.refresh(agent)

    logger.info(f"[AGENT] Updated agent for user {current_user.id}")
    return _agent_to_dict(agent)


@router.delete("/")
async def delete_agent(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete agent and associated GeminiAssistantConfig."""
    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    if agent.assistant_id:
        gemini = db.query(GeminiAssistantConfig).filter(
            GeminiAssistantConfig.id == agent.assistant_id
        ).first()
        if gemini:
            db.delete(gemini)

    db.delete(agent)
    db.commit()

    logger.info(f"[AGENT] Deleted agent for user {current_user.id}")
    return {"detail": "deleted"}


# ============================================================================
# ENDPOINTS — CHAT (ChatOrchestrator with tools)
# ============================================================================


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Text chat with the agent using GPT-5 + AGENT_CHAT_TOOLS."""
    if not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    from backend.services.agent_orchestrator import ChatOrchestrator

    try:
        orchestrator = ChatOrchestrator()
        result = await orchestrator.run(
            message=body.message,
            agent_config=agent,
            user=current_user,
            db=db,
        )
    except Exception as e:
        logger.error(f"[AGENT] Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"chat_error: {str(e)}")

    return {
        "reply": result["reply"],
        "timestamp": datetime.utcnow().isoformat(),
        "debug_log": result.get("debug_log", []),
    }


# ============================================================================
# ENDPOINTS — STATS
# ============================================================================


@router.get("/stats")
async def get_agent_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get agent statistics from AgentContact + AgentCall."""
    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    total_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.user_id == current_user.id
    ).scalar() or 0

    active_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.user_id == current_user.id,
        AgentContact.status.notin_(["rejected", "do_not_call"]),
    ).scalar() or 0

    total_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == current_user.id
    ).scalar() or 0

    success_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == current_user.id,
        AgentCall.post_call_decision == "SUCCESS",
    ).scalar() or 0

    followup_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == current_user.id,
        AgentCall.post_call_decision == "FOLLOWUP",
    ).scalar() or 0

    no_answer_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.user_id == current_user.id,
        AgentCall.post_call_decision.in_(["NO_ANSWER", "REJECTED"]),
    ).scalar() or 0

    scheduled_tasks = db.query(func.count(Task.id)).filter(
        Task.user_id == current_user.id,
        Task.is_agent_task == True,
        Task.status == TaskStatus.SCHEDULED,
    ).scalar() or 0

    return {
        "total_contacts": total_contacts,
        "active_contacts": active_contacts,
        "total_calls": total_calls,
        "success_calls": success_calls,
        "followup_calls": followup_calls,
        "no_answer_calls": no_answer_calls,
        "scheduled_tasks": scheduled_tasks,
    }


# ============================================================================
# ENDPOINTS — CONTACTS
# ============================================================================


@router.get("/contacts")
async def list_agent_contacts(
    status: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List agent contacts with optional status filter."""
    q = db.query(AgentContact).filter(AgentContact.user_id == current_user.id)
    if status:
        q = q.filter(AgentContact.status == status)

    total = q.count()
    contacts = q.order_by(AgentContact.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total": total,
        "contacts": [c.to_dict() for c in contacts],
    }


@router.post("/contacts")
async def create_agent_contact(
    body: AgentContactCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Manually add a contact and auto-schedule a first call in 1 hour."""
    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")

    contact = AgentContact(
        agent_config_id=agent.id,
        user_id=current_user.id,
        name=body.name,
        phone=body.phone,
        company=body.company,
        position=body.position,
        notes=body.notes,
        status="new",
        memory={},
    )
    db.add(contact)
    db.flush()

    # Auto-create first task in 1 hour
    task = Task(
        is_agent_task=True,
        agent_contact_id=contact.id,
        gemini_assistant_id=agent.assistant_id,
        user_id=current_user.id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=datetime.utcnow() + timedelta(hours=1),
        title=f"Первый звонок: {body.name or body.phone}",
        description=body.notes or "",
    )
    db.add(task)
    db.commit()
    db.refresh(contact)

    logger.info(f"[AGENT] Created contact {contact.id} with auto-task for user {current_user.id}")
    return contact.to_dict()


@router.delete("/contacts/{contact_id}")
async def delete_agent_contact(
    contact_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete an agent contact (cascade deletes AgentCalls)."""
    contact = db.query(AgentContact).filter(
        AgentContact.id == contact_id,
        AgentContact.user_id == current_user.id,
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="not_found")

    db.delete(contact)
    db.commit()

    logger.info(f"[AGENT] Deleted contact {contact_id}")
    return {"detail": "deleted"}


# ============================================================================
# ENDPOINTS — CALLS
# ============================================================================


@router.get("/calls")
async def list_agent_calls(
    agent_contact_id: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List agent calls with optional contact filter."""
    q = db.query(AgentCall).filter(AgentCall.user_id == current_user.id)
    if agent_contact_id:
        q = q.filter(AgentCall.agent_contact_id == agent_contact_id)

    total = q.count()
    calls = q.order_by(AgentCall.created_at.desc()).offset(offset).limit(limit).all()

    result = []
    for c in calls:
        d = c.to_dict()
        # Add contact info
        if c.contact:
            d["contact_name"] = c.contact.name
            d["contact_phone"] = c.contact.phone
        result.append(d)

    return {
        "total": total,
        "calls": result,
    }


@router.get("/calls/{call_id}")
async def get_agent_call(
    call_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a single agent call with full transcript."""
    call = db.query(AgentCall).filter(
        AgentCall.id == call_id,
        AgentCall.user_id == current_user.id,
    ).first()
    if not call:
        raise HTTPException(status_code=404, detail="not_found")

    d = call.to_dict()
    if call.contact:
        d["contact_name"] = call.contact.name
        d["contact_phone"] = call.contact.phone
    return d
