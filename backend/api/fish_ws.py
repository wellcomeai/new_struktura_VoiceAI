# backend/api/fish_ws.py
"""
WebSocket router для озвучки Fish Audio.

В отличие от Grok/Gemini здесь через бэкенд идёт НЕ весь звонок, а только
синтез речи. Диалог ведёт OpenAI Realtime прямо в сценарии Voximplant;
сюда сценарий шлёт готовый текст реплики и получает обратно PCM-кадры.

Voximplant VoxEngine:
    const tts = VoxEngine.createWebSocket("wss://voicyfy.ru/ws/fish/tts/" + assistantId);
    tts.addEventListener(WebSocketEvents.OPEN, () => tts.sendMediaTo(call));
    tts.send(JSON.stringify({ event: "text", text: "Здравствуйте!" }));
    tts.send(JSON.stringify({ event: "flush" }));
"""

import traceback

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets.handler_fish_tts import handle_fish_tts_connection
from backend.websockets.handler_llm_proxy import handle_llm_proxy_connection

logger = get_logger(__name__)

router = APIRouter()


@router.websocket("/ws/fish/tts/{assistant_id}")
async def fish_tts_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db),
):
    """
    🐟 Прокси синтеза речи Fish Audio для сценариев Voximplant.

    Сценарий шлёт текстовые команды (text / flush / clear / stop), получает
    медиа-фреймы Voximplant с PCM16 и проигрывает их в звонок через
    websocket.sendMediaTo(call).

    Ключ Fish — серверный (FISH_API_KEY), см. provider_keys.resolve("fish").
    """
    try:
        logger.info(f"[FISH-WS] New TTS connection: assistant_id={assistant_id}")

        await handle_fish_tts_connection(
            websocket=websocket,
            assistant_id=assistant_id,
            db=db,
        )

    except WebSocketDisconnect:
        logger.info(f"[FISH-WS] Scenario disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[FISH-WS] WebSocket error for assistant {assistant_id}: {e}")
        logger.error(f"[FISH-WS] Traceback: {traceback.format_exc()}")

        try:
            await websocket.close(code=1011, reason="Internal server error")
        except Exception:
            pass


@router.websocket("/ws/fish/llm/{assistant_id}")
async def fish_llm_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db),
):
    """
    🧠 Прокси OpenAI Chat Completions для каскада inbound_fish.js
    (быстрее коннектора Voximplant, см. handler_llm_proxy.py).
    """
    try:
        logger.info(f"[FISH-WS] New LLM connection: assistant_id={assistant_id}")
        await handle_llm_proxy_connection(websocket=websocket, assistant_id=assistant_id, db=db)
    except WebSocketDisconnect:
        logger.info(f"[FISH-WS] LLM scenario disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[FISH-WS] LLM WebSocket error for assistant {assistant_id}: {e}")
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except Exception:
            pass


@router.websocket("/ws/cascade/llm/{assistant_id}")
async def cascade_llm_websocket_endpoint(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db),
):
    """
    🧠 Тот же прокси модели для каскада VoxTTS (inbound_cascade.js /
    outbound_cascade.js): ассистент ищется в grok_assistant_configs
    (assistant_type='cascade'), ключ — provider_keys.resolve("cascade").
    """
    try:
        logger.info(f"[CASCADE-WS] New LLM connection: assistant_id={assistant_id}")
        await handle_llm_proxy_connection(
            websocket=websocket, assistant_id=assistant_id, db=db, kind="cascade",
        )
    except WebSocketDisconnect:
        logger.info(f"[CASCADE-WS] LLM scenario disconnected: assistant_id={assistant_id}")
    except Exception as e:
        logger.error(f"[CASCADE-WS] LLM WebSocket error for assistant {assistant_id}: {e}")
        try:
            await websocket.close(code=1011, reason="Internal server error")
        except Exception:
            pass


@router.get("/fish/health")
def fish_health_check():
    """Health check прокси Fish Audio."""
    return {
        "status": "ok",
        "service": "Fish Audio TTS proxy",
        "provider": "fish.audio",
        "endpoint": "/ws/fish/tts/{assistant_id}",
        "upstream": "wss://api.fish.audio/v1/tts/live",
    }
