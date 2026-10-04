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
attempts_min/max, never_called, called_at_least_once, not_called_days, called_within_days,
created_after/before, has_scheduled_call, no_scheduled_call; всегда скоуп user_id + agent_config_id;
stage `active` включает легаси-статусы). Модели заполняют необязательные поля «по умолчанию»,
поэтому `_normalize_contact_filter` выкидывает 0 в днях/попытках, `false` во флагах (флаги
работают только при `true`) и `*`/«все» в query. Если фильтр дал 0, а база не пуста,
`search_contacts` добавляет `total_in_base` и `hint`, чтобы модель не ответила «база пуста».
Аргументы тулз чата пишутся в лог: `[AGENT-CHAT] Tool: имя(args)`.
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

## Поиск контакта агентом и память контактов в чате (ветка 0110-contact)

- **Умный query.** `query` в фильтре контактов (`search_contacts`, bulk_*, выгрузка) больше не одна
  подстрока: `backend/services/contact_search.py` → `query_condition`. Похоже на телефон — сравнение
  по цифрам (`regexp_replace`, последние 10, +7/8 и скобки не важны); иначе слова в любом порядке,
  каждое в имени или компании, ё = е (`translate`). `company` тоже без учёта ё.
- **Нечёткий поиск** без LLM и расширений Postgres: `fuzzy_candidates` (падежи, опечатки, номер с
  ошибкой) по строкам агента (до 20 000, счёт в `asyncio.to_thread`, ~0.5 с на 10 000).
  `search_contacts` при 0 совпадений по query отдаёт `did_you_mean` (с учётом остальных условий фильтра).
- **`find_contact`** (только чат): найти конкретного человека — `match=exact|fuzzy|none`, ошибкой не
  отвечает. Промпт велит звать его первым, когда владелец называет человека.
- **Неверный id.** `execute_tool` добавляет к `Contact not found` подсказку «найди через find_contact»;
  невалидный UUID (выдуманный id) — `error=invalid_id` вместо текста ошибки Postgres.
- **Контакты между сообщениями** (`backend/services/agent_contact_refs.py`): v3-циклы чата (веб, веб-стрим,
  Telegram, Telegram-стрим) собирают контакты из результатов инструментов, сохраняют у ответа в истории
  полем `contacts` (до 15), а к следующему сообщению владельца приклеивают блок «КОНТАКТЫ ИЗ НЕДАВНЕГО
  ДИАЛОГА» (последние 6 ответов, до 25 строк). Блок идёт в user-сообщение, а не в ответы ассистента,
  чтобы модель не копировала служебный формат владельцу.

## Смена модели не теряет историю диалогов (ветка 0110-contact)

Диалоги всех провайдеров лежат в одной таблице `conversations`, своей связи с пользователем у них нет —
только `assistant_id`. Страница диалогов (`/api/conversations/sessions`) показывает диалоги лишь
существующих ассистентов, а у OpenAI ORM-каскад (`AssistantConfig.conversations`, `delete-orphan`) удаляет
их вместе с ассистентом. Смена модели пересоздаёт ассистента с новым ID и удаляет старого, поэтому история
пропадала. Внешнего ключа на `conversations.assistant_id` в боевой базе **нет** (в модели он объявлен —
модель расходится с базой; в базе, созданной `create_all`, ключ появится и перенос между провайдерами упадёт).
- `ConversationService.transfer_assistant_conversations(db, from_ids, to_id)` — переписывает `assistant_id`
  (без commit). Используют `POST /api/conversations/transfer` (оба ассистента живые и свои) и смена голоса
  агента в `PUT /api/agent` (перед `_delete_voice_assistant`).
- `voice-assistants.html` → `migrateModel`: создать нового с заголовком `X-Replaces-Assistant: <старый id>`
  (`enforce_assistant_limit` не считает заменяемого в лимит, `is_counted_assistant`) → перепривязать номера →
  перенести диалоги → удалить старого. Путь «на пределе лимита сначала удалить старого» убран. Не перенеслись
  диалоги или номера — старый ассистент остаётся.
