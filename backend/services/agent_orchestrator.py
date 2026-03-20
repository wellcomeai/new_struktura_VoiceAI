"""
Agent Orchestrator v2.1 — PreCall, PostCall, and Chat phases for Voicyfy Agent.
Uses OpenAI Responses API (gpt-5) with store=True for conversation continuity.
PostCall now uses AGENT_POSTCALL_TOOLS instead of JSON parsing.
ChatOrchestrator uses AGENT_CHAT_TOOLS for multi-turn dialog.

✅ v2.1 CHANGES:
- PostCall: поиск транскрипта по номеру телефона + временное окно (вместо session_id)
- PreCall:  сохраняет precall_log в agent_calls (стратегия, тон, ключевые факты)
- PostCall: сохраняет postcall_log в agent_calls (все tool calls + финальное решение)
- PostCall: задача на перезвон ВСЕГДА создаётся (это константа)
"""

import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

from openai import AsyncOpenAI

from sqlalchemy.orm.attributes import flag_modified

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.agent_config import AgentConfig
from backend.models.agent_contact import AgentContact
from backend.models.agent_call import AgentCall
from backend.models.task import Task, TaskStatus
from backend.models.conversation import Conversation
from backend.models.user import User
from backend.services.agent_tools import (
    AGENT_CHAT_TOOLS,
    AGENT_POSTCALL_TOOLS,
    execute_tool,
)

logger = get_logger(__name__)


CHAT_META_PROMPT = """# РОЛЬ
Ты — AI-оркестратор системы автономных звонков Voicyfy. Ты являешься центральным мозгом системы: управляешь базой контактов, планируешь звонки, анализируешь результаты и отвечаешь владельцу бизнеса на вопросы о работе агента. Ты общаешься с пользователем через текстовый чат.

# МЫШЛЕНИЕ (думай пошагово перед каждым ответом)
1. Определи — нужен ли tool для ответа на вопрос пользователя
2. Если вопрос касается контактов / задач / звонков / статистики — ВСЕГДА вызови tool первым
3. Получи реальные данные из БД → проанализируй → ответь на их основе
4. Никогда не выдумывай данные — только из tools

# ИНСТРУМЕНТЫ И КОГДА ИХ ИСПОЛЬЗОВАТЬ
- get_agent_contacts — когда спрашивают о контактах, их статусах, количестве, списке
- get_agent_tasks — когда спрашивают о задачах, расписании, следующих звонках по контакту
- get_contact_call_history — когда спрашивают об истории звонков конкретного контакта
- get_agent_stats — когда спрашивают о статистике, результатах, эффективности агента
- create_agent_contact — когда просят добавить новый контакт в базу обзвона
- create_agent_task — когда просят запланировать звонок
  → ОБЯЗАТЕЛЬНО перед созданием: вызови get_agent_tasks(agent_contact_id=..., status_filter="scheduled")
  → Если уже есть задача в статусе scheduled — сообщи пользователю, не создавай дубль

# ПРАВИЛА РАБОТЫ С ЗАДАЧАМИ
- Перед созданием новой задачи — всегда проверяй существующие через get_agent_tasks
- Если уже есть SCHEDULED задача по контакту — сообщи об этом пользователю
- Система автоматически отменяет старые задачи при создании новой

# ПРАВИЛА ОТВЕТОВ
- Отвечай кратко и по делу на русском языке
- Приводи конкретные данные: имена, номера, даты, статусы
- Если данных нет в БД — скажи прямо, не додумывай
- Предлагай следующий шаг если это уместно

# КОНТЕКСТ БИЗНЕСА ПОЛЬЗОВАТЕЛЯ (ниже)
---
"""

CHAT_SUFFIX = "\n---\nВыше — контекст бизнеса пользователя. Используй его для понимания продукта, целевой аудитории и стиля общения при планировании и анализе звонков."


# ============================================================================
# PRE-CALL ORCHESTRATOR
# ============================================================================

