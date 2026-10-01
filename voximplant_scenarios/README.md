# Сценарии Voximplant (каскады + VoxTTS / Fish)

Код VoxEngine-сценариев каскадных голосовых ассистентов. Каскад (`*_cascade`) и
Fish (`*_fish`) с v4.0 / v2.0 устроены одинаково:

встроенный ASR Voximplant (Yandex v2, streaming + interim) + **Silero VAD**
(конец реплики — тишина) → модель через **наш прокси** (`/ws/cascade/llm/{id}`
или `/ws/fish/llm/{id}`, `backend/websockets/handler_llm_proxy.py`; сейчас
`deepseek/deepseek-v4.1-flash` через OpenRouter/Together, первый токен ~0.3 с)
→ голос: **VoxTTS** (Anna/Sergey, встроен в Voximplant) у каскада, **Fish
Audio** через прокси `/ws/fish/tts/{id}` у Fish.

LLM-часть, ASR/VAD, склейка реплик, перебивания и ошибки модели — один и тот же
код в четырёх сценариях (`inbound_fish`, `outbound_fish`, `inbound_cascade`,
`outbound_cascade`): правьте их вместе.

## Каскад v4.0 (inbound_cascade / outbound_cascade)

До v4.0 каскад работал на OpenAI Realtime (`gpt-realtime-2.1-mini`, только текст)
+ `VoxTurnTaking` (Silero + Pipecat Smart Turn). Теперь — схема Fish v2.0:

- **Конец реплики — Silero.** Длительность тишины — пресет «Пауза перед
  ответом» ассистента (`grok_assistant_configs.silence_duration_ms`: 300 / 650 /
  1000, приезжает полем `silence_duration_ms` конфига, зажимается в 200–1500).
  Абонент продолжил фразу до звука ответа — куски склеиваются, прошлый запрос
  отменяется. Pipecat / `VoxTurnTaking` не используются: правило-цепочка
  `[vox-turn-taking, *_cascade]` по-прежнему работает (хелпер только объявляет
  глобальный объект), одиночное правило — тоже.
- **Модель через прокси.** URL — `llm_proxy_url` из `/api/telephony/config` и
  `/outbound-config` (`build_cascade_llm_url` в `telephony.py`), ассистент
  ищется в `grok_assistant_configs` (`assistant_type='cascade'`), ключ OpenAI —
  `provider_keys.resolve(user, "cascade")`, ключ OpenRouter — платформы.
  Модель — константа `LLM_MODEL` в сценарии; откат на коннектор Voximplant —
  `LLM_TRANSPORT = "connector"` (`CONFIG.api_key`, `LLM_CONNECTOR_MODEL`).
  Прогрев: во время приветствия (входящий) / гудков (исходящий) модели уходит
  тот же префикс с «Алло», ответ выбрасывается.
- **VoxTTS.** Текст копится до первой границы (предложение или запятая от 18
  символов) и уходит с `flush_context`, дальше пачками, в конце реплики —
  flush. Перебивание — `clearBuffer()` + `cancel` в прокси. Конец озвучки —
  `PlayerEvents.AudioChunksPlaybackFinished` (`final !== false`; события в
  первые 400 мс после `clearBuffer` — хвост сброшенной фразы); на случай, если
  события не будет, «агент звучит» ещё и по оценке длительности
  (`MS_PER_CHAR`), hangup после прощания — по ней же с запасом.
- **Биллинг.** Каскад бесплатен (тариф 0 ₽). Токены уходят в `/log` полем
  `cascade_usage` (с `model`) для статистики; списание по ним — за флагом
  `CASCADE_CREDITS_BILLING` (выключен, ставки там под старую модель).
- **Тест:** `node voximplant_scenarios/test_cascade.js` (входящий + исходящий на
  заглушках VoxEngine), бэкенд прокси — `python test_llm_proxy.py`.

Сценарии живут на **родительском аккаунте Voximplant** и копируются на дочерние
аккаунты штатными админ-эндпоинтами. Этот каталог — источник правды для их кода.

