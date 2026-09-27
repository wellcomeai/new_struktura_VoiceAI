"""
Публичное скачивание файлов агента (PDF / xlsx).

GET /api/agent-files/{file_id}/{token}/{filename}

Без авторизации: ссылку агент отправляет клиенту (SMS, мессенджер) и владельцу.
Доступ даёт только секретный token файла (services/agent_files.public_url);
имя файла в пути — для красоты ссылки и не проверяется.
"""

import asyncio
import hmac
import uuid
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from backend.db.session import SessionLocal
from backend.models.agent_file import AgentFile

router = APIRouter()


def _load(file_id: uuid.UUID):
    db = SessionLocal()
    try:
        f = db.query(AgentFile).filter(AgentFile.id == file_id).first()
        if not f:
            return None
        return {
            "token": f.token, "content": bytes(f.content),
            "mime": f.mime_type, "filename": f.filename,
        }
    finally:
        db.close()


@router.get("/{file_id}/{token}/{filename}")
@router.get("/{file_id}/{token}")
async def download_agent_file(file_id: uuid.UUID, token: str, filename: str = ""):
    f = await asyncio.to_thread(_load, file_id)
    if not f or not hmac.compare_digest(f["token"], token):
        raise HTTPException(status_code=404, detail="Файл не найден")
    # inline — PDF откроется прямо в браузере/мессенджере; xlsx браузер скачает сам.
    disposition = f"inline; filename*=UTF-8''{quote(f['filename'])}"
    return Response(
        content=f["content"],
        media_type=f["mime"],
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "private, max-age=3600",
            "X-Robots-Tag": "noindex, nofollow",
        },
    )
