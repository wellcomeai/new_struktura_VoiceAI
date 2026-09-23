# Voicyfy (WellcomeAI) — SaaS Voice AI Platform

## Overview

Voicyfy is a SaaS platform for creating and managing AI-powered voice assistants. Users can build conversational agents using OpenAI Realtime API, Google Gemini Live, xAI Grok Voice, and ElevenLabs — then connect them to telephony (Voximplant) or embed as web widgets. The platform includes a CRM, knowledge base, conversation analytics, partner program, and subscription billing.

**Production URL:** https://voicyfy.ru
**Version:** 3.0.0
**Python:** 3.10.11
**Hosting:** Render (Frankfurt region)

## Tech Stack

- **Backend:** FastAPI + Uvicorn + Gunicorn (Python 3.10)
- **Database:** PostgreSQL (via SQLAlchemy 2.x ORM, Alembic migrations)
- **Frontend (landing):** React + Vite (builds to `backend/static/landing/`)
- **Frontend (app pages):** Vanilla HTML/CSS/JS in `backend/static/`
- **WebSocket:** Native FastAPI WebSocket for real-time voice streaming
- **Storage:** Cloudflare R2 (S3-compatible)
- **Vector DB:** Pinecone (knowledge base search)
- **External APIs:** OpenAI, Google Gemini, xAI Grok, ElevenLabs, Voximplant, YooKassa (payments)

## Project Structure

