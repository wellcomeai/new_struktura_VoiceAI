# Сценарии Voximplant (cascade + VoxTTS)

Код VoxEngine-сценариев для каскадного голосового ассистента:
встроенный ASR (Yandex v2, streaming + interim) → VoxTurnTaking (Silero VAD +
Pipecat Smart Turn) → OpenAI gpt-5.4-nano (Chat Completions, stateless, ручная
история + спекулятивная генерация) → VoxTTS (Anna/Sergey).

Сценарии живут на **родительском аккаунте Voximplant** и копируются на дочерние
аккаунты штатными админ-эндпоинтами. Этот каталог — источник правды для их кода.

## Файлы

| Файл | Имя сценария на Voximplant | Назначение |
|---|---|---|
| `vox-turn-taking.js` | `vox-turn-taking` | Хелпер turn-taking. Объявляет глобальный `VoxTurnTaking` (Silero VAD + Pipecat Smart Turn + двухскоростной endpointing), сам ничего не запускает. Отдаёт сценарию `onUserTurn`, `onSpeculativeTurn`, `onInterrupt`, `canPlayAgentAudio()`, `currentVersion()`. Должен стоять ПЕРВЫМ в цепочке правила. Рассчитан на Yandex v2 с `interimResults`. |
| `inbound_cascade.js` | `inbound_cascade` | Входящий каскад: конфиг с `/api/telephony/config`, ASR Yandex v2 (interim), LLM gpt-5.4-nano через **Chat Completions** (stateless, ручной массив `messages`, ключ = **пользовательский** `OPENAI_API_KEY` со страницы каскад-агентов), TTS VoxTTS/Anna. Спекулятивная генерация на **втором** OpenAI-клиенте прячет TTFT под паузу; поколения гейтятся по completion-`id` (не по metadata). **Tool-calling** (как в `outbound_cascade`): при наличии функций у ассистента вызывается `POST /api/voximplant/functions/execute`, а `hangup_call` завершает звонок локально. Функции и спекуляция несовместимы — при включённых функциях спекуляция автоматически отключается (один клиент). **Запись/стоимость/логирование** как в Gemini-сценарии: `call.record()` на Connected, `call_session_history_id` из `AppEvents.Started`, стоимость/длительность из события Disconnected, и один `POST /api/voximplant/log` в конце звонка (запись→R2, полная стоимость через GetCallHistory, структурированный `dialog`, Telegram). Per-turn `/webhook/transcript` не используется. |
| `outbound_cascade.js` | `outbound_cascade` | **Исходящий** каскад. Точка входа — `AppEvents.Started` + `VoxEngine.customData()` (phone_number, assistant_id, caller_id, contact_name/task_*/custom_greeting). Конфиг с `/api/telephony/outbound-config`. Задача звонка + CRM инжектятся в system-промпт. **Readiness-before-dial**: ASR/LLM/TTS готовятся ДО `VoxEngine.callPSTN` (при сбое не звоним = 0₽). **Mute-окно** `mute_duration_ms` после ответа (мик абонента закрыт, чтобы «Алло» не оборвало приветствие). **Tool-calling** (Chat Completions `tools`, разбор из `Chunk.delta.tool_calls`) — в т.ч. `hangup_call`, чтобы ассистент сам завершил звонок. Silence hard-timeout ~180с. Запись/стоимость/`/log` — как в inbound. Спекуляция НЕ используется (несовместима с tool-calling; endpointing и так быстрый). Один LLM-клиент. **Самодостаточен**: `VoxTurnTaking` встроен в сам файл (идемпотентно), поэтому работает и с одиночным правилом, и с цепочкой — `vox-turn-taking` в цепочке НЕ обязателен. |
| `cartesia_inbound.js` | `cartesia_inbound` | Входящий half-cascade на **OpenAI Realtime** (`gpt-realtime-2.1-mini`, output text): STT + turn detection + reasoning на стороне OpenAI (Silero/Pipecat не нужны), TTS — VoxTTS/Anna. Ключ — пользовательский (`CONFIG.api_key`). Одиночный сценарий (без цепочки vox-turn-taking). Несмотря на имя, TTS не Cartesia. |

## Раскатка (вручную)

1. На родительском аккаунте Voximplant обновить код сценариев `vox-turn-taking`,
   `inbound_cascade` и `outbound_cascade` содержимым этих файлов (имена — строго
   как в таблице).
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

## Как работает цепочка из двух сценариев в одном правиле

`AddRule`/`SetRuleInfo` принимают `scenario_id` списком (`"id1;id2"`).
Оба сценария загружаются в одну JS-сессию по порядку и делят глобальную
область видимости: первый объявляет `VoxTurnTaking`, второй его использует.
Правило при этом остаётся одно — модель «1 номер → 1 правило» не меняется.
Бекенд уже умеет это: `voximplant_partner.add_rule` (список → `;`),
`telephony.bind-assistant` (цепочка для cascade).

## Ограничения текущей версии

- TTS-провайдер поддержан только `voxtts` (Anna/Sergey); для ассистентов со
  старыми провайдерами (`yandex`/`tinkoff`/`sber`) сценарий пишет warning в лог
  и озвучивает VoxTTS/Anna.
- Кастомные функции (`functions`) вызываются и в **исходящем**
  (`outbound_cascade`), и во **входящем** (`inbound_cascade`) каскаде через
  tool-calling. Во входящем при включённых функциях отключается спекулятивная
  генерация (несовместима с tool-calling).