class PreCallOrchestrator:
    """Prepares call strategy using gpt-5 Responses API."""

    async def run(
        self,
        task: Task,
        agent_contact: AgentContact,
        agent_call: AgentCall,
        agent_config: AgentConfig,
        user: User,
        db
    ) -> Dict[str, Any]:
        """
        Run PreCall phase: generate first_phrase and call strategy.
        Returns dict with: first_phrase, call_strategy, tone, key_points
        """
        logger.info(f"[AGENT-PRECALL] Starting for task {task.id}, contact {agent_contact.name or agent_contact.phone}")

        client = AsyncOpenAI(api_key=user.openai_api_key)

        memory_json = json.dumps(agent_contact.memory or {}, ensure_ascii=False)

        previous_calls = (
            db.query(AgentCall)
            .filter(AgentCall.agent_contact_id == agent_contact.id)
            .order_by(AgentCall.created_at.desc())
            .limit(5)
            .all()
        )

        calls_context = ""
        for pc in reversed(previous_calls):
            calls_context += f"\n--- Звонок {pc.created_at.strftime('%Y-%m-%d %H:%M') if pc.created_at else '?'} ---\n"
            calls_context += f"Статус: {pc.status}, Решение: {pc.post_call_decision or 'N/A'}\n"
            if pc.transcript:
                calls_context += f"Транскрипт: {pc.transcript[:500]}\n"

        pre_call_input = f"""ЗАДАЧА: {task.title}
ОПИСАНИЕ: {task.description or 'Нет описания'}
КОНТАКТ: {agent_contact.name or 'Неизвестный'} ({agent_contact.phone})
КОМПАНИЯ: {agent_contact.company or 'Не указана'}
ДОЛЖНОСТЬ: {agent_contact.position or 'Не указана'}
ПАМЯТЬ О КОНТАКТЕ: {memory_json}
ПОПЫТКА: {agent_contact.attempts_count + 1}

ПРЕДЫДУЩИЕ ЗВОНКИ:
{calls_context or 'Нет предыдущих звонков'}

Подготовь звонок. Верни JSON:
{{
  "first_phrase": "точная первая фраза агента",
  "call_strategy": "краткое описание тактики",
  "tone": "дружелюбный/деловой/настойчивый",
  "key_points": ["факт1", "факт2"]
}}"""

        try:
            response = await client.responses.create(
                model="gpt-5-2025-08-07",
                instructions=agent_config.orchestrator_prompt or "",
                input=pre_call_input,
                store=True,
            )

            output_text = response.output_text
            logger.info(f"[AGENT-PRECALL] Raw response: {output_text[:200]}")

            json_text = output_text
            if "```json" in json_text:
                json_text = json_text.split("```json")[1].split("```")[0]
            elif "```" in json_text:
                json_text = json_text.split("```")[1].split("```")[0]

            result = json.loads(json_text.strip())

            agent_call.pre_call_response_id = response.id
            agent_call.custom_greeting = result.get("first_phrase", "")
            agent_call.call_strategy = result.get("call_strategy", "")

            # ✅ v2.1: Сохраняем precall_log
            agent_call.precall_log = {
                "response_id": response.id,
                "model": "gpt-5-2025-08-07",
                "first_phrase": result.get("first_phrase", ""),
                "call_strategy": result.get("call_strategy", ""),
                "tone": result.get("tone", ""),
                "key_points": result.get("key_points", []),
                "attempts_before": agent_contact.attempts_count,
                "memory_snapshot": agent_contact.memory or {},
                "generated_at": datetime.utcnow().isoformat(),
            }

            task.pre_call_response_id = response.id
            task.custom_greeting = result.get("first_phrase", "")
            db.commit()

            logger.info(f"[AGENT-PRECALL] ✅ Success. Strategy: {result.get('call_strategy', '')[:80]}")
            logger.info(f"[AGENT-PRECALL] precall_log saved to agent_call {agent_call.id}")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"[AGENT-PRECALL] JSON parse error: {e}")
            agent_call.pre_call_response_id = response.id if 'response' in dir() else None
            agent_call.custom_greeting = output_text[:200] if 'output_text' in dir() else ""
            agent_call.precall_log = {
                "error": "json_parse_error",
                "raw_output": output_text[:500] if 'output_text' in dir() else "",
                "generated_at": datetime.utcnow().isoformat(),
            }
            task.pre_call_response_id = agent_call.pre_call_response_id
            task.custom_greeting = agent_call.custom_greeting
            db.commit()
            return {"first_phrase": agent_call.custom_greeting, "call_strategy": "fallback", "tone": "деловой", "key_points": []}

        except Exception as e:
            logger.error(f"[AGENT-PRECALL] Error: {e}", exc_info=True)
            raise


