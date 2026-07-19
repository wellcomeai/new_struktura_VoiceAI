# Voicyfy Agent API — создание и настройка автономных агентов

API для программного управления автономными агентами обзвона Voicyfy
(страница `https://voicyfy.ru/static/agent.html`). Предназначено для
интеграций вроде Claude Code: агент создаётся и настраивается HTTP-запросами.

**Base URL:** `https://voicyfy.ru`

---

## Аутентификация

Все запросы передают персональный API-ключ в заголовке:

```
X-Api-Key: vfy_...
```

Ключ генерируется в кабинете: **Настройки → API-ключ для интеграций**
(`https://voicyfy.ru/static/settings.html`). Ключ показывается один раз при
генерации; при перевыпуске старый ключ мгновенно перестаёт работать.

Ошибки авторизации: `401 {"detail": "invalid_api_key"}`.

Доступные по ключу эндпоинты — только перечисленные ниже (создание,
редактирование и чтение агентов + справочник моделей). Всё остальное API
Voicyfy по ключу недоступно.

---

## Важно: как устроен агент (прочитай перед настройкой)

У каждого агента ДВА независимых AI-компонента, и у каждого — свой скрытый
базовый системный промпт, который через API **не редактируется**:

1. **Оркестратор** — текстовый «мозг»: ведёт CRM, планирует звонки, готовит
   стратегию каждого звонка и анализирует результат. Его промпт собирается из:
   базовый шаблон + 5 документов компании (`doc_*`) + поле
   `additional_instructions` (секция «Дополнительные инструкции от владельца»).
2. **Голосовой агент** — говорит в живом телефонном разговоре. Его промпт:
   базовый шаблон + поле `voice_additional_instructions` (дописывается отдельной
   секцией). Документы `doc_*` в живом разговоре НЕ используются.

### Что писать в какое поле

| Поле | Куда попадает | Что писать |
|------|---------------|------------|
| `doc_who_am_i` | оркестратор | Кто компания: название, город, чем занимается |
| `doc_who_we_call` | оркестратор | Целевая аудитория: кому звоним и зачем |
| `doc_how_we_talk` | оркестратор | Стиль общения бренда |
| `doc_what_we_offer` | оркестратор | Продукты/услуги, цены, условия |
| `doc_rules_and_goals` | оркестратор | Цели, KPI, ограничения |
| `additional_instructions` | оркестратор | Правила планирования и работы с контактами, которые не вписываются в документы (например «не звонить чаще 1 раза в 3 дня») |
| `voice_additional_instructions` | голосовой агент | Поведение именно в живом разговоре: имя ассистента, манера речи, запретные темы, обработка возражений |
| `inbound_first_phrase` | голосовой агент | Приветствие ТОЛЬКО для входящих звонков (до 500 символов) |

### Первая фраза

- **Исходящие звонки:** первую фразу генерирует оркестратор индивидуально под
  каждый звонок (стратегия PreCall) — статически она не настраивается.
  Влиять на неё можно через `doc_*` и `additional_instructions`.
- **Входящие звонки:** статическое поле `inbound_first_phrase`.

---

## Эндпоинты

### 1. GET /api/agent/list — список агентов

```bash
curl -H "X-Api-Key: vfy_..." https://voicyfy.ru/api/agent/list
```

Ответ:

```json
{
  "total": 1,
  "max_agents": 3,
  "can_create_more": true,
  "has_agent_access": true,
  "agents": [ { ...объект агента, см. ниже... } ]
}
```

Отсюда берётся `agent_id` (поле `id`) для остальных запросов.

### 2. GET /api/agent/?agent_id={id} — один агент

```bash
curl -H "X-Api-Key: vfy_..." "https://voicyfy.ru/api/agent/?agent_id=<uuid>"
```

Без `agent_id` возвращается первый (самый старый) агент пользователя.
Перед любым редактированием сначала прочитай текущее состояние этим запросом.

### 3. GET /api/agent/orchestrator-models — доступные модели оркестратора

```bash
curl -H "X-Api-Key: vfy_..." https://voicyfy.ru/api/agent/orchestrator-models
```

Ответ: `{"models": [{"slug": "...", "name": "...", "description": "..."}], "default": "..."}`.
В `orchestrator_model` передавай только `slug` из этого списка. Если не уверен —
не передавай поле вовсе: применится модель по умолчанию.

### 4. POST /api/agent/create — создать агента

```bash
curl -X POST https://voicyfy.ru/api/agent/create \
  -H "X-Api-Key: vfy_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Алёна",
    "assistant_type": "openai",
    "doc_who_am_i": "Компания «АкваЛето», Иркутск. Продаём надувные бассейны...",
    "doc_who_we_call": "Частные домовладельцы, дачники...",
    "doc_how_we_talk": "Дружелюбно, на «вы», без канцелярита...",
    "doc_what_we_offer": "Бассейны Intex и Bestway от 15 000 ₽...",
    "doc_rules_and_goals": "Цель — записать на замер или выставить счёт...",
    "additional_instructions": "Не звонить одному контакту чаще раза в 3 дня.",
    "voice_additional_instructions": "Твоё имя — Алёна. Говори коротко, тепло.",
    "inbound_first_phrase": "Здравствуйте! Компания АкваЛето, меня зовут Алёна. Чем могу помочь?",
    "working_hours_start": 9,
    "working_hours_end": 21,
    "voice": "marin"
  }'
```

Поля запроса:

