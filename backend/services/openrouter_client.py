"""
OpenRouter API client for Voicyfy Agent orchestrator.
Uses system API key from settings.OPENROUTER_API_KEY.
"""
import json
from typing import Optional, List, Dict, Any, AsyncIterator
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

    async def chat_completion_stream(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        tool_choice: Optional[str] = "auto",
        temperature: float = 0.7,
        max_tokens: int = 4000,
        timeout: float = 90.0,
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Streaming version of chat_completion. Async-generator that yields raw
        SSE chunk dicts from OpenRouter (`{"choices":[{"delta":{...},"finish_reason":...}], "usage":...}`).

        Reconstruction of tool_calls from delta fragments is the caller's job —
        this client stays thin and just parses/forwards chunks.

        Raises on network/HTTP errors (caught by the orchestrator).
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
            "stream": True,
            # OpenRouter returns usage in the final chunk when this is set.
            "usage": {"include": True},
        }

        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", OPENROUTER_API_URL, json=payload, headers=headers
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    line = line.strip()
                    if not line:
                        continue
                    # OpenRouter keep-alive comments (e.g. ": OPENROUTER PROCESSING")
                    if line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        return
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError as e:
                        logger.warning(f"[OPENROUTER] Stream JSON parse error: {e} | line: {data[:200]}")
                        continue
                    yield chunk


_client: Optional[OpenRouterClient] = None


def get_openrouter_client() -> OpenRouterClient:
    global _client
    if _client is None:
        _client = OpenRouterClient()
    return _client