# ============================================================================
# POST-CALL ORCHESTRATOR
# ============================================================================

class PostCallOrchestrator:
    """Analyzes call results using GPT-5 with AGENT_POSTCALL_TOOLS."""

    @staticmethod
    def _find_transcript_by_phone(
        db,
        phone: str,
        call_time: datetime,
        window_minutes_before: int = 2,
        window_minutes_after: int = 20,
    ) -> List[Conversation]:
        """
        ✅ v2.1 FIX: Поиск транскрипта по номеру телефона + временное окно.

        Проблема была:
        - agent_calls.call_session_id = "4489857542" (Voximplant History ID)
        - conversations.session_id    = "vox_abc123" (UUID из сценария)
        Они никогда не совпадали → "транскрипт недоступен".

        Решение: ищем по последним 10 цифрам номера + временному окну.
        """
        phone_suffix = phone[-10:] if len(phone) >= 10 else phone

        time_from = call_time - timedelta(minutes=window_minutes_before)
        time_to = call_time + timedelta(minutes=window_minutes_after)

        convs = db.query(Conversation).filter(
            Conversation.caller_number.like(f"%{phone_suffix}%"),
            Conversation.created_at >= time_from,
            Conversation.created_at <= time_to,
        ).order_by(Conversation.created_at.asc()).all()

        return convs

    @staticmethod
    async def poll_and_run(
        agent_call_id: str,
        agent_config_id: str,
        user_openai_key: str,
        retries: int = 5,
        delay: int = 15
    ):
        """
        Poll for conversation transcript and run PostCall analysis.
        Opens its own DB session — safe for asyncio.create_task().
        """
        logger.info(f"[AGENT-POSTCALL] Starting poll for agent_call {agent_call_id}")

        db = SessionLocal()
        try:
            agent_call = db.query(AgentCall).filter(AgentCall.id == agent_call_id).first()
            if not agent_call:
                logger.error(f"[AGENT-POSTCALL] AgentCall {agent_call_id} not found")
                return

            agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            if not agent_config:
                logger.error(f"[AGENT-POSTCALL] AgentConfig {agent_config_id} not found")
                return

            agent_contact = db.query(AgentContact).filter(
                AgentContact.id == agent_call.agent_contact_id
            ).first()
            if not agent_contact:
                logger.error(f"[AGENT-POSTCALL] AgentContact not found for call {agent_call_id}")
                return

            user = db.query(User).filter(User.id == agent_call.user_id).first()

            task = None
            if agent_call.source_task_id:
                task = db.query(Task).filter(Task.id == agent_call.source_task_id).first()

            # Poll for transcript
            transcript = None
            call_status = "no_answer"
            duration_seconds = 0

            call_time = agent_call.started_at or agent_call.created_at

            for attempt in range(retries):
                await asyncio.sleep(delay)
                logger.info(f"[AGENT-POSTCALL] Poll attempt {attempt + 1}/{retries} for call {agent_call_id}")

                db.refresh(agent_call)

                # ============================================================
                # ✅ v2.1 FIX: Ищем по номеру + временному окну
                # ============================================================
                convs = PostCallOrchestrator._find_transcript_by_phone(
                    db=db,
                    phone=agent_contact.phone,
                    call_time=call_time,
                )

                # Fallback: старый поиск по session_id
                if not convs and agent_call.call_session_id:
                    convs = db.query(Conversation).filter(
                        Conversation.session_id == agent_call.call_session_id
                    ).all()
                    if convs:
                        logger.info(f"[AGENT-POSTCALL] Found via session_id fallback")

                if convs:
                    logger.info(f"[AGENT-POSTCALL] Found {len(convs)} record(s) for {agent_contact.phone}")
                    transcript_parts = []

                    for conv in convs:
                        if conv.client_info and isinstance(conv.client_info, dict):
                            dialog = conv.client_info.get("dialog", [])
                            for turn in dialog:
                                role = turn.get("role", "unknown")
                                text = turn.get("text", "")
                                if text:
                                    label = "Агент" if role == "assistant" else "Клиент"
                                    transcript_parts.append(f"{label}: {text}")

                        if conv.duration_seconds:
                            duration_seconds = max(duration_seconds, conv.duration_seconds or 0)

                    if transcript_parts:
                        transcript = "\n".join(transcript_parts)
                        call_status = "answered"
                        logger.info(f"[AGENT-POSTCALL] ✅ Found transcript ({len(transcript_parts)} turns)")
                        break
                    else:
                        logger.info(f"[AGENT-POSTCALL] Records found but no dialog turns yet, retrying...")
                else:
                    logger.info(f"[AGENT-POSTCALL] No records for {agent_contact.phone} in time window")

            if not transcript:
                call_status = "no_transcript"
                transcript = "(Транскрипт недоступен)"
                logger.warning(f"[AGENT-POSTCALL] No transcript found after {retries} attempts")

            orchestrator = PostCallOrchestrator()
            await orchestrator._analyze(
                agent_call=agent_call,
                agent_contact=agent_contact,
                agent_config=agent_config,
                user=user,
                task=task,
                transcript=transcript,
                call_status=call_status,
                duration_seconds=duration_seconds,
                openai_key=user_openai_key,
                db=db
            )

        except Exception as e:
            logger.error(f"[AGENT-POSTCALL] Fatal error: {e}", exc_info=True)
        finally:
            db.close()

    async def _analyze(
        self,
        agent_call: AgentCall,
        agent_contact: AgentContact,
        agent_config: AgentConfig,
        user: User,
        task: Optional[Task],
        transcript: str,
        call_status: str,
        duration_seconds: float,
        openai_key: str,
        db
    ):
        """Run PostCall analysis with gpt-5 using AGENT_POSTCALL_TOOLS."""
        logger.info(f"[AGENT-POSTCALL] Analyzing call {agent_call.id}")

        client = AsyncOpenAI(api_key=openai_key)

        previous_calls = (
            db.query(AgentCall)
            .filter(
                AgentCall.agent_contact_id == agent_contact.id,
                AgentCall.id != agent_call.id,
            )
            .order_by(AgentCall.created_at.desc())
            .limit(5)
            .all()
        )

        prev_calls_text = ""
        for pc in reversed(previous_calls):
            prev_calls_text += f"\n--- Звонок {pc.created_at.strftime('%Y-%m-%d %H:%M') if pc.created_at else '?'} ---\n"
            prev_calls_text += f"Решение: {pc.post_call_decision or 'N/A'}\n"
            if pc.transcript:
                prev_calls_text += f"Транскрипт: {pc.transcript[:300]}\n"

        memory_json = json.dumps(agent_contact.memory or {}, ensure_ascii=False)

        post_call_input = f"""КОНТАКТ: {agent_contact.name or 'Неизвестный'} ({agent_contact.phone})
КОМПАНИЯ: {agent_contact.company or 'Не указана'}
ПАМЯТЬ О КОНТАКТЕ: {memory_json}
ВСЕГО ПОПЫТОК: {agent_contact.attempts_count or 0}

ПРЕДЫДУЩИЕ ЗВОНКИ:
{prev_calls_text or 'Нет предыдущих звонков'}

ТЕКУЩИЙ ТРАНСКРИПТ ЗВОНКА:
{transcript}

СТАТУС ЗВОНКА: {call_status}
ДЛИТЕЛЬНОСТЬ: {duration_seconds}s
AGENT_CONTACT_ID: {str(agent_contact.id)}

Проанализируй звонок и выполни необходимые действия через tools:
1. ОБЯЗАТЕЛЬНО вызови update_contact_memory — обнови память о контакте.
2. ОБЯЗАТЕЛЬНО вызови create_agent_task — задача на перезвон создаётся ВСЕГДА.
   - Если клиент ответил — перезвони через разумное время (1-3 дня).
   - Если не ответил — перезвони через 24 часа.
   - Единственное исключение: клиент явно попросил НИКОГДА не звонить.
3. Если клиент явно попросил никогда не звонить — вызови set_contact_status(do_not_call)
   и НЕ создавай задачу.
4. Если нужно уведомить владельца (важный результат) — вызови send_telegram_notification.
5. Установи статус контакта через set_contact_status (active, success, rejected)."""

        # ✅ v2.1: Список для сбора всех tool calls
        tool_calls_log: List[Dict[str, Any]] = []
        postcall_response_id = None

        try:
            kwargs = {
                "model": "gpt-5-2025-08-07",
                "instructions": agent_config.orchestrator_prompt or "",
                "input": post_call_input,
                "tools": AGENT_POSTCALL_TOOLS,
                "store": True,
            }

            if agent_call.pre_call_response_id:
                kwargs["previous_response_id"] = agent_call.pre_call_response_id

            response = await client.responses.create(**kwargs)
            postcall_response_id = response.id

            context = {
                "agent_config_id": str(agent_call.agent_config_id),
                "user_id": str(agent_call.user_id),
                "user": user,
            }

            post_call_decision = None
            while True:
                has_tool_calls = False
                tool_results = []

                for item in response.output:
                    if item.type == "function_call":
                        has_tool_calls = True
                        tool_name = item.name
                        try:
                            tool_args = json.loads(item.arguments)
                        except json.JSONDecodeError:
                            tool_args = {}

                        logger.info(f"[AGENT-POSTCALL] Executing tool: {tool_name}({json.dumps(tool_args, ensure_ascii=False)[:200]})")

                        # ✅ v2.1: Начинаем запись tool entry
                        tool_entry = {
                            "tool": tool_name,
                            "args": tool_args,
                            "ts": datetime.utcnow().isoformat(),
                        }

                        result_str = await execute_tool(tool_name, tool_args, context, db)

                        # Парсим результат для лога
                        try:
                            tool_entry["result"] = json.loads(result_str)
                        except Exception:
                            tool_entry["result"] = result_str

                        tool_calls_log.append(tool_entry)

                        # Track decision
                        if tool_name == "set_contact_status":
                            status_val = tool_args.get("status", "")
                            if status_val == "do_not_call":
                                post_call_decision = "DO_NOT_CALL"
                            elif status_val == "success":
                                post_call_decision = "SUCCESS"
                            elif status_val == "rejected":
                                post_call_decision = "REJECTED"
                            else:
                                post_call_decision = post_call_decision or "FOLLOWUP"

                        if tool_name == "create_agent_task":
                            try:
                                result_data = json.loads(result_str)
                                if result_data.get("ok") and result_data.get("task_id"):
                                    agent_call.next_task_id = result_data["task_id"]
                            except Exception:
                                pass
                            if not post_call_decision:
                                post_call_decision = "FOLLOWUP"

                        tool_results.append({
                            "type": "function_call_output",
                            "call_id": item.call_id,
                            "output": result_str,
                        })

                    elif item.type == "message":
                        text_content = getattr(item, "text", "") or ""
                        if not text_content:
                            for part in getattr(item, "content", []):
                                if hasattr(part, "text"):
                                    text_content += part.text
                        logger.info(f"[AGENT-POSTCALL] GPT message: {text_content[:200]}")

                if not has_tool_calls:
                    break

                response = await client.responses.create(
                    model="gpt-5-2025-08-07",
                    input=tool_results,
                    previous_response_id=response.id,
                    tools=AGENT_POSTCALL_TOOLS,
                    store=True,
                )

            # Determine final decision
            if not post_call_decision:
                if call_status == "answered":
                    post_call_decision = "SUCCESS"
                else:
                    post_call_decision = "NO_ANSWER"

            # Update AgentCall
            agent_call.transcript = transcript
            agent_call.duration_seconds = int(duration_seconds)
            agent_call.status = "answered" if call_status == "answered" else "no_answer"
            agent_call.completed_at = datetime.utcnow()
            agent_call.post_call_decision = post_call_decision

            # ✅ v2.1: Сохраняем postcall_log
            agent_call.postcall_log = {
                "response_id": postcall_response_id,
                "model": "gpt-5-2025-08-07",
                "call_status": call_status,
                "duration_seconds": duration_seconds,
                "tool_calls": tool_calls_log,
                "final_decision": post_call_decision,
                "transcript_length": len(transcript),
                "analyzed_at": datetime.utcnow().isoformat(),
            }

            # Update AgentContact
            agent_contact.attempts_count = (agent_contact.attempts_count or 0) + 1
            agent_contact.last_called_at = datetime.utcnow()
            if agent_contact.status == "calling":
                agent_contact.status = "active"

            if task:
                task.post_call_decision = post_call_decision
                task.status = TaskStatus.COMPLETED

            flag_modified(agent_contact, 'memory')
            db.commit()
            logger.info(f"[AGENT-POSTCALL] ✅ Call {agent_call.id} completed: {post_call_decision}")
            logger.info(f"[AGENT-POSTCALL] postcall_log saved: {len(tool_calls_log)} tool calls")

        except Exception as e:
            logger.error(f"[AGENT-POSTCALL] Analysis error: {e}", exc_info=True)

            # ✅ v2.1: Сохраняем ошибку в лог
            agent_call.postcall_log = {
                "error": str(e),
                "call_status": call_status,
                "tool_calls": tool_calls_log,
                "analyzed_at": datetime.utcnow().isoformat(),
            }

            agent_call.status = "no_answer" if call_status != "answered" else "answered"
            agent_call.post_call_decision = "NO_ANSWER" if call_status != "answered" else "SUCCESS"
            agent_call.completed_at = datetime.utcnow()
            agent_call.transcript = transcript
            agent_call.duration_seconds = int(duration_seconds)
            agent_contact.attempts_count = (agent_contact.attempts_count or 0) + 1
            agent_contact.last_called_at = datetime.utcnow()
            if task:
                task.post_call_decision = agent_call.post_call_decision
                task.status = TaskStatus.COMPLETED
            flag_modified(agent_contact, 'memory')
            db.commit()