```
├── main.py                  # Entry point, Gunicorn/Uvicorn setup, import redirect
├── app.py                   # FastAPI app init, middleware, routes, startup events
├── gunicorn_config.py       # Gunicorn production config
├── render.yaml              # Render deployment config
├── requirements.txt         # Python dependencies
├── alembic/                 # Database migrations
│   ├── env.py
│   └── versions/            # Migration scripts
├── backend/
│   ├── api/                 # API route handlers (FastAPI routers)
│   │   ├── auth.py          # JWT auth (register, login, token refresh)
│   │   ├── users.py         # User profile and settings
│   │   ├── assistants.py    # OpenAI assistant CRUD
│   │   ├── gemini_assistants.py  # Gemini assistant CRUD
│   │   ├── grok_assistants.py    # Grok assistant CRUD
│   │   ├── elevenlabs.py    # ElevenLabs agent management
│   │   ├── websocket.py     # OpenAI Realtime WebSocket proxy
│   │   ├── gemini_ws.py     # Gemini Live WebSocket proxy
│   │   ├── grok_ws.py       # Grok Voice WebSocket proxy
│   │   ├── telephony.py     # Outbound calls, call scheduling
│   │   ├── voximplant.py    # Voximplant telephony integration
│   │   ├── conversations.py # Conversation history and analytics
│   │   ├── contacts.py      # CRM contacts management
│   │   ├── knowledge_base.py # Knowledge base (Pinecone)
│   │   ├── payments.py      # YooKassa payment processing
│   │   ├── subscriptions.py # Subscription plan management
│   │   ├── partners.py      # Partner/referral program
│   │   ├── embeds.py        # Embeddable widget pages
│   │   ├── functions.py     # Custom function management
│   │   └── admin.py         # Admin panel endpoints
│   ├── core/                # App core
│   │   ├── config.py        # Pydantic settings (env vars)
│   │   ├── security.py      # JWT token creation/validation
│   │   ├── dependencies.py  # FastAPI dependencies (get_current_user, etc.)
│   │   ├── scheduler.py     # Subscription expiry checker
│   │   ├── task_scheduler.py # Automated call task scheduler
│   │   └── logging.py       # Logging configuration
│   ├── models/              # SQLAlchemy ORM models
│   │   ├── user.py          # User model
│   │   ├── assistant.py     # OpenAI AssistantConfig
│   │   ├── gemini_assistant.py  # GeminiAssistantConfig
│   │   ├── grok_assistant.py    # GrokAssistantConfig
│   │   ├── elevenlabs.py    # ElevenLabsAgent, ElevenLabsConversation
│   │   ├── conversation.py  # Conversation model
│   │   ├── contact.py       # CRM Contact model
│   │   ├── subscription.py  # Subscription, SubscriptionPlan
│   │   ├── task.py          # Scheduled call tasks
│   │   ├── partner.py       # Partner referral model
│   │   ├── embed_config.py  # Embeddable widget config
│   │   └── ...
│   ├── schemas/             # Pydantic request/response schemas
│   ├── services/            # Business logic layer
│   │   ├── auth_service.py          # Authentication logic
│   │   ├── assistant_service.py     # OpenAI assistant operations
│   │   ├── conversation_service.py  # Conversation CRUD
│   │   ├── elevenlabs_service.py    # ElevenLabs API client
│   │   ├── google_sheets_service.py # Google Sheets integration
│   │   ├── payment_service.py       # YooKassa payment logic
│   │   ├── pinecone_service.py      # Pinecone vector search
│   │   ├── r2_storage.py            # Cloudflare R2 file storage
│   │   ├── partner_service.py       # Partner program logic
│   │   ├── telegram_notification.py # Telegram notifications
│   │   ├── notification_service.py  # General notifications
│   │   └── llm_streaming/          # LLM streaming utilities
│   ├── functions/           # Modular AI function calling system
│   │   ├── base.py          # Base function class
│   │   ├── registry.py      # Function discovery and registry
│   │   ├── add_google_sheet_row.py
│   │   ├── search_pinecone.py
│   │   ├── send_telegram_notification.py
│   │   ├── send_webhook.py
│   │   ├── query_llm.py
│   │   ├── hangup_call.py
│   │   ├── get_current_time.py
│   │   ├── create_crm_voicyfy_task.py
│   │   ├── api_request.py
│   │   ├── read_google_doc.py
│   │   └── start_browser_task.py
│   ├── websockets/          # WebSocket handlers for real-time voice
│   │   ├── handler.py               # OpenAI Realtime handler
│   │   ├── handler_gemini.py        # Gemini Live handler
│   │   ├── handler_grok.py          # Grok Voice handler
│   │   ├── openai_client.py         # OpenAI WS client
│   │   ├── gemini_client.py         # Gemini WS client
│   │   ├── grok_client.py           # Grok WS client
│   │   ├── voximplant_handler.py    # Telephony WS bridge
│   │   ├── voximplant_adapter.py    # Voximplant audio adapter
│   │   └── sentence_detector.py     # Sentence boundary detection
│   ├── utils/               # Utility modules
│   ├── db/                  # Database session management
│   └── static/              # All frontend HTML/CSS/JS pages
│       ├── landing/         # React landing page (built)
│       ├── agents.html      # OpenAI agents management page
│       ├── gemini-agents.html   # Gemini agents page
│       ├── grok-agents.html     # Grok agents page
│       ├── dashboard.html       # User dashboard
│       ├── telephony.html       # Telephony settings
│       ├── conversations.html   # Conversation history
│       ├── crm.html             # CRM contacts list
│       ├── crm-contact.html     # Individual contact view
│       ├── knowledge-base.html  # Knowledge base management
│       ├── settings.html        # User settings
│       ├── admin.html           # Admin panel
│       ├── agents/              # JS modules for agents page
│       │   ├── index.js         # Main agents logic
│       │   ├── api.js           # API client
│       │   └── ui.js            # UI rendering
│       └── js/                  # Shared JS modules
├── frontend/                # React landing page source
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/      # Navbar, Footer, PricingSection, etc.
│   │   ├── hooks/           # useAuth, useEmailVerification, useReferralTracker
│   │   └── utils/           # api.js, notifications.js
│   ├── package.json
│   └── vite.config.js
└── chrome-extension/        # Chrome extension (side panel + popup)
    ├── manifest.json
    ├── background.js
    ├── popup/
    └── sidepanel/
```

## Running the Project

### Local Development
```bash
pip install -r requirements.txt
# Set env vars in .env (DATABASE_URL, OPENAI_API_KEY, JWT_SECRET_KEY, etc.)
python main.py
# Server starts at http://localhost:5050
```

