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
    # Client identifier
    client_id = str(uuid.uuid4())
    openai_client = None
    
    try:
        # Accept connection
        await websocket.accept()
        logger.info(f"WebSocket connection accepted: client_id={client_id}, assistant_id={assistant_id}")
        
        # Register connection
        if assistant_id not in active_connections:
            active_connections[assistant_id] = []
        active_connections[assistant_id].append(websocket)
        
        # Load assistant from database
        assistant = None
        try:
            # Check if this is demo mode or not
            if assistant_id == "demo":
                # Use demo logic
                assistant = db.query(AssistantConfig).filter(AssistantConfig.is_public == True).first()
                if not assistant:
                    # Just get the first available assistant
                    assistant = db.query(AssistantConfig).first()
                logger.info(f"Using assistant {assistant.id if assistant else 'None'} for demo")
            else:
                # Try with different ID formats
                try:
                    uuid_obj = uuid.UUID(assistant_id)
                    assistant = db.query(AssistantConfig).filter(AssistantConfig.id == uuid_obj).first()
                except ValueError:
                    # If not UUID, try as string
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
                
                # Create temporary assistant for demo if none exists
                if db.query(AssistantConfig).count() == 0:
                    logger.info("Creating a temporary demo assistant")
                    
                    # Find any user
                    demo_user = db.query(User).first()
                    if demo_user:
                        demo_assistant = AssistantConfig(
                            id=uuid.uuid4(),
                            user_id=demo_user.id,
                            name="Demo Assistant",
                            description="Temporary demonstration assistant",
                            system_prompt="You are a helpful voice assistant that responds to questions politely and in a friendly manner.",
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
                        
                        # Inform client about temporary assistant
                        await websocket.send_json({
                            "type": "info",
                            "message": "Created temporary demo assistant for testing"
                        })
                    else:
                        logger.warning("No users found to create demo assistant")
                        await websocket.close(code=1008)
                        return
                else:
                    logger.warning("No assistants available and no demo assistant created")
                    await websocket.close(code=1008)
                    return
                
            # Get API key for OpenAI
            api_key = None
            if assistant.user_id:
                user = db.query(User).filter(User.id == assistant.user_id).first()
                if user and user.openai_api_key:
                    api_key = user.openai_api_key
            
            # If no user key, use key from settings
            if not api_key:
                api_key = settings.OPENAI_API_KEY
                
            if not api_key:
                logger.error(f"No OpenAI API key found for assistant {assistant_id}")
                await websocket.send_json({
                    "type": "error",
                    "error": {
                        "code": "no_api_key",
                        "message": "No OpenAI API key found. Please add a key in settings."
                    }
                })
                await websocket.close(code=1008)
                return
                
            # Create OpenAI client
            openai_client = OpenAIRealtimeClient(api_key, assistant, client_id, db)
            
            # Connect to OpenAI
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
            
            # Send connection confirmation
            await websocket.send_json({
                "type": "connection_status",
                "status": "connected",
                "message": "Connection established"
            })
            
            # Send session info without session_id
            await websocket.send_json({
                "type": "session.created",
                "assistant": {
                    "id": str(assistant.id),
                    "name": assistant.name
                }
            })
            
        except Exception as e:
            logger.error(f"Error loading assistant: {str(e)}")
            await websocket.send_json({
                "type": "error",
                "error": {
                    "code": "database_error",
                    "message": f"Error loading assistant: {str(e)}"
                }
            })
            await websocket.close(code=1011)
            return
        
        # Audio buffer for incoming audio
        audio_buffer = bytearray()
        
        # State flags
        is_processing = False
        
        # Start task for reading messages from OpenAI
        openai_task = asyncio.create_task(handle_openai_messages(openai_client, websocket))
        
        # Main loop for processing client messages
        while True:
            try:
                # Get message (text or binary data)
                message = await websocket.receive()
                
                # Log message type
                if 'text' in message:
                    logger.debug(f"Received text message: {message['text'][:50]}...")
                elif 'bytes' in message:
                    logger.debug(f"Received binary message: {len(message['bytes'])} bytes")
                else:
                    logger.debug(f"Received unknown message type: {message}")
                
                # Check message type
                if "text" in message:
                    # Process text message
                    try:
                        data = json.loads(message["text"])
                        
                        # Process different message types
                        msg_type = data.get("type", "")
                        logger.debug(f"Processing message type: {msg_type}")
                        
                        # Ping-pong for maintaining connection
                        if msg_type == "ping":
                            await websocket.send_json({"type": "pong"})
                            continue
                        
                        # Process audio buffer
                        if msg_type == "input_audio_buffer.append":
                            if "audio" in data:
                                # Decode audio from base64
                                try:
                                    audio_chunk = base64_to_audio_buffer(data["audio"])
                                    audio_buffer.extend(audio_chunk)
                                    
                                    # Send acknowledgment
                                    await websocket.send_json({
                                        "type": "input_audio_buffer.append.ack",
                                        "event_id": data.get("event_id", "unknown")
                                    })
                                except Exception as audio_error:
                                    logger.error(f"Error processing audio: {str(audio_error)}")
                                    await websocket.send_json({
                                        "type": "error",
                                        "error": {
                                            "code": "audio_processing_error",
                                            "message": "Error processing audio data"
                                        }
                                    })
                            continue
                        
                        # Commit buffer and send for processing
                        if msg_type == "input_audio_buffer.commit" and not is_processing:
                            is_processing = True
                            
                            # Check if there's data in buffer
                            if len(audio_buffer) == 0:
                                await websocket.send_json({
                                    "type": "error",
                                    "error": {
                                        "code": "input_audio_buffer_commit_empty",
                                        "message": "Audio buffer is empty"
                                    }
                                })
                                is_processing = False
                                continue
                            
                            # Send audio to OpenAI
                            if openai_client and openai_client.is_connected:
                                try:
                                    # First send audio data
                                    await openai_client.process_audio(audio_buffer)
                                    # Then call commit without session_id
                                    await openai_client.commit_audio()
                                    
                                    # Send acknowledgment
                                    await websocket.send_json({
                                        "type": "input_audio_buffer.commit.ack",
                                        "event_id": data.get("event_id", "unknown")
                                    })
                                except Exception as commit_error:
                                    logger.error(f"Error committing audio: {str(commit_error)}")
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
                            
                            # Reset state
                            audio_buffer.clear()
                            is_processing = False
                            continue
                        
                        # Clear buffer
                        if msg_type == "input_audio_buffer.clear":
                            audio_buffer.clear()
                            # Call clear_audio_buffer without session_id
                            if openai_client and openai_client.is_connected:
                                await openai_client.clear_audio_buffer()
                            await websocket.send_json({
                                "type": "input_audio_buffer.clear.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue
                        
                        # Cancel current response
                        if msg_type == "response.cancel":
                            # Send cancel command without session_id
                            if openai_client and openai_client.is_connected:
                                await openai_client.ws.send(json.dumps({
                                    "type": "response.cancel"
                                    # No additional fields required
                                }))
                            await websocket.send_json({
                                "type": "response.cancel.ack",
                                "event_id": data.get("event_id", "unknown")
                            })
                            continue
                        
                        # Unknown message type
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
                
                # Process binary data (if expected)
                elif "bytes" in message:
                    # Just add to buffer
                    audio_buffer.extend(message["bytes"])
                    
                    # Send acknowledgment
                    await websocket.send_json({
                        "type": "binary.ack"
                    })
                
            except WebSocketDisconnect:
                logger.info(f"WebSocket client {client_id} disconnected")
                break
            except ConnectionClosed:
                logger.info(f"WebSocket connection closed for client {client_id}")
                break
            except Exception as e:
                logger.error(f"Error in WebSocket message processing: {str(e)}")
                try:
                    # Check if connection is still active before sending
                    if websocket.client_state.CONNECTED:
                        await websocket.send_json({
                            "type": "error",
                            "error": {
                                "code": "processing_error",
                                "message": f"Error processing message: {str(e)}"
                            }
                        })
                except:
                    # If we can't send error message, stop processing
                    logger.error(f"Cannot send error message, connection may be closed")
                    break
        
        # Cancel OpenAI message reading task
        if 'openai_task' in locals() and not openai_task.done():
            openai_task.cancel()
            try:
                await asyncio.wait_for(openai_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                logger.info(f"OpenAI task cancelled for client {client_id}")
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket connection closed: client_id={client_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        # Close OpenAI connection
        if openai_client:
            try:
                await openai_client.close()
                logger.info(f"Successfully closed OpenAI connection for client {client_id}")
            except Exception as e:
                logger.error(f"Error closing OpenAI connection: {str(e)}")
            
        # Remove connection from active
        try:
            if assistant_id in active_connections and websocket in active_connections[assistant_id]:
                active_connections[assistant_id].remove(websocket)
                if not active_connections[assistant_id]:
                    del active_connections[assistant_id]
            logger.info(f"Removed WebSocket connection from active connections: client_id={client_id}")
        except Exception as e:
            logger.error(f"Error removing connection from active_connections: {str(e)}")

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
            # Get message from OpenAI
            response = await openai_client.ws.recv()
            
            try:
                # Parse response as JSON
                response_data = json.loads(response)
                
                # Handle different response types
                response_type = response_data.get("type", "")
                logger.debug(f"Received OpenAI event: {response_type}")
                
                # ИСПРАВЛЕНО: Корректная обработка сообщений от OpenAI Realtime API
                
                # События сессии
                if response_type in ["session.created", "session.updated"]:
                    logger.info(f"Received session update from OpenAI: {response_type}")
                    await websocket.send_json(response_data)
                    continue
                
                # События разговора
                if response_type in ["conversation.created", "conversation.item.created"]:
                    logger.info(f"Received conversation update from OpenAI: {response_type}")
                    await websocket.send_json(response_data)
                    continue
                
                # Транскрипция аудио от пользователя
                if response_type == "conversation.item.input_audio_transcription.completed":
                    logger.info(f"Received audio transcription from OpenAI")
                    await websocket.send_json(response_data)
                    
                    # Сохраняем транскрипцию в БД, если возможно
                    if openai_client.db_session and openai_client.conversation_record_id:
                        try:
                            transcript = response_data.get("transcript", "")
                            if transcript:
                                conversation = openai_client.db_session.query(Conversation).filter(
                                    Conversation.id == uuid.UUID(openai_client.conversation_record_id)
                                ).first()
                                
                                if conversation:
                                    conversation.user_message = transcript
                                    openai_client.db_session.commit()
                                    logger.info(f"Updated conversation with transcript: {transcript[:50]}...")
                        except Exception as db_error:
                            logger.error(f"Error updating conversation with transcript: {str(db_error)}")
                    continue
                
                # Создание ответа
                if response_type == "response.created":
                    await websocket.send_json(response_data)
                    continue
                
                # Обработка аудио-ответа и текстового ответа (дельты)
                if response_type == "response.audio.delta":
                    await websocket.send_json(response_data)
                    continue
                
                if response_type == "response.audio.done":
                    await websocket.send_json(response_data)
                    continue
                
                if response_type == "response.text.delta":
                    await websocket.send_json(response_data)
                    continue
                
                if response_type == "response.text.done":
                    text = response_data.get("text", "")
                    await websocket.send_json(response_data)
                    
                    # Сохраняем текст ответа в БД
                    if openai_client.db_session and openai_client.conversation_record_id and text:
                        try:
                            conversation = openai_client.db_session.query(Conversation).filter(
                                Conversation.id == uuid.UUID(openai_client.conversation_record_id)
                            ).first()
                            
                            if conversation:
                                conversation.assistant_message = text
                                openai_client.db_session.commit()
                                logger.info(f"Updated conversation with assistant message: {text[:50]}...")
                        except Exception as db_error:
                            logger.error(f"Error updating conversation: {str(db_error)}")
                    continue
                
                # Транскрипция аудио-ответа ассистента
                if response_type == "response.audio_transcript.delta":
                    await websocket.send_json(response_data)
                    continue
                
                if response_type == "response.audio_transcript.done":
                    await websocket.send_json(response_data)
                    continue
                
                # Завершение ответа
                if response_type == "response.done":
                    await websocket.send_json(response_data)
                    continue
                
                # Обработка ошибок
                if response_type == "error":
                    error = response_data.get("error", {})
                    error_msg = error.get("message", "Unknown error")
                    error_code = error.get("code", "unknown_error")
                    logger.error(f"Error from OpenAI: {error_code} - {error_msg}")
                    
                    await websocket.send_json(response_data)
                    continue
                
                # Для других типов сообщений просто пересылаем их клиенту
                logger.debug(f"Forwarding unprocessed message type: {response_type}")
                await websocket.send_json(response_data)
                
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from OpenAI: {response[:100]}...")
            except Exception as e:
                logger.error(f"Error processing OpenAI message: {str(e)}")
                
    except asyncio.CancelledError:
        logger.info(f"OpenAI message handler cancelled for client {openai_client.client_id}")
    except ConnectionClosed:
        logger.warning(f"OpenAI connection closed for client {openai_client.client_id}")
    except Exception as e:
        logger.error(f"Error in OpenAI message handler: {str(e)}")
