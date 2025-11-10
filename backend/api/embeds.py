# backend/api/embeds.py
"""
Embeds API - управление встраиваемыми страницами
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from typing import List, Optional
import uuid

from backend.db.session import get_db  # ✅ ИСПРАВЛЕНО
from backend.models.embed_config import EmbedConfig
from backend.models.assistant import AssistantConfig
from backend.models.user import User
from backend.api.dependencies import get_current_user

router = APIRouter(prefix="/api/embeds", tags=["Embeds"])


# ==================================================================================
# 🔐 AUTHENTICATED ENDPOINTS (Управление в ЛК)
# ==================================================================================

@router.post("/")
async def create_embed_config(
    assistant_id: str,
    custom_name: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создать новую embed-конфигурацию
    
    Returns:
        - embed_code: Уникальный код (w_abc123...)
        - embed_url: Полный URL для встраивания
        - iframe_code: Готовый HTML код
    """
    # Проверяем что assistant принадлежит пользователю
    assistant = db.query(AssistantConfig).filter(
        AssistantConfig.id == uuid.UUID(assistant_id),
        AssistantConfig.user_id == current_user.id
    ).first()
    
    if not assistant:
        raise HTTPException(status_code=404, detail="Assistant not found")
    
    # Создаем конфигурацию
    embed_config = EmbedConfig(
        user_id=current_user.id,
        assistant_id=uuid.UUID(assistant_id),
        custom_name=custom_name
    )
    
    db.add(embed_config)
    db.commit()
    db.refresh(embed_config)
    
    return {
        "embed_code": embed_config.embed_code,
        "embed_url": embed_config.get_embed_url(),
        "iframe_code": embed_config.get_iframe_code(),
        "config": embed_config.to_dict()
    }


@router.get("/user/me")
async def get_my_embed_configs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Получить все embed-конфигурации пользователя"""
    configs = db.query(EmbedConfig).filter(
        EmbedConfig.user_id == current_user.id
    ).order_by(EmbedConfig.created_at.desc()).all()
    
    return [
        {
            **config.to_dict(),
            "embed_url": config.get_embed_url(),
            "iframe_code": config.get_iframe_code()
        }
        for config in configs
    ]


@router.delete("/{embed_code}")
async def delete_embed_config(
    embed_code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Удалить embed-конфигурацию"""
    config = db.query(EmbedConfig).filter(
        EmbedConfig.embed_code == embed_code,
        EmbedConfig.user_id == current_user.id
    ).first()
    
    if not config:
        raise HTTPException(status_code=404, detail="Embed config not found")
    
    db.delete(config)
    db.commit()
    
    return {"success": True, "message": "Embed config deleted"}


@router.patch("/{embed_code}")
async def update_embed_config(
    embed_code: str,
    is_active: Optional[bool] = None,
    custom_name: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Обновить embed-конфигурацию (вкл/выкл, название)"""
    config = db.query(EmbedConfig).filter(
        EmbedConfig.embed_code == embed_code,
        EmbedConfig.user_id == current_user.id
    ).first()
    
    if not config:
        raise HTTPException(status_code=404, detail="Embed config not found")
    
    if is_active is not None:
        config.is_active = is_active
    if custom_name is not None:
        config.custom_name = custom_name
    
    db.commit()
    db.refresh(config)
    
    return config.to_dict()


# ==================================================================================
# 🌐 PUBLIC ENDPOINT (Отдача HTML страницы)
# ==================================================================================

@router.get("/embed/{embed_code}", response_class=HTMLResponse)
async def serve_embed_page(
    embed_code: str,
    db: Session = Depends(get_db)
):
    """
    Отдать HTML страницу с встроенным assistant_id
    
    Это публичный endpoint - не требует авторизации
    """
    # Найти конфигурацию
    config = db.query(EmbedConfig).filter(
        EmbedConfig.embed_code == embed_code,
        EmbedConfig.is_active == True
    ).first()
    
    if not config:
        return HTMLResponse(
            content="""
            <!DOCTYPE html>
            <html>
            <head><title>Not Found</title></head>
            <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                <div style="text-align:center;">
                    <h1>404</h1>
                    <p>Embed configuration not found or inactive</p>
                </div>
            </body>
            </html>
            """,
            status_code=404
        )
    
    # Обновить статистику
    config.increment_views(db)
    
    # Получить assistant_id
    assistant_id = str(config.assistant_id)
    
    # ✅ ЧИТАЕМ HTML из файла и подставляем assistant_id
    import os
    from pathlib import Path
    
    # Путь к шаблону
    template_path = Path(__file__).parent.parent / "static" / "voice_llm_interface.html"
    
    with open(template_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    
    # 🔥 ПОДСТАНОВКА assistant_id
    html_content = html_content.replace(
        'const ASSISTANT_ID = "17c631ce-0db1-4171-a81d-22d91d4cccd7";',
        f'const ASSISTANT_ID = "{assistant_id}";'
    )
    
    return HTMLResponse(content=html_content)