### Production (Render)
```bash
gunicorn -k uvicorn.workers.UvicornWorker -w 4 -b 0.0.0.0:$PORT main:application
```

### Frontend Landing (development)
```bash
cd frontend && npm install && npm run dev
# Build: npm run build (outputs to backend/static/landing/)
```

### ⚠️ ОБЯЗАТЕЛЬНО: пересборка лендинга после правок `frontend/`

Render собирает **только Python** (`buildCommand: pip install -r requirements.txt` в `render.yaml`).
`npm run build` при деплое **не запускается**. Прод отдаёт закоммиченный бандл из
`backend/static/landing/` (см. `app.py` → `FileResponse("backend/static/landing/index.html")`).

Поэтому любые изменения в `frontend/src/**` **не попадут на прод**, пока бандл не пересобран
и не закоммичен. Это уже приводило к тому, что лендинг месяц показывал устаревший контент.

После **любой** правки в `frontend/`:
```bash
cd frontend && npm ci && npm run build
cd .. && git add -A backend/static/landing frontend
```
Имена ассетов хешированные (`index-<hash>.js`), Vite чистит `outDir` — старый файл
удаляется, новый добавляется, `index.html` обновляет ссылки. Все три изменения
(удаление старого JS, новый JS, изменённый `index.html`) должны попасть в коммит.

Проверка перед коммитом — в `git status` рядом с правками в `frontend/src/**`
обязаны быть изменения в `backend/static/landing/`. Если их нет — сборка не выполнена.

### Пререндер лендинга (SEO)

`npm run build` после сборки запускает `frontend/scripts/prerender.mjs`: он рендерит
`App` в строку (`src/entry-server.jsx`) и вставляет готовый HTML в `#root` бандла плюс
JSON-LD FAQPage из `components/Faq.jsx`. В браузере `main.jsx` гидрирует разметку.
Поэтому компоненты лендинга **не должны обращаться к `window`/`document`/`localStorage`
во время рендера** — только в `useEffect` и обработчиках. Случайности (shuffle, Date)
тоже только после монтирования, иначе серверная и клиентская разметка разойдутся.
SEO-маршруты (`/robots.txt`, `/sitemap.xml`, `/llms.txt`) — `backend/api/seo.py`;
новую публичную страницу добавляйте в `PUBLIC_PAGES`, страницу кабинета — в `PRIVATE_PATHS`
и ставьте ей `<meta name="robots" content="noindex, nofollow">`.

## v6.0: единый ЛК, серверные ключи и кошелёк (ветка 0909-refactoring-v1)

- **Одна страница ассистентов** `backend/static/voice-assistants.html` заменяет `agents.html`,
  `gemini-agents.html`, `cartesia-agents.html`, `yandex-agents.html`, `cascade.html`,
  `fish-agents.html`, `knowledge-base.html`. Старые URL редиректятся в `app.py`
  (`LEGACY_PROVIDER_PAGES`), сами файлы оставлены для отката. Бэкенд и таблицы
  ассистентов не менялись: страница дёргает CRUD-API нужного провайдера по выбранной модели.
  Cartesia скрыта из витрины (тариф `is_enabled=false`), но существующие ассистенты работают.
- **Общий сайдбар** `backend/static/js/sidebar.js`: страницы держат пустой
  `<nav class="sidebar-nav" id="sidebar-nav"></nav>`, меню рисует скрипт (плюс карточка
  кошелька и модалка пополнения). Не копируйте меню руками в HTML.
- **Серверные ключи** `backend/services/provider_keys.py`: свой ключ в профиле → бесплатно,
  нет ключа → ключ из env (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `FISH_API_KEY`,
  `YANDEX_API_KEY`+`YANDEX_FOLDER_ID`, `CARTESIA_API_KEY`) и списание с кошелька. Ключи в БД
  не копируются, подмена в точках выдачи: WS-хендлеры виджета и `/api/telephony/config`,
  `/api/telephony/outbound-config` (`resolve_scenario_keys`).
