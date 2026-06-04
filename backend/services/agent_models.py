"""
Список топовых моделей для оркестратора Voicyfy Agent.
Все модели должны поддерживать function calling (tool calling).
Слаги — формат OpenRouter (provider/model-name).
"""

ORCHESTRATOR_MODELS = [
    {
        "slug": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "description": "Лучшее соотношение цена/качество. 1M контекст. Топ для агентов.",
        "is_default": True,
    },
    {
        "slug": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "description": "Самая дешёвая из топов. Быстрая. Подходит для простых сценариев.",
    },
    {
        "slug": "anthropic/claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "description": "Самая мощная модель Anthropic. Лучшие рассуждения. Дорогая.",
    },
    {
        "slug": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "description": "Баланс цены и качества от Anthropic. Стабильный tool calling.",
    },
    {
        "slug": "openai/gpt-5.5",
        "name": "GPT-5.5",
        "description": "Флагман OpenAI. Сильный в reasoning. Тяжёлый по токенам.",
    },
    {
        "slug": "openai/gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "description": "Премиум OpenAI для сложных задач. 1M+ контекст.",
    },
    {
        "slug": "google/gemini-3.1-pro",
        "name": "Gemini 3.1 Pro",
        "description": "1M контекст. Сильный в multistep workflows. Хороший tool calling.",
    },
    {
        "slug": "google/gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "description": "Самый дешёвый Gemini с приличным качеством. Топ tool calling.",
    },
    {
        "slug": "moonshotai/kimi-k2.6",
        "name": "Kimi K2.6",
        "description": "Открытая модель, заточена под агентов. 128K контекст.",
    },
    {
        "slug": "xiaomi/mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro",
        "description": "Xiaomi MoE с 1M контекстом. Сильный в длинных цепочках tool calls.",
    },
]


def get_default_model() -> str:
    return next(m["slug"] for m in ORCHESTRATOR_MODELS if m.get("is_default"))


def is_valid_model(slug: str) -> bool:
    return any(m["slug"] == slug for m in ORCHESTRATOR_MODELS)
