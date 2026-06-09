"""
Voicyfy Agent API v2.0 — CRUD, chat (with tools), contacts, calls, stats.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from fastapi import (
    APIRouter, Depends, HTTPException, Query, status,
    UploadFile, File, Form, BackgroundTasks,
)
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func, or_

from backend.core.logging import get_logger
from backend.db.session import get_db, SessionLocal
from backend.core.timezone_utils import adjust_to_working_hours, now_utc, iso_utc
from backend.models.user import User
from backend.models.agent_config import AgentConfig
from backend.models.gemini_assistant import GeminiAssistantConfig
from backend.models.assistant import AssistantConfig
from backend.models.cartesia_assistant import CartesiaAssistantConfig
from backend.models.voximplant_child import VoximplantChildAccount
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.core.dependencies import get_current_user
from backend.core.pipeline_stages import AGENT_CONTACT_STAGES, is_valid_stage
from backend.services.agent_prompts import get_voice_agent_prompt
from backend.services.agent_models import ORCHESTRATOR_MODELS, get_default_model, is_valid_model
from backend.services.agent_tools import assistant_task_kwargs
from backend.services.credit_service import (
    CreditService,
    activate_agent_trial,
    InsufficientCreditsError,
    SubscriptionExpiredError,
    SubscriptionRequiredError,
)

logger = get_logger(__name__)

router = APIRouter()

# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================


VALID_ASSISTANT_TYPES = ("gemini", "openai", "cartesia")

# Максимум агентов на одного пользователя (v3.1: было «один на юзера»).
MAX_AGENTS_PER_USER = 3


class AgentCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    assistant_type: str = Field(...)  # "gemini" | "openai" | "cartesia"
    doc_who_am_i: str = Field(..., min_length=1)
    doc_who_we_call: str = Field(..., min_length=1)
    doc_how_we_talk: str = Field(..., min_length=1)
    doc_what_we_offer: str = Field(..., min_length=1)
    doc_rules_and_goals: str = Field(..., min_length=1)
    additional_instructions: Optional[str] = None
    working_hours_start: int = Field(default=9, ge=0, le=23)
    working_hours_end: int = Field(default=21, ge=0, le=23)
    orchestrator_model: Optional[str] = None  # default → get_default_model()


class AgentUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    doc_who_am_i: Optional[str] = None
    doc_who_we_call: Optional[str] = None
    doc_how_we_talk: Optional[str] = None
    doc_what_we_offer: Optional[str] = None
    doc_rules_and_goals: Optional[str] = None
    additional_instructions: Optional[str] = None
    working_hours_start: Optional[int] = Field(None, ge=0, le=23)
    working_hours_end: Optional[int] = Field(None, ge=0, le=23)
    is_active: Optional[bool] = None
    default_caller_id: Optional[str] = Field(None, max_length=50)
    orchestrator_model: Optional[str] = None
    assistant_type: Optional[str] = None


class AgentChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)


class AgentContactCreateRequest(BaseModel):
    name: Optional[str] = None
    phone: str = Field(..., min_length=1, max_length=50)
    company: Optional[str] = None
    position: Optional[str] = None
    notes: Optional[str] = None


class AgentContactUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    company: Optional[str] = Field(None, max_length=255)
    position: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None


class AgentContactStatusRequest(BaseModel):
    status: str = Field(..., min_length=1, max_length=50)


class ImportExecuteRequest(BaseModel):
    preview_token: str = Field(..., min_length=1)
    agent_id: Optional[str] = None


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


def _check_telephony_verified(current_user: User, db: Session):
    """Raise HTTPException(400) if telephony is not verified for the user."""
    child_account = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == current_user.id
    ).first()
    if not child_account or not child_account.is_verified:
        raise HTTPException(status_code=400, detail="telephony_not_verified")


def _check_assistant_keys(assistant_type: str, current_user: User):
    """Validate required API keys for the chosen assistant type."""
    if assistant_type == "gemini":
        if not current_user.gemini_api_key:
            raise HTTPException(status_code=400, detail="api_key_required_gemini")
    elif assistant_type == "openai":
        if not current_user.openai_api_key:
            raise HTTPException(status_code=400, detail="api_key_required_openai")
    elif assistant_type == "cartesia":
        if not current_user.openai_api_key:
            raise HTTPException(status_code=400, detail="api_key_required_openai")
        if not current_user.cartesia_api_key:
            raise HTTPException(status_code=400, detail="api_key_required_cartesia")


def _create_voice_assistant(assistant_type: str, name: str, user_id, db):
    """Create a voice assistant of the given type with the hardcoded base prompt."""
    prompt = get_voice_agent_prompt()
    if assistant_type == "gemini":
        va = GeminiAssistantConfig(
            id=uuid.uuid4(), user_id=user_id, name=f"{name} Voice",
            system_prompt=prompt, voice="Kore", language="ru-RU",
            greeting_message="", is_active=True, is_public=False,
            temperature=0.7, max_tokens=4000,
        )
    elif assistant_type == "openai":
        va = AssistantConfig(
            id=uuid.uuid4(), user_id=user_id, name=f"{name} Voice",
            system_prompt=prompt, voice="alloy", language="ru",
            greeting_message="", is_active=True, is_public=False,
            temperature=0.7, max_tokens=4000,
        )
    elif assistant_type == "cartesia":
        va = CartesiaAssistantConfig(
            id=uuid.uuid4(), user_id=user_id, name=f"{name} Voice",
            system_prompt=prompt, greeting_message="", is_active=True,
        )
    else:
        raise HTTPException(status_code=400, detail="invalid_assistant_type")
    db.add(va)
    db.flush()
    return va


def _agent_to_dict(agent: AgentConfig) -> dict:
    """Serialize AgentConfig to dict for API response."""
    voice = agent.get_voice_assistant() if agent.assistant_type else agent.gemini_assistant
    voice_name = voice.name if voice else None

    return {
        "id": str(agent.id),
        "user_id": str(agent.user_id),
        "assistant_type": agent.assistant_type,
        "assistant_id": str(agent.get_voice_assistant_id()) if agent.get_voice_assistant_id() else None,
        "gemini_assistant_id": str(agent.gemini_assistant_id) if agent.gemini_assistant_id else None,
        "openai_assistant_id": str(agent.openai_assistant_id) if agent.openai_assistant_id else None,
        "cartesia_assistant_id": str(agent.cartesia_assistant_id) if agent.cartesia_assistant_id else None,
        "voice_assistant_name": voice_name,
        "gemini_assistant_name": voice_name,  # backward-compat for older frontend
        "name": agent.name,
        "is_active": agent.is_active,
        "orchestrator_model": agent.orchestrator_model,
        "orchestrator_prompt": agent.orchestrator_prompt,
        "uses_hardcoded_prompt": agent.uses_hardcoded_prompt,
        "doc_who_am_i": agent.doc_who_am_i,
        "doc_who_we_call": agent.doc_who_we_call,
        "doc_how_we_talk": agent.doc_how_we_talk,
        "doc_what_we_offer": agent.doc_what_we_offer,
        "doc_rules_and_goals": agent.doc_rules_and_goals,
        "additional_instructions": agent.additional_instructions,
        "working_hours_start": agent.working_hours_start,
        "working_hours_end": agent.working_hours_end,
        "default_caller_id": agent.default_caller_id,
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
        "updated_at": agent.updated_at.isoformat() if agent.updated_at else None,
    }


# ============================================================================
# ENDPOINTS — AGENT CRUD
# ============================================================================


def _resolve_agent(db: Session, user: User, agent_id: Optional[str] = None) -> Optional[AgentConfig]:
    """
    Вернуть конкретного агента пользователя.
    Если agent_id задан — ищем именно его (в пределах user_id, чужой → None).
    Иначе — первого по дате создания (обратная совместимость с одним агентом).
    """
    q = db.query(AgentConfig).filter(AgentConfig.user_id == user.id)
    if agent_id:
        return q.filter(AgentConfig.id == agent_id).first()
    return q.order_by(AgentConfig.created_at.asc()).first()


@router.get("/list")
async def list_agents(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Список всех агентов пользователя (для меню выбора агента)."""
    agents = (
        db.query(AgentConfig)
        .filter(AgentConfig.user_id == current_user.id)
        .order_by(AgentConfig.created_at.asc())
        .all()
    )
    return {
        "total": len(agents),
        "max_agents": MAX_AGENTS_PER_USER,
        "can_create_more": len(agents) < MAX_AGENTS_PER_USER and current_user.has_agent_access(),
        "has_agent_access": current_user.has_agent_access(),
        "agents": [_agent_to_dict(a) for a in agents],
    }


