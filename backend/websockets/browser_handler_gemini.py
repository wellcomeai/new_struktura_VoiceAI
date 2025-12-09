"""
🚀 PRODUCTION VERSION 2.1 - Google Gemini Live API Handler + Browser Agent
✅ PURE GEMINI VAD - removed client-side commit logic
✅ Continuous audio streaming - Gemini decides when to respond
✅ Complete function calling support with toolCall event handler
✅ Google Sheets logging with transcription support
✅ Database integration
✅ Interruption handling
✅ Screen context support
✅ Audio transcription support (input + output)
✅ Fallback logging on disconnect
✅ Maximum logging for debugging
✅ Ready for production deployment

🆕 BROWSER AGENT INTEGRATION (v2.1):
✅ Autonomous browser control via voice commands
✅ DOM scanning and element interaction
✅ Multi-step task execution
✅ Visual element highlighting
✅ Progress notifications to voice agent
✅ Parallel execution (doesn't block voice)
✅ start_browser_task function interception

ARCHITECTURE:
- Voice Agent: Handles voice I/O via Gemini Live API
- Browser Agent: Autonomous DOM controller via Gemini 2.0 Flash
- Single WebSocket with message multiplexing
- Function calling bridge between Voice and Browser agents
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
import traceback
import time
import sys
from typing import Dict, List, Optional, Callable, Awaitable
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.gemini_assistant import GeminiAssistantConfig, GeminiConversation
from backend.utils.audio_utils import base64_to_audio_buffer
from backend.websockets.gemini_client import GeminiLiveClient
from backend.services.google_sheets_service import GoogleSheetsService
from backend.services.conversation_service import ConversationService
from backend.services.browser_agent_service import get_browser_agent_service, BrowserAgentService
from backend.functions import execute_function, normalize_function_name

logger = get_logger(__name__)

# Force immediate log flushing to stdout for Render
import logging
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    force=True
)

# Active connections
active_gemini_connections: Dict[str, List[WebSocket]] = {}

# Debug mode
ENABLE_DETAILED_LOGGING = True

# Browser Agent feature flag
BROWSER_AGENT_ENABLED = True


def log_to_render(message: str, level: str = "INFO"):
    """Force log to Render stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [GEMINI] {level} - {message}"
    print(log_msg, flush=True)
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)