- **Кошелёк** (`users.wallet_balance`, копейки): `backend/services/wallet_service.py`
  (посекундно, минимум 10 с, в минус не уходим, идемпотентность по `ref_key`),
  `backend/services/voice_billing.py` (сессия виджета: списание раз в 60 с, стоп при нуле),
  телефония списывается по отчёту `POST /api/voximplant/log` (`call_duration`).
  Лимита длительности звонка пока нет (сценарии Voximplant не правим).
  Тарифы в таблице `voice_model_tariffs` (правка из админки, `/api/wallet/admin/tariffs`),
  журнал в `wallet_transactions`. Каскад бесплатен, каскад-кредиты за флагом
  `CASCADE_CREDITS_BILLING`. Роутер: `backend/api/wallet.py` (`/api/wallet`).
- **База знаний** принадлежит пользователю (`pinecone_configs.user_id`), к ассистенту
  подключается строкой `Pinecone namespace: <ns>` в промпте (таб «База знаний»).
- **Fish Audio** работает только на серверном `FISH_API_KEY`: свой ключ Fish пользователь
  не указывает (карточки в настройках нет, `provider_keys.resolve("fish")` колонку
  `users.fish_api_key` не читает, она оставлена для отката), поэтому модель всегда по
  тарифу. Голоса: готовые `FISH_VOICES` в `backend/models/fish_assistant.py` (Светлана
  по умолчанию, Сергей) плюс свой `reference_id` из fish.audio; пустой `fish_voice_id`
  бэкенд заменяет на `DEFAULT_FISH_VOICE_ID`. Список дублируется во фронте
  (`agent/instructions-voice.js`, fallback в `voice-assistants.html`), справочник —
  `GET /api/fish-assistants/options`.

## Обязательный онбординг (ветка 1909-pamatb)

Новый пользователь после регистрации не попадает в кабинет, пока не создаст
ассистента и не включит тестовый номер: `users.onboarding_completed_at` (NULL —
онбординг не пройден; существующим пользователям проставлен при добавлении колонки,
`ensure_onboarding_columns` в `app.py` / миграция `add_user_onboarding`). `/users/me`
отдаёт `onboarding_completed`; `backend/static/js/sidebar.js` при `false` редиректит
с любой страницы на `voice-assistants.html?onboarding=1` (шаг 1: только редактор
нового ассистента, Fish предвыбран) → после сохранения
`telephony.html?onboarding=1&assistant_type=&assistant_id=` (шаг 2: только карточка
тестового номера, ассистент предвыбран), остальные пункты меню — класс `ob-locked`.
Флаг снимает `TestNumberService.start`: аренда онбординга помечается
`test_number_leases.is_onboarding` и в лимит попыток не входит (после онбординга
остаётся обычная попытка). Блокировка только в интерфейсе, API не ограничен; админов
не касается.

## Память агента (ветка 1909-pamatb)

У Voicyfy Agent есть собственная память, отдельная от памяти контактов
(`agent_contacts.memory`): колонка `agent_configs.memory` (JSONB), заметки с id по
секциям `instructions` (правила владельца), `observations` (наблюдения агента), `plans`
(намерения). Логика в `backend/services/agent_memory.py`: правки **только точечные**
(`add` / `update` по id / `delete` по id) под `FOR UPDATE`, полной перезаписи нет.
Блок «ПАМЯТЬ АГЕНТА» приклеивается к user-сообщению во всех фазах оркестратора v3
(system-промпт остаётся статичным ради кэша). Агент правит память тулзой
`update_agent_memory`, владелец — карточкой «Память агента» на `agent.html`
(`backend/static/agent/memory.js`, API `/api/agent/memory`). Лимиты: 60 заметок,
400 символов на заметку, 8000 символов всего. Колонка добавляется на старте
(`ensure_agent_memory_column` в `app.py`) и миграцией `add_agent_memory`.

## Устойчивость к обрыву БД (ветка 1909-pamatb)