## Файлы

| Файл | Имя сценария на Voximplant | Назначение |
|---|---|---|
| `vox-turn-taking.js` | `vox-turn-taking` | **v2.1.** Хелпер turn-taking (Silero VAD + Pipecat Smart Turn). Объявляет глобальный `VoxTurnTaking`, сам ничего не запускает. Каскад v4.0 его **не использует**; файл оставлен, потому что правила каскадных номеров на дочерних аккаунтах — цепочка `[vox-turn-taking, *_cascade]` (бэкенд создаёт её и сейчас, это безвредно). |
| `inbound_cascade.js` | `inbound_cascade` | **v4.0. Входящий каскад** ASR → LLM → VoxTTS: конфиг с `/api/telephony/config` (`assistant_type` должен быть `cascade`, нужен `llm_proxy_url`), ASR Yandex v2 (`asr_lang`), Silero VAD с тишиной из `silence_duration_ms`, модель `LLM_MODEL` через прокси `/ws/cascade/llm/{id}`, VoxTTS с голосом `tts_voice`. Сокет модели, VAD и плеер поднимаются на гудках, потом answer. `first_phrase` — сразу в VoxTTS + прогрев модели; без неё здоровается модель. `hangup_call` (с усиленным описанием) — прощание и hangup после конца озвучки, остальные функции — `POST /api/voximplant/functions/execute`. Ошибка/обрыв модели — переподключение и повтор хода, после `LLM_FAIL_MAX` подряд — извинение и hangup. Запись, стоимость (звонок + ASR + запись) и диалог — один `/api/voximplant/log` в конце, плюс `cascade_usage`. |
| `outbound_cascade.js` | `outbound_cascade` | **v4.0. Исходящий каскад** — тот же код, что `inbound_cascade` v4.0, плюс исходящая специфика `outbound_fish`: точка входа `AppEvents.Started` + `customData()` (phone_number, assistant_id, caller_id, mute_duration_ms, contact_name/task_*/task/custom_greeting); конфиг `/api/telephony/outbound-config`; сокет модели, VAD и VoxTTS — до `callPSTN` (не поднялось — не звоним); прогрев во время гудков; контекст CRM и реальные номера/время — в system-промпт; `custom_greeting` приоритетнее приветствия; мьют `mute_duration_ms` (по умолчанию 3000) — аудио в ASR/VAD подключается после него; приветствие не перебивается (ответ встаёт в очередь VoxTTS за ним); тишина в линии 180 с — hangup. `/log` с `context` и `cascade_usage`. v3.x работал на Realtime + встроенном `VoxTurnTaking`. |
| `inbound_openai.js` | `inbound_openai` | **v5.1, GPT-Live.** Все входящие на OpenAI-ассистентов и агентов. Нативный коннектор Voximplant `OpenAI.createLiveAPIClient` — наш сервер не на пути аудио. Настройки сессии целиком с бэкенда: `/api/telephony/config` → `live_session` (промпт голосового слоя, голос Live, `delegation.responses` с `gpt-5.6-terra`, промптом и функциями) и `live_function_ids` (имя → `function_id`). Порядок: конфиг на гудках → `sessionStart` → `SessionStarted` → прогрев: `createURLPlayer(/static/audio/silence.wav, loop)` → Live и приветствие (`sessionInstructionsAppend` с `first_phrase`) ещё на гудках → `SessionInstructionsAppended` → answer + запись + `sendMediaBetween` (вход Live переключается с тишины на абонента) + `sessionCommentaryAppend`. Зачем: таймлайн Live идёт только при входящем аудио, а первый медиапоток коннектор поднимает ~2 с — раньше это было после ответа (~3 с тишины), теперь первое слово ~0.7 с после ответа. Не принято за 5 с — отвечаем всё равно. Функции — `ResponseEvent`: вызовы копятся по `delegation_id`, выполняются на `response.completed` через `/api/voximplant/functions/execute`, результаты `responseItemCreate` + один `responseCreate`. `hangup_call` — локально: прощание и hangup после `AgentStoppedSpeaking`. Диалог собирается из `Session*TranscriptDelta` (смена говорящего = новая реплика) и уходит в `/api/voximplant/log` с `voice_model: "gpt-live-1"` → списание по тарифу `openai-live`. Раскатка: код на родительский аккаунт → `POST /api/telephony/admin/setup-openai-scenarios-stream`. |
| `outbound_openai.js` | `outbound_openai` | **v5.0, GPT-Live.** Исходящие OpenAI-ассистентов и агентов по схеме `inbound_openai`. Точка входа — `AppEvents.Started` + `customData`. Конфиг `/api/telephony/outbound-config` → `live_session` + `live_function_ids`; сценарий дописывает в instructions голосового слоя и бэкенд-модели контекст CRM (`contact_name`, `task_title`, `task_description`, `task`) и блок с номерами/временем; `custom_greeting` (первая фраза PreCall-оркестратора) приоритетнее приветствия ассистента. В v4.11 (Realtime) эти поля не читались. Сессия Live поднимается **до** `callPSTN` (сбой → не звоним), на гудках в Live идёт тишина (`silence.wav`), на `Connected` — запись, `sendMediaBetween`, приветствие. Мьюта первых секунд нет. Функции, `hangup_call`, диалог, `/log` с `voice_model: "gpt-live-1"` — как во входящем. Секунды гудков тарифицируются OpenAI как время сессии Live. |
| `inbound_live.js` | `inbound_live` | **v0.1, экспериментально, оставлен для отката.** Входящий на **GPT-Live** (`gpt-live-1`): один WebSocket к `/ws/live/telephony/{assistant_id}`, аудио в обе стороны (`call.sendMediaTo(ws)` PCM16 16 кГц ↔ `ws.sendMediaTo(call)`). Сессия Live, VAD, перебивания, функции (delegation → бэкенд-модель) — на сервере (`backend/websockets/handler_live_telephony.py`). Приветствие — `first_phrase` через `session.instructions.append`. Транскрипт приходит от сервера в `call_summary` при завершении и уезжает в `/api/voximplant/log` вместе с записью и биллингом. Номер должен быть привязан к OpenAI-ассистенту. `hangup_call` пока не поддерживается. |
| `cartesia_inbound.js` | `cartesia_inbound` | Входящий half-cascade на **OpenAI Realtime** (`gpt-realtime-2.1-mini`, output text): STT + turn detection + reasoning на стороне OpenAI (Silero/Pipecat не нужны), TTS — VoxTTS/Anna. Ключ — пользовательский (`CONFIG.api_key`). Одиночный сценарий (без цепочки vox-turn-taking). Несмотря на имя, TTS не Cartesia. |
| `inbound_fish.js` | `inbound_fish` | **v2.0. Входящий full cascade**: ASR Voximplant (Yandex v2 по умолчанию, Deepgram — константа `ASR_PROVIDER`, свои ключи не нужны, ASR тарифицирует Voximplant) + **Silero VAD** (конец реплики — простая тишина `VAD_SILENCE_MS`=500, без Pipecat) → модель (константа `LLM_MODEL`, сейчас `deepseek/deepseek-v4.1-flash` через OpenRouter/Together — первый токен ~0.3 с против ~0.86 с у gpt-6-luna; модели с «/» прокси отправляет в OpenRouter на ключе платформы, для коннектора — `LLM_CONNECTOR_MODEL`) через **наш прокси `/ws/fish/llm/{assistant_id}`** (`LLM_TRANSPORT="proxy"`, `backend/websockets/handler_llm_proxy.py`: тёплое соединение с OpenAI, ключ остаётся на сервере — `provider_keys.resolve(user, "fish")`, разрешённые модели `LLM_PROXY_MODELS`, ответ можно оборвать `cancel`; URL сценарий получает из `fish_tts_url` заменой `/tts/` на `/llm/`). Коннектор Voximplant добавлял к первому токену 0.5–3.5 с (из звонка 1.1–4.2 с против 0.5–0.65 с с Render) и оставлен откатом `LLM_TRANSPORT="connector"` (клиент **Chat Completions** VoxEngine `OpenAI.createChatCompletionsAPIClient`, `storeContext: false`, ключ `CONFIG.api_key`). Параметры запроса: `stream: true`, `reasoning_effort=none` (minimal у luna нет; неподдерживаемое значение — автоповтор без параметра)) → озвучка **Fish Audio** через наш прокси `/ws/fish/tts/{assistant_id}` (как в v1.0). Responses-клиент не подошёл: на массив сообщений в `input` коннектор отвечал `Missing required parameter: 'input'` (в примерах Voximplant у него только строка). История диалога (system + messages + tool_calls/tool) ведётся в сценарии, поэтому поздний финал ASR правит реплику на месте без лишнего запроса. Первый flush в Fish — на первом предложении или запятой/тире, как только кусок ≥18 символов (`FIRST_FLUSH_MIN` / `FIRST_CLAUSE_MIN`; «Здравствуйте, слушаю.» уходит отдельно) (длинное первое предложение давало ~1 с до звука); до первого flush текст в Fish не шлётся, в синтез уходит ровно кусок до знака препинания — без обрыва слова. Прогрев (`LLM_WARMUP`): пока звучит приветствие, модели уходит тот же префикс с репликой «Алло» (`max_completion_tokens`=`WARMUP_MAX_TOKENS`, ответ выбрасывается), реплика абонента ждёт его закрытия — первый ответ в звонке шёл 3.5–4.2 с при 0.5–1.4 с для того же запроса с Render. Прокси отдаёт в `done` `openai_first_ms`/`total_ms`, сценарий пишет их в лог (`[LLM] proxy: OpenAI first chunk …`). Поздний финал ASR по куску, который склейка вернула в реплику, не дублируется. После тишины VAD ждём хвост ASR `SUBMIT_SETTLE_MS`=50 мс. `LLM_SERVICE_TIER`=`priority` — приоритетная обработка OpenAI (замер с Render: медиана первого токена 568 мс против 876 мс, цена x2 — ~0.1 ₽ на звонок; `null` — обычная). Поздний финал ASR, короче прежнего текста по буквам, но не по словам, принимается как исправленное слово («уфимская» → «финская»). Один ответ модели за раз: перебивание (речь поверх агента ≥ `BARGE_IN_MIN_MS`=300 или текст ASR) гасит звук и обрывает ответ (`cancel` в прокси; у коннектора — остаток игнорируется до закрытия); если абонент продолжил фразу до звука ответа — куски склеиваются в одну реплику, прошлый запрос отменяется и новый уходит сразу. Ошибка или обрыв сокета модели → переподключение и повтор того же хода; после `LLM_FAIL_MAX` неудач подряд агент извиняется голосом (`FAIL_PHRASE`) и кладёт трубку. `hangup_call` локально, остальные функции — `/api/voximplant/functions/execute`. В `/log` стоимость = звонок + ASR + запись (`call_cost_parts`). `CONFIG.model` (gpt-realtime-2.1) не используется — модель в константе `LLM_MODEL`. Тест на заглушках: `node voximplant_scenarios/test_inbound_fish.js` (основной прогон на коннекторе + `test_inbound_fish_proxy.js` для прокси); бэкенд прокси — `python test_llm_proxy.py`. Одиночный сценарий. |
| `outbound_fish.js` | `outbound_fish` | **v2.0. Исходящий** Fish — тот же каскад, что `inbound_fish` v2.0 (ASR Voximplant + Silero VAD → модель через прокси `/ws/fish/llm/{id}` → Fish через `/ws/fish/tts/{id}`); LLM/ASR/VAD/Fish-часть скопирована из входящего, правьте оба вместе. Точка входа — `AppEvents.Started` + `VoxEngine.customData()` (phone_number, assistant_id, caller_id, mute_duration_ms, contact_name/task_*/custom_greeting/task). Конфиг с `/api/telephony/outbound-config`. Оба сокета поднимаются ДО `callPSTN` (сокет модели не открылся — номер не набираем), прогрев модели (промпт + приветствие + «Алло») уходит во время гудков. После Connected приветствие уходит в Fish напрямую, аудио абонента подключается к ASR/VAD через `mute_duration_ms` (по умолчанию 3000); приветствие не перебивается, ответ на реплику поверх него встаёт в очередь синтеза. **Контекст звонка** (задача + карточка CRM) и реальные номера/время — в system-промпт; `custom_greeting` от PreCall-оркестратора приоритетнее приветствия из конфига. `hangup_call` (с усиленным описанием) завершает звонок после прощания, остальные функции — через `POST /api/voximplant/functions/execute`. Тест: `node voximplant_scenarios/test_outbound_fish.js`. v1.x работал на OpenAI Realtime. |

