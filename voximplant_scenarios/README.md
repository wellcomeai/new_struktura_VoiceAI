# Сценарии Voximplant (cascade + VoxTTS)

Код VoxEngine-сценариев для каскадного голосового ассистента:
встроенный ASR (YandexV3) → VoxTurnTaking (Silero VAD + Pipecat Smart Turn) →
OpenAI gpt-4o-mini (Responses API, стриминг) → VoxTTS (Anna/Sergey).

Сценарии живут на **родительском аккаунте Voximplant** и копируются на дочерние
аккаунты штатными админ-эндпоинтами. Этот каталог — источник правды для их кода.

## Файлы

| Файл | Имя сценария на Voximplant | Назначение |
|---|---|---|
| `vox-turn-taking.js` | `vox-turn-taking` | Хелпер turn-taking (эталонный код из документации Voximplant). Объявляет глобальный `VoxTurnTaking`, сам ничего не запускает. Должен стоять ПЕРВЫМ в цепочке правила. |
| `inbound_cascade.js` | `inbound_cascade` | Входящий каскад: конфиг с `/api/telephony/config`, ASR YandexV3, LLM gpt-4o-mini (ключ приходит из конфига = ENV `OPENAI_API_KEY` сервера), TTS VoxTTS, транскрипты в CRM. |

## Раскатка (вручную)

1. На родительском аккаунте Voximplant обновить код сценариев `vox-turn-taking`
   и `inbound_cascade` содержимым этих файлов (имена — строго как в таблице).
2. Раскатать на дочерние аккаунты:
   - `POST /api/telephony/admin/setup-cascade-scenarios` — копирует cascade-сценарии;
   - `POST /api/telephony/admin/deploy-turn-taking` — копирует хелпер и патчит
     inbound-правила cascade-номеров на цепочку `vox-turn-taking;inbound_cascade`.
3. Привязать cascade-ассистента к номеру (`POST /api/telephony/bind-assistant`,
   `assistant_type: "cascade"`) — бекенд сам создаст правило с цепочкой из двух
   сценариев.

## Как работает цепочка из двух сценариев в одном правиле

`AddRule`/`SetRuleInfo` принимают `scenario_id` списком (`"id1;id2"`).
Оба сценария загружаются в одну JS-сессию по порядку и делят глобальную
область видимости: первый объявляет `VoxTurnTaking`, второй его использует.
Правило при этом остаётся одно — модель «1 номер → 1 правило» не меняется.
Бекенд уже умеет это: `voximplant_partner.add_rule` (список → `;`),
`telephony.bind-assistant` (цепочка для cascade).

## Ограничения текущей версии

- Только входящие звонки (`outbound_cascade` — следующим шагом; его правило
  сейчас создаётся без хелпера в цепочке, перед включением исходящего каскада
  это нужно поправить в `admin/setup-cascade-scenarios`).
- TTS-провайдер поддержан только `voxtts` (Anna/Sergey); для ассистентов со
  старыми провайдерами (`yandex`/`tinkoff`/`sber`) сценарий пишет warning в лог
  и озвучивает VoxTTS/Anna.
- Кастомные функции ассистента (`functions`) в каскаде пока не вызываются.