Прод — один процесс uvicorn, запросы к БД синхронные, поэтому любое долгое ожидание базы
замораживает весь сервер. Защита в `backend/db/session.py`: `connect_timeout`, короткий
`pool_timeout`, TCP keepalive; `release_db_connection(db)` в WS-хендлерах сразу после
загрузки конфига (соединение не держится весь звонок); `ConversationService.save_conversation`
повторяет запись на свежей сессии при обрыве соединения; `/health` проверяет базу и отдаёт
503, чтобы Render перезапускал инстанс сам. Синхронные SDK (Pinecone, OpenAI-эмбеддинги,
`requests`) и опросы БД в фоновых циклах идут через `asyncio.to_thread`, чтобы не
останавливать loop; новый синхронный сетевой вызов или запрос к БД в `async def`
добавляйте только так. Подробнее — `backend/db/claude-db.md`.

## Контакты агента обзвона: экспорт и пагинация (ветка 1909-pamatb)

- **Экспорт базы** `GET /api/agent/contacts/export` → xlsx (`backend/services/contact_export_service.py`,
  openpyxl, файл в памяти). Два листа: «Контакты» (данные + стадия + итог последнего звонка +
  память агента + ближайший шаг; первые пять колонок совпадают с шаблоном импорта) и «Звонки»
  (все завершённые звонки/сообщения с транскриптами). Всегда вся база выбранного агента,
  время в МСК. Роут объявлен до `/contacts/{contact_id}`. Кнопки «Экспорт» — в модалке
  контактов, футере воронки и карточке «Контакты» на дашборде (`exportContacts` в `contacts.js`).
- **Пагинация.** Список контактов и воронка раньше показывали максимум 100/200 записей.
  Теперь список подгружается по 100 кнопкой «Показать ещё», воронка грузит каждую стадию
  отдельным запросом `GET /contacts?status=` по 100 карточек с кнопкой «Ещё» в колонке.
  Фильтр `status=active` на бэке включает и легаси-статусы вне воронки (напр. `calling`).

## Импорт контактов агента: до 10 000 строк (ветка 1909-pamatb)

`MAX_IMPORT_ROWS = 10000`, файл до 10 МБ (`backend/services/contact_import_service.py`).
Превью (`/contacts/import/preview`) разбирает файл через `asyncio.to_thread` и отдаёт только
первые 200 ошибок/дублей плюс `errors_count`/`duplicates_count` (полный список — в xlsx ошибок).
Запись (`_run_contacts_import` в `backend/api/agent.py`) — синхронная функция: BackgroundTasks
гоняет её в пуле потоков, event loop не блокируется. Пачки по `IMPORT_CHUNK_SIZE`=500 с
`add_all` + коммитом, id контактов генерируются на клиенте (без flush на строку). Прогресс —
JSON `job-<token>.json` рядом с превью (`save_import_job`/`load_import_job`, запись атомарная),
читается `GET /contacts/import/status/{token}`; фронт (`pollImportStatus` в `agent/import.js`)
опрашивает раз в секунду и рисует прогресс-бар. Повторный execute по тому же токену не
запускает второй импорт. Хранилище в файле рассчитано на один процесс (как сейчас на проде).

## Контакты агента обзвона: фильтры и массовые действия для ИИ (ветка 1909-pamatb)

Инструменты оркестратора в `backend/services/agent_tools.py` работают через общий фильтр
`_contact_filter_query` (`CONTACT_FILTER_PROPERTIES`: query, stage/stages, company,
attempts_min/max, never_called, not_called_days, called_within_days, created_after/before,
has_scheduled_call; всегда скоуп user_id + agent_config_id; stage `active` включает легаси-статусы).
- `search_contacts` — постранично: `limit` (по умолчанию 30, максимум `CONTACT_LIST_MAX`=200),
  `offset`, `sort`; в ответе точный `total`, `has_more`, `next_offset`; `count_only` — только число.
  Строки компактные (`_compact_contact`, пустые поля не передаются) — ~55 токенов на контакт.
  `get_agent_contacts` — тот же вывод без фильтров (по умолчанию 50).