## Раскатка (вручную)

1. На родительском аккаунте Voximplant обновить код сценариев `inbound_cascade`
   и `outbound_cascade` содержимым этих файлов (имена — строго как в таблице).
   Бэкенд с `llm_proxy_url` и `/ws/cascade/llm/{id}` должен быть задеплоен
   раньше: без `llm_proxy_url` в конфиге сценарий v4.0 звонок не принимает.
2. Раскатать на дочерние аккаунты:
   - `POST /api/telephony/admin/setup-cascade-scenarios` — копирует cascade-сценарии
     (inbound + outbound) и создаёт `outbound_cascade` rule **цепочкой**
     `vox-turn-taking;outbound_cascade`;
   - `POST /api/telephony/admin/deploy-turn-taking` — копирует хелпер и патчит
     inbound-правила cascade-номеров на цепочку `vox-turn-taking;inbound_cascade`,
     а также пересоздаёт `outbound_cascade` rule той же цепочкой.
3. Привязать cascade-ассистента к номеру (`POST /api/telephony/bind-assistant`,
   `assistant_type: "cascade"`) — бекенд сам создаст inbound-правило с цепочкой.
4. Исходящий звонок: `StartScenarios` по правилу `outbound_cascade` со
   `script_custom_data` (см. `voximplant_partner.start_outbound_call`).

