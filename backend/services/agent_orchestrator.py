"""
Agent Orchestrator v2.0 — PreCall, PostCall, and Chat phases for Voicyfy Agent.
Uses OpenAI Responses API (gpt-5) with store=True for conversation continuity.
PostCall now uses AGENT_POSTCALL_TOOLS instead of JSON parsing.
ChatOrchestrator uses AGENT_CHAT_TOOLS for multi-turn dialog.
"""

import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

from openai import AsyncOpenAI

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


CHAT_SUFFIX = """

Ты общаешься с пользователем через текстовый чат.
У тебя есть инструменты для управления контактами, задачами и статистикой.
Используй их когда пользователь просит создать контакт, запланировать звонок,
посмотреть статистику или историю звонков.
Отвечай кратко и по делу на русском языке."""


# ============================================================================
# PRE-CALL ORCHESTRATOR
# ============================================================================

class PreCallOrchestrator:
    """Prepares call strategy using gpt-5 Responses API.
    Now works with AgentContact instead of CRM Contact."""

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

        # Build context from AgentContact memory and previous calls
        memory_json = json.dumps(agent_contact.memory or {}, ensure_ascii=False)

        # Get last 5 calls for this contact
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

            # Parse JSON from response
            json_text = output_text
            if "```json" in json_text:
                json_text = json_text.split("```json")[1].split("```")[0]
            elif "```" in json_text:
                json_text = json_text.split("```")[1].split("```")[0]

            result = json.loads(json_text.strip())

            # Save to AgentCall
            agent_call.pre_call_response_id = response.id
            agent_call.custom_greeting = result.get("first_phrase", "")
            agent_call.call_strategy = result.get("call_strategy", "")

            # Sync to task
            task.pre_call_response_id = response.id
            task.custom_greeting = result.get("first_phrase", "")
            db.commit()

            logger.info(f"[AGENT-PRECALL] Success. Strategy: {result.get('call_strategy', '')[:80]}")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"[AGENT-PRECALL] JSON parse error: {e}")
            agent_call.pre_call_response_id = response.id if 'response' in dir() else None
            agent_call.custom_greeting = output_text[:200] if 'output_text' in dir() else ""
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

            # Also load the source task
            task = None
            if agent_call.source_task_id:
                task = db.query(Task).filter(Task.id == agent_call.source_task_id).first()

            # Poll for transcript
            transcript = None
            call_status = "no_answer"
            duration_seconds = 0

            for attempt in range(retries):
                await asyncio.sleep(delay)
                logger.info(f"[AGENT-POSTCALL] Poll attempt {attempt + 1}/{retries} for call {agent_call_id}")

                db.refresh(agent_call)

                if not agent_call.call_session_id:
                    continue

                convs = db.query(Conversation).filter(
                    Conversation.session_id == agent_call.call_session_id
                ).all()

                if convs:
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
                        logger.info(f"[AGENT-POSTCALL] Found transcript ({len(transcript_parts)} turns)")
                        break

            if not transcript:
                call_status = "no_transcript"
                transcript = "(Транскрипт недоступен)"
                logger.warning(f"[AGENT-POSTCALL] No transcript found after {retries} attempts")

            # Run PostCall analysis with tools
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

        # Build context from previous calls
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

ПРЕДЫДУЩИЕ ЗВОНКИ:
{prev_calls_text or 'Нет предыдущих звонков'}

ТЕКУЩИЙ ТРАНСКРИПТ ЗВОНКА:
{transcript}

СТАТУС ЗВОНКА: {call_status}
ДЛИТЕЛЬНОСТЬ: {duration_seconds}s
AGENT_CONTACT_ID: {str(agent_contact.id)}