- Массовые действия принимают `filter` (те же поля + `agent_contact_ids` / `all_contacts`),
  `dry_run`, `max_contacts` (до `BULK_ACTION_MAX`=1000): `bulk_schedule_calls` (никогда не
  планирует `do_not_call`, по умолчанию пропускает контакты с уже запланированным звонком;
  легаси `agent_contact_ids`/`stage` верхнего уровня работают), `bulk_move_contacts_stage`
  (`do_not_call` трогает только при явной стадии в фильтре; перевод в `do_not_call`
  отменяет запланированные задачи), `bulk_cancel_calls` (статус cancelled, `channel`).
  Пустой фильтр запрещён. Ответы короткие: числа + первые 20 задач.

## Key API Prefixes

| Prefix | Description |
|--------|-------------|
| `/api/auth` | Authentication (register, login, refresh) |
| `/api/users` | User profile, settings |
| `/api/assistants` | OpenAI assistant CRUD |
| `/api/gemini-assistants` | Gemini assistant CRUD |
| `/api/grok-assistants` | Grok assistant CRUD |
| `/api/elevenlabs` | ElevenLabs agents |
| `/api/telephony` | Outbound calls, call tasks |
| `/api/voximplant` | Voximplant telephony |
| `/api/conversations` | Conversation history |
| `/api/contacts` | CRM contacts |
| `/api/knowledge-base` | Knowledge base (Pinecone) |
| `/api/payments` | YooKassa payments |
| `/api/subscriptions` | Subscription plans |
| `/api/partners` | Partner referral program |
| `/api/embeds` | Embeddable widget configs |
| `/api/functions` | Custom AI functions |
| `/api/wallet` | Кошелёк, тарифы моделей, пополнение (v6.0) |
| `/ws/openai/{id}` | OpenAI Realtime voice WS |
| `/ws/gemini/{id}` | Gemini Live voice WS |
| `/ws/grok/{id}` | Grok Voice WS |

## Database

PostgreSQL with SQLAlchemy ORM. Migrations managed by Alembic (`alembic/versions/`).

Key tables: `users`, `assistant_configs`, `gemini_assistant_configs`, `grok_assistant_configs`, `elevenlabs_agents`, `conversations`, `contacts`, `tasks`, `subscription_plans`, `user_subscriptions`, `embed_configs`, `partners`.

## Environment Variables (Key)

- `DATABASE_URL` — PostgreSQL connection string
- `OPENAI_API_KEY` — OpenAI API key (server-level, users can also set their own)
- `JWT_SECRET_KEY` — JWT signing secret
- `HOST_URL` — Public URL (e.g., https://voicyfy.ru)
- `PRODUCTION` — "true" in production (disables docs, enables optimizations)
- `CORS_ORIGINS` — Allowed CORS origins

Users provide their own API keys for: Google Gemini, xAI Grok, ElevenLabs, Voximplant.

## Architecture Notes

- **Import redirection:** `main.py` contains a custom `MetaPathFinder` that redirects bare module imports (e.g., `core.config`) to `backend.core.config`. This allows modules to work both standalone and within the backend package.
- **Modular functions:** `backend/functions/` uses a registry pattern — new AI-callable functions are auto-discovered at startup via `discover_functions()`.
- **Multi-provider voice:** The WebSocket layer abstracts three different voice AI providers (OpenAI, Gemini, Grok) behind similar handler interfaces, with Voximplant telephony bridge support.
- **Startup schema fixes:** `app.py` startup event runs comprehensive schema checks and auto-adds missing columns for backwards compatibility.
- **Task scheduler:** Background scheduler (`core/task_scheduler.py`) polls for scheduled call tasks every 30 seconds and executes them automatically.
- **Trailing slash:** маршруты вида `@router.get("/")` с префиксом (`/api/contacts/`) доступны и без слэша: `TrailingSlashRewriteMiddleware` в `backend/core/http_optimizations.py` подменяет путь вместо 307-редиректа Starlette, потому что за прокси Render Location редиректа собирался с внутренним хостом `*.onrender.com` и фронт получал 403.
- **Static pages:** App pages (agents, dashboard, CRM, etc.) are vanilla HTML/JS served by FastAPI's `StaticFiles`. The React app is only used for the landing page.
