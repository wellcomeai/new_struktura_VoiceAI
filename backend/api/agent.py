"""
Voicyfy Agent API — CRUD, chat, stats for autonomous calling agent.
"""

import json
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.task import Task
from backend.models.contact import Contact
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
# ENDPOINTS
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
    # Check openai key
    if not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    # Check gemini key
    if not current_user.gemini_api_key:
        raise HTTPException(status_code=400, detail="gemini_key_required")

    # Check uniqueness
    existing = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="already_exists")

    # Generate orchestrator prompt
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

    # Extract company name from doc_who_am_i (first line or first 50 chars)
    company_name = body.doc_who_am_i.split('\n')[0][:50] if body.doc_who_am_i else body.name

    # Create GeminiAssistantConfig for voice
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

    # Create AgentConfig
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

    # Track if docs changed for prompt regeneration
    docs_changed = False
    doc_fields = ['doc_who_am_i', 'doc_who_we_call', 'doc_how_we_talk',
                  'doc_what_we_offer', 'doc_rules_and_goals']

    update_data = body.dict(exclude_unset=True)

    for field in doc_fields:
        if field in update_data and update_data[field] is not None:
            setattr(agent, field, update_data[field])
            docs_changed = True

    # Update non-doc fields
    for field in ['name', 'working_hours_start', 'working_hours_end', 'is_active']:
        if field in update_data and update_data[field] is not None:
            setattr(agent, field, update_data[field])

    # Regenerate orchestrator prompt if docs changed
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

    # Delete associated Gemini assistant
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


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Text chat with the agent using gpt-4o-mini."""
    if not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=current_user.openai_api_key)

    # Build messages from chat history
    chat_system = (agent.orchestrator_prompt or "") + """

Ты общаешься с пользователем через текстовый чат.
Отвечай кратко и по делу. Помогай с вопросами о звонках, контактах и стратегии.
Если спрашивают о статистике — отвечай что данные доступны на дашборде."""

    messages = [{"role": "system", "content": chat_system}]

    # Add last 20 messages from history
    history = agent.chat_history or []
    for msg in history[-20:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": body.message})

    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            temperature=0.7,
            max_tokens=1000
        )
        reply = response.choices[0].message.content
    except Exception as e:
        logger.error(f"[AGENT] Chat error: {e}")
        raise HTTPException(status_code=500, detail=f"chat_error: {str(e)}")

    # Update chat history (max 20 messages)
    new_history = list(history)
    new_history.append({"role": "user", "content": body.message, "ts": datetime.utcnow().isoformat()})
    new_history.append({"role": "assistant", "content": reply, "ts": datetime.utcnow().isoformat()})
    agent.chat_history = new_history[-20:]
    db.commit()

    return {"reply": reply, "timestamp": datetime.utcnow().isoformat()}


@router.get("/stats")
async def get_agent_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get agent calling statistics."""
    agent = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    # Tasks that went through the agent (have pre_call_response_id)
    agent_tasks = db.query(Task).filter(
        Task.user_id == current_user.id,
        Task.pre_call_response_id.isnot(None)
    )

    total_calls = agent_tasks.count()

    success_calls = agent_tasks.filter(
        Task.post_call_decision == "SUCCESS"
    ).count()

    followup_calls = agent_tasks.filter(
        Task.post_call_decision == "FOLLOWUP"
    ).count()

    no_answer_calls = agent_tasks.filter(
        Task.post_call_decision.in_(["NO_ANSWER", "ESCALATE", "REJECTED"])
    ).count()

    unique_contacts = db.query(func.count(func.distinct(Task.contact_id))).filter(
        Task.user_id == current_user.id,
        Task.pre_call_response_id.isnot(None)
    ).scalar() or 0

    contacts_with_memory = db.query(func.count(Contact.id)).filter(
        Contact.user_id == current_user.id,
        Contact.agent_memory != {}
    ).scalar() or 0

    return {
        "total_calls": total_calls,
        "success_calls": success_calls,
        "followup_calls": followup_calls,
        "no_answer_calls": no_answer_calls,
        "unique_contacts": unique_contacts,
        "contacts_with_memory": contacts_with_memory,
    }