# ============================================================================
# CHAT ORCHESTRATOR
# ============================================================================

class ChatOrchestrator:
    """
    Handles text chat with the agent.
    Uses GPT-5 (Responses API) with AGENT_CHAT_TOOLS.
    Supports multi-turn dialog through previous_response_id.
    """

    @staticmethod
    def _now_ts() -> str:
        return datetime.utcnow().isoformat()

    async def run(
        self,
        message: str,
        agent_config: AgentConfig,
        user: User,
        db
    ) -> Dict[str, Any]:
        """
        Process a chat message with the agent.
        Returns dict with: reply (str), debug_log (list of log entries).
        """
        client = AsyncOpenAI(api_key=user.openai_api_key)
        debug_log: List[Dict[str, Any]] = []

        debug_log.append({
            "ts": self._now_ts(),
            "type": "user_message",
            "data": message,
        })

        last_response_id = None
        history = agent_config.chat_history or []
        for msg in reversed(history):
            if msg.get("response_id"):
                last_response_id = msg["response_id"]
                break

        instructions = CHAT_META_PROMPT + (agent_config.orchestrator_prompt or "") + CHAT_SUFFIX

        kwargs = {
            "model": "gpt-5-2025-08-07",
            "instructions": instructions,
            "input": message,
            "tools": AGENT_CHAT_TOOLS,
            "store": True,
        }

        if last_response_id:
            kwargs["previous_response_id"] = last_response_id

        debug_log.append({
            "ts": self._now_ts(),
            "type": "gpt_thinking",
            "data": f"model: gpt-5-2025-08-07, previous_response_id: {last_response_id or 'None'}, tools: {len(AGENT_CHAT_TOOLS)}, instructions length: {len(instructions)}",
        })

        try:
            response = await client.responses.create(**kwargs)
        except Exception as e:
            if last_response_id and "previous_response_id" in str(e).lower():
                logger.warning(f"[AGENT-CHAT] Stale response_id, retrying without chain: {e}")
                kwargs.pop("previous_response_id", None)
                debug_log.append({
                    "ts": self._now_ts(),
                    "type": "gpt_thinking",
                    "data": "Retrying without previous_response_id (stale chain)",
                })
                response = await client.responses.create(**kwargs)
            else:
                raise

        context = {
            "agent_config_id": str(agent_config.id),
            "user_id": str(user.id),
            "user": user,
        }

        max_iterations = 10
        iteration = 0
        while iteration < max_iterations:
            iteration += 1
            has_tool_calls = False
            tool_results = []

            for item in response.output:
                if item.type == "function_call":
                    has_tool_calls = True
                    tool_name = item.name
                    try:
                        tool_args = json.loads(item.arguments)
                    except json.JSONDecodeError:
                        tool_args = {}

                    debug_log.append({
                        "ts": self._now_ts(),
                        "type": "tool_call",
                        "data": {"tool": tool_name, "args": tool_args},
                    })

                    logger.info(f"[AGENT-CHAT] Executing tool: {tool_name}")
                    try:
                        result_str = await execute_tool(tool_name, tool_args, context, db)
                        try:
                            result_parsed = json.loads(result_str)
                        except (json.JSONDecodeError, TypeError):
                            result_parsed = result_str
                        debug_log.append({
                            "ts": self._now_ts(),
                            "type": "tool_result",
                            "data": {"tool": tool_name, "result": result_parsed},
                        })
                    except Exception as e:
                        result_str = json.dumps({"ok": False, "error": str(e)})
                        debug_log.append({
                            "ts": self._now_ts(),
                            "type": "tool_error",
                            "data": {"tool": tool_name, "error": str(e)},
                        })

                    tool_results.append({
                        "type": "function_call_output",
                        "call_id": item.call_id,
                        "output": result_str,
                    })

            if not has_tool_calls:
                break

            response = await client.responses.create(
                model="gpt-5-2025-08-07",
                input=tool_results,
                previous_response_id=response.id,
                tools=AGENT_CHAT_TOOLS,
                store=True,
            )

        final_text = ""
        for item in response.output:
            if item.type == "message":
                for part in getattr(item, "content", []):
                    if hasattr(part, "text"):
                        final_text += part.text

        if not final_text:
            final_text = response.output_text or "Готово."

        debug_log.append({
            "ts": self._now_ts(),
            "type": "gpt_response",
            "data": final_text[:500],
        })

        new_history = list(history)
        new_history.append({
            "role": "user",
            "content": message,
            "ts": datetime.utcnow().isoformat(),
        })
        new_history.append({
            "role": "assistant",
            "content": final_text,
            "ts": datetime.utcnow().isoformat(),
            "response_id": response.id,
        })
        agent_config.chat_history = new_history[-20:]
        db.commit()

        return {"reply": final_text, "debug_log": debug_log}