@router.get("/")
async def get_agent(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get one of the user's AgentConfigs (defaults to the first one)."""
    agent = _resolve_agent(db, current_user, agent_id)

    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    return _agent_to_dict(agent)


@router.post("/create")
async def create_agent(
    body: AgentCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new Voicyfy Agent v3.0 (one per user). No gpt-4o-mini generation."""
    # 1. Validate assistant_type
    if body.assistant_type not in VALID_ASSISTANT_TYPES:
        raise HTTPException(status_code=400, detail="invalid_assistant_type")

    # 2. Validate orchestrator_model
    orchestrator_model = body.orchestrator_model or get_default_model()
    if not is_valid_model(orchestrator_model):
        raise HTTPException(status_code=400, detail="invalid_orchestrator_model")

    # 3. Telephony must be verified
    _check_telephony_verified(current_user, db)

    # 4. Required API keys for the chosen assistant type
    _check_assistant_keys(body.assistant_type, current_user)

    # 5. До MAX_AGENTS_PER_USER агентов на пользователя
    agents_count = db.query(AgentConfig).filter(
        AgentConfig.user_id == current_user.id
    ).count()
    if agents_count >= MAX_AGENTS_PER_USER:
        raise HTTPException(status_code=400, detail="agent_limit_reached")

    # 5b. Гейтинг доступа к агенту (v3.1): тестовый период / profi / legacy agent.
    #     Если триал уже использован и доступа нет — требуется тариф profi.
    #     Проверяем ДО создания, чтобы не оставлять «висячий» агент при 402.
    if current_user.agent_trial_used and not current_user.has_agent_access():
        raise HTTPException(status_code=402, detail="subscription_required")

    # 6. Create the voice assistant with the hardcoded base prompt
    voice_assistant = _create_voice_assistant(
        body.assistant_type, body.name, current_user.id, db
    )

    # 7. Create the AgentConfig (uses_hardcoded_prompt = TRUE, no orchestrator_prompt)
    agent = AgentConfig(
        id=uuid.uuid4(),
        user_id=current_user.id,
        name=body.name,
        assistant_type=body.assistant_type,
        gemini_assistant_id=voice_assistant.id if body.assistant_type == "gemini" else None,
        openai_assistant_id=voice_assistant.id if body.assistant_type == "openai" else None,
        cartesia_assistant_id=voice_assistant.id if body.assistant_type == "cartesia" else None,
        is_active=True,
        orchestrator_model=orchestrator_model,
        orchestrator_prompt=None,  # собирается на лету из захардкоженного шаблона
        doc_who_am_i=body.doc_who_am_i,
        doc_who_we_call=body.doc_who_we_call,
        doc_how_we_talk=body.doc_how_we_talk,
        doc_what_we_offer=body.doc_what_we_offer,
        doc_rules_and_goals=body.doc_rules_and_goals,
        additional_instructions=body.additional_instructions,
        working_hours_start=body.working_hours_start,
        working_hours_end=body.working_hours_end,
        uses_hardcoded_prompt=True,
        chat_history=[],
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)

    # 8. Активируем бесплатный trial тарифа agent при ПЕРВОМ создании
    #    (3 дня + 1500 кредитов). Если trial уже был — не выдаём повторно.
    trial_activated = False
    try:
        trial_activated = activate_agent_trial(db, current_user)
        if trial_activated:
            db.refresh(current_user)
    except Exception as e:
        logger.error(f"[AGENT] Trial activation failed for user {current_user.id}: {e}", exc_info=True)

    logger.info(
        f"[AGENT] Created v3 agent '{body.name}' ({body.assistant_type}) for user {current_user.id} "
        f"(trial_activated={trial_activated})"
    )
    result = _agent_to_dict(agent)
    result["trial_activated"] = trial_activated
    result["agent_trial_used"] = bool(current_user.agent_trial_used)
    return result


@router.put("/")
async def update_agent(
    body: AgentUpdateRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update the agent's documents and settings."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    update_data = body.dict(exclude_unset=True)

    # ── Смена типа голосового ассистента ──
    new_type = update_data.get("assistant_type")
    if new_type and new_type != agent.assistant_type:
        if new_type not in VALID_ASSISTANT_TYPES:
            raise HTTPException(status_code=400, detail="invalid_assistant_type")
        _check_assistant_keys(new_type, current_user)
        # Create new voice assistant; keep old one (numbers/history may reference it),
        # just clear the old FK.
        new_voice = _create_voice_assistant(new_type, agent.name, current_user.id, db)
        agent.gemini_assistant_id = None
        agent.openai_assistant_id = None
        agent.cartesia_assistant_id = None
        if new_type == "gemini":
            agent.gemini_assistant_id = new_voice.id
        elif new_type == "openai":
            agent.openai_assistant_id = new_voice.id
        elif new_type == "cartesia":
            agent.cartesia_assistant_id = new_voice.id
        agent.assistant_type = new_type
        logger.info(f"[AGENT] Switched assistant_type to {new_type} for user {current_user.id}")

    # ── Смена модели оркестратора ──
    if "orchestrator_model" in update_data and update_data["orchestrator_model"]:
        if not is_valid_model(update_data["orchestrator_model"]):
            raise HTTPException(status_code=400, detail="invalid_orchestrator_model")
        agent.orchestrator_model = update_data["orchestrator_model"]

    docs_changed = False
    doc_fields = ['doc_who_am_i', 'doc_who_we_call', 'doc_how_we_talk',
                  'doc_what_we_offer', 'doc_rules_and_goals']

    for field in doc_fields:
        if field in update_data and update_data[field] is not None:
            setattr(agent, field, update_data[field])
            docs_changed = True

    for field in ['name', 'additional_instructions', 'working_hours_start',
                  'working_hours_end', 'is_active', 'default_caller_id']:
        if field in update_data:
            setattr(agent, field, update_data[field])

    # ── Регенерация промпта через gpt-4o-mini — ТОЛЬКО для старых агентов ──
    if docs_changed and not agent.uses_hardcoded_prompt:
        if not current_user.openai_api_key:
            raise HTTPException(status_code=400, detail="openai_key_required")
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
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Полное удаление ОДНОГО агента и связанных с ним данных:
    - tasks этого агента (по его контактам + его «сироты»)
    - agent_calls и agent_contacts (каскадятся через FK AgentConfig)
    - AgentConfig
    - голосовой ассистент(ы), привязанные именно к этому агенту
    """
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    summary = {"tasks": 0, "voice_assistants": 0}

    try:
        # id контактов этого агента — чтобы удалить только его задачи,
        # не задев задачи других агентов того же пользователя.
        contact_ids = [
            row[0] for row in db.query(AgentContact.id).filter(
                AgentContact.agent_config_id == agent.id
            ).all()
        ]

        # 0. Считаем SCHEDULED-задачи этого агента ДО удаления — для журнала.
        task_filter = [
            Task.user_id == current_user.id,
            Task.is_agent_task == True,
        ]
        if contact_ids:
            task_filter.append(Task.agent_contact_id.in_(contact_ids))
        else:
            # У агента нет контактов → нет привязанных задач для удаления.
            task_filter.append(Task.agent_contact_id.is_(None))
            task_filter.append(Task.id.is_(None))  # фактически пусто

        scheduled_count = db.query(Task).filter(
            *task_filter, Task.status == TaskStatus.SCHEDULED,
        ).count()

        # Логируем факт удаления агента (баланс кредитов НЕ меняется).
        from backend.models.credit_transaction import CreditTransaction, CreditTransactionType
        db.add(CreditTransaction(
            user_id=current_user.id,
            type=CreditTransactionType.MANUAL_ADJUST.value,
            amount=0,
            balance_after=current_user.credits_balance or 0,
            ref_type="agent_deleted",
            ref_id=agent.id,
            notes=(
                f"Agent {agent.id} deleted by user. Tasks cancelled: {scheduled_count}. "
                f"Credits balance preserved: {current_user.credits_balance}."
            ),
        ))

        # 1. tasks этого агента ПЕРВЫМИ (иначе ON DELETE SET NULL осиротит их).
        if contact_ids:
            summary["tasks"] = db.query(Task).filter(
                Task.user_id == current_user.id,
                Task.is_agent_task == True,
                Task.agent_contact_id.in_(contact_ids),
            ).delete(synchronize_session=False)

        # 2. Голосовые ассистенты, привязанные именно к этому агенту.
        va_total = 0
        va_targets = [
            (GeminiAssistantConfig, agent.gemini_assistant_id),
            (AssistantConfig, agent.openai_assistant_id),
            (CartesiaAssistantConfig, agent.cartesia_assistant_id),
        ]

        # 3. AgentConfig — каскадом уносит agent_contacts и agent_calls.
        db.delete(agent)
        db.flush()

        for model_cls, va_id in va_targets:
            if va_id:
                va_total += db.query(model_cls).filter(
                    model_cls.id == va_id,
                    model_cls.user_id == current_user.id,
                ).delete(synchronize_session=False)
        summary["voice_assistants"] = va_total

        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"[AGENT] Delete failed for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"delete_failed: {str(e)}")

    logger.info(
        f"[AGENT] Fully deleted agent for user {current_user.id}: "
        f"{summary['tasks']} tasks, {summary['voice_assistants']} voice assistants"
    )
    return {"detail": "deleted", "summary": summary}


# ============================================================================
# ENDPOINTS — CHAT (ChatOrchestrator with tools)
# ============================================================================


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Text chat with the agent. v3 → OpenRouter, v2 (legacy) → OpenAI Responses API."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    # Legacy agents still need the user's OpenAI key
    if not agent.uses_hardcoded_prompt and not current_user.openai_api_key:
        raise HTTPException(status_code=400, detail="openai_key_required")

    from backend.services.agent_orchestrator import ChatOrchestrator

    try:
        orchestrator = ChatOrchestrator()
        result = await orchestrator.run(
            message=body.message,
            agent_config=agent,
            user=current_user,
            db=db,
        )
    except SubscriptionExpiredError:
        raise HTTPException(status_code=402, detail="subscription_expired")
    except SubscriptionRequiredError:
        raise HTTPException(status_code=402, detail="subscription_required")
    except InsufficientCreditsError as e:
        raise HTTPException(status_code=402, detail={
            "error": "insufficient_credits",
            "required": e.required,
            "available": e.available,
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[AGENT] Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"chat_error: {str(e)}")

    return {
        "reply": result["reply"],
        "timestamp": datetime.utcnow().isoformat(),
        "debug_log": result.get("debug_log", []),
    }


@router.post("/chat/stream")
async def agent_chat_stream(
    body: AgentChatRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Streaming text chat (NDJSON) with live tool progress + token-by-token reply.
    Only v3 (hardcoded-prompt) agents stream. Legacy v2 → 409, the front falls
    back to the non-streaming /chat endpoint.
    """
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    # Legacy v2 agents don't stream — tell the front to use /chat fallback.
    if not getattr(agent, "uses_hardcoded_prompt", False):
        if not current_user.openai_api_key:
            raise HTTPException(status_code=400, detail="openai_key_required")
        raise HTTPException(status_code=409, detail="streaming_not_supported")

    # Subscription/credit precheck BEFORE the stream starts, so 402 returns as
    # an HTTP status (after 200 starts we could only emit an in-stream error).
    try:
        CreditService.precheck(db, current_user)
    except SubscriptionExpiredError:
        raise HTTPException(status_code=402, detail="subscription_expired")
    except SubscriptionRequiredError:
        raise HTTPException(status_code=402, detail="subscription_required")
    except InsufficientCreditsError as e:
        raise HTTPException(status_code=402, detail={
            "error": "insufficient_credits",
            "required": e.required,
            "available": e.available,
        })

    from backend.services.agent_orchestrator import ChatOrchestrator
    orchestrator = ChatOrchestrator()

    async def event_gen():
        try:
            async for ev in orchestrator.run_stream(body.message, agent, current_user, db):
                yield json.dumps(ev, ensure_ascii=False) + "\n"
        except (SubscriptionExpiredError, SubscriptionRequiredError, InsufficientCreditsError):
            # precheck already ran above; this path means a late check — surface in-stream.
            yield json.dumps({"type": "error", "detail": "payment_required", "code": 402}, ensure_ascii=False) + "\n"
        except Exception as e:
            logger.error(f"[AGENT] stream error: {e}", exc_info=True)
            yield json.dumps({"type": "error", "detail": f"chat_error: {e}"}, ensure_ascii=False) + "\n"

    return StreamingResponse(
        event_gen(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# ============================================================================
# ENDPOINTS — STATS
# ============================================================================


@router.get("/stats")
async def get_agent_stats(
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get agent statistics from AgentContact + AgentCall (scoped to one agent)."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    total_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.agent_config_id == agent.id
    ).scalar() or 0

    active_contacts = db.query(func.count(AgentContact.id)).filter(
        AgentContact.agent_config_id == agent.id,
        AgentContact.status.notin_(["rejected", "do_not_call"]),
    ).scalar() or 0

    total_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent.id
    ).scalar() or 0

    success_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent.id,
        AgentCall.post_call_decision == "SUCCESS",
    ).scalar() or 0

    followup_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent.id,
        AgentCall.post_call_decision == "FOLLOWUP",
    ).scalar() or 0

    no_answer_calls = db.query(func.count(AgentCall.id)).filter(
        AgentCall.agent_config_id == agent.id,
        AgentCall.post_call_decision.in_(["NO_ANSWER", "REJECTED"]),
    ).scalar() or 0

    scheduled_tasks = db.query(func.count(Task.id)).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(
        AgentContact.agent_config_id == agent.id,
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
# ENDPOINTS — ORCHESTRATOR MODELS
# ============================================================================


@router.get("/orchestrator-models")
async def get_orchestrator_models(
    current_user: User = Depends(get_current_user),
):
    """Return the list of available orchestrator models for the wizard select."""
    return {"models": ORCHESTRATOR_MODELS, "default": get_default_model()}


# ============================================================================
# ENDPOINTS — TASKS (upcoming scheduled calls for the dashboard)
# ============================================================================


@router.get("/tasks")
async def list_agent_tasks(
    status: Optional[str] = Query("scheduled"),
    limit: int = Query(10, ge=1, le=500),
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List the agent's upcoming tasks (with contact names) for the dashboard."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    q = db.query(Task).join(
        AgentContact, Task.agent_contact_id == AgentContact.id
    ).filter(
        Task.user_id == current_user.id,
        Task.is_agent_task == True,
        AgentContact.agent_config_id == agent.id,
    )
    if status:
        try:
            q = q.filter(Task.status == TaskStatus(status))
        except ValueError:
            q = q.filter(Task.status == status)

    tasks = q.order_by(Task.scheduled_time.asc()).limit(limit).all()

    # Resolve contact names in one pass
    contact_ids = [t.agent_contact_id for t in tasks if t.agent_contact_id]
    contacts_map = {}
    if contact_ids:
        rows = db.query(AgentContact).filter(AgentContact.id.in_(contact_ids)).all()
        contacts_map = {str(c.id): c for c in rows}

    result = []
    for t in tasks:
        c = contacts_map.get(str(t.agent_contact_id)) if t.agent_contact_id else None
        result.append({
            "id": str(t.id),
            "title": t.title,
            "description": t.description,
            "scheduled_time": iso_utc(t.scheduled_time),
            "status": t.status.value if hasattr(t.status, "value") else t.status,
            "contact_name": (c.name or c.phone) if c else None,
            "contact_phone": c.phone if c else None,
        })

    return {"total": len(result), "tasks": result}


@router.delete("/tasks/{task_id}")
async def delete_agent_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete a single agent task (manual removal from the calendar)."""
    task = db.query(Task).filter(
        Task.id == task_id,
        Task.user_id == current_user.id,
        Task.is_agent_task == True,
    ).first()
    if not task:
        raise HTTPException(status_code=404, detail="not_found")

    db.delete(task)
    db.commit()

    logger.info(f"[AGENT] Deleted task {task_id} for user {current_user.id}")
    return {"detail": "deleted"}


# ============================================================================
# ENDPOINTS — PHONE NUMBERS
# ============================================================================


@router.get("/phone-numbers")
async def get_phone_numbers(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get available phone numbers for caller_id selection."""
    from backend.models.voximplant_child import VoximplantChildAccount, VoximplantPhoneNumber

    numbers = []

    # 1. Partner integration — VoximplantPhoneNumber via child account
    child_account = None
    if hasattr(current_user, 'voximplant_child_account') and current_user.voximplant_child_account:
        child_account = current_user.voximplant_child_account

    if child_account and child_account.phone_numbers:
        for phone in child_account.phone_numbers:
            if phone.is_active:
                numbers.append({
                    "phone_number": phone.phone_number,
                    "region": phone.phone_region,
                    "source": phone.phone_source or "voximplant",
                    "is_active": True,
                })

    # 2. Legacy integration — caller_id from user config
    if not numbers and current_user.has_voximplant_config():
        vox_config = current_user.get_voximplant_config()
        if vox_config and vox_config.get("caller_id"):
            numbers.append({
                "phone_number": vox_config["caller_id"],
                "region": None,
                "source": "legacy",
                "is_active": True,
            })

    return {"phone_numbers": numbers}


# ============================================================================
# ENDPOINTS — CONTACTS
# ============================================================================


@router.get("/contacts")
async def list_agent_contacts(
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None, description="Поиск по name или phone (ILIKE)"),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List agent contacts with optional status and search filter."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    q = db.query(AgentContact).filter(AgentContact.agent_config_id == agent.id)
    if status:
        q = q.filter(AgentContact.status == status)
    if search:
        pattern = f"%{search.strip()}%"
        q = q.filter(
            or_(
                AgentContact.name.ilike(pattern),
                AgentContact.phone.ilike(pattern),
                AgentContact.company.ilike(pattern),
            )
        )

    total = q.count()
    contacts = q.order_by(AgentContact.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total": total,
        "contacts": [c.to_dict() for c in contacts],
    }


@router.get("/contacts/{contact_id}")
async def get_agent_contact_details(
    contact_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Детали контакта + последние 20 звонков с транскриптами и размышлениями.
    Используется в модалке детального просмотра контакта.
    """
    contact = db.query(AgentContact).filter(
        AgentContact.id == contact_id,
        AgentContact.user_id == current_user.id,
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="not_found")

    calls = (
        db.query(AgentCall)
        .filter(AgentCall.agent_contact_id == contact_id)
        .order_by(AgentCall.created_at.desc())
        .limit(20)
        .all()
    )

    contact_data = contact.to_dict()
    contact_data["calls"] = [c.to_dict() for c in calls]
    return contact_data


@router.post("/contacts")
async def create_agent_contact(
    body: AgentContactCreateRequest,
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Manually add a contact and auto-schedule a first call in 1 hour."""
    agent = _resolve_agent(db, current_user, agent_id)
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

    # Auto-create first task in 1 hour, но прогоняем через ту же проверку
    # рабочих часов (МСК), что и массовый импорт — для унификации.
    scheduled_time, _shifted = adjust_to_working_hours(
        now_utc() + timedelta(hours=1),
        agent.working_hours_start,
        agent.working_hours_end,
    )

    # Auto-create first task (route assistant FK by agent type)
    task = Task(
        is_agent_task=True,
        agent_contact_id=contact.id,
        user_id=current_user.id,
        contact_id=None,
        status=TaskStatus.SCHEDULED,
        scheduled_time=scheduled_time,
        title=f"Первый звонок: {body.name or body.phone}",
        description=body.notes or "",
        **assistant_task_kwargs(agent),
    )
    db.add(task)
    db.commit()
    db.refresh(contact)

    logger.info(f"[AGENT] Created contact {contact.id} with auto-task for user {current_user.id}")
    return contact.to_dict()


@router.put("/contacts/{contact_id}")
async def update_agent_contact(
    contact_id: str,
    body: AgentContactUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Обновление полей контакта (вручную из UI или через тулзу агента)."""
    contact = db.query(AgentContact).filter(
        AgentContact.id == contact_id,
        AgentContact.user_id == current_user.id,
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="not_found")

    update_data = body.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(contact, field, value)

    db.commit()
    db.refresh(contact)
    logger.info(f"[AGENT] Updated contact {contact_id} fields: {list(update_data.keys())}")
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


@router.get("/pipeline/stages")
async def get_pipeline_stages(current_user: User = Depends(get_current_user)):
    """Справочник стадий воронки (фиксированный набор) — для канбана на фронте."""
    return {"stages": AGENT_CONTACT_STAGES}


@router.patch("/contacts/{contact_id}/status")
async def update_agent_contact_status(
    contact_id: str,
    body: AgentContactStatusRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ручной перевод контакта на стадию воронки (drag-drop в канбане / select в карточке)."""
    if not is_valid_stage(body.status):
        raise HTTPException(status_code=400, detail="invalid_stage")

    contact = db.query(AgentContact).filter(
        AgentContact.id == contact_id,
        AgentContact.user_id == current_user.id,
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="not_found")

    old_stage = contact.status
    contact.status = body.status
    db.commit()
    db.refresh(contact)
    logger.info(f"[AGENT] Contact {contact_id} stage {old_stage} -> {body.status} (manual)")
    return contact.to_dict()


# ============================================================================
# ENDPOINTS — CALLS
# ============================================================================


@router.get("/calls")
async def list_agent_calls(
    agent_contact_id: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    agent_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List agent calls with optional contact filter (scoped to one agent)."""
    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")

    # Показываем только ФИНАЛИЗИРОВАННЫЕ звонки — у которых PostCall завершился и
    # есть достоверный результат. Промежуточные статусы ('calling' — звонок идёт,
    # 'finalizing' — идёт пост-обработка) скрываем, чтобы в списке не появлялись
    # звонки без подтверждённой информации.
    FINALIZED_STATUSES = ["answered", "no_answer", "failed"]
    q = db.query(AgentCall).filter(
        AgentCall.agent_config_id == agent.id,
        AgentCall.status.in_(FINALIZED_STATUSES),
    )
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


# ============================================================================
# ENDPOINTS — CONTACTS BULK IMPORT (xlsx/csv)
# ============================================================================

XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)


@router.get("/contacts/import/template")
async def import_contacts_template(
    current_user: User = Depends(get_current_user),
):
    """Скачать xlsx-шаблон для импорта контактов (генерируется на лету)."""
    from backend.services.contact_import_service import generate_template_xlsx

    content = generate_template_xlsx()
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="contacts_template.xlsx"'},
    )


@router.post("/contacts/import/preview")
async def import_contacts_preview(
    file: UploadFile = File(...),
    agent_id: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Загрузка файла, парсинг и валидация БЕЗ записи в БД."""
    from backend.services.contact_import_service import (
        parse_file, assign_schedule, save_preview,
        MAX_IMPORT_ROWS, CREDITS_PER_CONTACT,
    )

    agent = _resolve_agent(db, current_user, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")

    content = await file.read()
    try:
        parsed = parse_file(file.filename or "", content)
    except ValueError:
        raise HTTPException(status_code=400, detail="unsupported_format")
    except Exception as e:
        logger.error(f"[AGENT-IMPORT] Parse failed for user {current_user.id}: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail="parse_failed")

    total_rows = parsed["total_rows"]
    if total_rows > MAX_IMPORT_ROWS:
        raise HTTPException(status_code=400, detail="exceed_limit")

    rows = parsed["rows"]
    errors = list(parsed["errors"])

    # Дубликаты: в пределах файла + уже существующие в базе этого агента
    existing_phones = {
        row[0] for row in db.query(AgentContact.phone).filter(
            AgentContact.agent_config_id == agent.id
        ).all()
    }

    duplicates: List[dict] = []
    unique_rows: List[dict] = []
    seen = set()
    for r in rows:
        ph = r["phone"]
        if ph in existing_phones or ph in seen:
            duplicates.append({"row": r["row"], "phone": ph})
            continue
        seen.add(ph)
        unique_rows.append(r)

    # Распределение времени + проверка рабочих часов
    shifted = assign_schedule(
        unique_rows,
        agent.working_hours_start,
        agent.working_hours_end,
        base_utc=now_utc(),
    )

    valid_rows = len(unique_rows)
    credits_required = valid_rows * CREDITS_PER_CONTACT
    credits_available = current_user.credits_balance or 0

    blocked_reasons: List[str] = []
    if valid_rows == 0:
        blocked_reasons.append("no_valid_rows")
    if credits_required > credits_available:
        blocked_reasons.append("insufficient_credits")
    can_proceed = len(blocked_reasons) == 0

    token = save_preview({
        "agent_id": str(agent.id),
        "user_id": str(current_user.id),
        "rows": unique_rows,
        "errors": errors,
        "duplicates": duplicates,
    })

    logger.info(
        f"[AGENT-IMPORT] Preview for user {current_user.id}: total={total_rows}, "
        f"valid={valid_rows}, errors={len(errors)}, duplicates={len(duplicates)}, shifted={shifted}"
    )

    return {
        "preview_token": token,
        "total_rows": total_rows,
        "valid_rows": valid_rows,
        "errors": errors,
        "duplicates": duplicates,
        "shifted_to_working_hours": shifted,
        "credits_required_estimate": credits_required,
        "credits_available": credits_available,
        "can_proceed": can_proceed,
        "blocked_reasons": blocked_reasons,
    }


async def _run_contacts_import(preview_token: str, agent_id: str, user_id: str):
    """
    Фоновый импорт: создаёт AgentContact + Task пачками по 50.
    Открывает собственную сессию БД — безопасно для BackgroundTasks.
    """
    from backend.services.contact_import_service import load_preview, delete_preview

    db = SessionLocal()
    try:
        data = load_preview(preview_token)
        if not data:
            logger.error(f"[AGENT-IMPORT] Preview {preview_token} expired/not found")
            return
        if data.get("user_id") != str(user_id):
            logger.error(f"[AGENT-IMPORT] Preview ownership mismatch for {preview_token}")
            return

        agent = db.query(AgentConfig).filter(
            AgentConfig.id == agent_id,
            AgentConfig.user_id == user_id,
        ).first()
        if not agent:
            logger.error(f"[AGENT-IMPORT] Agent {agent_id} not found for import")
            return

        rows = data.get("rows", [])
        task_kwargs = assistant_task_kwargs(agent)

        # Повторный дедуп против БД (на случай изменений между preview и execute)
        existing_phones = {
            row[0] for row in db.query(AgentContact.phone).filter(
                AgentContact.agent_config_id == agent.id
            ).all()
        }

        created_contacts = 0
        created_tasks = 0
        batch = 0

        for r in rows:
            phone = r["phone"]
            if phone in existing_phones:
                continue
            existing_phones.add(phone)

            name = r.get("name")
            notes = r.get("notes")
            contact = AgentContact(
                agent_config_id=agent.id,
                user_id=user_id,
                name=name,
                phone=phone,
                company=r.get("company"),
                position=r.get("position"),
                notes=notes,
                status="new",
                memory={},
            )
            db.add(contact)
            db.flush()
            created_contacts += 1

            # scheduled_time_utc — ISO-строка с UTC-маркером
            try:
                scheduled_time = datetime.fromisoformat(r["scheduled_time_utc"])
            except (ValueError, KeyError, TypeError):
                scheduled_time = now_utc() + timedelta(hours=1)

            task = Task(
                is_agent_task=True,
                agent_contact_id=contact.id,
                user_id=user_id,
                contact_id=None,
                status=TaskStatus.SCHEDULED,
                scheduled_time=scheduled_time,
                title=r.get("task_title") or f"Первый звонок: {name or phone}",
                description=r.get("task_description") or notes or "",
                **task_kwargs,
            )
            db.add(task)
            created_tasks += 1

            batch += 1
            if batch >= 50:
                db.commit()
                batch = 0

        db.commit()
        delete_preview(preview_token)

        logger.info(
            f"[AGENT-IMPORT] ✅ Import done for user {user_id}: "
            f"{created_contacts} contacts, {created_tasks} tasks"
        )

        # Telegram-уведомление владельцу (если настроен личный бот)
        user = db.query(User).filter(User.id == user_id).first()
        if user and user.telegram_bot_token and user.telegram_chat_id:
            try:
                from backend.services.telegram_notification import TelegramNotificationService
                text = (
                    f"🤖 <b>Voicyfy Agent</b>\n\n"
                    f"Импорт контактов завершён.\n"
                    f"Создано контактов: <b>{created_contacts}</b>\n"
                    f"Запланировано звонков: <b>{created_tasks}</b>"
                )
                await TelegramNotificationService.send_message(
                    user.telegram_bot_token, user.telegram_chat_id, text
                )
            except Exception as te:
                logger.warning(f"[AGENT-IMPORT] Telegram notify failed: {te}")

    except Exception as e:
        db.rollback()
        logger.error(f"[AGENT-IMPORT] Import failed for user {user_id}: {e}", exc_info=True)
    finally:
        db.close()


@router.post("/contacts/import/execute")
async def import_contacts_execute(
    body: ImportExecuteRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Подтверждение импорта — запускает создание контактов в фоне."""
    from backend.services.contact_import_service import load_preview, CREDITS_PER_CONTACT

    data = load_preview(body.preview_token)
    if not data:
        raise HTTPException(status_code=404, detail="preview_expired")
    if data.get("user_id") != str(current_user.id):
        raise HTTPException(status_code=403, detail="forbidden")

    agent = _resolve_agent(db, current_user, body.agent_id or data.get("agent_id"))
    if not agent:
        raise HTTPException(status_code=404, detail="agent_not_found")

    rows = data.get("rows", [])
    if not rows:
        raise HTTPException(status_code=400, detail="no_valid_rows")

    # Финальная проверка баланса кредитов
    credits_required = len(rows) * CREDITS_PER_CONTACT
    if credits_required > (current_user.credits_balance or 0):
        raise HTTPException(status_code=402, detail={
            "error": "insufficient_credits",
            "required": credits_required,
            "available": current_user.credits_balance or 0,
        })

    background_tasks.add_task(
        _run_contacts_import, body.preview_token, str(agent.id), str(current_user.id)
    )

    estimated = max(5, len(rows) // 10)
    logger.info(f"[AGENT-IMPORT] Execute started for user {current_user.id}: {len(rows)} rows")
    return {"status": "started", "estimated_seconds": estimated, "total": len(rows)}


@router.get("/contacts/import/errors/{preview_token}")
async def import_contacts_errors(
    preview_token: str,
    current_user: User = Depends(get_current_user),
):
    """Скачать xlsx с проблемными строками для исправления."""
    from backend.services.contact_import_service import load_preview, generate_errors_xlsx

    data = load_preview(preview_token)
    if not data:
        raise HTTPException(status_code=404, detail="preview_expired")
    if data.get("user_id") != str(current_user.id):
        raise HTTPException(status_code=403, detail="forbidden")

    content = generate_errors_xlsx(data.get("errors", []))
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="import_errors.xlsx"'},
    )
