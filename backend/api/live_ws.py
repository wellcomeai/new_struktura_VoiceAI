"""
WebSocket-роут экспериментального виджета на GPT-Live (gpt-live-1).

/ws/live/{assistant_id}?token=<JWT> — доступ только владельцу ассистента
или админу (проверка в handler_live). Регистрируется в app.py ДО
websocket.router, иначе путь перехватит /ws/{assistant_id}.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.db.session import get_db
from backend.websockets.handler_live import handle_live_connection
from backend.websockets.handler_live_telephony import handle_live_telephony

logger = get_logger(__name__)
router = APIRouter()


@router.websocket("/ws/live/{assistant_id}")
async def live_websocket(
    websocket: WebSocket,
    assistant_id: str,
    token: Optional[str] = Query(None),
    voice: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    logger.info(f"[LIVE-WS] connection for assistant {assistant_id}")
    try:
        await handle_live_connection(websocket, assistant_id, db, token, voice=voice)
    except WebSocketDisconnect:
        logger.info(f"[LIVE-WS] client disconnected (assistant {assistant_id})")
    except Exception as e:
        logger.error(f"[LIVE-WS] error: {e}", exc_info=True)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


@router.websocket("/ws/live/telephony/{assistant_id}")
async def live_telephony_websocket(
    websocket: WebSocket,
    assistant_id: str,
    db: Session = Depends(get_db),
):
    """Мост Voximplant ⇄ gpt-live-1 (voximplant_scenarios/inbound_live.js). Без JWT, как /api/voximplant/ws."""
    logger.info(f"[LIVE-WS] telephony connection for assistant {assistant_id}")
    try:
        await handle_live_telephony(websocket, assistant_id, db)
    except WebSocketDisconnect:
        logger.info(f"[LIVE-WS] telephony client disconnected (assistant {assistant_id})")
    except Exception as e:
        logger.error(f"[LIVE-WS] telephony error: {e}", exc_info=True)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
