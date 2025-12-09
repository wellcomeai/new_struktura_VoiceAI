"""
🤖 Browser Agent Service v1.5
Автономный агент для управления браузером через голосовые команды.

v1.5: Переход на OpenAI API
- Использует GPT-4o-mini вместо Gemini
- API key берётся из переменной окружения OPENAI_API_KEY
- Не конфликтует с лимитами Gemini Voice Agent
"""

import asyncio
import json
import uuid
import time
import traceback
from typing import Optional, Dict, Any, List, Callable, Awaitable
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import aiohttp

from backend.core.logging import get_logger
from backend.core.config import settings

logger = get_logger(__name__)


# ============================================================================
# DATA CLASSES
# ============================================================================

class DecisionType(str, Enum):
    ACTION = "action"
    COMPLETED = "completed"
    FAILED = "failed"
    NEED_MORE_INFO = "need_more_info"


@dataclass
class AgentDecision:
    """Решение агента после анализа DOM"""
    type: DecisionType
    reasoning: str
    action: Optional[Dict] = None
    notify_user: bool = False
    status_message: str = ""
    extracted_data: Optional[Dict] = None
    
    @classmethod
    def from_json(cls, json_str: str) -> "AgentDecision":
        """Парсинг JSON ответа от LLM"""
        text = json_str.strip()
        
        # Убираем markdown code blocks
        if text.startswith("```"):
            lines = text.split("\n")
            # Убираем первую строку (```json или ```)
            if lines[0].strip() in ["```json", "```"]:
                lines = lines[1:]
            # Убираем последнюю строку если это ```
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)
        
        # Пытаемся найти JSON в тексте
        text = text.strip()
        
        # Ищем начало JSON объекта
        start_idx = text.find("{")
        end_idx = text.rfind("}") + 1
        
        if start_idx != -1 and end_idx > start_idx:
            text = text[start_idx:end_idx]
        
        data = json.loads(text)
        return cls(
            type=DecisionType(data.get("type", "action")),
            reasoning=data.get("reasoning", ""),
            action=data.get("action"),
            notify_user=data.get("notify_user", False),
            status_message=data.get("status_message", ""),
            extracted_data=data.get("extracted_data")
        )


# ============================================================================
# BROWSER AGENT SERVICE
# ============================================================================