Проанализируй звонок и выполни необходимые действия через tools:
1. ОБЯЗАТЕЛЬНО вызови update_contact_memory — обнови память о контакте.
2. ОБЯЗАТЕЛЬНО вызови create_agent_task для перезвона, КРОМЕ случая когда клиент просит никогда не звонить.
3. Если клиент просит никогда не звонить — вызови set_contact_status с do_not_call.
4. Если нужно уведомить владельца (важный результат) — вызови send_telegram_notification.
5. Установи статус контакта через set_contact_status (active, success, rejected)."""

        try:
            kwargs = {
                "model": "gpt-5-2025-08-07",
                "instructions": agent_config.orchestrator_prompt or "",
                "input": post_call_input,
                "tools": AGENT_POSTCALL_TOOLS,
                "store": True,
            }

            # Chain with PreCall if available
            if agent_call.pre_call_response_id:
                kwargs["previous_response_id"] = agent_call.pre_call_response_id

            response = await client.responses.create(**kwargs)

            # Build tool execution context
            context = {
                "agent_config_id": str(agent_call.agent_config_id),
                "user_id": str(agent_call.user_id),
                "user": user,
            }

            # Process tool calls in a loop
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
                        result_str = await execute_tool(tool_name, tool_args, context, db)

                        # Track decision from set_contact_status
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
                            # Link the new task to this call
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
                        # GPT returned text — extract decision hint
                        text_content = getattr(item, "text", "") or ""
                        if not text_content:
                            for part in getattr(item, "content", []):
                                if hasattr(part, "text"):
                                    text_content += part.text
                        logger.info(f"[AGENT-POSTCALL] GPT message: {text_content[:200]}")

                if not has_tool_calls:
                    break

                # Continue conversation with tool results
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

            # Update AgentContact
            agent_contact.attempts_count = (agent_contact.attempts_count or 0) + 1
            agent_contact.last_called_at = datetime.utcnow()
            if agent_contact.status == "calling":
                agent_contact.status = "active"

            # Update source task
            if task:
                task.post_call_decision = post_call_decision
                task.status = TaskStatus.COMPLETED

            db.commit()
            logger.info(f"[AGENT-POSTCALL] Call {agent_call.id} completed with decision: {post_call_decision}")

        except Exception as e:
            logger.error(f"[AGENT-POSTCALL] Analysis error: {e}", exc_info=True)
            # Fallback
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

    async def run(
        self,
        message: str,
        agent_config: AgentConfig,
        user: User,
        db
    ) -> str:
        """
        Process a chat message with the agent.
        Returns the final assistant text reply.
        """
        client = AsyncOpenAI(api_key=user.openai_api_key)

        # Get last response_id from chat history for conversation continuity
        last_response_id = None
        history = agent_config.chat_history or []
        for msg in reversed(history):
            if msg.get("response_id"):
                last_response_id = msg["response_id"]
                break

        instructions = (agent_config.orchestrator_prompt or "") + CHAT_SUFFIX

        kwargs = {
            "model": "gpt-5-2025-08-07",
            "instructions": instructions,
            "input": message,
            "tools": AGENT_CHAT_TOOLS,
            "store": True,
        }

        if last_response_id:
            kwargs["previous_response_id"] = last_response_id

        try:
            response = await client.responses.create(**kwargs)
        except Exception as e:
            # If previous_response_id is stale, retry without it
            if last_response_id and "previous_response_id" in str(e).lower():
                logger.warning(f"[AGENT-CHAT] Stale response_id, retrying without chain: {e}")
                kwargs.pop("previous_response_id", None)
                response = await client.responses.create(**kwargs)
            else:
                raise

        # Build tool execution context
        context = {
            "agent_config_id": str(agent_config.id),
            "user_id": str(user.id),
            "user": user,
        }

        # Process tool calls in a loop
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

                    logger.info(f"[AGENT-CHAT] Executing tool: {tool_name}")
                    result_str = await execute_tool(tool_name, tool_args, context, db)

                    tool_results.append({
                        "type": "function_call_output",
                        "call_id": item.call_id,
                        "output": result_str,
                    })

            if not has_tool_calls:
                break

            # Continue with tool results
            response = await client.responses.create(
                model="gpt-5-2025-08-07",
                input=tool_results,
                previous_response_id=response.id,
                tools=AGENT_CHAT_TOOLS,
                store=True,
            )

        # Extract final text output
        final_text = ""
        for item in response.output:
            if item.type == "message":
                for part in getattr(item, "content", []):
                    if hasattr(part, "text"):
                        final_text += part.text

        if not final_text:
            final_text = response.output_text or "Готово."

        # Save to chat history
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

        return final_text
