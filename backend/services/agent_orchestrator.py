"""
Agent Orchestrator — PreCall and PostCall phases for Voicyfy Agent.
Uses OpenAI Responses API (gpt-5) with store=True for conversation continuity.
"""

import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from openai import AsyncOpenAI

from backend.core.logging import get_logger
from backend.db.session import SessionLocal
from backend.models.agent_config import AgentConfig
from backend.models.task import Task, TaskStatus
from backend.models.contact import Contact
from backend.models.conversation import Conversation
from backend.models.user import User
from backend.services.telegram_notification import TelegramNotificationService

logger = get_logger(__name__)


# ============================================================================
# PRE-CALL ORCHESTRATOR
# ============================================================================

class PreCallOrchestrator:
    """Prepares call strategy using gpt-5 Responses API."""

    async def run(
        self,
        task: Task,
        contact: Contact,
        agent_config: AgentConfig,
        user: User,
        db
    ) -> Dict[str, Any]:
        """
        Run PreCall phase: generate first_phrase and call strategy.

        Returns dict with: first_phrase, call_strategy, tone, key_points
        """
        logger.info(f"[AGENT-PRECALL] Starting for task {task.id}, contact {contact.name or contact.phone}")

        client = AsyncOpenAI(api_key=user.openai_api_key)

        memory_json = json.dumps(contact.agent_memory or {}, ensure_ascii=False)

        pre_call_input = f"""ЗАДАЧА: {task.title}
ОПИСАНИЕ: {task.description or 'Нет описания'}
КОНТАКТ: {contact.name or 'Неизвестный'} ({contact.phone})
ПАМЯТЬ О КОНТАКТЕ: {memory_json}
ПОПЫТКА: {(task.retry_count or 0) + 1}

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

            # Parse JSON from response (handle markdown code blocks)
            json_text = output_text
            if "```json" in json_text:
                json_text = json_text.split("```json")[1].split("```")[0]
            elif "```" in json_text:
                json_text = json_text.split("```")[1].split("```")[0]

            result = json.loads(json_text.strip())

            # Save response_id and custom_greeting
            task.pre_call_response_id = response.id
            task.custom_greeting = result.get("first_phrase", "")
            db.commit()

            logger.info(f"[AGENT-PRECALL] Success. Strategy: {result.get('call_strategy', '')[:80]}")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"[AGENT-PRECALL] JSON parse error: {e}")
            # Fallback: use raw text as greeting
            task.pre_call_response_id = response.id if 'response' in dir() else None
            task.custom_greeting = output_text[:200] if 'output_text' in dir() else ""
            db.commit()
            return {"first_phrase": task.custom_greeting, "call_strategy": "fallback", "tone": "деловой", "key_points": []}

        except Exception as e:
            logger.error(f"[AGENT-PRECALL] Error: {e}", exc_info=True)
            raise


# ============================================================================
# POST-CALL ORCHESTRATOR
# ============================================================================

class PostCallOrchestrator:
    """Analyzes call results and executes follow-up actions."""

    @staticmethod
    async def poll_and_run(
        task_id: str,
        agent_config_id: str,
        user_openai_key: str,
        retries: int = 5,
        delay: int = 15
    ):
        """
        Poll for conversation transcript and run PostCall analysis.
        Opens its own DB session — safe for asyncio.create_task().
        """
        logger.info(f"[AGENT-POSTCALL] Starting poll for task {task_id}")

        db = SessionLocal()
        try:
            task = db.query(Task).filter(Task.id == task_id).first()
            if not task:
                logger.error(f"[AGENT-POSTCALL] Task {task_id} not found")
                return

            agent_config = db.query(AgentConfig).filter(AgentConfig.id == agent_config_id).first()
            if not agent_config:
                logger.error(f"[AGENT-POSTCALL] AgentConfig {agent_config_id} not found")
                return

            contact = db.query(Contact).filter(Contact.id == task.contact_id).first()
            if not contact:
                logger.error(f"[AGENT-POSTCALL] Contact not found for task {task_id}")
                return

            user = db.query(User).filter(User.id == task.user_id).first()

            # Poll for transcript
            transcript = None
            call_status = "no_answer"
            duration_seconds = 0

            for attempt in range(retries):
                await asyncio.sleep(delay)
                logger.info(f"[AGENT-POSTCALL] Poll attempt {attempt + 1}/{retries} for task {task_id}")

                # Refresh task to get latest call_session_id
                db.refresh(task)

                if not task.call_session_id:
                    continue

                convs = db.query(Conversation).filter(
                    Conversation.session_id == task.call_session_id
                ).all()

                if convs:
                    # Build transcript from conversation data
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

            # Run PostCall analysis
            orchestrator = PostCallOrchestrator()
            await orchestrator._analyze(
                task=task,
                contact=contact,
                agent_config=agent_config,
                user=user,
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
        task: Task,
        contact: Contact,
        agent_config: AgentConfig,
        user: User,
        transcript: str,
        call_status: str,
        duration_seconds: float,
        openai_key: str,
        db
    ):
        """Run PostCall analysis with gpt-5 using previous_response_id chain."""
        logger.info(f"[AGENT-POSTCALL] Analyzing call for task {task.id}")

        client = AsyncOpenAI(api_key=openai_key)

        post_call_input = f"""ТРАНСКРИПТ ЗВОНКА:
{transcript}

