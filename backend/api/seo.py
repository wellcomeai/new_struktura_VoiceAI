"""
SEO-маршруты: robots.txt, sitemap.xml, llms.txt.

Отдают статичный текст и не трогают логику приложения. Нужны, чтобы
поисковые роботы и краулеры ИИ-поиска понимали, что на сайте публичное
(лендинг, документация, юридические страницы), а что кабинет.

ВАЖНО: каталог /static нельзя закрывать целиком. Лендинг грузит стили и
скрипты из /static/css, /static/landing и /static/images; без них Google
не сможет отрисовать главную. Закрываем только страницы кабинета поимённо.
"""

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse, Response

from backend.core.config import settings

router = APIRouter(include_in_schema=False)

DEFAULT_SITE = "https://voicyfy.ru"

# Публичные страницы: (путь, приоритет, частота обновления)
PUBLIC_PAGES = [
    ("/", "1.0", "weekly"),
    ("/static/agent-guide.html", "0.8", "monthly"),
    ("/static/prompts-wiki.html", "0.8", "monthly"),
    ("/static/api-docs.html", "0.7", "monthly"),
    ("/static/agent-api-docs.html", "0.6", "monthly"),
    ("/static/privacy-policy.html", "0.2", "yearly"),
    ("/static/terms-of-service.html", "0.2", "yearly"),
    ("/static/public-offer.html", "0.2", "yearly"),
    ("/static/payment-terms.html", "0.2", "yearly"),
]

# Страницы кабинета, тестовые и устаревшие. Файлы остаются на месте
# (нужны пользователям и для отката), но в индекс попадать не должны.
# Дублируется мета-тегом noindex внутри самих страниц.
PRIVATE_PATHS = [
    "/api/",
    "/ws/",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/static/admin.html",
    "/static/agent.html",
    "/static/agents.html",
    "/static/cartesia-agents.html",
    "/static/cascade-test.html",
    "/static/cascade.html",
    "/static/conversations.html",
    "/static/crm-contact.html",
    "/static/crm.html",
    "/static/dashboard.html",
    "/static/elevenlabs-agents.html",
    "/static/fish-agents.html",
    "/static/gemini-agents.html",
    "/static/gemini-agents_old.html",
    "/static/grok-agents.html",
    "/static/index.html",
    "/static/index_original.html",
    "/static/integrations.html",
    "/static/knowledge-base.html",
    "/static/live-test.html",
    "/static/login.html",
    "/static/outbound-calls.html",
    "/static/settings.html",
    "/static/telephony.html",
    "/static/test-ga-api.html",
    "/static/test_outbound-calls.html",
    "/static/translate.html",
    "/static/voice-assistants.html",
    "/static/voice_llm_interface_old.html",
    "/static/voice_llm_interface/",
    "/static/widget.html",
    "/static/yandex-agents.html",
    "/static/yarik.html",
]

CACHE = "public, max-age=3600"


def site_url() -> str:
    return (settings.HOST_URL or DEFAULT_SITE).rstrip("/")


def _robots_txt() -> str:
    lines = [
        "# Voicyfy: платформа голосовых ИИ-ассистентов для бизнеса",
        "# Публичное: лендинг, документация, wiki промптов, юридические страницы.",
        "# Закрыто: API и страницы личного кабинета.",
        "",
        "User-agent: *",
        "Allow: /",
    ]
    lines += [f"Disallow: {p}" for p in PRIVATE_PATHS]
    lines += [
        "",
        "# Яндекс: не плодить дубли главной из-за UTM и партнёрских меток",
        "User-agent: Yandex",
        "Allow: /",
    ]
    lines += [f"Disallow: {p}" for p in PRIVATE_PATHS]
    lines += [
        "Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&ref /",
        "",
        f"Sitemap: {site_url()}/sitemap.xml",
        "",
    ]
    return "\n".join(lines)


def _sitemap_xml() -> str:
    base = site_url()
    items = []
    for path, priority, freq in PUBLIC_PAGES:
        items.append(
            "  <url>\n"
            f"    <loc>{base}{path}</loc>\n"
            f"    <changefreq>{freq}</changefreq>\n"
            f"    <priority>{priority}</priority>\n"
            "  </url>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(items)
        + "\n</urlset>\n"
    )


def _llms_txt() -> str:
    base = site_url()
    return f"""# Voicyfy

> Voicyfy — платформа, на которой бизнес создаёт голосовых ИИ-ассистентов и ИИ-агентов за десять минут без программирования. Ассистент отвечает на звонки и разговаривает с посетителями сайта, агент сам обзванивает клиентов, пишет в мессенджеры и ведёт CRM.

Voicyfy is a Russian SaaS platform for building voice AI assistants and autonomous AI agents for business in about ten minutes, with no coding. Assistants answer phone calls and talk to website visitors; agents make outbound calls, message customers and keep a CRM.

## Что умеет

- Голосовой ассистент на входящие звонки: покупка номера, переадресация, работа 24/7.
- Голосовой виджет на сайт: одна строка кода перед закрывающим тегом body.
- Автономный агент: сам обзванивает базу контактов, пишет в мессенджеры, помнит каждого клиента, отчитывается в чате.
- Встроенная CRM: карточка клиента, история разговоров, записи и расшифровки.
- База знаний: документы подключаются к ассистенту, он отвечает по ним.
- Голосовые модели на выбор: OpenAI Realtime, Google Gemini Live, Яндекс SpeechKit, Fish Audio, Каскад. Со своим ключом провайдера разговоры бесплатны.
- Оплата посекундно по тарифу модели, пробный период 3 дня без карты.
- Телефония через Voximplant, функции: вебхуки, Google Sheets, Telegram-уведомления, HTTP-запросы.

## Для кого

Отделы продаж, клиентский сервис, клиники, автосервисы, доставка, недвижимость, любой бизнес, куда звонят клиенты или которому нужно обзванивать базу.

## Страницы

- [Главная]({base}/): описание платформы, тарифы, вопросы и ответы
- [Как работает автономный агент]({base}/static/agent-guide.html)
- [База знаний и промпты]({base}/static/prompts-wiki.html): как писать промпты для голосовых ассистентов
- [API документация]({base}/static/api-docs.html)
- [Agent API]({base}/static/agent-api-docs.html)
- [Политика конфиденциальности]({base}/static/privacy-policy.html)
- [Пользовательское соглашение]({base}/static/terms-of-service.html)
- [Публичная оферта]({base}/static/public-offer.html)

## Контакты

- Сайт: {base}
- Telegram: https://t.me/voicyfy
- Поддержка: https://t.me/voicyfy_support
- Почта: info@voicyfy.ru
"""


@router.get("/robots.txt")
async def robots_txt():
    return PlainTextResponse(_robots_txt(), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": CACHE})


@router.get("/sitemap.xml")
async def sitemap_xml():
    return Response(_sitemap_xml(), media_type="application/xml; charset=utf-8",
                    headers={"Cache-Control": CACHE})


@router.get("/llms.txt")
async def llms_txt():
    return PlainTextResponse(_llms_txt(), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": CACHE})