- Обычное удаление ассистента по-прежнему стирает (OpenAI) или прячет (остальные) его диалоги;
  «сироты» удалённых раньше ассистентов (на проде ~7.7 тыс. строк) не восстанавливались.

## Проверка ответа клиента (ветка 2709-skills)

Тулза `schedule_reply_check` (только v3, домешивается в `build_chat_tools` /
`build_postcall_tools`) ставит `Task(channel="reply_check")`: «через N проверь, ответил ли
клиент». У контакта одна ожидающая проверка — новая отменяет прежние. Логика в
`backend/services/agent_reply_check.py`: `client_reply_since` без LLM смотрит входящие
Telegram/MAX/SMS, входящий или состоявшийся (answered) звонок после `task.created_at`.
Планировщик (`TaskScheduler.execute_agent_reply_check`): ответил → задача `COMPLETED`,
`post_call_decision="REPLIED"`, модель не запускается; молчит → `AgentCall` +
`PostCallOrchestrator.run_for_reply_check` (`call_direction="reply_check"`), дальше агент
решает сам по своему промпту; попытки и авто-стадия не трогаются; `do_not_call` пропускается.
Входящие Telegram/MAX/SMS сразу закрывают ожидающие проверки (`cancel_pending_reply_checks`
в `handle_inbound_*`). В UI канал `reply_check` — бейдж «Проверка ответа» (`core.js`, `calls.js`).

## Файлы агента: PDF и таблицы (ветка 2709-skills)

Тулзы v3 (домешиваются в `build_chat_tools` / `build_postcall_tools`, `export_contacts_table`
только в чат): `create_pdf_document` (простая разметка `#`, `-`, `1.`, `| таблица |`, `**жирный**`
→ PDF через reportlab, кириллица — шрифт DejaVu из `backend/assets/fonts`, системных шрифтов на
Render нет), `create_spreadsheet` (листы `{name, columns, rows}` → xlsx; строка с `=` пишется
текстом, не формулой), `export_contacts_table` (`all_contacts=true`, пустой фильтр или `all_contacts` внутри filter — вся база, остальные поля тогда игнорируются; иначе фильтр как у `search_contacts` →
`generate_contacts_export_xlsx(contact_ids=…)`, до 10 000 контактов, сборка в потоке),
`get_agent_files`. Логика — `backend/services/agent_files.py`, таблица `agent_files` (байты в
Postgres, до 5 МБ; создаётся `ensure_agent_files_table` в `app.py`). Публичная ссылка с
секретным токеном: `GET /api/agent-files/{id}/{token}/{filename}` (`backend/api/agent_files.py`).
`telegram_send_message`, `max_send_message` (через `pymax.File`) и `send_telegram_notification`
(бот, `sendDocument`) принимают `file_id` и шлют файл вложением; в тред пишется пометка `[📎 имя]`.

## Массовая рассылка в мессенджерах и фильтр «молчит» (ветка 2709-skills)

- Фильтр контактов `no_reply_days=N`: агент выходил на связь (исходящий звонок, кроме
  проверок ответа, или исходящее сообщение Telegram/MAX) N+ дней назад, а клиент за последние
  N дней не ответил (нет входящего события `AgentCall.direction="inbound"`, состоявшегося
  исходящего звонка, входящих в тредах Telegram/MAX). Прогоны отправки сообщений (`answered`
  с `call_direction=telegram_outbound/max_outbound`) ответом не считаются.
- `bulk_schedule_messages` (только чат и только при подключённом Telegram или MAX): по фильтру
  ставит `Task(channel=telegram|max)` каждому контакту с инструкцией в `description`, до 200 за
  вызов, `do_not_call` пропускает, дубли в том же канале по умолчанию пропускает. Интервал не
  меньше 12 мин, если есть контакты без переписки (лимит 5 новых диалогов в час), иначе не
  меньше 2 мин.

