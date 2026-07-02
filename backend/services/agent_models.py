"""
Список топовых моделей для оркестратора Voicyfy Agent.
Все модели должны поддерживать function calling (tool calling).
Слаги — формат OpenRouter (provider/model-name).

✅ Кредитная модель: к каждой модели добавлены ставки списания
   input_credits_per_1k / output_credits_per_1k (см. ТЗ раздел 1.4).
   Базовая константа: 1 кредит = $0.0001 себестоимости (×2 маржа к OpenRouter).
"""

ORCHESTRATOR_MODELS = [
    {
        "slug": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "description": "Лучшее соотношение цена/качество. 1M контекст. Топ для агентов.",
        "is_default": True,
        "input_credits_per_1k": 3,
        "output_credits_per_1k": 12,
    },
    {
        "slug": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "description": "Самая дешёвая из топов. Быстрая. Подходит для простых сценариев.",
        "input_credits_per_1k": 1,
        "output_credits_per_1k": 4,
    },
    {
        "slug": "anthropic/claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "description": "Самая мощная модель Anthropic. Лучшие рассуждения. Дорогая.",
        "input_credits_per_1k": 150,
        "output_credits_per_1k": 750,
    },
    {
        "slug": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "description": "Баланс цены и качества от Anthropic. Стабильный tool calling.",
        "input_credits_per_1k": 30,
        "output_credits_per_1k": 150,
    },
    {
        "slug": "openai/gpt-5.5",
        "name": "GPT-5.5",
        "description": "Флагман OpenAI. Сильный в reasoning. Тяжёлый по токенам.",
        "input_credits_per_1k": 25,
        "output_credits_per_1k": 150,
    },
    {
        "slug": "openai/gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "description": "Премиум OpenAI для сложных задач. 1M+ контекст.",
        "input_credits_per_1k": 300,
        "output_credits_per_1k": 1800,
    },
    {
        "slug": "google/gemini-3.1-pro",
        "name": "Gemini 3.1 Pro",
        "description": "1M контекст. Сильный в multistep workflows. Хороший tool calling.",
        "input_credits_per_1k": 20,
        "output_credits_per_1k": 80,
    },
    {
        "slug": "google/gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "description": "Дешёвый Gemini с приличным качеством. Топ tool calling.",
        "input_credits_per_1k": 3,
        "output_credits_per_1k": 12,
    },
    {
        "slug": "google/gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "description": "Самый дешёвый Gemini. Для простых сценариев и высокого объёма звонков.",
        "input_credits_per_1k": 1,
        "output_credits_per_1k": 4,
    },
    {
        "slug": "moonshotai/kimi-k2.6",
        "name": "Kimi K2.6",
        "description": "Открытая модель, заточена под агентов. 128K контекст.",
        "input_credits_per_1k": 5,
        "output_credits_per_1k": 20,
    },
    {
        "slug": "xiaomi/mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro",
        "description": "Xiaomi MoE с 1M контекстом. Сильный в длинных цепочках tool calls.",
        "input_credits_per_1k": 10,
        "output_credits_per_1k": 50,
    },
    {
        "slug": "z-ai/glm-5.2",
        "name": "GLM 5.2",
        "description": "Флагман Zhipu AI. Сильный агентный tool calling, хорошая цена.",
        "input_credits_per_1k": 4,
        "output_credits_per_1k": 16,
    },
    {
        "slug": "qwen/qwen3.7-plus",
        "name": "Qwen 3.7 Plus",
        "description": "Флагман Alibaba. Уверенный tool calling, широкий контекст.",
        "input_credits_per_1k": 6,
        "output_credits_per_1k": 24,
    },
    {
        "slug": "minimax/minimax-m3",
        "name": "MiniMax M3",
        "description": "Компактная агентная модель. Быстрая и недорогая для рутинных звонков.",
        "input_credits_per_1k": 2,
        "output_credits_per_1k": 8,
    },
    {
        "slug": "nvidia/nemotron-3-ultra-550b-a55b:free",
        "name": "Nemotron 3 Ultra (free)",
        "description": "Огромный MoE от NVIDIA, бесплатный тариф OpenRouter. Списывается минимум 1 кредит за вызов.",
        "input_credits_per_1k": 0,
        "output_credits_per_1k": 0,
    },
]


def get_default_model() -> str:
    return next(m["slug"] for m in ORCHESTRATOR_MODELS if m.get("is_default"))


def is_valid_model(slug: str) -> bool:
    return any(m["slug"] == slug for m in ORCHESTRATOR_MODELS)


def get_model_rates(slug: str) -> dict | None:
    """Вернуть ставки списания кредитов для модели или None если slug неизвестен."""
    for m in ORCHESTRATOR_MODELS:
        if m["slug"] == slug:
            return {
                "input_credits_per_1k": m["input_credits_per_1k"],
                "output_credits_per_1k": m["output_credits_per_1k"],
            }
    return None