Fish-сценарии раскатываются так же, своими эндпоинтами:

1. Обновить код `inbound_fish` и `outbound_fish` на родительском аккаунте.
2. `POST /api/telephony/admin/setup-fish-scenarios` (или
   `…/setup-fish-scenarios-stream` — SSE с прогрессом по аккаунтам): копирует оба
   сценария на дочерние аккаунты и создаёт правило `outbound_fish`.
3. Входящие: `POST /api/telephony/bind-assistant` с `assistant_type: "fish"`
   (или `"agent"` для агента обзвона с fish-голосом) — правило создаётся само.
4. Исходящие агента обзвона идут по правилу `outbound_fish`
   (`task_scheduler._outbound_rule_name`), цепочка сценариев не нужна.

## Как работает цепочка из двух сценариев в одном правиле

`AddRule`/`SetRuleInfo` принимают `scenario_id` списком (`"id1;id2"`).
Оба сценария загружаются в одну JS-сессию по порядку и делят глобальную
область видимости: первый объявляет `VoxTurnTaking`, второй его использует.
Правило при этом остаётся одно — модель «1 номер → 1 правило» не меняется.
Бекенд уже умеет это: `voximplant_partner.add_rule` (список → `;`),
`telephony.bind-assistant` (цепочка для cascade).

## Ограничения текущей версии

- TTS каскада — только VoxTTS (Anna/Sergey); для `tts_provider` не `voxtts`
  сценарий пишет warning и озвучивает VoxTTS.
- `vox-turn-taking` в цепочке правила каскада больше не нужен, но бэкенд
  (`bind-assistant`, `setup-cascade-scenarios`, `deploy-turn-taking`) пока
  продолжает собирать цепочку — это безвредно.