СТАТУС ЗВОНКА: {call_status}
ДЛИТЕЛЬНОСТЬ: {duration_seconds}s

Проанализируй звонок. Верни JSON с решениями:
{{
  "decision": "SUCCESS/FOLLOWUP/NO_ANSWER/ESCALATE/REJECTED",
  "memory_update": {{
    "summary": "краткий итог",
    "tone_history": ["тон этого звонка"],
    "best_time": "лучшее время для звонка или null",
    "key_facts": ["новые факты"]
  }},
  "followup": {{
    "needed": true/false,
    "hours_delay": 24,
    "title": "Тема перезвона",
    "greeting": "Первая фраза перезвона"
  }},
  "telegram_message": "Сообщение для уведомления или null",
  "notes": "Краткие заметки по звонку"
}}"""

        try:
            kwargs = {
                "model": "gpt-5-2025-08-07",
                "input": post_call_input,
                "store": True,
            }

            # Chain with PreCall if available
            if task.pre_call_response_id:
                kwargs["previous_response_id"] = task.pre_call_response_id

            response = await client.responses.create(**kwargs)
            output_text = response.output_text
            logger.info(f"[AGENT-POSTCALL] Raw response: {output_text[:200]}")

            # Parse JSON
            json_text = output_text
            if "```json" in json_text:
                json_text = json_text.split("```json")[1].split("```")[0]
            elif "```" in json_text:
                json_text = json_text.split("```")[1].split("```")[0]

            result = json.loads(json_text.strip())

            # Execute tool actions
            await self._execute_actions(result, task, contact, agent_config, user, db)

        except json.JSONDecodeError as e:
            logger.error(f"[AGENT-POSTCALL] JSON parse error: {e}")
            # Fallback: mark as completed
            task.post_call_decision = "NO_ANSWER" if call_status != "answered" else "SUCCESS"
            task.status = TaskStatus.COMPLETED
            db.commit()

        except Exception as e:
            logger.error(f"[AGENT-POSTCALL] Analysis error: {e}", exc_info=True)
            task.post_call_decision = "NO_ANSWER"
            task.status = TaskStatus.COMPLETED
            db.commit()

    async def _execute_actions(
        self,
        result: Dict[str, Any],
        task: Task,
        contact: Contact,
        agent_config: AgentConfig,
        user: User,
        db
    ):
        """Execute PostCall tool actions based on gpt-5 analysis."""

        # 1. Update contact memory (always)
        memory_update = result.get("memory_update", {})
        if memory_update:
            existing = contact.agent_memory or {}
            # Merge memory
            if "summary" in memory_update:
                existing["summary"] = memory_update["summary"]
            if "best_time" in memory_update and memory_update["best_time"]:
                existing["best_time"] = memory_update["best_time"]
            # Append tone history
            tone_list = existing.get("tone_history", [])
            new_tones = memory_update.get("tone_history", [])
            tone_list.extend(new_tones)
            existing["tone_history"] = tone_list[-10:]  # Keep last 10
            # Append key facts (deduplicate)
            facts = set(existing.get("key_facts", []))
            facts.update(memory_update.get("key_facts", []))
            existing["key_facts"] = list(facts)
            # Update counters
            existing["attempts"] = (existing.get("attempts", 0)) + 1
            existing["last_call"] = datetime.utcnow().strftime("%Y-%m-%d")

            contact.agent_memory = existing
            logger.info(f"[AGENT-POSTCALL] Updated memory for contact {contact.id}")

        # 2. Create followup task if needed
        followup = result.get("followup", {})
        if followup.get("needed"):
            hours_delay = followup.get("hours_delay", 24)
            new_task = Task(
                contact_id=contact.id,
                gemini_assistant_id=agent_config.assistant_id,
                user_id=task.user_id,
                status=TaskStatus.SCHEDULED,
                scheduled_time=datetime.utcnow() + timedelta(hours=hours_delay),
                title=followup.get("title", f"Перезвон: {contact.name or contact.phone}"),
                description=result.get("notes", ""),
                custom_greeting=followup.get("greeting", ""),
                retry_count=(task.retry_count or 0) + 1,
            )
            db.add(new_task)
            logger.info(f"[AGENT-POSTCALL] Created followup task in {hours_delay}h")

        # 3. Send telegram notification if needed
        telegram_msg = result.get("telegram_message")
        if telegram_msg and user.has_telegram_config():
            tg_config = user.get_telegram_config()
            try:
                await TelegramNotificationService.send_message(
                    bot_token=tg_config["bot_token"],
                    chat_id=tg_config["chat_id"],
                    text=f"🤖 <b>Voicyfy Agent</b>\n\n{telegram_msg}"
                )
                logger.info(f"[AGENT-POSTCALL] Telegram notification sent")
            except Exception as e:
                logger.error(f"[AGENT-POSTCALL] Telegram error: {e}")

        # 4. Mark task result (always last)
        decision = result.get("decision", "SUCCESS")
        task.post_call_decision = decision
        task.call_result = result.get("notes", task.call_result or "")
        task.status = TaskStatus.COMPLETED

        db.commit()
        logger.info(f"[AGENT-POSTCALL] Task {task.id} completed with decision: {decision}")