| Поле | Тип | Обяз. | Описание |
|------|-----|-------|----------|
| `name` | string | да | Имя агента (1–255 символов) |
| `assistant_type` | string | да | Провайдер голоса: `gemini` \| `openai` \| `cartesia` \| `yandex` |
| `doc_who_am_i` … `doc_rules_and_goals` | string | да (все 5) | Документы компании для оркестратора |
| `additional_instructions` | string | нет | Доп. инструкции оркестратора |
| `voice_additional_instructions` | string | нет | Доп. инструкции голосового агента |
| `inbound_first_phrase` | string | нет | Приветствие входящих (≤500 символов) |
| `working_hours_start` / `working_hours_end` | int 0–23 | нет | Рабочие часы для звонков (МСК), по умолчанию 9–21 |
| `orchestrator_model` | string | нет | Slug из `/orchestrator-models`; по умолчанию — дефолтная |
| `voice` | string | нет | Имя голоса для gemini/openai/yandex (см. списки ниже) |
| `cartesia_voice_id` | string | нет | ID голоса Cartesia (только для `assistant_type: "cartesia"`) |
| `voice_speed` | float 0.5–1.5 | нет | Скорость речи (только Cartesia) |

Успех: `200` с объектом агента (+ `trial_activated`). Ответ содержит `id` —
сохрани его как `agent_id`.

Предусловия (иначе `400`/`402` — см. «Ошибки»): у пользователя верифицирована
телефония Voximplant, задан API-ключ выбранного голосового провайдера
(в настройках кабинета), активен тариф agent/profi или доступен триал,
меньше 3 агентов.

### 5. PUT /api/agent/?agent_id={id} — редактировать агента

Передавай **только изменяемые поля** — остальные не трогаются:

```bash
curl -X PUT "https://voicyfy.ru/api/agent/?agent_id=<uuid>" \
  -H "X-Api-Key: vfy_..." \
  -H "Content-Type: application/json" \
  -d '{
    "voice_additional_instructions": "Твоё имя — Алёна. Отвечай короче.",
    "inbound_first_phrase": "Добрый день! АкваЛето, Алёна слушает."
  }'
```

Доступны все поля из create, а также:

| Поле | Тип | Описание |
|------|-----|----------|
| `is_active` | bool | Включить/выключить агента |
| `default_caller_id` | string | Номер, с которого звонит агент |
| `webhook_url` | string ≤500 | URL вебхука для передачи событий во внешнюю систему |
| `assistant_type` | string | Смена голосового провайдера (создаётся новый голосовой ассистент; нужен ключ нового провайдера) |

При изменении `voice_additional_instructions` системный промпт голосового
агента пересобирается автоматически. При изменении `doc_*` промпт оркестратора
обновляется автоматически (он собирается на лету).

---

## Голоса по провайдерам

- **openai:** `alloy`, `echo`, `marin`, `cedar`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`
- **gemini:** `Zephyr`, `Puck`, `Charon`, `Kore`, `Fenrir`, `Leda`, `Orus`, `Aoede`, `Callirrhoe`, `Autonoe`, `Enceladus`, `Iapetus`, `Umbriel`, `Algieba`, `Despina`, `Erinome`, `Algenib`, `Rasalgethi`, `Laomedeia`, `Achernar`, `Alnilam`, `Schedar`, `Gacrux`, `Pulcherrima`, `Achird`, `Zubenelgenubi`, `Vindemiatrix`, `Sadachbia`, `Sadaltager`, `Sulafat`
- **yandex:** `marina`, `dasha`, `alexander`, `julia`, `lera`, `masha`, `anton`, `kirill`, `filipp`, `ermil`, `jane`, `omazh`, `zahar`, `madi_ru`, `saule_ru`
- **cartesia:** голос задаётся не именем, а `cartesia_voice_id` + опционально `voice_speed` (0.5–1.5)

Невалидное имя голоса → `400 invalid_voice` (в update) или молча дефолт (в create).
Дефолты: openai — `alloy`, gemini — `Kore`, yandex — `marina`.

---

## Объект агента (ответ GET/POST/PUT)

Ключевые поля: `id`, `name`, `assistant_type`, `is_active`,
`orchestrator_model`, `doc_who_am_i` … `doc_rules_and_goals`,
`additional_instructions`, `voice_additional_instructions`,
`inbound_first_phrase`, `working_hours_start`, `working_hours_end`,
`default_caller_id`, `webhook_url`, `voice`, `cartesia_voice_id`,
`voice_speed`, `has_knowledge_base`, `created_at`, `updated_at`.

---

## Ошибки

| Код | `detail` | Причина |
|-----|----------|---------|
| 401 | `invalid_api_key` | Неверный или отозванный API-ключ |
| 400 | `telephony_not_verified` | Телефония Voximplant не верифицирована (делается в кабинете) |
| 400 | `api_key_required_gemini` / `api_key_required_openai` / `api_key_required_cartesia` / `api_key_required_yandex` | Не задан ключ голосового провайдера в настройках кабинета |
| 400 | `agent_limit_reached` | Уже 3 агента |
| 400 | `invalid_assistant_type` / `invalid_orchestrator_model` / `invalid_voice` | Невалидное значение поля |
| 402 | `subscription_required` | Триал использован, нужен тариф |
| 404 | `not_found` | Агент не найден (чужой или несуществующий `agent_id`) |

---

## Рекомендуемый флоу для Claude Code

**Редактирование существующего агента:**
1. `GET /api/agent/list` → найти агента, взять `id`.
2. `GET /api/agent/?agent_id=<id>` → прочитать текущие настройки.
3. `PUT /api/agent/?agent_id=<id>` → отправить только изменённые поля.
4. Перечитать агента и показать пользователю, что изменилось.

**Создание нового агента:**
1. `GET /api/agent/list` → проверить `can_create_more`.
2. `GET /api/agent/orchestrator-models` → выбрать модель (или пропустить).
3. Составить 5 документов `doc_*` и инструкции по таблице выше.
4. `POST /api/agent/create`.
5. Обработать возможные 400/402 (предусловия выполняются пользователем в кабинете).
