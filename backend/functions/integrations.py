# backend/functions/integrations.py
from .registry import register_function
import httpx
import json
from typing import Dict, Any

@register_function(
    func_id="send_webhook",
    description="Отправить данные на webhook URL",
    parameters={
        "type": "object",
        "properties": {
            "webhook_url": {
                "type": "string",
                "description": "URL вебхука"
            },
            "text": {
                "type": "string",
                "description": "Текст для отправки"
            }
        },
        "required": ["text"]
    }
)
async def send_webhook(webhook_url: str, text: str) -> Dict[str, Any]:
    """Отправить данные на webhook"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                webhook_url, 
                json={
                    "text": text, 
                    "source": "wellcomeai"
                }
            )
            return {
                "success": response.status_code >= 200 and response.status_code < 300,
                "message": "Данные успешно отправлены"
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