## Входящие OpenAI на GPT-Live (ветка 2709-skills)

Все входящие звонки на OpenAI-ассистентов и агентов идут через сценарий
`voximplant_scenarios/inbound_openai.js` (v5.0): Voximplant сам открывает `gpt-live-1`
(`OpenAI.createLiveAPIClient`), без нашего сервера на пути аудио. Настройки сессии отдаёт
`/api/telephony/config` полями `live_session` (собирает `compose_live_session` в
`backend/websockets/live_client.py` — общий с виджетом и серверным мостом) и
`live_function_ids`; поле `model` осталось Realtime для старого сценария до раскатки.
Бэкенд-модель — `LIVE_DELEGATION_MODEL` (по умолчанию `gpt-5.6-luna`: terra в 10 раз дороже и съедает маржу тарифа). Голоса OpenAI-ассистента —
все 22 встроенных голоса gpt-live-1 (`OPENAI_VOICES` в `backend/schemas/assistant.py`; дубли во
фронте: `voice-assistants.html`, `agent/instructions-voice.js`); 12 из них (`OPENAI_LIVE_ONLY_VOICES`)
Realtime не знает — на Live (звонки и виджет) работают все; при откате виджета на Realtime их не выбирать. Шлагбаум и списание —
тариф `openai-live` (`/log` смотрит `voice_model == "gpt-live-1"`); секунды списания — `max(call_duration,
data.live_usage_seconds)`: OpenAI берёт деньги за всю сессию Live, включая гудки исходящего, прогрев и недозвоны. Исходящие — `voximplant_scenarios/outbound_openai.js` (v5.0) по той же схеме: `/api/telephony/outbound-config`
тоже отдаёт `live_session`, а контекст CRM из `customData` (`contact_name`, `task_title`,
`task_description`, `task`, `custom_greeting`) сценарий дописывает в instructions обоих слоёв. Агент и публичный API
звонят OpenAI через правило `outbound_openai` (`OUTBOUND_RULE_BY_TYPE` в `task_scheduler.py`, раньше — общий
`outbound_crm`); пока правила нет на дочернем аккаунте, `_resolve_outbound_rule` откатывается на `outbound_crm`. Веб-виджет OpenAI
(`/ws/{assistant_id}`, `widget.js`) тоже на Live: `backend/websockets/handler_live_widget.py` говорит на
прежнем протоколе виджета (`response.audio.delta` и т.д.), сессию открывает `OpenAILiveClient` (24 кГц), функции
выполняет сам клиент, в паузы досылает тишину (таймлайн Live идёт только при входящем звуке), тариф
`openai-live` посекундно (`VoiceBillingSession`), диалог в conversations/Sheets в конце сессии. `connection_status`
несёт `full_duplex: true` — `widget.js` тогда не глушит микрофон во время ответа (перебивания, эхо на браузерном
AEC). Откат виджета: env `WIDGET_OPENAI_TRANSPORT=realtime`; demo и ElevenLabs всегда идут в Realtime-хендлер.
Серверный мост `inbound_live.js` + `handler_live_telephony.py` оставлен
для отката. Раскатка кода со стримом: `POST /api/telephony/admin/setup-openai-scenarios-stream`
(копирует `inbound_openai`/`outbound_openai` с родительского аккаунта на все дочерние).

## Fish (входящие и исходящие): каскад ASR → LLM → Fish (ветка 2709-skills)