async def handle_gemini_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    🚀 PRODUCTION v2.1 - Main WebSocket handler for Gemini Live API + Browser Agent
    ✅ Pure Gemini VAD - continuous audio streaming
    ✅ Audio transcription support
    ✅ Browser Agent integration with start_browser_task function
    """
    client_id = str(uuid.uuid4())
    gemini_client: Optional[GeminiLiveClient] = None
    browser_agent: Optional[BrowserAgentService] = None
    connection_start = time.time()
    
    # Browser Agent task tracking
    active_browser_tasks: Dict[str, asyncio.Task] = {}
    
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log_to_render(f"🚀 NEW GEMINI CONNECTION INITIATED (v2.1 + Browser Agent)")
    log_to_render(f"   Client ID: {client_id}")
    log_to_render(f"   Assistant ID: {assistant_id}")
    log_to_render(f"   Browser Agent: {'ENABLED' if BROWSER_AGENT_ENABLED else 'DISABLED'}")
    log_to_render(f"   Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    user_agent = ""
    if hasattr(websocket, 'headers'):
        user_agent = websocket.headers.get('user-agent', '')
        log_to_render(f"📱 User-Agent: {user_agent[:100]}")

    try:
        await websocket.accept()
        log_to_render(f"✅ WebSocket accepted for client {client_id}")

        # Register connection
        active_gemini_connections.setdefault(assistant_id, []).append(websocket)
        log_to_render(f"📝 Active Gemini connections for {assistant_id}: {len(active_gemini_connections.get(assistant_id, []))}")

        # Load assistant
        log_to_render(f"🔍 Loading Gemini assistant: {assistant_id}")
        if assistant_id == "demo":
            assistant = db.query(GeminiAssistantConfig).filter(GeminiAssistantConfig.is_public.is_(True)).first()
            if not assistant:
                assistant = db.query(GeminiAssistantConfig).first()
        else:
            try:
                uuid_obj = uuid.UUID(assistant_id)
                assistant = db.query(GeminiAssistantConfig).get(uuid_obj)
            except ValueError:
                assistant = db.query(GeminiAssistantConfig).filter(
                    GeminiAssistantConfig.id.cast(str) == assistant_id
                ).first()

        if not assistant:
            log_to_render(f"❌ Gemini assistant not found: {assistant_id}", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "assistant_not_found", "message": "Gemini assistant not found"}
            })
            await websocket.close(code=1008)
            return

        log_to_render(f"✅ Gemini assistant loaded: {getattr(assistant, 'name', assistant_id)}")
        log_to_render(f"   Voice: {getattr(assistant, 'voice', 'Aoede')}")
        log_to_render(f"   Model: gemini-2.5-flash-native-audio-preview-09-2025")
        log_to_render(f"   Thinking enabled: {getattr(assistant, 'enable_thinking', False)}")
        log_to_render(f"   Transcription: ENABLED")

        # Extract enabled functions
        functions = getattr(assistant, "functions", None)
        enabled_functions = []
        if isinstance(functions, list):
            enabled_functions = [normalize_function_name(f.get("name")) for f in functions if f.get("name")]
        elif isinstance(functions, dict) and "enabled_functions" in functions:
            enabled_functions = [normalize_function_name(name) for name in functions.get("enabled_functions", [])]
            
        log_to_render(f"🔧 Functions configuration:")
        log_to_render(f"   Enabled count: {len(enabled_functions)}")
        log_to_render(f"   Functions: {enabled_functions}")
        
        # Check if start_browser_task is enabled
        browser_task_enabled = "start_browser_task" in enabled_functions
        log_to_render(f"   Browser Task Function: {'ENABLED' if browser_task_enabled else 'NOT ENABLED'}")

        # Check Google Sheets config
        if hasattr(assistant, 'google_sheet_id') and assistant.google_sheet_id:
            log_to_render(f"📊 Google Sheets logging ENABLED")
            log_to_render(f"   Sheet ID: {assistant.google_sheet_id[:20]}...")
        else:
            log_to_render(f"⚠️ Google Sheets logging DISABLED (no sheet_id)")

        # Check subscription and get API key
        api_key = None
        user_id_str = None
        if assistant.user_id:
            user = db.query(User).get(assistant.user_id)
            if user:
                user_id_str = str(user.id)
                log_to_render(f"👤 User loaded:")
                log_to_render(f"   Email: {user.email}")
                log_to_render(f"   User ID: {user.id}")
                
                if not user.is_admin and user.email != "well96well@gmail.com":
                    from backend.services.user_service import UserService
                    subscription_status = await UserService.check_subscription_status(db, str(user.id))
                    
                    log_to_render(f"💳 Subscription check:")
                    log_to_render(f"   Active: {subscription_status.get('active')}")
                    log_to_render(f"   Trial: {subscription_status.get('is_trial')}")
                    
                    if not subscription_status["active"]:
                        log_to_render(f"❌ Subscription expired for user {user.id}", "WARNING")
                        
                        error_code = "TRIAL_EXPIRED" if subscription_status.get("is_trial") else "SUBSCRIPTION_EXPIRED"
                        error_message = "Ваш пробный период истек" if subscription_status.get("is_trial") else "Ваша подписка истекла"
                        
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": error_code,
                                "message": error_message,
                                "subscription_status": subscription_status,
                                "requires_payment": True
                            }
                        })
                        await websocket.close(code=1008)
                        return
                
                api_key = user.gemini_api_key
                if api_key:
                    log_to_render(f"🔑 Gemini API key loaded: {api_key[:10]}...{api_key[-5:]}")
                else:
                    log_to_render(f"⚠️ No Gemini API key for user", "WARNING")
        
        if not api_key:
            log_to_render(f"❌ No Gemini API key available", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "no_api_key", "message": "Google Gemini API key required"}
            })
            await websocket.close(code=1008)
            return

        # =====================================================================
        # 🎤 VOICE AGENT: Create Gemini Live client
        # =====================================================================
        log_to_render(f"🎤 Creating Gemini Live client (Voice Agent)...")
        log_to_render(f"   Client ID: {client_id}")
        log_to_render(f"   API Key: {api_key[:10]}...")
        gemini_client = GeminiLiveClient(api_key, assistant, client_id, db, user_agent)
        
        log_to_render(f"🔌 Connecting to Gemini Live API...")
        connect_start = time.time()
        if not await gemini_client.connect():
            log_to_render(f"❌ Failed to connect to Gemini", "ERROR")
            await websocket.send_json({
                "type": "error",
                "error": {"code": "gemini_connection_failed", "message": "Failed to connect to Gemini"}
            })
            await websocket.close(code=1008)
            return

        connection_time = time.time() - connect_start
        log_to_render(f"✅ Connected to Gemini in {connection_time:.2f}s")

        # =====================================================================
        # 🤖 BROWSER AGENT: Initialize
        # =====================================================================
        if BROWSER_AGENT_ENABLED:
            log_to_render(f"🤖 Initializing Browser Agent...")
            browser_agent = get_browser_agent_service(api_key)
            log_to_render(f"✅ Browser Agent ready (model: gemini-2.0-flash)")
        
        # =====================================================================
        # 📢 BROWSER AGENT: Voice notification callback
        # =====================================================================
        async def notify_voice_agent_callback(notification: Dict):
            """
            Browser Agent уведомляет Voice Agent о прогрессе/результате.
            Voice Agent озвучивает сообщение пользователю.
            """
            try:
                notification_type = notification.get("type", "")
                message = notification.get("message", "")
                task_id = notification.get("task_id", "")
                
                log_to_render(f"📢 Browser Agent notification: {notification_type}")
                log_to_render(f"   Task: {task_id[:8] if task_id else 'N/A'}...")
                log_to_render(f"   Message: {message}")
                
                if notification_type == "browser_agent.completed":
                    # Задача выполнена — озвучить результат
                    await websocket.send_json({
                        "type": "browser_agent.speak",
                        "message": message,
                        "event": "completed",
                        "task_id": task_id,
                        "extracted_data": notification.get("extracted_data")
                    })
                    
                elif notification_type == "browser_agent.progress":
                    # Прогресс — озвучить статус
                    await websocket.send_json({
                        "type": "browser_agent.speak",
                        "message": message,
                        "event": "progress",
                        "task_id": task_id,
                        "step": notification.get("step")
                    })
                    
                elif notification_type == "browser_agent.failed":
                    # Ошибка — озвучить
                    await websocket.send_json({
                        "type": "browser_agent.speak",
                        "message": message,
                        "event": "failed",
                        "task_id": task_id
                    })
                    
                elif notification_type == "browser_agent.need_info":
                    # Нужно уточнение от пользователя
                    await websocket.send_json({
                        "type": "browser_agent.speak",
                        "message": message,
                        "event": "need_info",
                        "task_id": task_id
                    })
                    
            except Exception as e:
                log_to_render(f"❌ Error in voice notification callback: {e}", "ERROR")
                log_to_render(traceback.format_exc(), "ERROR")

        # Send connection status
        await websocket.send_json({
            "type": "connection_status", 
            "status": "connected", 
            "message": "Connected to Gemini Live API (Production v2.1 + Browser Agent)",
            "model": "gemini-2.5-flash-native-audio-preview-09-2025",
            "functions_enabled": len(enabled_functions),
            "google_sheets": bool(getattr(assistant, 'google_sheet_id', None)),
            "thinking_enabled": getattr(assistant, 'enable_thinking', False),
            "transcription_enabled": True,
            "browser_agent_enabled": BROWSER_AGENT_ENABLED,
            "browser_task_function": browser_task_enabled,
            "client_id": client_id,
            "vad_mode": "gemini_native"
        })

        # Interruption state
        interruption_state = {
            "is_user_speaking": False,
            "is_assistant_speaking": False,
            "last_speech_start": 0,
            "last_speech_stop": 0,
            "interruption_count": 0,
            "last_interruption_time": 0
        }

        log_to_render(f"🎬 Starting Gemini message handler...")
        
        # =====================================================================
        # 🆕 v2.1: Pass browser_agent to message handler for function interception
        # =====================================================================
        gemini_task = asyncio.create_task(
            handle_gemini_messages(
                gemini_client=gemini_client,
                websocket=websocket,
                interruption_state=interruption_state,
                browser_agent=browser_agent,
                active_browser_tasks=active_browser_tasks,
                notify_voice_callback=notify_voice_agent_callback,
                user_id_str=user_id_str
            )
        )

        # Main client receive loop
        log_to_render(f"🔄 Starting main WebSocket receive loop...")
        message_count = 0
        audio_chunks_sent = 0
        browser_messages_count = 0
        
        while True:
            try:
                message = await websocket.receive()
                message_count += 1

                if "text" in message:
                    data = json.loads(message["text"])
                    msg_type = data.get("type", "")

                    if ENABLE_DETAILED_LOGGING and message_count % 10 == 0:
                        log_to_render(f"📨 Client message #{message_count}: {msg_type}")

                    # ==========================================================
                    # 🤖 BROWSER AGENT MESSAGES (from widget)
                    # ==========================================================
                    
                    if msg_type.startswith("browser.") and BROWSER_AGENT_ENABLED and browser_agent:
                        browser_messages_count += 1
                        
                        # ----- DOM Response from Widget -----
                        if msg_type == "browser.dom_response":
                            request_id = data.get("request_id")
                            dom = data.get("dom")
                            
                            log_to_render(f"📄 DOM response received")
                            log_to_render(f"   Request ID: {request_id[:8] if request_id else 'N/A'}...")
                            log_to_render(f"   Elements: {len(dom.get('elements', [])) if dom else 0}")
                            log_to_render(f"   URL: {dom.get('url', 'N/A') if dom else 'N/A'}")
                            
                            browser_agent.handle_dom_response(request_id, dom)
                            continue
                        
                        # ----- Action Result from Widget -----
                        if msg_type == "browser.action_result":
                            action_id = data.get("action_id")
                            result = data.get("result", {})
                            
                            log_to_render(f"⚡ Action result received")
                            log_to_render(f"   Action ID: {action_id[:8] if action_id else 'N/A'}...")
                            log_to_render(f"   Success: {result.get('success', False)}")
                            if not result.get('success'):
                                log_to_render(f"   Error: {result.get('error', 'unknown')}")
                            
                            browser_agent.handle_action_result(action_id, result)
                            continue
                        
                        # ----- Start Browser Task (from widget directly) -----
                        if msg_type == "browser.start_task":
                            goal = data.get("goal")
                            initial_url = data.get("url")
                            
                            log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                            log_to_render(f"🚀 BROWSER TASK REQUESTED (from widget)")
                            log_to_render(f"   Goal: {goal}")
                            log_to_render(f"   URL: {initial_url}")
                            log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                            
                            # Create task
                            task = await browser_agent.create_task(
                                user_id=user_id_str or "anonymous",
                                assistant_id=str(assistant.id),
                                session_id=gemini_client.session_id,
                                goal=goal,
                                initial_url=initial_url
                            )
                            
                            # Start execution asynchronously (doesn't block voice!)
                            browser_task = asyncio.create_task(
                                browser_agent.execute_task(
                                    task_id=task["id"],
                                    send_to_widget=websocket.send_json,
                                    notify_voice_agent=notify_voice_agent_callback
                                )
                            )
                            active_browser_tasks[task["id"]] = browser_task
                            
                            # Confirm task started
                            await websocket.send_json({
                                "type": "browser.task_started",
                                "task_id": task["id"],
                                "goal": goal
                            })
                            
                            log_to_render(f"✅ Browser task started: {task['id'][:8]}...")
                            continue
                        
                        # ----- Cancel Browser Task -----
                        if msg_type == "browser.cancel_task":
                            task_id = data.get("task_id")
                            
                            log_to_render(f"🛑 Browser task cancellation requested: {task_id[:8] if task_id else 'N/A'}...")
                            
                            if browser_agent.cancel_task(task_id):
                                # Also cancel the asyncio task
                                if task_id in active_browser_tasks:
                                    active_browser_tasks[task_id].cancel()
                                    del active_browser_tasks[task_id]
                                
                                await websocket.send_json({
                                    "type": "browser.task_cancelled",
                                    "task_id": task_id
                                })
                                log_to_render(f"✅ Task cancelled")
                            else:
                                await websocket.send_json({
                                    "type": "browser.cancel_failed",
                                    "task_id": task_id,
                                    "error": "Task not found or already completed"
                                })
                            continue
                        
                        # ----- Get Task Status -----
                        if msg_type == "browser.get_task_status":
                            task_id = data.get("task_id")
                            task = browser_agent.get_task(task_id)
                            
                            if task:
                                await websocket.send_json({
                                    "type": "browser.task_status",
                                    "task": task
                                })
                            else:
                                await websocket.send_json({
                                    "type": "browser.task_status",
                                    "task": None,
                                    "error": "Task not found"
                                })
                            continue
                    
                    # ==========================================================
                    # 🎤 VOICE AGENT MESSAGES (existing logic)
                    # ==========================================================

                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                        continue

                    if msg_type == "session.update":
                        log_to_render(f"📝 Client session.update received")
                        await websocket.send_json({
                            "type": "session.update.ack", 
                            "event_id": data.get("event_id", f"ack_{int(time.time() * 1000)}")
                        })
                        continue

                    # Screen context handler (silent mode)
                    if msg_type == "screen.context":
                        log_to_render(f"📸 Screen context received (silent mode)")
                        
                        image_data = data.get("image")
                        is_silent = data.get("silent", True)
                        
                        if not image_data:
                            log_to_render(f"❌ No image data in screen.context", "ERROR")
                            continue
                        
                        image_size_kb = len(image_data) // 1024
                        log_to_render(f"📸 Image size: {image_size_kb}KB")
                        log_to_render(f"📸 Silent mode: {is_silent}")
                        
                        if gemini_client.is_connected:
                            success = await gemini_client.send_screen_context(image_data, silent=is_silent)
                            if success:
                                log_to_render(f"✅ Screen context added to conversation")
                            else:
                                log_to_render(f"❌ Failed to send screen context", "ERROR")
                        else:
                            log_to_render(f"❌ Gemini not connected", "ERROR")
                        
                        continue

                    # ✅ PURE GEMINI VAD - continuous audio streaming
                    if msg_type == "input_audio_buffer.append":
                        audio_chunk = base64_to_audio_buffer(data["audio"])
                        audio_chunks_sent += 1
                        
                        if gemini_client.is_connected:
                            # ✅ Just send to Gemini - it handles everything
                            await gemini_client.process_audio(audio_chunk)
                        
                        # Send ack
                        await websocket.send_json({
                            "type": "input_audio_buffer.append.ack", 
                            "event_id": data.get("event_id")
                        })
                        
                        if audio_chunks_sent % 100 == 0:
                            log_to_render(f"📤 Sent {audio_chunks_sent} audio chunks (continuous stream)")
                        
                        continue

                    if msg_type == "response.cancel":
                        log_to_render(f"🛑 Response cancellation requested")
                        await websocket.send_json({
                            "type": "response.cancel.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    # Interruption handling
                    if msg_type == "interruption.manual":
                        log_to_render(f"⚡ Manual interruption triggered")
                        await gemini_client.handle_interruption()
                        await websocket.send_json({
                            "type": "interruption.manual.ack", 
                            "event_id": data.get("event_id")
                        })
                        continue
                    
                    if msg_type == "audio_playback.stopped":
                        log_to_render(f"🔇 Client stopped playback")
                        gemini_client.set_assistant_speaking(False)
                        interruption_state["is_assistant_speaking"] = False
                        continue
                    
                    # Speech events - for logging only
                    if msg_type == "speech.user_started":
                        log_to_render(f"🗣️ User started speaking (UI event)")
                        interruption_state["is_user_speaking"] = True
                        interruption_state["last_speech_start"] = time.time()
                        
                        # Check if interrupting assistant
                        if interruption_state["is_assistant_speaking"]:
                            log_to_render(f"⚡ User interrupted assistant!")
                            await gemini_client.handle_interruption()
                            interruption_state["interruption_count"] += 1
                            interruption_state["last_interruption_time"] = time.time()
                        continue
                    
                    if msg_type == "speech.user_stopped":
                        log_to_render(f"🤐 User stopped speaking (UI event)")
                        interruption_state["is_user_speaking"] = False
                        interruption_state["last_speech_stop"] = time.time()
                        continue

                elif "bytes" in message:
                    # Binary audio data (if sent this way)
                    audio_chunks_sent += 1
                    if gemini_client.is_connected:
                        await gemini_client.process_audio(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                log_to_render(f"🔌 Client WebSocket disconnected: {client_id}")
                break
            except Exception as e:
                log_to_render(f"❌ Error in WebSocket loop: {e}", "ERROR")
                log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                break

        # Cleanup
        log_to_render(f"🧹 Cleaning up connection...")
        
        # Cancel Gemini task
        if not gemini_task.done():
            gemini_task.cancel()
            await asyncio.sleep(0)
        
        # Cancel all browser tasks
        for task_id, task in active_browser_tasks.items():
            if not task.done():
                task.cancel()
                log_to_render(f"🛑 Cancelled browser task: {task_id[:8]}...")

        session_duration = time.time() - connection_start
        log_to_render(f"📊 Session stats:")
        log_to_render(f"   Duration: {session_duration:.2f}s")
        log_to_render(f"   Messages processed: {message_count}")
        log_to_render(f"   Audio chunks sent: {audio_chunks_sent}")
        log_to_render(f"   Browser messages: {browser_messages_count}")
        log_to_render(f"   Interruptions: {interruption_state['interruption_count']}")
        log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    except Exception as outer_e:
        log_to_render(f"❌ CRITICAL ERROR: {outer_e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
        
        try:
            await websocket.send_json({
                "type": "error",
                "error": {"code": "server_error", "message": "Internal server error"}
            })
        except:
            pass
    finally:
        if gemini_client:
            await gemini_client.close()
        
        conns = active_gemini_connections.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
        log_to_render(f"👋 Connection closed: {client_id}")


async def handle_gemini_messages(
    gemini_client: GeminiLiveClient, 
    websocket: WebSocket, 
    interruption_state: Dict,
    browser_agent: Optional[BrowserAgentService] = None,
    active_browser_tasks: Optional[Dict[str, asyncio.Task]] = None,
    notify_voice_callback: Optional[Callable[[Dict], Awaitable[None]]] = None,
    user_id_str: Optional[str] = None
):
    """
    🚀 PRODUCTION v2.1 - Handle messages from Gemini Live API
    ✅ Complete function calling support
    ✅ Google Sheets logging
    ✅ Database integration
    ✅ Audio transcription support (input + output)
    ✅ Maximum logging for debugging
    🆕 Browser Agent function interception (start_browser_task)
    """
    if not gemini_client.is_connected or not gemini_client.ws:
        log_to_render(f"❌ Gemini client not connected", "ERROR")
        return
    
    # Transcripts
    user_transcript = ""
    assistant_transcript = ""
    
    # Function tracking
    pending_function_call = {
        "name": None,
        "call_id": None,
        "arguments": {}
    }
    
    # Metrics
    event_count = 0
    function_execution_count = 0
    transcript_events_received = 0
    browser_tasks_started = 0
    
    # =========================================================================
    # 🤖 HELPER: Start Browser Task (used by both toolCall handlers)
    # =========================================================================
    async def start_browser_task_helper(
        function_id: str,
        arguments: Dict,
        normalized_name: str
    ) -> bool:
        """
        Helper to start browser task. Returns True if handled, False otherwise.
        """
        nonlocal browser_tasks_started
        
        if not browser_agent:
            log_to_render(f"❌ Browser Agent not available for start_browser_task", "ERROR")
            gemini_client.last_function_name = normalized_name
            await gemini_client.send_function_result(function_id, {
                "success": False,
                "error": "Browser Agent не доступен. Используйте виджет с поддержкой Browser Agent."
            })
            await websocket.send_json({
                "type": "function_call.error",
                "function": normalized_name,
                "function_call_id": function_id,
                "error": "Browser Agent not available"
            })
            return True
        
        goal = arguments.get("goal", "")
        initial_url = arguments.get("url")
        
        if not goal:
            log_to_render(f"❌ No goal provided for browser task", "ERROR")
            gemini_client.last_function_name = normalized_name
            await gemini_client.send_function_result(function_id, {
                "success": False,
                "error": "Не указана цель задачи (goal)"
            })
            return True
        
        log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        log_to_render(f"🤖 BROWSER TASK FROM VOICE COMMAND")
        log_to_render(f"   Goal: {goal}")
        log_to_render(f"   URL: {initial_url or 'current page'}")
        log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        
        try:
            # Create task
            task = await browser_agent.create_task(
                user_id=user_id_str or "anonymous",
                assistant_id=str(gemini_client.assistant_config.id),
                session_id=gemini_client.session_id,
                goal=goal,
                initial_url=initial_url
            )
            
            task_id = task["id"]
            log_to_render(f"✅ Browser task created: {task_id[:8]}...")
            
            # Start execution ASYNCHRONOUSLY (doesn't block voice!)
            browser_async_task = asyncio.create_task(
                browser_agent.execute_task(
                    task_id=task_id,
                    send_to_widget=websocket.send_json,
                    notify_voice_agent=notify_voice_callback
                )
            )
            
            # Save for cleanup
            if active_browser_tasks is not None:
                active_browser_tasks[task_id] = browser_async_task
            
            # Notify widget
            await websocket.send_json({
                "type": "browser.task_started",
                "task_id": task_id,
                "goal": goal
            })
            
            # ✅ Return result to Gemini IMMEDIATELY
            # This allows Gemini to say "Okay, starting to search..."
            gemini_client.last_function_name = normalized_name
            await gemini_client.send_function_result(function_id, {
                "success": True,
                "status": "started",
                "task_id": task_id,
                "message": f"Задача запущена: {goal}. Начинаю выполнение и сообщу о результате."
            })
            
            await websocket.send_json({
                "type": "function_call.completed",
                "function": normalized_name,
                "function_call_id": function_id,
                "result": {"status": "started", "task_id": task_id}
            })
            
            browser_tasks_started += 1
            log_to_render(f"✅ Browser task {task_id[:8]}... started and acknowledged to Gemini")
            
        except Exception as e:
            log_to_render(f"❌ Failed to start browser task: {e}", "ERROR")
            log_to_render(traceback.format_exc(), "ERROR")
            
            gemini_client.last_function_name = normalized_name
            await gemini_client.send_function_result(function_id, {
                "success": False,
                "error": f"Не удалось запустить задачу: {str(e)}"
            })
        
        return True
    
    # =========================================================================
    # MAIN MESSAGE LOOP
    # =========================================================================
    try:
        log_to_render(f"🎭 Gemini message handler started (v2.1)")
        log_to_render(f"   Client ID: {gemini_client.client_id}")
        log_to_render(f"   Session ID: {gemini_client.session_id}")
        log_to_render(f"   Enabled functions: {gemini_client.enabled_functions}")
        log_to_render(f"   Browser Agent: {'AVAILABLE' if browser_agent else 'NOT AVAILABLE'}")
        log_to_render(f"   VAD mode: Pure Gemini (automatic)")
        log_to_render(f"   Transcription: ENABLED")
        
        while True:
            try:
                raw = await gemini_client.ws.recv()
                event_count += 1
                
                try:
                    response_data = json.loads(raw)
                except json.JSONDecodeError:
                    log_to_render(f"❌ JSON decode error: {raw[:200]}", "ERROR")
                    continue
                
                # Detailed logging
                should_log = (
                    ENABLE_DETAILED_LOGGING and (
                        event_count % 20 == 0 or
                        "toolCall" in response_data or
                        "serverContent" in response_data
                    )
                )
                
                if should_log:
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_to_render(f"📡 Gemini Event #{event_count}")
                    log_to_render(f"   Keys: {list(response_data.keys())}")
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                
                # Setup complete
                if "setupComplete" in response_data:
                    log_to_render(f"✅ Gemini setup complete (transcription enabled)")
                    await websocket.send_json({
                        "type": "gemini.setup.complete",
                        "timestamp": time.time(),
                        "transcription_enabled": True
                    })
                    continue
                
                # =============================================================
                # ✅ Tool Call event (top-level, outside serverContent)
                # =============================================================
                if "toolCall" in response_data:
                    tool_call = response_data["toolCall"]
                    function_calls = tool_call.get("functionCalls", [])
                    
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_to_render(f"🔧 TOOL CALL EVENT (top-level)")
                    log_to_render(f"   Function calls: {len(function_calls)}")
                    log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    
                    for func_call in function_calls:
                        function_name = func_call.get("name")
                        function_id = func_call.get("id")
                        arguments = func_call.get("args", {})
                        
                        log_to_render(f"📞 Function: {function_name}")
                        log_to_render(f"   ID: {function_id}")
                        log_to_render(f"   Args: {json.dumps(arguments, ensure_ascii=False)[:200]}")
                        
                        normalized_name = normalize_function_name(function_name)
                        
                        # =====================================================
                        # 🤖 INTERCEPT: start_browser_task
                        # =====================================================
                        if normalized_name == "start_browser_task":
                            log_to_render(f"🤖 INTERCEPTING start_browser_task")
                            await start_browser_task_helper(function_id, arguments, normalized_name)
                            continue
                        
                        # =====================================================
                        # Standard function execution
                        # =====================================================
                        try:
                            start_time = time.time()
                            
                            log_to_render(f"⚙️ Executing function: {normalized_name}")
                            
                            # ✅ Set last_function_name for send_function_result
                            gemini_client.last_function_name = normalized_name
                            
                            # ✅ execute_function with correct signature
                            result = await execute_function(
                                name=normalized_name,
                                arguments=arguments,
                                context={
                                    "assistant_config": gemini_client.assistant_config,
                                    "client_id": gemini_client.client_id,
                                    "db_session": gemini_client.db_session,
                                    "websocket": websocket
                                }
                            )
                            
                            execution_time = time.time() - start_time
                            function_execution_count += 1
                            
                            log_to_render(f"✅ Function executed: {execution_time:.3f}s")
                            
                            # Send result to Gemini
                            log_to_render(f"📤 Sending function result to Gemini...")
                            delivery_status = await gemini_client.send_function_result(
                                function_id,
                                result
                            )
                            
                            if delivery_status and delivery_status.get("success"):
                                log_to_render(f"✅ Result delivered to Gemini")
                                
                                await websocket.send_json({
                                    "type": "function_call.completed",
                                    "function": normalized_name,
                                    "function_call_id": function_id,
                                    "result": result,
                                    "execution_time": execution_time
                                })
                            else:
                                log_to_render(f"❌ Delivery failed: {delivery_status.get('error')}", "ERROR")
                                
                                await websocket.send_json({
                                    "type": "function_call.delivery_error",
                                    "function_call_id": function_id,
                                    "error": delivery_status.get('error')
                                })
                                
                        except Exception as e:
                            log_to_render(f"❌ Function execution error: {e}", "ERROR")
                            log_to_render(f"   Traceback: {traceback.format_exc()}", "ERROR")
                            
                            await websocket.send_json({
                                "type": "error",
                                "error": {"code": "function_execution_error", "message": str(e)}
                            })
                    
                    continue
                
                # =============================================================
                # Server content (main response container)
                # =============================================================
                if "serverContent" in response_data:
                    server_content = response_data["serverContent"]
                    
                    # ✅ INPUT TRANSCRIPTION (user's speech)
                    if "inputTranscription" in server_content:
                        input_trans = server_content["inputTranscription"]
                        if "text" in input_trans:
                            transcript_text = input_trans["text"]
                            user_transcript += transcript_text
                            transcript_events_received += 1
                            log_to_render(f"👤 USER TRANSCRIPT: {transcript_text}")
                            
                            await websocket.send_json({
                                "type": "input.transcription",
                                "text": transcript_text
                            })
                    
                    # ✅ OUTPUT TRANSCRIPTION (assistant's speech)
                    if "outputTranscription" in server_content:
                        output_trans = server_content["outputTranscription"]
                        if "text" in output_trans:
                            transcript_text = output_trans["text"]
                            assistant_transcript += transcript_text
                            transcript_events_received += 1
                            log_to_render(f"🤖 ASSISTANT TRANSCRIPT: {transcript_text}")
                            
                            await websocket.send_json({
                                "type": "output.transcription",
                                "text": transcript_text
                            })
                    
                    # Check for interruption
                    if server_content.get("interrupted"):
                        log_to_render(f"⚡ Conversation interrupted by Gemini")
                        interruption_state["interruption_count"] += 1
                        interruption_state["last_interruption_time"] = time.time()
                        interruption_state["is_assistant_speaking"] = False
                        gemini_client.set_assistant_speaking(False)
                        
                        await websocket.send_json({
                            "type": "conversation.interrupted",
                            "timestamp": interruption_state["last_interruption_time"]
                        })
                        continue
                    
                    # Model turn
                    if "modelTurn" in server_content:
                        model_turn = server_content["modelTurn"]
                        parts = model_turn.get("parts", [])
                        
                        for part in parts:
                            # Text content
                            if "text" in part:
                                text = part["text"]
                                await websocket.send_json({
                                    "type": "response.text.delta",
                                    "delta": text
                                })
                            
                            # Inline audio data
                            if "inlineData" in part:
                                inline_data = part["inlineData"]
                                mime_type = inline_data.get("mimeType", "")
                                data = inline_data.get("data", "")
                                
                                if "audio/pcm" in mime_type:
                                    if not interruption_state["is_assistant_speaking"]:
                                        log_to_render(f"🔊 Assistant started speaking")
                                        interruption_state["is_assistant_speaking"] = True
                                        gemini_client.set_assistant_speaking(True)
                                        
                                        await websocket.send_json({
                                            "type": "assistant.speech.started",
                                            "timestamp": time.time()
                                        })
                                    
                                    # Send audio delta
                                    await websocket.send_json({
                                        "type": "response.audio.delta",
                                        "delta": data
                                    })
                                    
                                    # Count samples
                                    sample_count = len(base64.b64decode(data)) // 2
                                    gemini_client.increment_audio_samples(sample_count)
                            
                            # =========================================================
                            # Function call (inside modelTurn)
                            # =========================================================
                            if "functionCall" in part:
                                function_call = part["functionCall"]
                                function_name = function_call.get("name")
                                arguments = function_call.get("args", {})
                                
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                log_to_render(f"🔧 FUNCTION CALL DETECTED (in modelTurn)")
                                log_to_render(f"   Function: {function_name}")
                                log_to_render(f"   Arguments: {json.dumps(arguments, ensure_ascii=False)[:200]}")
                                log_to_render(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                                
                                normalized_name = normalize_function_name(function_name) or function_name
                                
                                if normalized_name not in gemini_client.enabled_functions:
                                    log_to_render(f"❌ UNAUTHORIZED function: {normalized_name}", "WARNING")
                                    
                                    await websocket.send_json({
                                        "type": "function_call.error",
                                        "function": normalized_name,
                                        "error": f"Function {function_name} not activated"
                                    })
                                    continue
                                
                                # Generate call_id for this function call
                                function_call_id = f"call_{int(time.time() * 1000)}"
                                
                                # =====================================================
                                # 🤖 INTERCEPT: start_browser_task
                                # =====================================================
                                if normalized_name == "start_browser_task":
                                    log_to_render(f"🤖 INTERCEPTING start_browser_task (from modelTurn)")
                                    await start_browser_task_helper(function_call_id, arguments, normalized_name)
                                    continue
                                
                                # =====================================================
                                # Standard function execution
                                # =====================================================
                                
                                # Store for later
                                pending_function_call = {
                                    "name": normalized_name,
                                    "call_id": function_call_id,
                                    "arguments": arguments
                                }
                                gemini_client.last_function_name = normalized_name
                                
                                await websocket.send_json({
                                    "type": "function_call.started",
                                    "function": normalized_name,
                                    "function_call_id": pending_function_call["call_id"]
                                })
                                
                                # Execute function
                                try:
                                    await websocket.send_json({
                                        "type": "function_call.executing",
                                        "function": normalized_name,
                                        "function_call_id": pending_function_call["call_id"],
                                        "arguments": arguments
                                    })
                                    
                                    log_to_render(f"🚀 EXECUTING FUNCTION: {normalized_name}")
                                    start_time = time.time()
                                    
                                    result = await execute_function(
                                        name=normalized_name,
                                        arguments=arguments,
                                        context={
                                            "assistant_config": gemini_client.assistant_config,
                                            "client_id": gemini_client.client_id,
                                            "db_session": gemini_client.db_session,
                                            "websocket": websocket
                                        }
                                    )
                                    
                                    execution_time = time.time() - start_time
                                    function_execution_count += 1
                                    
                                    log_to_render(f"✅ FUNCTION EXECUTED SUCCESSFULLY")
                                    log_to_render(f"   Execution time: {execution_time:.3f}s")
                                    
                                    # Fast display for query_llm
                                    if normalized_name == "query_llm":
                                        log_to_render(f"⚡ QUERY_LLM - sending result IMMEDIATELY")
                                        
                                        llm_response_content = ""
                                        llm_model = "gpt-4"
                                        
                                        if isinstance(result, dict):
                                            llm_response_content = result.get("full_response", result.get("response", str(result)))
                                            llm_model = result.get("model_used", "gpt-4")
                                        else:
                                            llm_response_content = str(result)
                                        
                                        await websocket.send_json({
                                            "type": "llm_result",
                                            "content": llm_response_content,
                                            "model": llm_model,
                                            "function": normalized_name,
                                            "execution_time": execution_time,
                                            "timestamp": time.time()
                                        })
                                    
                                    # Save to DB
                                    if gemini_client.db_session and gemini_client.conversation_record_id:
                                        try:
                                            conv = gemini_client.db_session.query(GeminiConversation).get(
                                                uuid.UUID(gemini_client.conversation_record_id)
                                            )
                                            if conv:
                                                function_summary = f"[Function: {normalized_name}] Result: {json.dumps(result, ensure_ascii=False)[:200]}"
                                                conv.assistant_message = function_summary
                                                if user_transcript and not conv.user_message:
                                                    conv.user_message = user_transcript
                                                gemini_client.db_session.commit()
                                                log_to_render(f"✅ DATABASE UPDATE SUCCESSFUL")
                                        except Exception as e:
                                            log_to_render(f"❌ DB save error: {e}", "ERROR")
                                    
                                    # Google Sheets logging for function calls
                                    if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                        sheet_id = gemini_client.assistant_config.google_sheet_id
                                        
                                        try:
                                            sheets_result = await GoogleSheetsService.log_conversation(
                                                sheet_id=sheet_id,
                                                user_message=user_transcript or f"[Function call: {normalized_name}]",
                                                assistant_message=f"[Function executed: {normalized_name}]",
                                                function_result=result,
                                                conversation_id=gemini_client.conversation_record_id
                                            )
                                            
                                            if sheets_result:
                                                log_to_render(f"✅ Google Sheets logged (function call)")
                                            else:
                                                log_to_render(f"❌ Google Sheets failed", "WARNING")
                                        except Exception as e:
                                            log_to_render(f"❌ Sheets error: {e}", "ERROR")
                                    
                                    # Send result to Gemini
                                    log_to_render(f"📤 Sending function result to Gemini...")
                                    delivery_status = await gemini_client.send_function_result(
                                        pending_function_call["call_id"], 
                                        result
                                    )
                                    
                                    if delivery_status["success"]:
                                        log_to_render(f"✅ Function result delivered")
                                        
                                        await websocket.send_json({
                                            "type": "function_call.completed",
                                            "function": normalized_name,
                                            "function_call_id": pending_function_call["call_id"],
                                            "result": result,
                                            "execution_time": execution_time
                                        })
                                    else:
                                        log_to_render(f"❌ Delivery failed: {delivery_status['error']}", "ERROR")
                                        
                                        await websocket.send_json({
                                            "type": "function_call.delivery_error",
                                            "function_call_id": pending_function_call["call_id"],
                                            "error": delivery_status['error']
                                        })
                                    
                                except Exception as e:
                                    log_to_render(f"❌ Function execution ERROR: {e}", "ERROR")
                                    log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
                                    
                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {"code": "function_execution_error", "message": str(e)}
                                    })
                                
                                # Clear pending
                                pending_function_call = {"name": None, "call_id": None, "arguments": {}}
                        
                        # Turn complete
                        if server_content.get("turnComplete"):
                            log_to_render(f"🏁 Turn complete")
                            log_to_render(f"📊 TRANSCRIPTS - User: {len(user_transcript)} chars | Assistant: {len(assistant_transcript)} chars")
                            
                            if interruption_state["is_assistant_speaking"]:
                                interruption_state["is_assistant_speaking"] = False
                                gemini_client.set_assistant_speaking(False)
                                
                                await websocket.send_json({
                                    "type": "assistant.speech.ended",
                                    "timestamp": time.time()
                                })
                            
                            # ✅ LOGGING WITH TRANSCRIPTS
                            if user_transcript or assistant_transcript:
                                final_user = user_transcript or "[Voice input - no text transcript]"
                                final_assistant = assistant_transcript or "[Voice response - no text transcript]"
                                
                                log_to_render(f"💾 Saving dialog with transcripts")
                                log_to_render(f"   User: {final_user[:100]}...")
                                log_to_render(f"   Assistant: {final_assistant[:100]}...")
                                
                                # Save to DB
                                try:
                                    await ConversationService.save_conversation(
                                        db=gemini_client.db_session,
                                        assistant_id=str(gemini_client.assistant_config.id),
                                        user_message=final_user,
                                        assistant_message=final_assistant,
                                        session_id=gemini_client.session_id,
                                        caller_number=None,
                                        tokens_used=0
                                    )
                                    log_to_render(f"✅ Dialog saved to DB")
                                except Exception as e:
                                    log_to_render(f"❌ Error saving dialog: {e}", "ERROR")
                                
                                # ✅ Google Sheets logging for regular dialog
                                if gemini_client.assistant_config and gemini_client.assistant_config.google_sheet_id:
                                    log_to_render(f"📊 Attempting Google Sheets log...")
                                    log_to_render(f"   Sheet ID: {gemini_client.assistant_config.google_sheet_id[:20]}...")
                                    
                                    try:
                                        sheets_result = await GoogleSheetsService.log_conversation(
                                            sheet_id=gemini_client.assistant_config.google_sheet_id,
                                            user_message=final_user,
                                            assistant_message=final_assistant,
                                            function_result=None,
                                            conversation_id=gemini_client.conversation_record_id
                                        )
                                        
                                        if sheets_result:
                                            log_to_render(f"✅ ✅ ✅ GOOGLE SHEETS LOGGED SUCCESSFULLY ✅ ✅ ✅")
                                        else:
                                            log_to_render(f"❌ Google Sheets returned False", "ERROR")
                                    except Exception as e:
                                        log_to_render(f"❌ Sheets error: {e}", "ERROR")
                                        log_to_render(f"   Traceback: {traceback.format_exc()}", "ERROR")
                                else:
                                    log_to_render(f"⚠️ Skipping Sheets: no google_sheet_id configured", "WARNING")
                            else:
                                log_to_render(f"⚠️ Skipping dialog save: both transcripts empty", "WARNING")
                            
                            # Reset transcripts
                            user_transcript = ""
                            assistant_transcript = ""
                
                # User transcript from clientContent (if any)
                if "clientContent" in response_data:
                    client_content = response_data["clientContent"]
                    turns = client_content.get("turns", [])
                    
                    for turn in turns:
                        parts = turn.get("parts", [])
                        for part in parts:
                            if "text" in part:
                                log_to_render(f"👤 CLIENT CONTENT TEXT: {part['text']}")

            except ConnectionClosed as e:
                log_to_render(f"⚠️ Gemini connection closed: {e}", "WARNING")
                if await gemini_client.reconnect():
                    log_to_render(f"✅ Reconnected to Gemini")
                    continue
                else:
                    log_to_render(f"❌ Reconnection failed", "ERROR")
                    await websocket.send_json({
                        "type": "error",
                        "error": {"code": "gemini_connection_lost", "message": "Connection lost"}
                    })
                    break

    except (ConnectionClosed, asyncio.CancelledError):
        log_to_render(f"👋 Handler terminated for {gemini_client.client_id}")
        return
    except Exception as e:
        log_to_render(f"❌ CRITICAL Handler error: {e}", "ERROR")
        log_to_render(f"Traceback: {traceback.format_exc()}", "ERROR")
    finally:
        # ✅ FALLBACK LOGGING if there are unsaved transcripts
        if (user_transcript or assistant_transcript) and gemini_client.assistant_config:
            log_to_render(f"💾 FINAL SAVE: Found unsaved transcripts on disconnect")
            log_to_render(f"   User: {len(user_transcript)} chars")
            log_to_render(f"   Assistant: {len(assistant_transcript)} chars")
            
            final_user = user_transcript or "[Voice input - no text transcript]"
            final_assistant = assistant_transcript or "[Voice response - incomplete]"
            
            # Save to DB
            try:
                await ConversationService.save_conversation(
                    db=gemini_client.db_session,
                    assistant_id=str(gemini_client.assistant_config.id),
                    user_message=final_user,
                    assistant_message=final_assistant,
                    session_id=gemini_client.session_id,
                    caller_number=None,
                    tokens_used=0
                )
                log_to_render(f"✅ Final transcripts saved to DB")
            except Exception as e:
                log_to_render(f"❌ Final DB save error: {e}", "ERROR")
            
            # Save to Google Sheets
            if gemini_client.assistant_config.google_sheet_id:
                try:
                    sheets_result = await GoogleSheetsService.log_conversation(
                        sheet_id=gemini_client.assistant_config.google_sheet_id,
                        user_message=final_user,
                        assistant_message=final_assistant,
                        function_result=None,
                        conversation_id=gemini_client.conversation_record_id
                    )
                    
                    if sheets_result:
                        log_to_render(f"✅ Final transcripts saved to Google Sheets")
                    else:
                        log_to_render(f"❌ Final Sheets save failed", "ERROR")
                except Exception as e:
                    log_to_render(f"❌ Final Sheets error: {e}", "ERROR")
        
        log_to_render(f"📊 Final handler stats:")
        log_to_render(f"   Total events processed: {event_count}")
        log_to_render(f"   Functions executed: {function_execution_count}")
        log_to_render(f"   Browser tasks started: {browser_tasks_started}")
        log_to_render(f"   Transcript events received: {transcript_events_received}")