class BrowserAgentService:
    """
    Автономный агент для управления браузером.
    
    v1.5: Переход на OpenAI API
    - Использует GPT-4o-mini для анализа DOM
    - Берёт ключ из переменных окружения OPENAI_API_KEY
    - Не конфликтует с лимитами Gemini Voice Agent
    """
    
    # OpenAI API endpoint
    OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
    
    def __init__(self, api_key: str = None):
        # Берём OpenAI ключ из переменных окружения
        import os
        self.api_key = os.environ.get('OPENAI_API_KEY')
        
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required for BrowserAgentService")
        
        # Активные задачи
        self.active_tasks: Dict[str, Dict] = {}
        
        # Ожидающие ответы
        self.pending_dom_requests: Dict[str, asyncio.Future] = {}
        self.pending_action_results: Dict[str, asyncio.Future] = {}
        
        # Модель OpenAI (быстрая и дешёвая)
        self.model_name = 'gpt-4o-mini'
        
        # Конфигурация
        self.max_iterations = 25
        self.action_timeout = 15.0
        self.dom_request_timeout = 10.0
        self.step_delay = 0.5
        
        logger.info(f"[BROWSER-AGENT] Service initialized (v1.5 - OpenAI)")
        logger.info(f"[BROWSER-AGENT]   Model: {self.model_name}")
        logger.info(f"[BROWSER-AGENT]   API Key: {self.api_key[:10]}...{self.api_key[-5:]}")
    
    # ========================================================================
    # OPENAI API (Direct HTTP)
    # ========================================================================
    
    async def _call_llm(self, prompt: str) -> str:
        """
        Прямой HTTP запрос к OpenAI API.
        Использует gpt-4o-mini для быстрого анализа DOM.
        """
        if not self.api_key:
            raise ValueError("OpenAI API key not configured")
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a Browser Agent that controls a web browser. Always respond with valid JSON only, no markdown."
                },
                {
                    "role": "user", 
                    "content": prompt
                }
            ],
            "temperature": 0.7,
            "max_tokens": 2048
        }
        
        logger.info(f"[BROWSER-AGENT] Calling OpenAI API...")
        logger.info(f"[BROWSER-AGENT]   Model: {self.model_name}")
        logger.info(f"[BROWSER-AGENT]   Prompt length: {len(prompt)} chars")
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.OPENAI_API_URL,
                    headers=headers,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as response:
                    response_text = await response.text()
                    
                    if response.status != 200:
                        logger.error(f"[BROWSER-AGENT] ❌ OpenAI API error: {response.status}")
                        logger.error(f"[BROWSER-AGENT]   Response: {response_text[:500]}")
                        raise Exception(f"OpenAI API error: {response.status} - {response_text[:200]}")
                    
                    data = json.loads(response_text)
                    
                    # Извлекаем текст из ответа OpenAI
                    choices = data.get("choices", [])
                    if not choices:
                        logger.error(f"[BROWSER-AGENT] ❌ No choices in response")
                        raise Exception("No response from OpenAI")
                    
                    message = choices[0].get("message", {})
                    result_text = message.get("content", "")
                    
                    if not result_text:
                        logger.error(f"[BROWSER-AGENT] ❌ Empty content in response")
                        raise Exception("Empty response from OpenAI")
                    
                    logger.info(f"[BROWSER-AGENT] ✅ OpenAI response received: {len(result_text)} chars")
                    logger.info(f"[BROWSER-AGENT]   Preview: {result_text[:200]}...")
                    
                    return result_text
                    
        except aiohttp.ClientError as e:
            logger.error(f"[BROWSER-AGENT] ❌ Network error: {e}")
            raise Exception(f"Network error calling OpenAI: {e}")
        except asyncio.TimeoutError:
            logger.error(f"[BROWSER-AGENT] ❌ Timeout calling OpenAI API")
            raise Exception("Timeout calling OpenAI API")
        except Exception as e:
            logger.error(f"[BROWSER-AGENT] ❌ Error calling OpenAI: {e}")
            logger.error(f"[BROWSER-AGENT]   Traceback: {traceback.format_exc()}")
            raise
    
    # ========================================================================
    # TASK MANAGEMENT
    # ========================================================================
    
    async def create_task(
        self,
        user_id: str,
        assistant_id: str,
        session_id: str,
        goal: str,
        initial_url: str = None
    ) -> Dict:
        """Создать новую задачу"""
        task_id = str(uuid.uuid4())
        
        task = {
            "id": task_id,
            "user_id": user_id,
            "assistant_id": assistant_id,
            "session_id": session_id,
            "goal": goal,
            "status": "pending",
            "initial_url": initial_url,
            "current_url": initial_url,
            "plan": [],
            "current_step": 0,
            "history": [],
            "result": None,
            "error": None,
            "iterations": 0,
            "created_at": datetime.utcnow().isoformat()
        }
        
        self.active_tasks[task_id] = task
        
        logger.info(f"[BROWSER-AGENT] Task created: {task_id}")
        logger.info(f"[BROWSER-AGENT]   Goal: {goal}")
        
        return task
    
    def get_task(self, task_id: str) -> Optional[Dict]:
        return self.active_tasks.get(task_id)
    
    def cancel_task(self, task_id: str) -> bool:
        task = self.active_tasks.get(task_id)
        if task and task["status"] in ("pending", "running", "waiting_dom"):
            task["status"] = "cancelled"
            logger.info(f"[BROWSER-AGENT] Task cancelled: {task_id}")
            return True
        return False
    
    # ========================================================================
    # MAIN EXECUTION LOOP
    # ========================================================================
    
    async def execute_task(
        self,
        task_id: str,
        send_to_widget: Callable[[Dict], Awaitable[None]],
        notify_voice_agent: Callable[[Dict], Awaitable[None]]
    ):
        """Главный цикл выполнения задачи"""
        task = self.active_tasks.get(task_id)
        if not task:
            logger.error(f"[BROWSER-AGENT] Task not found: {task_id}")
            return
        
        logger.info(f"[BROWSER-AGENT] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logger.info(f"[BROWSER-AGENT] 🚀 STARTING TASK: {task_id[:8]}...")
        logger.info(f"[BROWSER-AGENT]    Goal: {task['goal']}")
        logger.info(f"[BROWSER-AGENT]    Model: {self.model_name} (OpenAI)")
        logger.info(f"[BROWSER-AGENT] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        
        task["status"] = "running"
        task["started_at"] = datetime.utcnow().isoformat()
        
        try:
            for iteration in range(self.max_iterations):
                task["iterations"] = iteration + 1
                
                if task["status"] == "cancelled":
                    logger.info(f"[BROWSER-AGENT] Task was cancelled")
                    break
                
                logger.info(f"[BROWSER-AGENT] --- Iteration {iteration + 1}/{self.max_iterations} ---")
                
                # 1. Запросить DOM
                task["status"] = "waiting_dom"
                dom = await self._request_dom(task["session_id"], send_to_widget)
                
                if not dom:
                    logger.error(f"[BROWSER-AGENT] Failed to get DOM")
                    task["status"] = "failed"
                    task["error"] = "Не удалось получить информацию о странице"
                    await notify_voice_agent({
                        "type": "browser_agent.failed",
                        "task_id": task_id,
                        "message": "Не удалось получить информацию о странице"
                    })
                    break
                
                task["current_url"] = dom.get("url")
                task["last_dom_snapshot"] = dom
                task["status"] = "running"
                
                logger.info(f"[BROWSER-AGENT] DOM received: {len(dom.get('elements', []))} elements")
                logger.info(f"[BROWSER-AGENT] URL: {dom.get('url', 'unknown')}")
                
                # 2. Подумать
                decision = await self._think(task, dom)
                
                logger.info(f"[BROWSER-AGENT] Decision: {decision.type.value}")
                logger.info(f"[BROWSER-AGENT] Reasoning: {decision.reasoning}")
                
                # 3. Обработать решение
                if decision.type == DecisionType.COMPLETED:
                    task["status"] = "completed"
                    task["result"] = decision.status_message
                    task["completed_at"] = datetime.utcnow().isoformat()
                    
                    logger.info(f"[BROWSER-AGENT] ✅ TASK COMPLETED")
                    
                    await notify_voice_agent({
                        "type": "browser_agent.completed",
                        "task_id": task_id,
                        "message": decision.status_message,
                        "extracted_data": decision.extracted_data
                    })
                    break
                    
                elif decision.type == DecisionType.FAILED:
                    task["status"] = "failed"
                    task["error"] = decision.status_message
                    
                    logger.info(f"[BROWSER-AGENT] ❌ TASK FAILED: {decision.status_message}")
                    
                    await notify_voice_agent({
                        "type": "browser_agent.failed",
                        "task_id": task_id,
                        "message": decision.status_message
                    })
                    break
                    
                elif decision.type == DecisionType.ACTION:
                    if decision.notify_user and decision.status_message:
                        await notify_voice_agent({
                            "type": "browser_agent.progress",
                            "task_id": task_id,
                            "message": decision.status_message,
                            "step": task["current_step"]
                        })
                    
                    action = decision.action
                    action["id"] = str(uuid.uuid4())
                    
                    logger.info(f"[BROWSER-AGENT] Executing: {action.get('type')} -> {action.get('selector')}")
                    
                    result = await self._execute_action(
                        task["session_id"],
                        action,
                        send_to_widget
                    )
                    
                    task["history"].append({
                        "step": task["current_step"],
                        "action": action,
                        "result": result,
                        "timestamp": time.time()
                    })
                    task["current_step"] += 1
                    
                    if result.get("success"):
                        logger.info(f"[BROWSER-AGENT] Action successful")
                    else:
                        logger.warning(f"[BROWSER-AGENT] Action failed: {result.get('error')}")
                    
                    await asyncio.sleep(self.step_delay)
                    
                elif decision.type == DecisionType.NEED_MORE_INFO:
                    await notify_voice_agent({
                        "type": "browser_agent.need_info",
                        "task_id": task_id,
                        "message": decision.status_message
                    })
                    await asyncio.sleep(2.0)
            
            else:
                task["status"] = "failed"
                task["error"] = "Превышено максимальное количество шагов"
                
                logger.warning(f"[BROWSER-AGENT] Max iterations reached")
                
                await notify_voice_agent({
                    "type": "browser_agent.failed",
                    "task_id": task_id,
                    "message": "Не удалось выполнить задачу за отведённое время"
                })
                
        except asyncio.CancelledError:
            task["status"] = "cancelled"
            logger.info(f"[BROWSER-AGENT] Task execution cancelled")
            
        except Exception as e:
            task["status"] = "failed"
            task["error"] = str(e)
            
            logger.error(f"[BROWSER-AGENT] Unexpected error: {e}")
            logger.error(traceback.format_exc())
            
            await notify_voice_agent({
                "type": "browser_agent.failed",
                "task_id": task_id,
                "message": f"Произошла ошибка: {str(e)}"
            })
        
        finally:
            logger.info(f"[BROWSER-AGENT] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            logger.info(f"[BROWSER-AGENT] 📊 TASK STATS: {task_id[:8]}...")
            logger.info(f"[BROWSER-AGENT]    Status: {task['status']}")
            logger.info(f"[BROWSER-AGENT]    Iterations: {task['iterations']}")
            logger.info(f"[BROWSER-AGENT]    Steps: {task['current_step']}")
            logger.info(f"[BROWSER-AGENT] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            # Cleanup after 60 seconds
            await asyncio.sleep(60)
            self.active_tasks.pop(task_id, None)
    
    # ========================================================================
    # LLM THINKING
    # ========================================================================
    
    async def _think(self, task: Dict, dom: Dict) -> AgentDecision:
        """LLM анализирует ситуацию и принимает решение"""
        elements_text = self._format_elements(dom.get("elements", []))
        history_text = self._format_history(task["history"])
        
        prompt = f"""Ты — Browser Agent. Управляешь браузером пользователя голосовыми командами.

ЗАДАЧА: {task['goal']}

ТЕКУЩИЙ URL: {dom.get('url', 'неизвестен')}
ЗАГОЛОВОК: {dom.get('title', 'неизвестен')}

ДОСТУПНЫЕ ЭЛЕМЕНТЫ НА СТРАНИЦЕ:
{elements_text}

ИСТОРИЯ ДЕЙСТВИЙ:
{history_text}

ТЕКУЩИЙ ШАГ: {task['current_step'] + 1}

Проанализируй ситуацию и ответь ТОЛЬКО валидным JSON (без markdown, без ```):
{{
    "type": "action" | "completed" | "failed" | "need_more_info",
    "reasoning": "краткое объяснение твоего решения",
    "action": {{
        "type": "click" | "type" | "scroll" | "wait" | "extract",
        "selector": "CSS селектор элемента",
        "params": {{"text": "для type", "direction": "up|down для scroll"}}
    }},
    "notify_user": true | false,
    "status_message": "Короткое сообщение для пользователя (будет озвучено)",
    "extracted_data": {{"key": "value"}}
}}

ПРАВИЛА:
1. Если задача ВЫПОЛНЕНА → type: "completed", status_message: описание результата
2. Если НЕВОЗМОЖНО выполнить → type: "failed", status_message: причина
3. Если нужно ДЕЙСТВИЕ → type: "action", заполни action
4. Если нужно УТОЧНЕНИЕ → type: "need_more_info"
5. notify_user: true ТОЛЬКО для важных этапов
6. status_message должен быть КОРОТКИМ (для озвучки)
7. Используй ТОЧНЫЕ селекторы из списка элементов
8. Если элементов мало — возможно страница простая, работай с тем что есть

ВАЖНО: Ответ должен быть ТОЛЬКО JSON, без лишнего текста!"""
        
        try:
            logger.info(f"[BROWSER-AGENT] Calling LLM for decision...")
            response_text = await self._call_llm(prompt)
            
            logger.info(f"[BROWSER-AGENT] Parsing LLM response...")
            decision = AgentDecision.from_json(response_text)
            logger.info(f"[BROWSER-AGENT] ✅ Decision parsed: {decision.type.value}")
            
            return decision
            
        except json.JSONDecodeError as e:
            logger.error(f"[BROWSER-AGENT] JSON parse error: {e}")
            logger.error(f"[BROWSER-AGENT] Response was: {response_text[:500] if 'response_text' in locals() else 'N/A'}")
            return AgentDecision(
                type=DecisionType.FAILED,
                reasoning=f"Failed to parse LLM response: {e}",
                status_message="Ошибка обработки ответа от ИИ"
            )
            
        except Exception as e:
            logger.error(f"[BROWSER-AGENT] LLM error: {e}")
            logger.error(f"[BROWSER-AGENT] Traceback: {traceback.format_exc()}")
            return AgentDecision(
                type=DecisionType.FAILED,
                reasoning=str(e),
                status_message=f"Ошибка при анализе страницы: {str(e)[:50]}"
            )
    
    # ========================================================================
    # WIDGET COMMUNICATION
    # ========================================================================
    
    async def _request_dom(
        self,
        session_id: str,
        send_to_widget: Callable[[Dict], Awaitable[None]]
    ) -> Optional[Dict]:
        """Запросить DOM у виджета"""
        request_id = str(uuid.uuid4())
        
        future = asyncio.get_event_loop().create_future()
        self.pending_dom_requests[request_id] = future
        
        try:
            await send_to_widget({
                "type": "browser.dom_request",
                "request_id": request_id
            })
            
            logger.info(f"[BROWSER-AGENT] DOM request sent: {request_id[:8]}...")
            
            dom = await asyncio.wait_for(future, timeout=self.dom_request_timeout)
            return dom
            
        except asyncio.TimeoutError:
            logger.error(f"[BROWSER-AGENT] DOM request timeout")
            return None
            
        except Exception as e:
            logger.error(f"[BROWSER-AGENT] DOM request error: {e}")
            return None
            
        finally:
            self.pending_dom_requests.pop(request_id, None)
    
    async def _execute_action(
        self,
        session_id: str,
        action: Dict,
        send_to_widget: Callable[[Dict], Awaitable[None]]
    ) -> Dict:
        """Отправить действие в виджет"""
        action_id = action.get("id") or str(uuid.uuid4())
        
        future = asyncio.get_event_loop().create_future()
        self.pending_action_results[action_id] = future
        
        try:
            await send_to_widget({
                "type": "browser.action",
                "action": action
            })
            
            logger.info(f"[BROWSER-AGENT] Action sent: {action.get('type')} [{action_id[:8]}...]")
            
            result = await asyncio.wait_for(future, timeout=self.action_timeout)
            return result
            
        except asyncio.TimeoutError:
            logger.error(f"[BROWSER-AGENT] Action timeout: {action_id[:8]}...")
            return {"success": False, "error": "Timeout"}
            
        except Exception as e:
            logger.error(f"[BROWSER-AGENT] Action error: {e}")
            return {"success": False, "error": str(e)}
            
        finally:
            self.pending_action_results.pop(action_id, None)
    
    # ========================================================================
    # RESPONSE HANDLERS
    # ========================================================================
    
    def handle_dom_response(self, request_id: str, dom: Dict):
        """Обработать ответ DOM от виджета"""
        future = self.pending_dom_requests.get(request_id)
        if future and not future.done():
            future.set_result(dom)
            logger.info(f"[BROWSER-AGENT] DOM response received: {request_id[:8]}...")
        else:
            logger.warning(f"[BROWSER-AGENT] Unexpected DOM response: {request_id[:8]}...")
    
    def handle_action_result(self, action_id: str, result: Dict):
        """Обработать результат действия от виджета"""
        future = self.pending_action_results.get(action_id)
        if future and not future.done():
            future.set_result(result)
            logger.info(f"[BROWSER-AGENT] Action result received: {action_id[:8]}...")
        else:
            logger.warning(f"[BROWSER-AGENT] Unexpected action result: {action_id[:8]}...")
    
    # ========================================================================
    # FORMATTING HELPERS
    # ========================================================================
    
    def _format_elements(self, elements: List[Dict], limit: int = 50) -> str:
        if not elements:
            return "Элементы не найдены (страница может быть пустой или ещё загружается)"
        
        lines = []
        for el in elements[:limit]:
            parts = [f"[{el.get('tag', '?')}]"]
            
            if el.get('text'):
                text = el['text'][:50].replace('\n', ' ')
                parts.append(f'text="{text}"')
            if el.get('placeholder'):
                parts.append(f'placeholder="{el["placeholder"]}"')
            if el.get('name'):
                parts.append(f'name="{el["name"]}"')
            if el.get('type'):
                parts.append(f'type="{el["type"]}"')
            if el.get('value'):
                parts.append(f'value="{el["value"][:30]}"')
            if el.get('href'):
                href = el['href'][:50]
                parts.append(f'href="{href}"')
            
            parts.append(f'selector="{el.get("selector", "?")}"')
            lines.append("  " + " ".join(parts))
        
        if len(elements) > limit:
            lines.append(f"  ... и ещё {len(elements) - limit} элементов")
        
        return "\n".join(lines)
    
    def _format_history(self, history: List[Dict], limit: int = 10) -> str:
        if not history:
            return "Пока нет действий"
        
        lines = []
        for h in history[-limit:]:
            action = h.get("action", {})
            result = h.get("result", {})
            status = "✓" if result.get("success") else "✗"
            action_type = action.get("type", "?")
            selector = action.get("selector", "?")[:40]
            
            line = f"  {status} Шаг {h.get('step', '?')}: {action_type} → {selector}"
            
            if not result.get("success"):
                line += f" (ошибка: {result.get('error', '?')})"
            
            lines.append(line)
        
        return "\n".join(lines)


# ============================================================================
# FACTORY FUNCTION
# ============================================================================

def create_browser_agent_service() -> BrowserAgentService:
    """
    Создаёт новый экземпляр BrowserAgentService.
    
    API key берётся из переменной окружения OPENAI_API_KEY.
    """
    return BrowserAgentService()


def get_browser_agent_service(api_key: str = None) -> BrowserAgentService:
    """
    Создаёт BrowserAgentService.
    
    Параметр api_key игнорируется - ключ берётся из OPENAI_API_KEY.
    Оставлен для обратной совместимости с handler.
    """
    return BrowserAgentService()


# ============================================================================
# BACKWARDS COMPATIBILITY
# ============================================================================

# Эта переменная оставлена для обратной совместимости с импортами.
# НЕ ИСПОЛЬЗУЙТЕ эту переменную! Она всегда None.
# Вместо этого вызывайте get_browser_agent_service() для создания агента.
browser_agent_service: Optional[BrowserAgentService] = None