`voximplant_scenarios/inbound_fish.js` v2.0 (имя сценария то же): ASR Voximplant
(Yandex v2, interim; Deepgram — константа `ASR_PROVIDER`) + Silero VAD (тишина 500 мс, без Pipecat) →
LLM через наш прокси `/ws/fish/llm/{id}` (сейчас `LLM_MODEL = "deepseek/deepseek-v4.1-flash"` — модели с «/» прокси шлёт в OpenRouter на `settings.OPENROUTER_API_KEY`, провайдер из `OPENROUTER_PROVIDERS` (DeepSeek → Together), `reasoning_effort` → `reasoning.effort`; замер `scripts/bench_fast_llm.py`: первый токен ~0.3 с против ~0.86 с у gpt-6-luna priority; откат — `"gpt-6-luna"`, разрешённые модели — env `LLM_PROXY_MODELS`) (`backend/websockets/handler_llm_proxy.py`,
роут в `fish_ws.py`; ключ OpenAI на сервере, `cancel` обрывает ответ) → Fish через прокси `/ws/fish/tts/{id}`.
Коннектор Voximplant `createChatCompletionsAPIClient` (на `CONFIG.api_key`) давал первый токен 1.1–4.2 с
против 0.5–0.65 с с Render — оставлен откатом `LLM_TRANSPORT = "connector"`. Первый ответ модели в звонке шёл 3.5–4.2 с (с Render даже холодный — 0.5–1.4 с), поэтому во время приветствия уходит прогрев через тот же сокет (`LLM_WARMUP`: префикс + «Алло», ответ выбрасывается, реплика абонента ждёт его закрытия). Прокси отдаёт в `done` тайминги OpenAI (`openai_first_ms`), сценарий пишет их в лог.
Responses-клиент VoxEngine не использовать: массив сообщений в `input` он отвергает (`Missing required parameter: 'input'`).
Модель, паузу и провайдера ASR задают константы в начале сценария; `CONFIG.model` и
`DEFAULT_FISH_LLM_MODEL` (gpt-realtime-2.1) сценарии больше не читают (поле в конфиге оставлено для отката на v1.x).
`voximplant_scenarios/outbound_fish.js` v2.0 — тот же каскад (LLM/ASR/VAD/Fish-часть — копия входящего, правьте оба
вместе) плюс исходящая специфика: сокеты к прокси синтеза и модели открываются до `callPSTN` (сокет модели не
открылся — номер не набираем), прогрев уходит во время гудков (приветствие известно заранее), контекст CRM из
`customData` (`contact_name`, `task_*`, `task`) дописывается в system-промпт, `custom_greeting` заменяет приветствие,
мьют `mute_duration_ms` (по умолчанию 3 с) — аудио в ASR/VAD подключается после него, приветствие не перебивается
(ответ на реплику поверх него встаёт в очередь синтеза), описание `hangup_call` усилено. Тест —
`node voximplant_scenarios/test_outbound_fish.js`. Первый flush в Fish режется строго по знаку препинания (от 18 символов). Тест: `node voximplant_scenarios/test_inbound_fish.js` (запускает и `test_inbound_fish_proxy.js`), бэкенд прокси — `python test_llm_proxy.py`. Подробности — README сценариев.

## Каскад на прокси модели и Silero (ветка 0110-contact)

`voximplant_scenarios/inbound_cascade.js` / `outbound_cascade.js` v4.0 переведены на схему Fish v2.0:
ASR Voximplant (Yandex, `asr_lang`) + Silero VAD (тишина = пресет `silence_duration_ms` ассистента, Pipecat /
`VoxTurnTaking` не используются) → модель `LLM_MODEL` (`deepseek/deepseek-v4.1-flash`) через прокси
`/ws/cascade/llm/{id}` (тот же `handler_llm_proxy.py`, `kind="cascade"`: ассистент из `grok_assistant_configs`
с `assistant_type='cascade'`, ключ `provider_keys.resolve(user, "cascade")`; роут в `fish_ws.py`) → VoxTTS.
URL сценарий берёт из `llm_proxy_url` конфига (`build_cascade_llm_url` в `telephony.py`, `/config` и
`/outbound-config`); без него v4.0 звонок не принимает — бэкенд деплоить раньше сценариев. LLM/ASR/VAD-часть —
копия Fish-сценариев (правьте четыре файла вместе), исходящая специфика — как у `outbound_fish`. Конец озвучки
VoxTTS — `PlayerEvents.AudioChunksPlaybackFinished` плюс оценка длительности по `MS_PER_CHAR`. Каскад бесплатен:
токены в `/log` (`cascade_usage`) только для статистики. Цепочка `vox-turn-taking` в правилах оставлена (безвредна).
Тест — `node voximplant_scenarios/test_cascade.js`, бэкенд прокси — `python test_llm_proxy.py`.

