"""
WebSocket handler for WellcomeAI application.
Handles WebSocket connections and message processing.
"""

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
import json
import asyncio
import uuid
import base64
from typing import Dict, Any, Optional, List
from websockets.exceptions import ConnectionClosed

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.assistant import AssistantConfig
from backend.models.conversation import Conversation
from backend.utils.audio_utils import base64_to_audio_buffer, create_wav_from_pcm
from backend.websockets.openai_client import OpenAIRealtimeClient

logger = get_logger(__name__)

# Store active connections for each assistant
active_connections: Dict[str, List[WebSocket]] = {}


async def handle_websocket_connection(
    websocket: WebSocket,
    assistant_id: str,
    db: Session
) -> None:
    """
    WebSocket connection handler

    Args:
        websocket: WebSocket connection
        assistant_id: Assistant ID
        db: Database session
    """
    client_id = str(uuid.uuid4())
    openai_client = None

    try:
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")

        # Register connection
        active_connections.setdefault(assistant_id, []).append(websocket)

        # Load assistant from DB
        try:
            if assistant_id == "demo":
                assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public.is_(True)).first()
                if not assistant:
                    assistant = db.query(AssistantConfig).first()
                logger.info(f"Using assistant {assistant.id if assistant else 'None'} for demo")
            else:
                try:
                    uuid_obj = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).filter(AssistantConfig.id == uuid_obj).first()
                except ValueError:
                    assistant = db.query(AssistantConfig).filter(
                        AssistantConfig.id.cast(str) == assistant_id
                    ).first()

            if not assistant:
                logger.warning(f"Assistant not found: {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "assistant_not_found",
                        "message": "Assistant not found. Please check ID or create a new assistant."
                    }
                })
                # create temporary demo assistant if none exist
                if db.query(AssistantConfig).count() == 0:
                    demo_user = db.query(User).first()
                    if demo_user:
                        demo_assistant = AssistantConfig(
                            id=uuid.uuid4(),
                            user_id=demo_user.id,
                            name="Demo Assistant",
                            description="Temporary demonstration assistant",
                            system_prompt="You are a helpful voice assistant that responds politely and friendly.",
                            voice="alloy",
                            language="en",
                            is_active=True,
                            is_public=True
                        )
                        db.add(demo_assistant)
                        db.commit()
                        db.refresh(demo_assistant)
                        assistant = demo_assistant
                        logger.info(f"Created temporary demo assistant with ID: {assistant.id}")
                        await websocket.send_json({
                            "type": "info",
                            "message": "Created temporary demo assistant for testing"
                        })
                    else:
                        logger.warning("No users found to create demo assistant")
                        await websocket.close(code=1008)
                        return
                else:
                    await websocket.close(code=1008)
                    return

            # Determine API key
            api_key = None
            if assistant.user_id:
                user = db.query(User).filter(User.id == assistant.user_id).first()
                if user and user.openai_api_key:
                    api_key = user.openai_api_key
            if not api_key:
                api_key = settings.OPENAI_API_KEY

            if not api_key:
                logger.error(f"No OpenAI API key for assistant {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "no_api_key",
                        "message": "No OpenAI API key found. Please add a key in settings."
                    }
                })
                await websocket.close(code=1008)
                return

            # Initialize OpenAI client
            openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
            connected = await openai_client.connect()
            if not connected:
                logger.error(f"Failed to connect to OpenAI for assistant {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "openai_connection_failed",
                        "message": "Failed to connect to OpenAI. Please try again later."
                    }
                })
                await websocket.close(code=1008)
                return

            await websocket.send_json({
                "type": "connection_status",
                "status": "connected",
                "message": "Connection established"
            })

        except Exception as e:
            logger.error(f"Error loading assistant: {e}")
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "database_error",
                    "message": f"Error loading assistant: {e}"
                }
            })
            await websocket.close(code=1011)
            return

        audio_buffer = bytearray()
        is_processing = False
        openai_task = asyncio.create_task(handle_openai_messages(openai_client, websocket))

        while True:
            try:
                message = await websocket.receive()

                if "text" in message:
                    try:
                        data = json.loads(message["text"])
                        msg_type = data.get("type", "")

                        if msg_type == "ping":
                            await websocket.send_json({"type": "pong"})
                            continue

                        if msg_type == "input_audio_buffer.append":
                            if "audio" in data:
                                try:
                                    audio_chunk = base64_to_audio_buffer(data["audio"])
                                    audio_buffer.extend(audio_chunk)
                                    if openai_client and openai_client.is_connected:
                                        await openai_client.process_audio(audio_chunk)
                                    await websocket.send_json({
                                        "type": "input_audio_buffer.append.ack",
                                        "event_id": data.get("event_id", "unknown")
                                    })
                                except Exception as audio_error:
                                    logger.error(f"Error processing audio: {audio_error}")
                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {
                                            "code": "audio_processing_error",
                                            "message": "Error processing audio data"
                                        }
                                    })
                            continue

                        if msg_type == "input_audio_buffer.commit" and not is_processing:
                            is_processing = True
                            if not audio_buffer:
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {
                                        "code": "input_audio_buffer_commit_empty",
                                        "message": "Audio buffer is empty"
                                    }
                                })
                                is_processing = False
                                continue

                            if openai_client and openai_client.is_connected:
                                try:
                                    await openai_client.commit_audio()
                                    await websocket.send_json({
                                        "type": "input_audio_buffer.commit.ack",
                                        "event_id": data.get("event_id", "unknown")
                                    })
                                except Exception as commit_error:
                                    logger.error(f"Error committing audio: {commit_error}")
                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {
                                            "code": "audio_commit_error",
                                            "message": "Error processing audio request"
                                        }
                                    })
                            else:
                                logger.error("Cannot process audio: OpenAI client not connected")
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {
                                        "code": "openai_not_connected",
                                        "message": "Connection to OpenAI lost"
                                    }
                                })

                            audio_buffer.clear()
                            is_processing = False
                            continue

                        if msg_type == "input_audio_buffer.clear":
                            audio_buffer.clear()
                            if openai_client and openai_client.is_connected:
                                await openai_client.clear_audio_buffer()
                            await websocket.send_json({
                                "type": "input_audio_buffer.clear.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue

                        if msg_type == "response.cancel":
                            if openai_client and openai_client.is_connected:
                                await openai_client.ws.send(json.dumps({
                                    "type": "response.cancel",
                                    "event_id": data.get("event_id", "unknown")
                                }))
                            await websocket.send_json({
                                "type": "response.cancel.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue

                        logger.warning(f"Unknown message type: {msg_type}")
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "unknown_message_type",
                                "message": f"Unknown message type: {msg_type}"
                            }
                        })

                    except json.JSONDecodeError:
                        logger.warning(f"Invalid JSON: {message['text'][:50]}...")
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "invalid_json",
                                "message": "Invalid JSON format"
                            }
                        })

                elif "bytes" in message:
                    audio_buffer.extend(message["bytes"])
                    await websocket.send_json({"type": "binary.ack"})

            except (WebSocketDisconnect, ConnectionClosed):
                logger.info(f"WebSocket connection closed for client {client_id}")
                break
            except Exception as e:
                # ignore “receive after disconnect” errors
                if "Cannot call \"receive\" once a disconnect" in str(e):
                    logger.info(f"Ignoring receive-after-disconnect for client {client_id}")
                    break
                logger.error(f"Error in WebSocket message processing: {e}")
                try:
                    if websocket.client_state.CONNECTED:
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "processing_error",
                                "message": f"Error processing message: {e}"
                            }
                        })
                except Exception:
                    logger.warning("Cannot send error message, connection may be closed")
                break

        # teardown
        if not openai_task.done():
            openai_task.cancel()
            try:
                await asyncio.wait_for(openai_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                logger.info(f"OpenAI task cancelled for client {client_id}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket connection closed: client_id={client_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if openai_client:
            try:
                await openai_client.close()
                logger.info(f"Closed OpenAI connection for client {client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI connection: {e}")

        # Remove from active connections
        conns = active_connections.get(assistant_id, [])
        if websocket in conns:
            conns.remove(websocket)
            if not conns:
                active_connections.pop(assistant_id, None)
        logger.info(f"Removed WebSocket connection: client_id={client_id}")


async def handle_openai_messages(openai_client, websocket):
    """
    Handle messages from OpenAI and forward to client

    Args:
        openai_client: OpenAI client
        websocket: WebSocket connection to client
    """
    if not openai_client or not openai_client.ws:
        return

    try:
        while True:
            response = await openai_client.ws.recv()
            try:
                response_data = json.loads(response)
                response_type = response_data.get("type", "")

                # Forward to client
                await websocket.send_json(response_data)

                # Save completed text responses
                if response_type == "response.text.done":
                    text = response_data.get("text", "")
                    if openai_client.db_session and openai_client.conversation_record_id and text:
                        conv = openai_client.db_session.query(Conversation).get(
                            uuid.UUID(openai_client.conversation_record_id)
                        )
                        if conv:
                            conv.assistant_message = text
                            openai_client.db_session.commit()
                            logger.info(f"Saved assistant response: {text[:50]}...")

                # Handle transcription events
                elif response_type == "conversation.item.input_audio_transcription.completed":
                    transcript = response_data.get("transcript", "")
                    if openai_client.db_session and openai_client.conversation_record_id and transcript:
                        conv = openai_client.db_session.query(Conversation).get(
                            uuid.UUID(openai_client.conversation_record_id)
                        )
                        if conv:
                            conv.user_message = transcript
                            openai_client.db_session.commit()
                            logger.info(f"Saved user transcript: {transcript[:50]}...")

            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from OpenAI: {response[:100]}...")
            except Exception as e:
                logger.error(f"Error processing OpenAI message: {e}")

    except asyncio.CancelledError:
        logger.info(f"OpenAI message handler cancelled for client {openai_client.client_id}")
    except ConnectionClosed:
        logger.warning(f"OpenAI connection closed for client {openai_client.client_id}")
    except Exception as e:
        logger.error(f"Error in OpenAI message handler: {e}")
