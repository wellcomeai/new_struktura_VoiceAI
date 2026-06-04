"""
OpenRouter API client for Voicyfy Agent orchestrator.
Uses system API key from settings.OPENROUTER_API_KEY.
"""
from typing import Optional, List, Dict, Any
import httpx
from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


class OpenRouterClient:
    def __init__(self):
        self.api_key = settings.OPENROUTER_API_KEY
        if not self.api_key:
            logger.warning("[OPENROUTER] OPENROUTER_API_KEY not set in env!")

    async def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        tool_choice: Optional[str] = "auto",
        temperature: float = 0.7,
        max_tokens: int = 4000,
        timeout: float = 90.0,
    ) -> Dict[str, Any]:
        """
        Returns full response dict from OpenRouter.
        Raises Exception on error.
        """
        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY not configured")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://voicyfy.ru",
            "X-Title": "Voicyfy Agent",
        }

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                OPENROUTER_API_URL,
                json=payload,
                headers=headers
            )
            response.raise_for_status()
            return response.json()


_client: Optional[OpenRouterClient] = None


def get_openrouter_client() -> OpenRouterClient:
    global _client
    if _client is None:
        _client = OpenRouterClient()
    return _client