## Описание API для ИИ-инструментов (ветка 2709-skills)

`backend/static/agent-api.md` — «скилл» для Claude Code и т.п.: справочник возможностей агента
+ эндпоинты по персональному ключу `X-Api-Key` (`get_current_user_flexible`). По ключу открыты:
агенты (list/get/create/update, модели), каскад-ассистенты и заметки памяти агента
(`GET/POST /api/agent/memory`, `PUT/DELETE /api/agent/memory/{note_id}`; очистка всей памяти
`DELETE /api/agent/memory` — только JWT). База знаний, контакты, подключения — только кабинет.
Добавляя тулзу агента или меняя тарифы/провайдеров, обновляй этот файл (шпаргалка, таблицы
инструментов, PostCall-набор, «Тарифы»). HTML-версия для людей — `agent-api-docs.html`.
## Запись звонка агента обзвона (ветка 2509-agent)

`agent_calls.record_url` (Text) — ссылка на аудиозапись (R2, при сбое — временный URL
Voximplant). Источник — `conversations.client_info["record_url"]`, который пишет
`POST /api/voximplant/log` до запуска разбора звонка. `PostCallOrchestrator._extract_record_url`
берёт самую свежую ссылку из найденных conversations в `finalize_from_webhook` и
`poll_and_run` и коммитит её **до** `_analyze` (иначе rollback при ошибке анализа её
потеряет). Оркестратор видит строку `ЗАПИСЬ ЗВОНКА (аудио): <url>` в блоке текущего звонка
и сам решает, прикладывать ли её в `send_telegram_notification` (по промпту владельца —
автодописывания нет). Если ссылка на запись есть в тексте уведомления
(`_find_recording_url`: `/recordings/` или .mp3/.wav/.ogg/.m4a), бот агента включает
предпросмотр только для неё (`link_preview_options.url` в `AgentTelegramService._send_chunk`,
параметр `preview_url`) — в Telegram появляется плеер; остальные ссылки без превью. В чате ссылку отдают `get_contact_call_history` и
`get_call_transcript` (`record_url`). UI: плеер + «Скачать запись» в `renderCallExpanded`
(`agent/calls.js`, общий для модалки звонков, истории и карточки контакта), в xlsx-экспорте —
колонка «Запись звонка». Колонка добавляется на старте (`ensure_agent_call_record_url_column`)
и миграцией `add_agent_call_record_url`. Заполняется только для новых звонков.

## Уведомления агента в истории Telegram-чата (ветка 2509-agent)

`send_telegram_notification`, вызванный из фонового разбора (`PostCallOrchestrator._analyze`
v2/v3: звонки, входящие SMS/TG/MAX, отложенные отправки), дописывает отправленный текст в
историю Telegram-чатов владельца (`agent_telegram_chat_histories.history`, реплика
`assistant`, `kind: "notification"`) — только в чаты, куда отправка прошла
(`send_to_all_chats` → `sent_chat_ids`). Первая строка служебная:
`[Уведомление, отправленное мной автоматически; контакт Имя (+7…), AGENT_CONTACT_ID: …, AGENT_CALL_ID: …]`,
поэтому на «а что по этому клиенту?» чат-оркестратор знает, о ком речь. Контекст передаётся
через `context["notification_history_context"]` (`_notification_history_context`); в
интерактивном чате его нет и запись не делается. Запись — `append_notification_to_chat_histories`
(своя сессия, `FOR UPDATE`, через `asyncio.to_thread`, хранится 20 последних записей), а
`ChatOrchestrator._persist_telegram_history` перечитывает `history` перед записью, чтобы не
затереть уведомление, пришедшее во время ответа. Веб-чат (`agent_configs.chat_history`) не трогается.

## Поиск в базе знаний в живом звонке (ветка 2509-agent)

`backend/functions/search_pinecone.py`: Pinecone отдаёт `top_k` ближайших (1–10, по умолчанию 3),
затем ответ ужимается — `MAX_RESULT_CHARS`=3500 на все фрагменты, `MAX_FRAGMENT_CHARS`=1200 на
один (раньше общий лимит 1000 — первый фрагмент съедал весь бюджет и модель получала один кусок),
огрызки короче `MIN_FRAGMENT_CHARS`=200 не кладутся. Фрагменты со score ниже `MIN_SCORE`=0.25
отбрасываются; если ничего не осталось — `found: false` + `message` (не придумывать ответ).
В лог пишутся все scores (`[PINECONE] ... scores=[...] below_threshold=N`) — по ним подбирать порог.
Поиск оркестратора агента (`fn_search_knowledge_base`) этих лимитов не использует.

## Админка: все типы ассистентов, базы знаний, заполненность Pinecone (ветка 2509-agent)

`backend/api/admin.py`: `ASSISTANT_KINDS` — все типы (Fish, OpenAI, Gemini, Каскад, Grok,
Яндекс, Cartesia; Каскад и Grok делятся по `grok_assistant_configs.assistant_type`).
`_count_assets_by_user(db, user_ids)` считает типы + агентов + базы знаний (`pinecone_configs` и
`agent_configs.kb_namespace`) одним `GROUP BY` на таблицу (раньше — 3 запроса на каждого
пользователя). `/admin/users` отдаёт `counts`, `kb_count`; `/admin/users/{id}` — `by_kind`,
`agents`, `knowledge_bases`; `/admin/stats` — `assistants.by_kind`, `agents`, `knowledge_bases`.
`GET /admin/pinecone-usage` — живой `describe_index_stats` (кэш 5 мин, `?refresh=true`): занято
из `PINECONE_NAMESPACE_LIMIT`=100, `level` ok/warn/danger по порогам 80/95, мусорные namespaces
(нет ссылок в БД — `_referenced_namespaces`, как в скрипте чистки) и базы без векторов; при
недоступном Pinecone — `available: false`. Фронт (`admin.html`): виджет `[data-pc-root]` на
вкладке «Пользователи» и в «Статистике» (`ui.renderPineconeUsage`), бейджи типов
(`ui.assistantBadges`), таблица агентов в карточке пользователя (базы знаний по пользователям
в UI не показываем — достаточно общего счётчика). Фильтр «Оплаченные (активные)»
(`subscription_status=active`) отдаёт только оплаченные действующие подписки — не триал, не
`FREE_PLAN_CODES`, не админы (`_is_paid_subscription`), сортировка по дате окончания; строки с
`is_paid` подсвечены зелёным, колонка «Подписка до» — дата окончания и остаток дней.

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

## Промпт голосового агента во входящих (ветка 2709-skills)

`GET /api/telephony/config` (входящие): если номер привязан к агенту (`agent_config_id`) и у агента
заполнено `voice_additional_instructions` (вкладка «Звонки» → «Инструкции для голосового агента»),
в сценарий уходит **этот текст** + `VOICE_AGENT_FUNCTIONS_BLOCK` (правила send_sms / hangup_call) +
карточка звонящего, без остального `VOICE_AGENT_PROMPT_BASE` (он написан под исходящие со стратегией
оркестратора; блок функций вынесен из него отдельной константой, текст шаблона не изменился). Пустое поле — прежний `system_prompt`
ассистента (шаблон + блок владельца). Исходящие не менялись.
