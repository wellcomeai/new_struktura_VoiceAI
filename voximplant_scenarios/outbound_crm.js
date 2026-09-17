/*
 * Voximplant OUTBOUND CRM Script v5.6 - Universal AI Agent
 * ============================================================================
 *
 * 🆕 v5.6 ИЗМЕНЕНИЯ (относительно v5.5) — ТОЛЬКО ВЕТКА GEMINI:
 * ✅ [Gemini] Поддержка Gemini 3.8 Live (вместе с 2.5 и 3.1) — по образцу
 *            inbound_gemini v8.0:
 *            - MODEL_VERSION ("2.5" | "3.1" | "3.8") вместо булева IS_31.
 *              IS_31 оставлен как производный флаг: на него завязаны ветки,
 *              где 3.8 ведёт себя как 2.5.
 *            - Версия определяется по подстроке в config.model, проверка 3.8
 *              идёт ПЕРВОЙ — иначе новая модель молча уехала бы в ветку 2.5
 *              и упала на thinkingBudget.
 *            - thinkingConfig: 2.5 → thinkingBudget:0 / 3.1 → thinkingLevel:
 *              "minimal" / 3.8 → поле НЕ отправляется вовсе (модель его не
 *              поддерживает, у неё interleaved reasoning; присланное поле
 *              валит сетап).
 *            - Runtime-текст («Алло», пинг тишины, farewell, GoAway, session
 *              warning): 3.1 → sendRealtimeInput / 2.5 и 3.8 → sendClientContent
 *              (в 3.8 client content снова разрешён на всём сеансе).
 *            - Финальный лог: gemini_model + model_version (is_31 оставлен
 *              как legacy-поле, бэкенд его уже знает).
 *            ⚠️ gemini-3.8-live-extended-thinking сюда НЕ подходит: у неё
 *              turnComplete не означает, что сессия свободна (нужен
 *              interaction_status), а на turnComplete у нас завязаны
 *              приветствие и таймеры тишины.
 *
 * ⚠️ Остальная логика ветки Gemini (PSTN после SetupComplete, mute-окно,
 *    симулированный «Алло», VAD, пинг 8с + хард 180с, Session TTL, GoAway)
 *    и ветки OpenAI / Cartesia / Yandex НЕ ИЗМЕНЕНЫ.
 *
 * Поддерживаемые модели Gemini (версия — по подстроке в config.model):
 *   - "gemini-2.5-flash-native-audio-preview-12-2025"        → "2.5"
 *   - "models/gemini-2.5-flash-native-audio-preview-12-2025" → "2.5"
 *   - "gemini-3.1-flash-live-preview"                        → "3.1"
 *   - "gemini-3.8-live"                                      → "3.8"
 *
 * v5.5 ИЗМЕНЕНИЯ (относительно v5.4) — ТОЛЬКО ВЕТКА GEMINI:
 * ✅ [Gemini] VAD TUNING: realtimeInputConfig.automaticActivityDetection
 *            (sensitivity HIGH/HIGH, prefixPaddingMs 100, silenceDurationMs 500)
 *            → быстрее детект конца реплики, меньше пауза перед ответом.
 * ✅ [Gemini] proactiveAudio — УДАЛЁН. Позволял модели "решить не отвечать"
 *            на шум/невнятную реплику → молчание 3-4с. НЕ ВОЗВРАЩАТЬ.
 * ✅ [Gemini] SILENCE SAFETY переработан (реализация из inbound v7.9):
 *            - Пинг 8с: ассистент сам подаёт голос при тишине клиента.
 *              Отсчёт стартует ТОЛЬКО после реального окончания аудио
 *              (WebSocketMediaEnded); флаг geminiAudioPlaying блокирует
 *              пинг, пока ассистент говорит.
 *            - Хард-таймаут 180с (вместо общих 20с — которые с якорем на
 *              транскрипции могли оборвать звонок ПОСРЕДИ речи ассистента:
 *              транскрипция приходит на 10+ сек раньше конца аудио).
 *            - outputTranscription больше НЕ сбрасывает таймер тишины.
 * ✅ [Gemini] SESSION TTL: предупреждение на 9-й минуте, завершение на 10-й
 *            (сессия Gemini Live живёт ~10 минут — раньше был внезапный обрыв).
 * ✅ [Gemini] GoAway handling: предупреждение о завершении сессии.
 * ✅ [Gemini] vad_config в финальном логе (для A/B аналитики, как в
 *            специализированных inbound v7.9 / outbound v5.3).
 *
 * ⚠️ Ветки OpenAI / Cartesia / Yandex НЕ ИЗМЕНЕНЫ: общий хард-таймаут
 *    тишины 20с работает для них как в v5.4 (у Yandex сброс уже корректно
 *    привязан к MediaEnded).
 *
 * v5.4 ИЗМЕНЕНИЯ (относительно v5.3):
 * ✅ [NEW] Четвёртый провайдер: 🟡 YANDEX (Yandex Realtime API)
 *          Логика перенесена из отработанного outbound_yandex v1.1.
 *
 *   Особенности ветки yandex (отличаются от остальных провайдеров):
 *   - PSTN набирается ТОЛЬКО после SessionCreated (retry ×3 × 3с).
 *     Если Yandex не поднялся — звонок не совершается → 0₽ потерь.
 *   - Greeting стартует по CallEvents.Connected + YANDEX_GREETING_DELAY_MS
 *     (500мс на подъём RTP). НЕ ждём FirstAudioPacketReceived — при early
 *     media оно приходит ДО Connected и как признак готовности бесполезно.
 *   - Микрофон клиента замьючен до ФАКТИЧЕСКОГО конца приветствия
 *     (WebSocketMediaEnded), а не на фиксированный MUTE_DURATION.
 *     MUTE_DURATION в ветке yandex ИГНОРИРУЕТСЯ.
 *   - Tools подключаются вторым sessionUpdate ПОСЛЕ приветствия
 *     (нет утечки tool-токенов в TTS на первой фразе).
 *   - Двойной якорь первой фразы: декларативно в промпте + responseCreate.
 *     sanitizeGreeting() чистит фразу от кавычек и мета-префиксов.
 *   - Greeting retry ×2 по 7с → тихий hangup (без TTS-извинений).
 *   - hangup_call: function_call_output → responseCreate(прощание) →
 *     WebSocketMediaEnded → hangup (+ safety-таймаут 8с).
 *
 * ✅ [yandex] Silence hard-timeout — общий SILENCE_TIMEOUT_MS (20с), как у всех.
 * ✅ [yandex] Payload лога: provider: "yandex" + crm_context (бэкенд понимает оба).
 * ✅ [yandex] Подстановка имени в приветствие (общая логика) → затем sanitize.
 *
 * v5.3: [ALL] Хард-таймаут тишины 20с.
 * v5.2: [Gemini] Gemini 3.1 (IS_31), sendRuntimeText(), retry ×1.
 * v5.1: [Gemini] Приветствие через симулированный "Алло"; PSTN после SetupComplete.
 *
 * UNIFIED скрипт для ВСЕХ типов ассистентов:
 *   🟢 Gemini   — Gemini 2.5 / 3.1 / 3.8 Live Native Audio (STT + LLM + TTS)
 *   🔵 OpenAI   — OpenAI Realtime API (STT + LLM + TTS)
 *   🟠 Cartesia — OpenAI Realtime (STT + LLM text-only) + Cartesia TTS
 *   🟡 Yandex   — Yandex Realtime API (STT + LLM + TTS)
 *
 * ✅ CRM контекст (contact_name, task_title, task_description, custom_greeting)
 * ✅ Structured dialog (dialogLog[])
 * ✅ Dynamic config from /api/telephony/outbound-config
 * ✅ Function calls
 * ✅ Call recording + billing (GetCallHistory API)
 * ✅ Client microphone mute on connect
 * ✅ Персонализация приветствия
 * ✅ Silence safety: Gemini — пинг 8с + хард 180с (по MediaEnded);
 *    остальные провайдеры — хард 20с
 *
 * ============================================================================
 */

require(Modules.Gemini);
require(Modules.OpenAI);
require(Modules.Cartesia);
require(Modules.Yandex);

// ── Глобальные переменные биллинга ──
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;

// ══════════════════════════════════════════════════════════════════════════
// v5.4: САНИТИЗАЦИЯ ПЕРВОЙ ФРАЗЫ (из yandex v1.1)
// Срезаем мета-префиксы ("Скажи дословно:", "Произнеси фразу:") и
// обрамляющие кавычки, которые могли просочиться из конфига/CRM.
// Без этого модель может ОЗВУЧИТЬ служебную инструкцию вслух.
// ══════════════════════════════════════════════════════════════════════════
function sanitizeGreeting(raw) {
    if (!raw) return "";
    var s = String(raw).trim();

    // Срезаем мета-префиксы (могут идти подряд в любом порядке)
    var prev = "";
    while (prev !== s) {
        prev = s;
        s = s.replace(/^(повтори(те)?\s+дословно\s*)/i, "");
        s = s.replace(/^(произнеси(те)?\s+(фразу|текст)\s*)/i, "");
        s = s.replace(/^(скажи(те)?\s+(фразу|текст|дословно)\s*)/i, "");
        s = s.replace(/^[:,\-—]\s*/, "");
        s = s.trim();
    }

    // Срезаем обрамляющие кавычки всех видов (могут быть вложенными)
    prev = "";
    while (prev !== s) {
        prev = s;
        s = s.replace(/^["'«„“”‚]+/, "").replace(/["'»“”‛]+$/, "").trim();
    }

    // Убираем ВНУТРЕННИЕ кавычки и переводы строк
    s = s.replace(/["«»„“”]/g, "").replace(/[\r\n]+/g, " ");

    // Схлопываем множественные пробелы
    s = s.replace(/\s{2,}/g, " ").trim();

    return s;
}

VoxEngine.addEventListener(AppEvents.Started, async function(e) {
    call_session_history_id = e.sessionId;

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (OUTBOUND CRM v5.6 — Gemini 2.5/3.1/3.8 / OpenAI / Cartesia / Yandex)");
    Logger.write("🔑 Session History ID: " + call_session_history_id);
    Logger.write("🆕 v5.6: Gemini branch — 3.8 Live support (MODEL_VERSION, no thinkingConfig for 3.8)");
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── Общие переменные ──
    var aiClient = null;
    var cartesiaPlayer = null;
    var call = null;
    var isHangingUp = false;
    var call_id = null;
    var assistantType = "gemini";

    // ══════════════════════════════════════════════════════════════════════
    // 🆕 v5.6: ВЕРСИЯ МОДЕЛИ GEMINI (определяется после загрузки конфига)
    // MODEL_VERSION: "2.5" | "3.1" | "3.8"
    // IS_31 — производный флаг (только для 3.1-специфичных веток:
    // sendRealtimeInput, thinkingLevel). 3.8 ведёт себя как 2.5.
    // ══════════════════════════════════════════════════════════════════════
    var MODEL_VERSION = "2.5";
    var IS_31 = false;

    // v5.1: Флаги синхронизации для Gemini
    var geminiReady = false;
    var callConnected = false;
    var greetingTriggered = false;

    // v5.2: Retry механизм для Gemini
    var geminiRetryCount = 0;
    var MAX_GEMINI_RETRIES = 1;
    var GEMINI_INIT_TIMEOUT = 8000;
    var geminiInitTimer = null;

    // v5.3: Хард-таймаут тишины для OpenAI / Cartesia / Yandex (без пинга)
    var SILENCE_TIMEOUT_MS = 20000;   // 20 сек тишины на линии → обрыв (НЕ gemini)
    var silenceTimeoutId = null;

    // ══════════════════════════════════════════════════════════════════════
    // 🆕 v5.5: ПАРАМЕТРЫ GEMINI — VAD + SILENCE SAFETY + SESSION TTL
    // (перенос отработанной логики из inbound v7.9 / outbound v5.3)
    // ══════════════════════════════════════════════════════════════════════
    var VAD_PREFIX_PADDING_MS = 100;          // фильтр коротких шумов на старте речи
    var VAD_SILENCE_DURATION_MS = 500;        // тишина до "конец реплики клиента"

    var GEMINI_SILENCE_PING_MS = 8000;        // пинг после 8с тишины (отсчёт ПОСЛЕ MediaEnded)
    var GEMINI_SILENCE_TIMEOUT_MS = 180000;   // хард-обрыв после 180с тишины
    var GEMINI_SESSION_WARNING_MS = 9 * 60 * 1000;  // предупреждение о конце сессии
    var GEMINI_SESSION_MAX_MS = 10 * 60 * 1000;     // TTL сессии Gemini Live

    // 🆕 v5.5: Флаг — играет ли сейчас аудио ассистента (только gemini).
    // true между WebSocketMediaStarted и WebSocketMediaEnded.
    // Пока true — пинг тишины НЕ взводится и НЕ срабатывает.
    var geminiAudioPlaying = false;

    // 🆕 v5.5: Таймеры gemini safety
    var silencePingTimeoutId = null;
    var sessionWarningTimeoutId = null;
    var sessionMaxTimeoutId = null;

    // ══════════════════════════════════════════════════════════════════════
    // v5.4: КОНСТАНТЫ И ФЛАГИ YANDEX
    // ══════════════════════════════════════════════════════════════════════
    var YANDEX_SETUP_TIMEOUT_MS = 3000;      // ожидание SessionCreated на попытку
    var YANDEX_MAX_RETRY_ATTEMPTS = 3;       // попыток подключения к Yandex
    var YANDEX_MAX_GREETING_ATTEMPTS = 2;    // попыток приветствия
    var YANDEX_GREETING_TIMEOUT_MS = 7000;   // ожидание начала речи ассистента
    var YANDEX_GREETING_DELAY_MS = 500;      // ⭐ пауза Connected → greeting
                                             //    (подъём RTP; НЕ ждём FirstAudioPacketReceived)
    var YANDEX_HANGUP_SAFETY_MS = 8000;      // если WebSocketMediaEnded не пришёл после hangup_call
    var YANDEX_DEFAULT_MODEL = "speech-realtime-260528";
    var YANDEX_DEFAULT_VOICE = "marina";
    var YANDEX_DEFAULT_VAD_THRESHOLD = 0.5;
    var YANDEX_DEFAULT_VAD_SILENCE_MS = 500;

    var yandexTools = [];
    var yandexGreetingAttempt = 0;
    var yandexAssistantSpeaking = false;   // ассистент начал говорить приветствие
    var yandexGreetingStarted = false;     // greeting-триггер уже отправлялся
    var yandexGreetingLogged = false;      // фейковый "Алло" добавлен в dialogLog
    var yandexDuplexActive = false;        // полный дуплекс открыт
    var yandexHangupRequested = false;     // hangup_call вызван — ждём конца прощания
    var yandexToolsAttached = false;       // tools подключены вторым sessionUpdate
    var yandexGreetingTimeoutId = null;
    var yandexGreetingDelayId = null;
    var yandexHangupSafetyId = null;
    var yandexActualModel = null;
    var YANDEX_MODEL = "";
    var YANDEX_VOICE = "";

    // Для Cartesia
    var isInterrupted = false;
    var sessionStarted = false;
    var cartesiaContextId = "vox_" + Math.random().toString(36).substring(2, 11);

    // Для OpenAI
    var greetingPlayed = false;

    // Для Gemini — streaming буферы
    var currentUserText = "";
    var currentAssistantText = "";
    var lastRole = null;
    var isFirstGeminiMessage = true;

    // Общие буферы
    var userMessageBuffer = "";
    var assistantMessageBuffer = "";
    var dialogLog = [];
    var lastFunctionResult = null;
    var logCounter = 0;
    var functionNameToIdMap = {};

    // ── Парсим customData ──
    var callData;
    try {
        callData = JSON.parse(VoxEngine.customData());
    } catch (err) {
        Logger.write("❌ Failed to parse custom data: " + err);
        VoxEngine.terminate();
        return;
    }

    var PHONE_NUMBER = callData.phone_number;
    var ASSISTANT_ID = callData.assistant_id;
    var CALLER_ID = callData.caller_id || "+1234567890";
    var MUTE_DURATION = callData.mute_duration_ms !== undefined ? callData.mute_duration_ms : 3000;
    var CONTACT_NAME = callData.contact_name || "";
    var TASK_TITLE = callData.task_title || "";
    var TASK_DESCRIPTION = callData.task_description || "";
    var CUSTOM_GREETING = callData.custom_greeting || "";
    var TIMEZONE = callData.timezone || "Europe/Moscow";
    var API_TASK = callData.task || "";

    if (!PHONE_NUMBER || !ASSISTANT_ID) {
        Logger.write("❌ Missing phone_number or assistant_id");
        VoxEngine.terminate();
        return;
    }

    var caller_number = "OUTBOUND: " + PHONE_NUMBER;
    var chat_id = "vox_" + Math.random().toString(36).substring(2, 15);

    var LOG_URL = "https://voicyfy.ru/api/voximplant/log";
    var FUNCTIONS_URL = "https://voicyfy.ru/api/voximplant/functions/execute";

    // ── Тип звонка (для логов/бэкенда) ──
    var isCrmCall = !!(CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION);
    var hasApiTask = !!API_TASK;
    var callType = "API";
    if (isCrmCall && hasApiTask)      callType = "CRM+Task";
    else if (isCrmCall)               callType = "CRM";
    else if (hasApiTask)              callType = "API+Task";

    // ══════════════════════════════════════════════════════════════════════════
    // УТИЛИТЫ
    // ══════════════════════════════════════════════════════════════════════════

    function getCurrentDateTime(timezone) {
        var days = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
        var months = ['января','февраля','марта','апреля','мая','июня',
                      'июля','августа','сентября','октября','ноября','декабря'];
        var tzShort = {
            'Europe/Moscow':'МСК','Europe/Kaliningrad':'КЛГ','Europe/Samara':'СМР',
            'Asia/Yekaterinburg':'ЕКБ','Asia/Omsk':'ОМС','Asia/Krasnoyarsk':'КРС',
            'Asia/Irkutsk':'ИРК','Asia/Yakutsk':'ЯКТ','Asia/Vladivostok':'ВЛД',
            'Asia/Magadan':'МГД','Asia/Kamchatka':'КАМ'
        };
        var tzOff = {
            'Europe/Kaliningrad':2,'Europe/Moscow':3,'Europe/Samara':4,
            'Asia/Yekaterinburg':5,'Asia/Omsk':6,'Asia/Krasnoyarsk':7,
            'Asia/Irkutsk':8,'Asia/Yakutsk':9,'Asia/Vladivostok':10,
            'Asia/Magadan':11,'Asia/Kamchatka':12
        };
        try {
            var now = new Date();
            var off = tzOff[timezone] || 3;
            var ld = new Date(now.getTime() + off * 3600000);
            var tz = tzShort[timezone] || timezone;
            return ld.getUTCDate() + " " + months[ld.getUTCMonth()] + " " + ld.getUTCFullYear() +
                   ", " + days[ld.getUTCDay()] + ", " +
                   String(ld.getUTCHours()).padStart(2,'0') + ":" +
                   String(ld.getUTCMinutes()).padStart(2,'0') + " (" + tz + ")";
        } catch(e) { return new Date().toISOString(); }
    }

    var currentDateTime = getCurrentDateTime(TIMEZONE);

    // ── Логирование параметров ──
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("📞 OUTBOUND CRM v5.6");
    Logger.write("   🎯 Target: " + PHONE_NUMBER);
    Logger.write("   📱 Caller ID: " + CALLER_ID);
    Logger.write("   🤖 Assistant: " + ASSISTANT_ID);
    Logger.write("   🔇 Mute: " + MUTE_DURATION + "ms");
    Logger.write("   ⏱️ Silence: gemini → ping " + (GEMINI_SILENCE_PING_MS / 1000) + "s + hard " + (GEMINI_SILENCE_TIMEOUT_MS / 1000) + "s | others → hard " + (SILENCE_TIMEOUT_MS / 1000) + "s");
    Logger.write("   📅 DateTime: " + currentDateTime);
    Logger.write("   📋 Call type: " + callType);
    Logger.write("───────────────────────────────────────");
    Logger.write("📋 CRM:");
    Logger.write("   👤 Contact: " + (CONTACT_NAME || "—"));
    Logger.write("   📋 Task: " + (TASK_TITLE || "—"));
    Logger.write("   📝 Desc: " + (TASK_DESCRIPTION ? TASK_DESCRIPTION.substring(0,80) : "—"));
    Logger.write("   💬 Greeting: " + (CUSTOM_GREETING ? CUSTOM_GREETING.substring(0,80) : "—"));
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ══════════════════════════════════════════════════════════════════════════
    // 🆕 v5.5: ТАЙМЕРЫ ТИШИНЫ — РАЗДЕЛЕНИЕ ПО ПРОВАЙДЕРАМ
    //
    // GEMINI (реализация из inbound v7.9):
    //   - Пинг 8с: взводится ТОЛЬКО в фазе разговора (callConnected &&
    //     !isFirstGeminiMessage) и ТОЛЬКО когда аудио ассистента не играет.
    //     Честный отсчёт стартует на WebSocketMediaEnded.
    //   - Хард-таймаут 180с: всегда в фазе звонка.
    //   - ВАЖНО: outputTranscription НЕ сбрасывает таймер (транскрипция
    //     приходит на 10+ сек раньше конца аудио — с якорем на ней старые
    //     20с могли оборвать звонок посреди речи ассистента).
    //
    // OPENAI / CARTESIA / YANDEX — без изменений (v5.3): хард 20с,
    //   перезапуск при любой активности. У Yandex сброс уже корректно
    //   привязан к MediaEnded.
    // ══════════════════════════════════════════════════════════════════════════
    function resetSilenceTimer() {
        if (isHangingUp) return;
        if (silenceTimeoutId) { clearTimeout(silenceTimeoutId); silenceTimeoutId = null; }

        if (assistantType === "gemini") {
            if (silencePingTimeoutId) { clearTimeout(silencePingTimeoutId); silencePingTimeoutId = null; }

            // Пинг — только в фазе разговора и только в реальной тишине
            if (callConnected && !isFirstGeminiMessage && !geminiAudioPlaying) {
                silencePingTimeoutId = setTimeout(function() {
                    // double-check: если аудио вдруг играет — пинг пропускаем,
                    // перезапуск придёт на ближайшем MediaEnded
                    if (!isHangingUp && callConnected && !geminiAudioPlaying) {
                        Logger.write("🔔 SILENCE PING: клиент молчит " + (GEMINI_SILENCE_PING_MS / 1000) + "с после конца аудио, подаём голос");
                        sendRuntimeText("Произнеси вслух короткую фразу, чтобы проверить, на связи ли собеседник, например: Алло, вы меня слышите?");
                    } else {
                        Logger.write("🔕 Ping skipped: assistant audio is playing");
                    }
                }, GEMINI_SILENCE_PING_MS);
            }

            // Хард-таймаут — всегда
            silenceTimeoutId = setTimeout(function() {
                Logger.write("⏱️ SILENCE TIMEOUT (gemini): " + (GEMINI_SILENCE_TIMEOUT_MS / 1000) + "s — terminating");
                terminateCall();
            }, GEMINI_SILENCE_TIMEOUT_MS);

        } else {
            // OpenAI / Cartesia / Yandex — как в v5.4
            silenceTimeoutId = setTimeout(function() {
                Logger.write("⏱️ SILENCE TIMEOUT: " + (SILENCE_TIMEOUT_MS / 1000) + "s — terminating");
                terminateCall();
            }, SILENCE_TIMEOUT_MS);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ФИНАЛИЗАЦИЯ GEMINI STREAMING TURN
    // ══════════════════════════════════════════════════════════════════════════
    function finalizeGeminiTurns() {
        if (currentUserText.trim()) {
            dialogLog.push({ role: "user", text: currentUserText.trim(), ts: Date.now() });
            currentUserText = "";
        }
        if (currentAssistantText.trim()) {
            dialogLog.push({ role: "assistant", text: currentAssistantText.trim(), ts: Date.now() });
            currentAssistantText = "";
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CARTESIA HELPERS
    // ══════════════════════════════════════════════════════════════════════════
    function stopCartesia() {
        if (cartesiaPlayer) {
            try {
                if (typeof cartesiaPlayer.clearBuffer === "function") cartesiaPlayer.clearBuffer();
                cartesiaPlayer.stop();
            } catch(e) {}
            cartesiaPlayer = null;
        }
    }

    var activeConfig = null;

    function sendToCartesia(text) {
        if (!text || !text.trim() || isInterrupted || !activeConfig) return;
        Logger.write("[Cartesia] → \"" + text.substring(0,80) + "\"");
        stopCartesia();
        try {
            cartesiaPlayer = Cartesia.createRealtimeTTSPlayer(text, {
                apiKey: activeConfig.cartesia_api_key,
                progressive: false,
                generationRequestParameters: {
                    model_id: "sonic-3",
                    language: activeConfig.language || "ru",
                    voice: { mode: "id", id: activeConfig.cartesia_voice_id },
                    generation_config: { speed: activeConfig.voice_speed || 0.8 },
                    context_id: cartesiaContextId,
                    continue: false
                }
            });
            cartesiaPlayer.sendMediaTo(call);
            cartesiaPlayer.addEventListener(PlayerEvents.Started, function() {
                Logger.write("[Cartesia] ▶ Playing");
            });
            cartesiaPlayer.addEventListener(PlayerEvents.PlaybackFinished, function(ev) {
                if (ev.error) Logger.write("[Cartesia] ❌ " + ev.error);
                else Logger.write("[Cartesia] ✅ Done");
            });
        } catch(err) {
            Logger.write("[Cartesia] Failed: " + err);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ЛОГИРОВАНИЕ
    // ══════════════════════════════════════════════════════════════════════════
    async function sendConversationLog(isFinal) {
        try {
            logCounter++;
            var payload = {
                assistant_id: ASSISTANT_ID,
                chat_id: chat_id,
                call_id: call_id || "unknown",
                caller_number: caller_number,
                type: "conversation",
                provider: assistantType,
                call_type: callType,
                crm_context: {
                    contact_name: CONTACT_NAME,
                    task_title: TASK_TITLE,
                    task_description: TASK_DESCRIPTION
                },
                data: {
                    user_message: userMessageBuffer,
                    assistant_message: assistantMessageBuffer,
                    function_result: lastFunctionResult,
                    dialog: dialogLog
                }
            };

            if (isFinal) {
                if (record_url) payload.record_url = record_url;
                if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);
                payload.call_cost = call_cost;
                payload.call_duration = call_duration;
                if (assistantType === "yandex") {
                    payload.greeting_attempts = yandexGreetingAttempt;
                    payload.yandex_model = yandexActualModel || YANDEX_MODEL;
                }
                // 🆕 v5.5: VAD-параметры gemini в финальном логе для A/B аналитики
                // 🆕 v5.6: + gemini_model / model_version (is_31 — legacy-поле)
                if (assistantType === "gemini") {
                    payload.gemini_model = GEMINI_MODEL;
                    payload.model_version = MODEL_VERSION;
                    payload.is_31 = IS_31;
                    payload.vad_config = {
                        prefix_padding_ms: VAD_PREFIX_PADDING_MS,
                        silence_duration_ms: VAD_SILENCE_DURATION_MS,
                        start_sensitivity: "HIGH",
                        end_sensitivity: "HIGH",
                        proactive_audio: false
                    };
                }
            }

            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("📤 SENDING LOG #" + logCounter + (isFinal ? " (FINAL)" : ""));
            Logger.write("   👤 User (" + userMessageBuffer.length + " chars): " + userMessageBuffer.substring(0,80) + "...");
            Logger.write("   🤖 Assistant (" + assistantMessageBuffer.length + " chars): " + assistantMessageBuffer.substring(0,80) + "...");
            Logger.write("   📝 Dialog turns: " + dialogLog.length);
            if (record_url) Logger.write("   🎙️ Record URL: " + record_url.substring(0,60) + "...");
            if (call_session_history_id) Logger.write("   🔑 Session History ID: " + call_session_history_id);
            if (isFinal) {
                Logger.write("   💰 Fallback Cost: " + call_cost);
                Logger.write("   ⏱️ Duration: " + call_duration + "s");
                if (assistantType === "gemini") Logger.write("   🤖 Model: " + GEMINI_MODEL + " (version=" + MODEL_VERSION + ")");
                if (assistantType === "yandex") Logger.write("   👋 Greeting attempts: " + yandexGreetingAttempt);
            }
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            var resp = await Net.httpRequestAsync(LOG_URL, {
                headers: ["Content-Type: application/json"],
                method: "POST",
                postData: JSON.stringify(payload)
            });

            Logger.write("📡 Response: HTTP " + resp.code);

            if (resp.code == 200) {
                Logger.write("✅ Log #" + logCounter + " sent successfully");
                try {
                    var rd = JSON.parse(resp.text);
                    if (rd.saved !== undefined) Logger.write("   📊 Saved: DB=" + rd.saved + ", Sheets=" + (rd.sheets_saved || false));
                    if (rd.dialog_turns_saved) Logger.write("   📝 Dialog turns saved: " + rd.dialog_turns_saved);
                    if (rd.cost_breakdown) {
                        Logger.write("   💰 Cost source: " + (rd.cost_breakdown.source || "unknown"));
                        Logger.write("   💰 Final cost: " + (rd.cost_breakdown.total_cost || call_cost));
                    }
                } catch(e) {}
                if (isFinal) {
                    userMessageBuffer = "";
                    assistantMessageBuffer = "";
                    lastFunctionResult = null;
                }
            } else {
                Logger.write("❌ Log failed: HTTP " + resp.code);
            }
        } catch(err) {
            Logger.write("❌ Log error: " + err);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ЗАВЕРШЕНИЕ ЗВОНКА
    // ══════════════════════════════════════════════════════════════════════════
    var terminateCall = async function() {
        if (isHangingUp) return;
        isHangingUp = true;

        if (geminiInitTimer) {
            clearTimeout(geminiInitTimer);
            geminiInitTimer = null;
        }

        // v5.3: гасим таймер тишины, чтобы он не выстрелил повторно после обрыва
        if (silenceTimeoutId) {
            clearTimeout(silenceTimeoutId);
            silenceTimeoutId = null;
        }

        // 🆕 v5.5: гасим gemini safety-таймеры
        if (silencePingTimeoutId)    { clearTimeout(silencePingTimeoutId);    silencePingTimeoutId = null; }
        if (sessionWarningTimeoutId) { clearTimeout(sessionWarningTimeoutId); sessionWarningTimeoutId = null; }
        if (sessionMaxTimeoutId)     { clearTimeout(sessionMaxTimeoutId);     sessionMaxTimeoutId = null; }

        // v5.4: гасим таймеры Yandex
        if (yandexGreetingTimeoutId) { clearTimeout(yandexGreetingTimeoutId); yandexGreetingTimeoutId = null; }
        if (yandexGreetingDelayId)   { clearTimeout(yandexGreetingDelayId);   yandexGreetingDelayId = null; }
        if (yandexHangupSafetyId)    { clearTimeout(yandexHangupSafetyId);    yandexHangupSafetyId = null; }

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("📴 Terminating outbound call...");
        Logger.write("   Target was: " + caller_number);
        Logger.write("   Provider: " + assistantType);
        Logger.write("   Call type was: " + callType);
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        if (assistantType === "gemini") finalizeGeminiTurns();

        if (aiClient) { try { aiClient.close(); } catch(e) {} }
        stopCartesia();
        if (call) { try { call.stopRecord(); } catch(e) {} }

        await new Promise(function(r) { setTimeout(r, 500); });

        try {
            if (call) {
                if (typeof call.cost === "function") {
                    var c = call.cost(); if (c && call_cost === 0) call_cost = c;
                }
                if (typeof call.duration === "function") {
                    var d = call.duration(); if (d && call_duration === 0) call_duration = d;
                }
            }
        } catch(e) {}

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("💰 BILLING INFO (v5.6):");
        Logger.write("   🔑 Session History ID: " + (call_session_history_id || "NONE"));
        Logger.write("   🤖 Provider: " + assistantType);
        if (assistantType === "gemini") Logger.write("   🤖 Model: " + GEMINI_MODEL + " (version=" + MODEL_VERSION + ")");
        if (assistantType === "yandex") {
            Logger.write("   🤖 Model: " + YANDEX_MODEL + " | actual: " + (yandexActualModel || "n/a"));
            Logger.write("   👋 Greeting attempts: " + yandexGreetingAttempt);
            Logger.write("   🔧 Tools attached: " + yandexToolsAttached);
        }
        Logger.write("   💰 Fallback Cost: " + call_cost);
        Logger.write("   ⏱️ Duration: " + call_duration + "s");
        Logger.write("   🎙️ Record URL: " + (record_url ? "YES" : "NO"));
        Logger.write("   📝 Dialog turns: " + dialogLog.length);
        Logger.write("   🔄 Gemini retries used: " + geminiRetryCount);
        Logger.write("   ✅ Full cost will be fetched via GetCallHistory API");
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        if (userMessageBuffer || assistantMessageBuffer || call_session_history_id || dialogLog.length > 0) {
            Logger.write("📤 Sending final log before terminate...");
            try {
                await sendConversationLog(true);
                Logger.write("✅ Final log sent successfully");
            } catch(err) {
                Logger.write("❌ Final log error: " + err);
            }
        }

        if (call) { try { call.hangup(); } catch(e) {} }
        setTimeout(function() {
            Logger.write("✅ Outbound call terminated - Total logs: " + logCounter);
            VoxEngine.terminate();
        }, 500);
    };

    // ══════════════════════════════════════════════════════════════════════════
    // ОБРАБОТКА FUNCTION CALLS — GEMINI
    // ══════════════════════════════════════════════════════════════════════════

    async function handleGeminiFunctionCall(callId, functionName, args) {
        try {
            Logger.write("🔧 [Gemini] FUNCTION: " + functionName);

            if (functionName === "hangup_call") {
                Logger.write("📴 HANGUP requested by AI");
                if (args.farewell_message) {
                    Logger.write("   💬 Farewell: " + args.farewell_message);
                    sendRuntimeText('Скажи с эмоцией: "' + args.farewell_message + '"');
                    setTimeout(function() { terminateCall(); }, 3000);
                } else {
                    terminateCall();
                }
                aiClient.sendToolResponse({
                    functionResponses: [{ id: callId, name: functionName, response: { output: "Call terminated" } }]
                });
                return;
            }

            var function_id = functionNameToIdMap[functionName];
            if (!function_id) {
                Logger.write("❌ Unknown function: " + functionName);
                aiClient.sendToolResponse({
                    functionResponses: [{ id: callId, name: functionName, response: { output: "Error: unknown function" } }]
                });
                return;
            }

            var cleanArgs = Object.assign({}, args);
            delete cleanArgs.function_id;

            var resp = await Net.httpRequestAsync(FUNCTIONS_URL, {
                headers: ["Content-Type: application/json"],
                method: "POST",
                postData: JSON.stringify({
                    function_id: function_id,
                    arguments: Object.assign({}, cleanArgs, { assistant_id: ASSISTANT_ID }),
                    call_data: {
                        call_id: call_id,
                        chat_id: chat_id,
                        assistant_id: ASSISTANT_ID,
                        caller_number: caller_number,
                        contact_name: CONTACT_NAME,
                        task_title: TASK_TITLE
                    }
                })
            });

            if (resp.code == 200) {
                var result = JSON.parse(resp.text);
                Logger.write("✅ Function OK: " + functionName);
                lastFunctionResult = result;
                aiClient.sendToolResponse({
                    functionResponses: [{ id: callId, name: functionName, response: { output: JSON.stringify(result) } }]
                });
            } else {
                Logger.write("❌ Function HTTP " + resp.code);
                aiClient.sendToolResponse({
                    functionResponses: [{ id: callId, name: functionName, response: { output: "Error: HTTP " + resp.code } }]
                });
            }
        } catch(err) {
            Logger.write("❌ Function error: " + err);
            try {
                aiClient.sendToolResponse({
                    functionResponses: [{ id: callId, name: functionName, response: { output: "Error: " + err } }]
                });
            } catch(e) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ОБРАБОТКА FUNCTION CALLS — OPENAI / CARTESIA
    // ══════════════════════════════════════════════════════════════════════════

    async function handleOpenAIFunctionCall(item) {
        try {
            var functionName = item.name;
            var args = JSON.parse(item.arguments);
            var callId = item.call_id;

            Logger.write("🔧 [" + assistantType + "] FUNCTION: " + functionName);

            if (functionName === "hangup_call") {
                Logger.write("📴 HANGUP requested");
                lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
                if (args.farewell_message) {
                    if (assistantType === "cartesia") {
                        sendToCartesia(args.farewell_message);
                    } else {
                        aiClient.responseCreate({ instructions: 'Скажи: "' + args.farewell_message + '"' });
                    }
                    setTimeout(function() { call.hangup(); }, 3000);
                } else {
                    call.hangup();
                }
                return;
            }

            var function_id = functionNameToIdMap[functionName];
            if (!function_id) {
                Logger.write("❌ Unknown function: " + functionName);
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "Unknown" }) }
                });
                aiClient.responseCreate();
                return;
            }

            var resp = await Net.httpRequestAsync(FUNCTIONS_URL, {
                headers: ["Content-Type: application/json"],
                method: "POST",
                postData: JSON.stringify({
                    function_id: function_id,
                    arguments: Object.assign({}, args, { function_id: function_id }),
                    call_data: {
                        call_id: call_id,
                        chat_id: chat_id,
                        assistant_id: ASSISTANT_ID,
                        caller_number: caller_number,
                        contact_name: CONTACT_NAME,
                        task_title: TASK_TITLE
                    }
                })
            });

            if (resp.code == 200) {
                var result = JSON.parse(resp.text);
                Logger.write("✅ Function OK: " + functionName);
                lastFunctionResult = result;
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) }
                });
            } else {
                Logger.write("❌ Function HTTP " + resp.code);
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "Failed" }) }
                });
            }
            aiClient.responseCreate();
        } catch(err) {
            Logger.write("❌ Function error: " + err);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v5.4: ОБРАБОТКА FUNCTION CALLS — YANDEX
    // Протокол: function_call_output → ОБЯЗАТЕЛЬНЫЙ responseCreate.
    // hangup_call: прощание доигрывает → WebSocketMediaEnded → terminate.
    // ══════════════════════════════════════════════════════════════════════════
    async function handleYandexFunctionCall(callId, functionName, argumentsStr) {
        try {
            var args = {};
            try { args = argumentsStr ? JSON.parse(argumentsStr) : {}; } catch (err) {}

            Logger.write("🔧 [Yandex] FUNCTION: " + functionName + " | Args: " + JSON.stringify(args).substring(0, 200));

            // ─────────────── hangup_call — локально ───────────────
            if (functionName === "hangup_call") {
                Logger.write("📴 HANGUP" + (args.farewell_message ? ": " + args.farewell_message : ""));

                lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
                yandexHangupRequested = true;

                aiClient.conversationItemCreate({
                    item: {
                        type: "function_call_output",
                        call_id: callId,
                        output: "Ok, call will be terminated after farewell"
                    }
                });

                // Прощание без обрамляющих кавычек
                var farewellText = sanitizeGreeting(args.farewell_message);
                var farewellInstruction = farewellText
                    ? "Скажи дословно следующий текст и больше ничего:\n\n" + farewellText
                    : "Коротко и вежливо попрощайся с собеседником.";
                aiClient.responseCreate({ instructions: farewellInstruction });

                // Основной путь: WebSocketMediaEnded → terminate. Safety net:
                yandexHangupSafetyId = setTimeout(function() {
                    Logger.write("⏱️ Hangup safety timeout → terminating");
                    terminateCall();
                }, YANDEX_HANGUP_SAFETY_MS);
                return;
            }

            // ─────────────── Функции через бэкенд voicyfy ───────────────
            var cleanArgs = Object.assign({}, args);
            var function_id = cleanArgs.function_id || functionNameToIdMap[functionName];
            delete cleanArgs.function_id;

            if (!function_id) {
                Logger.write("❌ No function_id for: " + functionName);
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "Function ID not found" }) }
                });
                aiClient.responseCreate({});
                return;
            }

            var resp = await Net.httpRequestAsync(FUNCTIONS_URL, {
                headers: ["Content-Type: application/json"],
                method: "POST",
                postData: JSON.stringify({
                    function_id: function_id,
                    arguments: Object.assign({}, cleanArgs, { assistant_id: ASSISTANT_ID }),
                    call_data: {
                        call_id: call_id,
                        chat_id: chat_id,
                        assistant_id: ASSISTANT_ID,
                        caller_number: caller_number,
                        contact_name: CONTACT_NAME,
                        task_title: TASK_TITLE
                    }
                })
            });

            if (resp.code == 200) {
                var result = JSON.parse(resp.text);
                Logger.write("✅ Function OK: " + functionName + " | " + JSON.stringify(result).substring(0, 200));
                lastFunctionResult = result;
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) }
                });
            } else {
                Logger.write("❌ Function HTTP " + resp.code);
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "HTTP " + resp.code }) }
                });
            }
            aiClient.responseCreate({});

        } catch (error) {
            Logger.write("❌ handleYandexFunctionCall: " + error);
            try {
                aiClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: String(error) }) }
                });
                aiClient.responseCreate({});
            } catch (err) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v5.2 / v5.6: sendRuntimeText — враппер для отправки текста в Gemini runtime
    //
    // Gemini 2.5 → sendClientContent (turns + turnComplete)
    // Gemini 3.1 → sendRealtimeInput (text) — sendClientContent запрещён
    //              в 3.1 для runtime-сообщений, только для initial history
    //              (после первого хода модели прилетает ошибка 1007)
    // Gemini 3.8 → sendClientContent: ограничение 3.1 снято, client content
    //              снова разрешён на всём сеансе
    //
    // ⚠️ У client content turnComplete:true безусловно прерывает генерацию,
    // поэтому пинг тишины взводится только по MediaEnded (см. resetSilenceTimer).
    // ══════════════════════════════════════════════════════════════════════════
    function sendRuntimeText(text) {
        if (IS_31) {
            Logger.write("   🤖 Method: sendRealtimeInput (3.1)");
            aiClient.sendRealtimeInput({ text: text });
        } else {
            Logger.write("   🤖 Method: sendClientContent (" + MODEL_VERSION + ")");
            aiClient.sendClientContent({
                turns: [{ role: "user", parts: [{ text: text }] }],
                turnComplete: true
            });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // СИНХРОНИЗИРОВАННЫЙ ТРИГГЕР ПРИВЕТСТВИЯ (только для Gemini)
    // ══════════════════════════════════════════════════════════════════════════
    function tryTriggerGeminiGreeting(GREETING) {
        if (greetingTriggered || !geminiReady || !callConnected || isHangingUp) return;
        greetingTriggered = true;

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("👋 TRIGGERING GREETING (Variant A - Synced)");
        Logger.write("   ✅ Gemini ready: YES");
        Logger.write("   ✅ Call connected: YES");
        Logger.write("   📤 Sending simulated 'Алло'");
        Logger.write("   🎯 Expected: " + GREETING.substring(0, 60) + "...");
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        sendRuntimeText("Алло");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ГЛАВНАЯ ЛОГИКА
    // ══════════════════════════════════════════════════════════════════════════
    try {
        var CONFIG_URL = "https://voicyfy.ru/api/telephony/outbound-config?assistant_id=" + ASSISTANT_ID +
                         "&assistant_type=" + (callData.assistant_type || "gemini");

        Logger.write("🔄 Loading config...");
        var response = await Net.httpRequestAsync(CONFIG_URL);

        if (response.code != 200) {
            Logger.write("❌ Config HTTP " + response.code);
            VoxEngine.terminate();
            return;
        }

        var config = JSON.parse(response.text);
        if (!config.success) {
            Logger.write("❌ Config success=false");
            VoxEngine.terminate();
            return;
        }

        activeConfig = config;
        assistantType = config.assistant_type || callData.assistant_type || "gemini";

        // ══════════════════════════════════════════════════════════════════
        // 🆕 v5.6: определяем версию модели Gemini сразу после загрузки конфига.
        // Порядок проверок важен: сначала 3.8, потом 3.1 — иначе новая модель
        // молча уехала бы в ветку 2.5 и упала на thinkingBudget.
        // ══════════════════════════════════════════════════════════════════
        var GEMINI_MODEL = config.model || "models/gemini-2.5-flash-native-audio-preview-12-2025";
        if (assistantType === "gemini") {
            if (GEMINI_MODEL.indexOf("3.8") !== -1) {
                MODEL_VERSION = "3.8";
            } else if (GEMINI_MODEL.indexOf("3.1") !== -1) {
                MODEL_VERSION = "3.1";
            } else {
                MODEL_VERSION = "2.5";
            }
        }
        IS_31 = (assistantType === "gemini") && (MODEL_VERSION === "3.1");

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("✅ Config loaded: " + config.assistant_name);
        Logger.write("   Provider: " + assistantType);
        Logger.write("   Model: " + (config.model || "—") + " | Voice: " + (config.voice || "—") +
                     " | Functions: " + (config.functions ? config.functions.length : 0));
        if (assistantType === "gemini") {
            Logger.write("   🆕 Version: Gemini " + MODEL_VERSION + " | IS_31: " + IS_31);
            Logger.write("   🆕 VAD: HIGH/HIGH | prefix " + VAD_PREFIX_PADDING_MS + "ms | silence " + VAD_SILENCE_DURATION_MS + "ms");
        }
        if (assistantType === "cartesia") {
            Logger.write("   🎤 Cartesia Voice: " + config.cartesia_voice_id);
            Logger.write("   ⚡ Speed: " + config.voice_speed);
            Logger.write("   🔑 Cartesia Key: " + (config.cartesia_api_key ? "YES" : "NONE"));
        }
        if (assistantType === "yandex") {
            Logger.write("   🟡 Yandex folder_id: " + (config.folder_id ? "YES" : "NONE"));
            Logger.write("   🗣️ Voice role: " + (config.voice_role || "—"));
        }
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        if (!config.api_key) {
            Logger.write("❌ No API key!");
            VoxEngine.terminate();
            return;
        }
        if (assistantType === "cartesia" && (!config.cartesia_api_key || !config.cartesia_voice_id)) {
            Logger.write("❌ Cartesia requires cartesia_api_key + cartesia_voice_id");
            VoxEngine.terminate();
            return;
        }
        // v5.4: Yandex требует folder_id
        if (assistantType === "yandex" && !config.folder_id) {
            Logger.write("❌ Yandex requires folder_id");
            VoxEngine.terminate();
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ПРИВЕТСТВИЕ
        // 1) Приоритет: CUSTOM_GREETING (CRM) → config.first_phrase → дефолт
        // 2) Подстановка имени контакта (общая логика для всех провайдеров)
        // 3) v5.4: sanitize (для yandex) — снимает кавычки и мета-префиксы
        // ══════════════════════════════════════════════════════════════════
        var GREETING = CUSTOM_GREETING || config.first_phrase || "Здравствуйте!";
        if (CONTACT_NAME) {
            GREETING = GREETING.replace(/клиент/gi, CONTACT_NAME);
            GREETING = GREETING.replace(/\{имя\}/gi, CONTACT_NAME);
            GREETING = GREETING.replace(/\{name\}/gi, CONTACT_NAME);
        }

        if (CUSTOM_GREETING) {
            Logger.write("   💬 Using CUSTOM_GREETING");
        } else {
            Logger.write("   💬 Using config.first_phrase");
        }

        if (assistantType === "yandex") {
            var rawGreeting = GREETING;
            GREETING = sanitizeGreeting(GREETING) || "Здравствуйте!";
            if (GREETING !== String(rawGreeting).trim()) {
                Logger.write("   ⚠️ Greeting sanitized (мета-префиксы/кавычки удалены)");
            }
        }

        Logger.write("   Greeting: \"" + GREETING.substring(0,80) + "\"");

        // ══════════════════════════════════════════════════════════════════
        // СИСТЕМНЫЙ ПРОМПТ + CRM КОНТЕКСТ
        // ══════════════════════════════════════════════════════════════════
        var systemPrompt = config.system_prompt || config.prompt || "Ты голосовой ассистент.";

        // v5.4: API_TASK — задача на конкретный звонок (если передана)
        if (API_TASK) {
            var taskBlock = "══════════════════════════════════════\n";
            taskBlock += "📋 ЗАДАЧА НА ЭТОТ ЗВОНОК\n";
            taskBlock += "══════════════════════════════════════\n";
            taskBlock += API_TASK + "\n";
            taskBlock += "══════════════════════════════════════\n";
            taskBlock += "ВАЖНО: Выполни задачу, описанную выше. Это твоя главная цель в этом звонке.\n";
            taskBlock += "══════════════════════════════════════\n\n";
            systemPrompt = taskBlock + systemPrompt;
            Logger.write("✅ API_TASK added (" + API_TASK.length + " chars)");
        }

        if (CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION) {
            var ctx = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
            ctx += "КОНТЕКСТ ТЕКУЩЕГО ЗВОНКА:\n";
            ctx += "📅 Сейчас: " + currentDateTime + "\n";
            ctx += "📞 Телефон клиента: " + PHONE_NUMBER + "\n";
            if (CONTACT_NAME) {
                ctx += "👤 Клиент: " + CONTACT_NAME + "\n";
                ctx += 'ВАЖНО: Обращайся к клиенту по имени "' + CONTACT_NAME + '" в течение разговора.\n';
            }
            if (TASK_TITLE) ctx += "📋 Цель звонка: " + TASK_TITLE + "\n";
            if (TASK_DESCRIPTION) ctx += "\n📝 Дополнительный контекст:\n" + TASK_DESCRIPTION + "\n";
            ctx += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
            systemPrompt = ctx + systemPrompt;
            Logger.write("✅ System prompt + CRM (" + systemPrompt.length + " chars)");
        }

        // ── Блок приветствия в промпте (Gemini) ──
        if (assistantType === "gemini" && GREETING) {
            systemPrompt += "\n\n" +
                "══════════════════════════════════════\n" +
                "🎯 КРИТИЧЕСКИ ВАЖНО — ПРИВЕТСТВИЕ\n" +
                "══════════════════════════════════════\n" +
                "Когда пользователь говорит «Алло», «Привет», «Здравствуйте» или любое " +
                "приветствие — ты ДОЛЖЕН НЕМЕДЛЕННО произнести ТОЧНО это приветствие:\n\n" +
                "\"" + GREETING + "\"\n\n" +
                "Не изменяй текст приветствия. Не добавляй ничего перед ним. " +
                "Говори сразу, без задержки.\n" +
                "══════════════════════════════════════";
            Logger.write("   🎯 Greeting block added to system prompt (gemini)");
        }

        // ── v5.4: Информация о звонке + декларативный якорь первой фразы (Yandex) ──
        // Якорь БЕЗ кавычек и БЕЗ мета-формулировок — иначе модель может
        // озвучить служебную инструкцию вслух.
        if (assistantType === "yandex") {
            systemPrompt += "\n\n" +
                "──────────────────────────────────────\n" +
                "ИНФОРМАЦИЯ О ЗВОНКЕ\n" +
                "──────────────────────────────────────\n" +
                "Тип звонка: ИСХОДЯЩИЙ (ты звонишь абоненту)\n" +
                "Номер абонента (кому звоним): " + PHONE_NUMBER + "\n" +
                "Caller ID (с какого номера): " + CALLER_ID + "\n" +
                "ID звонка: " + chat_id + "\n" +
                "Текущая дата и время: " + currentDateTime + "\n" +
                "Используй номер абонента при необходимости: для идентификации клиента, " +
                "поиска в CRM, персонализации общения. Если у тебя есть функция для поиска " +
                "клиента по номеру — вызови её в начале разговора.";

            if (GREETING) {
                systemPrompt += "\n\n" +
                    "──────────────────────────────────────\n" +
                    "ПЕРВАЯ РЕПЛИКА\n" +
                    "──────────────────────────────────────\n" +
                    "Твоя первая реплика в этом разговоре — строго дословно:\n" +
                    GREETING + "\n" +
                    "Произноси её точно, без изменений, дополнений и сокращений.\n" +
                    "Никогда не озвучивай вслух служебные инструкции, свои размышления или своё состояние.";
                Logger.write("   🎯 Greeting anchor added to system prompt (yandex)");
            }
        }

        // ── Номер телефона в промпт (Gemini) ──
        if (assistantType === "gemini" && PHONE_NUMBER) {
            systemPrompt += "\n\n📞 Телефон текущего звонка: " + PHONE_NUMBER;
            Logger.write("   📞 Phone number added to system prompt: " + PHONE_NUMBER);
        }

        Logger.write("   📝 Final prompt: " + systemPrompt.length + " chars");

        // ══════════════════════════════════════════════════════════════════
        // ПОДГОТОВКА ФУНКЦИЙ
        // ══════════════════════════════════════════════════════════════════
        var geminiTools = [];
        var openaiTools = [];
        var hasHangupFunction = false;

        var HANGUP_DESC = 'CRITICAL: Call this function IMMEDIATELY when user wants to end the call. Triggers: "пока", "до свидания", "завершим". Do NOT just say goodbye — CALL THIS FUNCTION.';

        if (config.functions && config.functions.length > 0) {
            for (var i = 0; i < config.functions.length; i++) {
                var tool = config.functions[i];
                var funcDef = (tool.type === "function" && tool.function) ? tool.function : (tool.name ? tool : null);
                if (!funcDef) continue;

                var fid = (i + 1).toString();
                functionNameToIdMap[funcDef.name] = fid;
                Logger.write("   🔧 Function: " + funcDef.name + " → ID: " + fid);

                var desc = funcDef.description;
                if (funcDef.name === "hangup_call") {
                    hasHangupFunction = true;
                    desc = HANGUP_DESC;
                }

                geminiTools.push({ name: funcDef.name, description: desc, parameters: funcDef.parameters });
                openaiTools.push({ type: "function", name: funcDef.name, description: funcDef.description, parameters: funcDef.parameters });
                yandexTools.push({
                    type: "function",
                    name: funcDef.name,
                    description: desc,
                    parameters: funcDef.parameters || { type: "object", properties: {}, required: [] }
                });
            }
        }

        // v5.4: у Yandex hangup_call доступен ВСЕГДА (даже если нет в конфиге) —
        // иначе модель не сможет завершить разговор по просьбе клиента.
        if (assistantType === "yandex" && !hasHangupFunction) {
            yandexTools.push({
                type: "function",
                name: "hangup_call",
                description: HANGUP_DESC,
                parameters: {
                    type: "object",
                    properties: {
                        farewell_message: { type: "string", description: "Прощальная фраза, которую нужно произнести перед завершением" }
                    },
                    required: []
                }
            });
            Logger.write("   + default hangup_call added (yandex)");
        }

        // ══════════════════════════════════════════════════════════════════
        // ИНИЦИАЛИЗАЦИЯ AI КЛИЕНТА
        // ══════════════════════════════════════════════════════════════════

        if (assistantType === "gemini") {
            // ══════════════════════════════════════════════════════════════
            // 🟢 GEMINI
            // ══════════════════════════════════════════════════════════════

            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("🔌 GEMINI CONNECTION (with retry support)");
            Logger.write("   Max retries: " + MAX_GEMINI_RETRIES);
            Logger.write("   Init timeout: " + GEMINI_INIT_TIMEOUT + "ms");
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            function buildGeminiConfig() {
                var cfg = {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice || "Aoede" } }
                    },
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    inputAudioTranscription: { model: "default", language: config.language || "ru" },
                    outputAudioTranscription: { model: "default" },
                    toolConfig: { functionCallingConfig: { mode: "AUTO" } },

                    // ════════════════════════════════════════════════
                    // 🆕 v5.5: ТЮНИНГ ВСТРОЕННОГО VAD (из inbound v7.8)
                    // startOfSpeechSensitivity HIGH — легче засчитывает
                    //   начало речи (тихая/телефонная речь)
                    // endOfSpeechSensitivity HIGH — быстрее фиксирует конец
                    // prefixPaddingMs — фильтр коротких шумов на старте
                    // silenceDurationMs — тишина до "конец реплики"
                    //   (главный параметр отзывчивости)
                    // ════════════════════════════════════════════════
                    realtimeInputConfig: {
                        automaticActivityDetection: {
                            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                            prefixPaddingMs: VAD_PREFIX_PADDING_MS,
                            silenceDurationMs: VAD_SILENCE_DURATION_MS
                        }
                    }
                };

                // ════════════════════════════════════════════════════
                // 🆕 v5.6: thinkingConfig — у каждой версии свой.
                //
                // 3.8 Live: поля нет вообще. Модель не принимает ни
                // thinkingLevel, ни thinkingBudget (у неё interleaved
                // reasoning), и присланное поле валит сетап. Поэтому
                // для 3.8 thinkingConfig не назначаем.
                // ════════════════════════════════════════════════════
                if (MODEL_VERSION === "3.8") {
                    // намеренно пусто
                } else if (IS_31) {
                    cfg.thinkingConfig = { thinkingLevel: "minimal" };
                } else {
                    cfg.thinkingConfig = { thinkingBudget: 0 };
                    // ════════════════════════════════════════════════
                    // 🆕 v5.5: proactiveAudio УДАЛЁН (раньше был enabled)
                    // Proactivity позволяла модели РЕШАТЬ, отвечать или
                    // нет — фича для умных колонок. В телефонии все
                    // реплики адресованы ассистенту; на шум/невнятную
                    // фразу модель "осознанно молчала" 3-4с.
                    // НЕ ВОЗВРАЩАТЬ.
                    // ════════════════════════════════════════════════
                }

                if (geminiTools.length > 0) {
                    cfg.tools = [{ functionDeclarations: geminiTools }];
                }
                return cfg;
            }

            async function createGeminiClient(attempt) {
                Logger.write("🔌 Creating Gemini client (attempt " + attempt + ")...");
                Logger.write("   Model: " + GEMINI_MODEL);
                Logger.write("   Version: Gemini " + MODEL_VERSION);
                Logger.write("   VAD: HIGH/HIGH | prefix " + VAD_PREFIX_PADDING_MS + "ms | silence " + VAD_SILENCE_DURATION_MS + "ms");

                aiClient = await Gemini.createLiveAPIClient({
                    apiKey: config.api_key,
                    model: GEMINI_MODEL,
                    connectConfig: buildGeminiConfig(),
                    backend: Gemini.Backend.GEMINI_API,
                    onWebSocketClose: function() {
                        Logger.write("🔌 Gemini WebSocket closed");
                        if (!isHangingUp) terminateCall();
                    }
                });

                Logger.write("✅ Gemini WebSocket connected (attempt " + attempt + ")");
                Logger.write("   ⚡ Thinking: " +
                             (MODEL_VERSION === "3.8" ? "not sent (3.8)" : (IS_31 ? "thinkingLevel=minimal" : "thinkingBudget=0")) +
                             " | 🎯 Proactive: OFF (v5.5)" +
                             " | 🗣️ Voice: " + (config.voice || "Aoede"));

                geminiInitTimer = setTimeout(function() {
                    if (!geminiReady && !isHangingUp) {
                        Logger.write("⏰ Gemini init timeout (attempt " + attempt + ")");
                        if (geminiRetryCount < MAX_GEMINI_RETRIES) {
                            geminiRetryCount++;
                            Logger.write("🔄 Retrying Gemini... (" + geminiRetryCount + "/" + MAX_GEMINI_RETRIES + ")");
                            try { aiClient.close(); } catch(e) {}
                            aiClient = null;
                            createGeminiClient(attempt + 1);
                        } else {
                            Logger.write("❌ Gemini max retries exceeded");
                            terminateCall();
                        }
                    }
                }, GEMINI_INIT_TIMEOUT);

                // SetupComplete → инициируем PSTN звонок
                aiClient.addEventListener(Gemini.LiveAPIEvents.SetupComplete, function(event) {
                    if (geminiInitTimer) {
                        clearTimeout(geminiInitTimer);
                        geminiInitTimer = null;
                    }
                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    Logger.write("✅ GEMINI SetupComplete RECEIVED!");
                    Logger.write("   Retry count: " + geminiRetryCount);
                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                    geminiReady = true;

                    if (!call && !isHangingUp) {
                        initiateGeminiPSTNCall();
                    } else if (callConnected) {
                        tryTriggerGeminiGreeting(GREETING);
                    }
                });

                aiClient.addEventListener(Gemini.LiveAPIEvents.ToolCall, async function(event) {
                    try {
                        var fcs = event.data && event.data.payload && event.data.payload.functionCalls;
                        if (!fcs || !fcs.length) return;
                        for (var i = 0; i < fcs.length; i++) {
                            await handleGeminiFunctionCall(fcs[i].id, fcs[i].name, fcs[i].args || {});
                        }
                    } catch(err) { Logger.write("❌ ToolCall error: " + err); }
                });

                aiClient.addEventListener(Gemini.LiveAPIEvents.ServerContent, function(event) {
                    try {
                        var p = event.data && event.data.payload;
                        if (!p) return;

                        var parts = [];
                        if (p.modelTurn) parts.push("modelTurn");
                        if (p.outputTranscription) parts.push("outputTranscription");
                        if (p.inputTranscription) parts.push("inputTranscription");
                        if (p.turnComplete) parts.push("turnComplete");
                        if (parts.length > 0) {
                            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                            Logger.write("📨 SERVER CONTENT (" + parts.join(", ") + ")");
                        }

                        if (p.interrupted) {
                            Logger.write("🔇 INTERRUPTED");
                            aiClient.clearMediaBuffer();
                        }

                        // 🆕 v5.5: GoAway — сервер закрывает соединение, предупреждаем
                        if (p.goAway) {
                            Logger.write("⚠️ GoAway received — connection closing in " +
                                (p.goAway.timeLeft || "unknown") + "ms");
                            if (callConnected && !isHangingUp && !isFirstGeminiMessage) {
                                sendRuntimeText("Пожалуйста, завершите разговор, время сессии подходит к концу.");
                            }
                        }

                        if (p.inputTranscription) {
                            var t = p.inputTranscription.text;
                            resetSilenceTimer();
                            if (isFirstGeminiMessage) {
                                Logger.write("👤 USER (simulated 'Алло'): \"" + t + "\" → skipping");
                            } else {
                                if (lastRole === "assistant" && currentAssistantText.trim()) {
                                    dialogLog.push({ role: "assistant", text: currentAssistantText.trim(), ts: Date.now() });
                                    currentAssistantText = "";
                                }
                                if (currentUserText && !currentUserText.endsWith(" ")) currentUserText += " ";
                                currentUserText += t;
                                lastRole = "user";
                                if (userMessageBuffer && !userMessageBuffer.endsWith(" ")) userMessageBuffer += " ";
                                userMessageBuffer += t;
                                Logger.write("👤 USER: \"" + t + "\" (turn: " + currentUserText.length + ", total: " + userMessageBuffer.length + ")");
                            }
                        }

                        // 🆕 v5.5: outputTranscription НЕ сбрасывает таймер тишины.
                        // Транскрипция приходит на 10+ сек раньше конца аудио —
                        // якорь тишины теперь WebSocketMediaEnded.
                        if (p.outputTranscription) {
                            var t2 = p.outputTranscription.text;
                            if (lastRole === "user" && currentUserText.trim()) {
                                Logger.write("📝 Finalized USER turn #" + (dialogLog.length + 1));
                                dialogLog.push({ role: "user", text: currentUserText.trim(), ts: Date.now() });
                                currentUserText = "";
                            }
                            if (currentAssistantText && !currentAssistantText.endsWith(" ") && !t2.startsWith(" ")) currentAssistantText += " ";
                            currentAssistantText += t2;
                            lastRole = "assistant";
                            if (assistantMessageBuffer && !assistantMessageBuffer.endsWith(" ") && !t2.startsWith(" ")) assistantMessageBuffer += " ";
                            assistantMessageBuffer += t2;
                            Logger.write("🤖 ASSISTANT: \"" + t2 + "\" (turn: " + currentAssistantText.length + ", total: " + assistantMessageBuffer.length + ")");
                        }

                        if (p.turnComplete) {
                            Logger.write("🏁 Turn complete");
                            if (isFirstGeminiMessage) {
                                isFirstGeminiMessage = false;
                                Logger.write("   ✅ First greeting complete, switching to normal mode");
                                if (currentAssistantText || assistantMessageBuffer) {
                                    dialogLog.push({ role: "user", text: "Алло", ts: Date.now() - 1000 });
                                    userMessageBuffer = "Алло";
                                    if (currentAssistantText.trim()) {
                                        dialogLog.push({ role: "assistant", text: currentAssistantText.trim(), ts: Date.now() });
                                        Logger.write("   📝 Added 'Алло' as first user turn");
                                        Logger.write("   📝 Added greeting as first assistant turn");
                                        currentAssistantText = "";
                                    }
                                    lastRole = "assistant";
                                }
                            }
                            // 🆕 v5.5: перезапуск таймеров; пинг взведётся только если
                            // аудио уже доиграло (иначе — на ближайшем MediaEnded)
                            resetSilenceTimer();
                            Logger.write("   📝 Dialog: " + dialogLog.length + " turns, User: " + userMessageBuffer.length + "ch, Assistant: " + assistantMessageBuffer.length + "ch");
                        }

                        if (parts.length > 0) {
                            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        }
                    } catch(err) { Logger.write("❌ ServerContent error: " + err); }
                });

                aiClient.addEventListener(Gemini.LiveAPIEvents.Unknown, function(event) {
                    Logger.write("⚠️ Gemini Unknown: " + JSON.stringify(event));
                });

                // 🆕 v5.5: MediaStarted — ассистент начал говорить.
                // Пинг тишины невозможен: снимаем таймер, ставим флаг.
                aiClient.addEventListener(Gemini.Events.WebSocketMediaStarted, function() {
                    Logger.write("🎵 Media started (24kHz HD Audio)");
                    geminiAudioPlaying = true;
                    if (silencePingTimeoutId) {
                        clearTimeout(silencePingTimeoutId);
                        silencePingTimeoutId = null;
                        Logger.write("🔕 Ping timer cancelled: assistant audio started");
                    }
                });

                // 🆕 v5.5: MediaEnded — аудио ДОИГРАЛО клиенту.
                // ГЛАВНЫЙ ЯКОРЬ: отсюда стартует честный отсчёт тишины.
                aiClient.addEventListener(Gemini.Events.WebSocketMediaEnded, function() {
                    Logger.write("🎵 Media ended (assistant audio finished playing)");
                    geminiAudioPlaying = false;
                    if (callConnected && !isHangingUp && !isFirstGeminiMessage) {
                        Logger.write("⏱️ Silence countdown starts NOW (audio finished)");
                        resetSilenceTimer();
                    }
                });
            }

            // ── PSTN звонок: вызывается ТОЛЬКО из SetupComplete ──
            function initiateGeminiPSTNCall() {
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("📞 INITIATING PSTN CALL (Gemini is ready!)");
                Logger.write("   Target: " + PHONE_NUMBER + " | Caller ID: " + CALLER_ID);
                Logger.write("   Call type: " + callType);
                Logger.write("   Gemini retries used: " + geminiRetryCount + " | Version: " + MODEL_VERSION);
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);

                call.addEventListener(CallEvents.Connected, function() {
                    call_id = call.id();

                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    Logger.write("✅ OUTBOUND CALL CONNECTED [gemini]");
                    Logger.write("   Call ID: " + call_id + " | Target: " + caller_number);
                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                    try {
                        call.record({ stereo: false, lossless: false, hd_audio: true });
                    } catch(e) { Logger.write("⚠️ Recording failed: " + e); }

                    aiClient.sendMediaTo(call);

                    Logger.write("🔇 MICROPHONE MUTED FOR CLIENT (" + MUTE_DURATION + "ms)");
                    callConnected = true;

                    // 🆕 v5.5: SESSION TTL — Gemini Live сессия живёт ~10 минут
                    sessionWarningTimeoutId = setTimeout(function() {
                        Logger.write("⚠️ Gemini session: 1 min remaining");
                        if (aiClient && !isHangingUp && !isFirstGeminiMessage) {
                            sendRuntimeText("Пожалуйста, завершите разговор, время сессии подходит к концу.");
                        }
                    }, GEMINI_SESSION_WARNING_MS);

                    sessionMaxTimeoutId = setTimeout(function() {
                        Logger.write("⏱️ Gemini session TTL reached — terminating");
                        terminateCall();
                    }, GEMINI_SESSION_MAX_MS);

                    resetSilenceTimer();
                    tryTriggerGeminiGreeting(GREETING);

                    setTimeout(function() {
                        if (!isHangingUp && call) {
                            call.sendMediaTo(aiClient);
                            Logger.write("🎙️ MICROPHONE UNMUTED - Full bidirectional media active");
                        }
                    }, MUTE_DURATION);
                });

                attachCommonCallHandlers(call, "gemini");
            }

            await createGeminiClient(1);

        } else if (assistantType === "openai") {
            // ══════════════════════════════════════════════════════════════
            // 🔵 OPENAI
            // ══════════════════════════════════════════════════════════════
            Logger.write("🔵 Initializing OpenAI Realtime API...");

            aiClient = await OpenAI.createRealtimeAPIClient({
                apiKey: config.api_key,
                model: config.model || "gpt-realtime",
                type: OpenAI.RealtimeAPIClientType.REALTIME,
                onWebSocketClose: function() {
                    Logger.write("🔌 OpenAI WS closed");
                    if (!isHangingUp) terminateCall();
                }
            });

            Logger.write("✅ OpenAI connected");

            aiClient.sessionUpdate({
                session: {
                    type: "realtime",
                    instructions: systemPrompt,
                    voice: config.voice || "alloy",
                    audio: { input: { transcription: { model: "gpt-4o-transcribe", language: config.language || "ru" } } },
                    tools: openaiTools,
                    tool_choice: openaiTools.length > 0 ? "auto" : "none"
                }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function(event) {
                try {
                    var tr = event.data && event.data.payload && event.data.payload.transcript;
                    if (tr && tr.trim()) {
                        resetSilenceTimer();
                        var label = CONTACT_NAME || PHONE_NUMBER;
                        Logger.write("👤 USER (" + label + "): \"" + tr + "\"");
                        dialogLog.push({ role: "user", text: tr.trim(), ts: Date.now() });
                        if (userMessageBuffer) userMessageBuffer += " ";
                        userMessageBuffer += tr.trim();
                    }
                } catch(err) { Logger.write("❌ User handler error: " + err); }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ResponseOutputAudioTranscriptDone, function(event) {
                try {
                    var tr = event.data && event.data.payload && event.data.payload.transcript;
                    if (tr && tr.trim()) {
                        resetSilenceTimer();
                        Logger.write("🤖 ASSISTANT: \"" + tr + "\"");
                        dialogLog.push({ role: "assistant", text: tr.trim(), ts: Date.now() });
                        if (assistantMessageBuffer) assistantMessageBuffer += " ";
                        assistantMessageBuffer += tr.trim();
                    }
                } catch(err) { Logger.write("❌ Assistant handler error: " + err); }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ResponseOutputItemDone, async function(event) {
                try {
                    var item = event.data && event.data.payload && event.data.payload.item;
                    if (!item || item.type !== "function_call") return;
                    await handleOpenAIFunctionCall(item);
                } catch(err) { Logger.write("❌ Function handler error: " + err); }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.InputAudioBufferSpeechStarted, function() {
                if (aiClient) { aiClient.clearMediaBuffer(); Logger.write("🔇 Interruption"); }
            });

            aiClient.addEventListener(OpenAI.Events.WebSocketMediaEnded, function() {
                if (!greetingPlayed) {
                    greetingPlayed = true;
                    if (call) {
                        VoxEngine.sendMediaBetween(call, aiClient);
                        Logger.write("🎙️ Bidirectional media established");
                    }
                }
            });

            Logger.write("📞 Calling: " + PHONE_NUMBER + " from " + CALLER_ID);
            call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);

            call.addEventListener(CallEvents.Connected, function() {
                call_id = call.id();
                Logger.write("✅ CONNECTED [openai] | Call ID: " + call_id);
                if (CONTACT_NAME) Logger.write("   👤 " + CONTACT_NAME);

                try { call.record({ stereo: false, lossless: false, hd_audio: true }); } catch(e) {}

                aiClient.sendMediaTo(call);
                resetSilenceTimer();

                Logger.write("👋 Sending greeting via OpenAI...");
                aiClient.responseCreate({ instructions: 'Скажи точно так: "' + GREETING + '"' });
            });

            attachCommonCallHandlers(call, "openai");

        } else if (assistantType === "cartesia") {
            // ══════════════════════════════════════════════════════════════
            // 🟠 CARTESIA (OpenAI text + Cartesia TTS)
            // ══════════════════════════════════════════════════════════════
            Logger.write("🟠 Initializing Cartesia (OpenAI text + Cartesia TTS)...");

            aiClient = await OpenAI.createRealtimeAPIClient({
                apiKey: config.api_key,
                model: config.model || "gpt-realtime",
                type: OpenAI.RealtimeAPIClientType.REALTIME,
                onWebSocketClose: function() {
                    Logger.write("🔌 OpenAI WS closed");
                    if (!isHangingUp) terminateCall();
                },
                onWebSocketError: function(err) {
                    Logger.write("[OpenAI] WS error: " + JSON.stringify(err));
                }
            });

            Logger.write("✅ OpenAI (text mode) connected");

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.SessionCreated, function() {
                if (sessionStarted) return;
                sessionStarted = true;
                Logger.write("[Cartesia] Session created — configuring text-only...");
                aiClient.sessionUpdate({
                    session: {
                        type: "realtime",
                        output_modalities: ["text"],
                        instructions: systemPrompt,
                        audio: { input: { transcription: { model: "gpt-4o-transcribe", language: config.language || "ru" } } },
                        tools: openaiTools,
                        tool_choice: openaiTools.length > 0 ? "auto" : "none",
                        turn_detection: {
                            type: "server_vad", threshold: 0.5,
                            prefix_padding_ms: 300, silence_duration_ms: 500,
                            create_response: true, interrupt_response: true
                        }
                    }
                });
                Logger.write("[Cartesia] Session configured");
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ResponseOutputTextDone, function(event) {
                if (isInterrupted) return;
                var text = (event && event.data && event.data.text) ||
                           (event && event.data && event.data.payload && event.data.payload.text) || "";
                if (!text.trim()) return;
                resetSilenceTimer();
                Logger.write("🤖 ASSISTANT: \"" + text.substring(0,80) + "\"");
                dialogLog.push({ role: "assistant", text: text.trim(), ts: Date.now() });
                if (assistantMessageBuffer) assistantMessageBuffer += " ";
                assistantMessageBuffer += text.trim();
                sendToCartesia(text);
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function(event) {
                try {
                    var tr = event.data && event.data.payload && event.data.payload.transcript;
                    if (tr && tr.trim()) {
                        resetSilenceTimer();
                        var label = CONTACT_NAME || PHONE_NUMBER;
                        Logger.write("👤 USER (" + label + "): \"" + tr + "\"");
                        dialogLog.push({ role: "user", text: tr.trim(), ts: Date.now() });
                        if (userMessageBuffer) userMessageBuffer += " ";
                        userMessageBuffer += tr.trim();
                    }
                } catch(err) { Logger.write("❌ User handler error: " + err); }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ResponseCreated, function() {
                isInterrupted = false;
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.InputAudioBufferSpeechStarted, function() {
                Logger.write("🔇 INTERRUPTION");
                isInterrupted = true;
                try { aiClient.clearMediaBuffer(); } catch(e) {}
                stopCartesia();
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.ResponseOutputItemDone, async function(event) {
                try {
                    var item = event.data && event.data.payload && event.data.payload.item;
                    if (!item || item.type !== "function_call") return;
                    await handleOpenAIFunctionCall(item);
                } catch(err) { Logger.write("❌ Function handler error: " + err); }
            });

            aiClient.addEventListener(OpenAI.RealtimeAPIEvents.Error, function(event) {
                Logger.write("[OpenAI] Error: " + JSON.stringify(event && event.data));
            });

            Logger.write("📞 Calling: " + PHONE_NUMBER + " from " + CALLER_ID);
            call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);

            call.addEventListener(CallEvents.Connected, function() {
                call_id = call.id();
                Logger.write("✅ CONNECTED [cartesia] | Call ID: " + call_id);
                if (CONTACT_NAME) Logger.write("   👤 " + CONTACT_NAME);

                try { call.record({ stereo: false, lossless: false, hd_audio: true }); } catch(e) {}

                resetSilenceTimer();

                Logger.write("👋 Playing greeting via Cartesia...");
                dialogLog.push({ role: "assistant", text: GREETING.trim(), ts: Date.now() });
                if (assistantMessageBuffer) assistantMessageBuffer += " ";
                assistantMessageBuffer += GREETING.trim();
                sendToCartesia(GREETING);

                if (MUTE_DURATION > 0) {
                    Logger.write("🔇 Mute: " + MUTE_DURATION + "ms");
                    setTimeout(function() {
                        if (!isHangingUp && call && aiClient) {
                            call.sendMediaTo(aiClient);
                            Logger.write("🎙️ Client → OpenAI connected (mute expired)");
                        }
                    }, MUTE_DURATION);
                } else {
                    call.sendMediaTo(aiClient);
                }
            });

            attachCommonCallHandlers(call, "cartesia");

        } else if (assistantType === "yandex") {
            // ══════════════════════════════════════════════════════════════
            // 🟡 YANDEX  (v5.4 — логика из outbound_yandex v1.1)
            // ══════════════════════════════════════════════════════════════

            YANDEX_MODEL = config.model || YANDEX_DEFAULT_MODEL;
            YANDEX_VOICE = config.voice || YANDEX_DEFAULT_VOICE;

            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("🟡 YANDEX CONNECTION (PSTN only after SessionCreated)");
            Logger.write("   Model: " + YANDEX_MODEL + " | Voice: " + YANDEX_VOICE);
            Logger.write("   Retry: " + YANDEX_MAX_RETRY_ATTEMPTS + " × " + YANDEX_SETUP_TIMEOUT_MS + "ms");
            Logger.write("   🔧 tools (" + yandexTools.length + ") will attach AFTER greeting");
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            // ──────────────────────────────────────────────────────────
            // Сборка sessionUpdate.
            // includeTools = false → отправляем ДО приветствия (нет утечки
            //   tool-токенов в TTS первой фразы).
            // includeTools = true  → второй sessionUpdate ПОСЛЕ приветствия.
            // ──────────────────────────────────────────────────────────
            function buildYandexSessionUpdate(includeTools) {
                var su = {
                    session: {
                        type: "realtime",
                        instructions: systemPrompt,
                        output_modalities: ["audio"],
                        audio: {
                            input: {
                                turn_detection: {
                                    type: "server_vad",
                                    threshold: (config.vad_threshold !== undefined) ? config.vad_threshold : YANDEX_DEFAULT_VAD_THRESHOLD,
                                    silence_duration_ms: (config.vad_silence_ms !== undefined) ? config.vad_silence_ms : YANDEX_DEFAULT_VAD_SILENCE_MS
                                }
                            },
                            output: { voice: YANDEX_VOICE }
                        }
                    }
                };

                if (config.language) {
                    var langMap = { ru: "ru-RU", kk: "kk-KZ", en: "en-US", uz: "uz-UZ" };
                    su.session.audio.input.languages = [langMap[config.language] || config.language];
                }
                if (config.voice_role) {
                    su.session.audio.output.role = config.voice_role;
                }
                if (includeTools && yandexTools.length > 0) {
                    su.session.tools = yandexTools;
                    su.session.tool_choice = "auto";
                }
                return su;
            }

            // ──────────────────────────────────────────────────────────
            // Подключение tools ПОСЛЕ приветствия (идемпотентно)
            // ──────────────────────────────────────────────────────────
            function attachYandexToolsPostGreeting() {
                if (yandexToolsAttached) return;
                yandexToolsAttached = true;

                if (yandexTools.length === 0) {
                    Logger.write("🔧 No tools to attach (config has none)");
                    return;
                }
                try {
                    aiClient.sessionUpdate(buildYandexSessionUpdate(true));
                    Logger.write("🔧 TOOLS ATTACHED post-greeting: " + yandexTools.length);
                } catch (err) {
                    yandexToolsAttached = false; // позволим повторить при следующем MediaEnded
                    Logger.write("❌ attachYandexToolsPostGreeting: " + err);
                }
            }

            // ──────────────────────────────────────────────────────────
            // Единая точка: "ассистент заговорил" (для greeting-логики)
            // ──────────────────────────────────────────────────────────
            function markYandexSpeaking(source) {
                if (yandexAssistantSpeaking) return;
                if (!yandexGreetingStarted) return;

                yandexAssistantSpeaking = true;

                if (yandexGreetingTimeoutId) {
                    clearTimeout(yandexGreetingTimeoutId);
                    yandexGreetingTimeoutId = null;
                }

                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("✅ YANDEX STARTED SPEAKING (attempt #" + yandexGreetingAttempt + ", via " + source + ")");
                Logger.write("   → waiting WebSocketMediaEnded for tools + full duplex");
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            }

            // ──────────────────────────────────────────────────────────
            // GREETING FAILED → тихий hangup.
            // Исходящий звонок: мы сами позвонили, играть абоненту
            // "перезвоните позже" неуместно.
            // ──────────────────────────────────────────────────────────
            function yandexGreetingFailed() {
                if (isHangingUp) return;
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("❌ GREETING FAILED after " + yandexGreetingAttempt + " attempts");
                Logger.write("   OUTBOUND: тихий hangup, без TTS fallback");
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                terminateCall();
            }

            // ──────────────────────────────────────────────────────────
            // GREETING TRIGGER — responseCreate({instructions})
            // ──────────────────────────────────────────────────────────
            function sendYandexGreetingTrigger() {
                yandexGreetingAttempt++;

                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("👋 GREETING ATTEMPT #" + yandexGreetingAttempt + "/" + YANDEX_MAX_GREETING_ATTEMPTS);
                Logger.write("   Expected: " + GREETING.substring(0, 60));
                Logger.write("   Timeout: " + (YANDEX_GREETING_TIMEOUT_MS / 1000) + "s");
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                try {
                    aiClient.responseCreate({
                        instructions: "Скажи дословно следующий текст и больше ничего. Не добавляй, не сокращай, не перефразируй и не комментируй:\n\n" + GREETING
                    });
                } catch (err) {
                    Logger.write("❌ responseCreate (greeting): " + err);
                }

                if (yandexGreetingTimeoutId) clearTimeout(yandexGreetingTimeoutId);
                yandexGreetingTimeoutId = setTimeout(function() {
                    if (!yandexAssistantSpeaking && !isHangingUp) {
                        Logger.write("⚠️ GREETING TIMEOUT (attempt #" + yandexGreetingAttempt + ")");
                        if (yandexGreetingAttempt < YANDEX_MAX_GREETING_ATTEMPTS) {
                            Logger.write("🔄 Retrying greeting...");
                            sendYandexGreetingTrigger();
                        } else {
                            yandexGreetingFailed();
                        }
                    }
                }, YANDEX_GREETING_TIMEOUT_MS);
            }

            // ──────────────────────────────────────────────────────────
            // ⭐ ЗАПУСК ПРИВЕТСТВИЯ — напрямую по Connected + пауза на RTP.
            // НЕ ждём FirstAudioPacketReceived: при early media (гудки)
            // оно приходит ДО Connected и как признак готовности бесполезно.
            // Идемпотентно.
            // ──────────────────────────────────────────────────────────
            function startYandexGreetingFlow(trigger) {
                if (yandexGreetingStarted || isHangingUp) return;
                yandexGreetingStarted = true;

                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("🎙️ Starting greeting flow (trigger: " + trigger + ")");
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                // Односторонний поток: Yandex → абонент.
                // Микрофон абонента НЕ идёт в Yandex до конца приветствия.
                aiClient.sendMediaTo(call);
                Logger.write("🔇 Client mic MUTED (Yandex→client only, until greeting fully played)");
                Logger.write("   ℹ️ MUTE_DURATION (" + MUTE_DURATION + "ms) IGNORED for yandex");

                sendYandexGreetingTrigger();
            }

            // ──────────────────────────────────────────────────────────
            // ОБРАБОТЧИКИ СОБЫТИЙ YANDEX
            // ──────────────────────────────────────────────────────────
            function setupYandexEventHandlers(client) {

                client.addEventListener(Yandex.RealtimeAPIEvents.SessionUpdated, function(event) {
                    var session = event.data && event.data.payload ? event.data.payload.session : null;
                    var voice = session && session.audio && session.audio.output ? session.audio.output.voice : "unknown";
                    var instrLen = session && session.instructions ? session.instructions.length : 0;
                    var toolCount = session && session.tools ? session.tools.length : 0;
                    if (session && session.model) yandexActualModel = session.model;
                    Logger.write("🔄 SessionUpdated | voice: " + voice + " | instructions: " + instrLen +
                                 " chars | tools: " + toolCount +
                                 (session && session.model ? " | model: " + session.model : ""));
                });

                // ── Транскрипция пользователя (целая реплика) ──
                client.addEventListener(Yandex.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function(event) {
                    var transcript = event.data && event.data.payload ? event.data.payload.transcript : null;
                    if (!transcript || !transcript.trim()) return;

                    resetSilenceTimer();
                    var label = CONTACT_NAME || PHONE_NUMBER;
                    Logger.write("👤 USER (" + label + "): \"" + transcript + "\"");
                    dialogLog.push({ role: "user", text: transcript.trim(), ts: Date.now() });
                    if (userMessageBuffer && !userMessageBuffer.endsWith(" ")) userMessageBuffer += " ";
                    userMessageBuffer += transcript.trim();
                });

                // ── Транскрипция ассистента (целый ответ) ──
                client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputAudioTranscriptDone, function(event) {
                    var transcript = event.data && event.data.payload ? event.data.payload.transcript : null;
                    if (!transcript || !transcript.trim()) return;

                    resetSilenceTimer();
                    markYandexSpeaking("transcript");

                    // Фейковый "Алло" перед приветствием — для консистентности CRM
                    if (!yandexGreetingLogged) {
                        yandexGreetingLogged = true;
                        dialogLog.push({ role: "user", text: "Алло", ts: Date.now() - 5000 });
                        if (!userMessageBuffer) userMessageBuffer = "Алло";
                    }

                    Logger.write("🤖 ASSISTANT: \"" + transcript.substring(0, 100) + (transcript.length > 100 ? "..." : "") + "\"");
                    dialogLog.push({ role: "assistant", text: transcript.trim(), ts: Date.now() });
                    if (assistantMessageBuffer && !assistantMessageBuffer.endsWith(" ")) assistantMessageBuffer += " ";
                    assistantMessageBuffer += transcript.trim();
                });

                // ── Function calling ──
                client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputItemDone, async function(event) {
                    try {
                        var item = event.data && event.data.payload ? event.data.payload.item : null;
                        if (!item || item.type !== "function_call") return;
                        if (!item.name) return;
                        await handleYandexFunctionCall(item.call_id, item.name, item.arguments);
                    } catch (error) {
                        Logger.write("❌ ResponseOutputItemDone: " + error);
                    }
                });

                // ── Barge-in (сработает только после открытия дуплекса) ──
                client.addEventListener(Yandex.RealtimeAPIEvents.InputAudioBufferSpeechStarted, function() {
                    Logger.write("🔇 User speech started (barge-in)");
                    try { client.clearMediaBuffer(); } catch (err) {}
                    resetSilenceTimer();
                });

                // ── Медиа: аудио от Yandex пошло ──
                client.addEventListener(Yandex.Events.WebSocketMediaStarted, function() {
                    Logger.write("🎵 Media started (audio from Yandex)");
                    markYandexSpeaking("media");
                });

                // ── Медиа: аудио от Yandex закончилось ──
                client.addEventListener(Yandex.Events.WebSocketMediaEnded, function() {
                    Logger.write("🎵 Media ended");

                    // Прощание доиграло → вешаем трубку
                    if (yandexHangupRequested) {
                        Logger.write("👋 Farewell finished → hangup");
                        setTimeout(function() { terminateCall(); }, 500);
                        return;
                    }

                    // Приветствие ПОЛНОСТЬЮ доиграло → tools + полный дуплекс
                    if (yandexGreetingStarted && yandexAssistantSpeaking && !yandexDuplexActive) {
                        yandexDuplexActive = true;

                        attachYandexToolsPostGreeting();

                        VoxEngine.sendMediaBetween(call, aiClient);
                        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        Logger.write("🎙️ Full duplex ACTIVE (sendMediaBetween) — greeting fully played");
                        Logger.write("✅ Greeting complete (attempt #" + yandexGreetingAttempt + ") → CONVERSATION");
                        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        resetSilenceTimer();
                    }
                });

                // ── Ошибки ──
                client.addEventListener(Yandex.RealtimeAPIEvents.Error, function(event) {
                    Logger.write("❌ Yandex Error: " + JSON.stringify(event.data));
                });
                client.addEventListener(Yandex.RealtimeAPIEvents.WebSocketError, function(event) {
                    Logger.write("❌ Yandex WebSocketError: " + JSON.stringify(event.data));
                });
                client.addEventListener(Yandex.RealtimeAPIEvents.RateLimitsUpdated, function(event) {
                    Logger.write("⏳ RateLimitsUpdated: " + JSON.stringify(event.data));
                });
                client.addEventListener(Yandex.RealtimeAPIEvents.Unknown, function(event) {
                    Logger.write("⚠️ Yandex Unknown event: " + JSON.stringify(event));
                });
            }

            // ──────────────────────────────────────────────────────────
            // ПОДКЛЮЧЕНИЕ К YANDEX С RETRY. Готовность = SessionCreated.
            // ──────────────────────────────────────────────────────────
            function attemptYandexConnection(attemptNum) {
                return new Promise(async function(resolve, reject) {
                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    Logger.write("🔌 ATTEMPT #" + attemptNum + "/" + YANDEX_MAX_RETRY_ATTEMPTS + ": Connecting to Yandex Realtime...");
                    Logger.write("   Model: " + YANDEX_MODEL + " | Timeout: " + YANDEX_SETUP_TIMEOUT_MS + "ms");
                    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                    var sessionReceived = false;
                    var timeoutId = null;
                    var client = null;

                    try {
                        client = await Yandex.createRealtimeAPIClient({
                            apiKey: config.api_key,
                            folderId: config.folder_id,
                            model: YANDEX_MODEL,
                            onWebSocketClose: function(event) {
                                Logger.write("🔌 Yandex WebSocket closed (attempt #" + attemptNum + ")" +
                                             (event && event.code ? " code: " + event.code : ""));

                                if (!sessionReceived) {
                                    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                                    reject(new Error("WebSocket closed before SessionCreated"));
                                } else if (!isHangingUp) {
                                    terminateCall();
                                }
                            }
                        });

                        Logger.write("   ✅ Client created, waiting SessionCreated...");

                        client.addEventListener(Yandex.RealtimeAPIEvents.SessionCreated, function(event) {
                            if (sessionReceived) return;
                            sessionReceived = true;

                            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

                            var session = event.data && event.data.payload ? event.data.payload.session : null;
                            if (session && session.model) {
                                yandexActualModel = session.model;
                                Logger.write("   🤖 Actual session model: " + session.model);
                            }

                            Logger.write("   ✅ SessionCreated received! (attempt #" + attemptNum + ")");
                            resolve(client);
                        });

                        timeoutId = setTimeout(function() {
                            if (!sessionReceived) {
                                Logger.write("   ⚠️ TIMEOUT " + YANDEX_SETUP_TIMEOUT_MS + "ms (attempt #" + attemptNum + ")");
                                try { client.close(); } catch (err) {}
                                client = null;
                                reject(new Error("SessionCreated timeout"));
                            }
                        }, YANDEX_SETUP_TIMEOUT_MS);

                    } catch (err) {
                        Logger.write("❌ createRealtimeAPIClient error (attempt #" + attemptNum + "): " + err);
                        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                        reject(err);
                    }
                });
            }

            async function connectYandexWithRetry() {
                for (var attempt = 1; attempt <= YANDEX_MAX_RETRY_ATTEMPTS; attempt++) {
                    if (isHangingUp) return null;
                    try {
                        return await attemptYandexConnection(attempt);
                    } catch (err) {
                        Logger.write("   ❌ Attempt #" + attempt + " failed: " + err.message);
                        if (attempt >= YANDEX_MAX_RETRY_ATTEMPTS) {
                            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                            Logger.write("❌ ALL " + YANDEX_MAX_RETRY_ATTEMPTS + " ATTEMPTS FAILED");
                            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        }
                    }
                }
                return null;
            }

            // ── ШАГ 1: подключаемся к Yandex ДО набора PSTN ──
            aiClient = await connectYandexWithRetry();

            if (!aiClient) {
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("❌ YANDEX INIT FAILED after " + YANDEX_MAX_RETRY_ATTEMPTS + " attempt(s)");
                Logger.write("   ✅ NO PSTN CALL WAS MADE — 0₽ lost!");
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                VoxEngine.terminate();
                return;
            }

            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("🟢 YANDEX READY → dialing PSTN");
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            setupYandexEventHandlers(aiClient);

            // ── sessionUpdate #1 — БЕЗ TOOLS (до звонка) ──
            Logger.write("📤 sessionUpdate #1 (NO TOOLS) | instructions: " + systemPrompt.length +
                         " chars | voice: " + YANDEX_VOICE + " | tools deferred: " + yandexTools.length);
            aiClient.sessionUpdate(buildYandexSessionUpdate(false));

            // ── ШАГ 2: PSTN звонок ──
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("📞 INITIATING PSTN CALL (Yandex is ready!)");
            Logger.write("   Target: " + PHONE_NUMBER + " | Caller ID: " + CALLER_ID);
            Logger.write("   Call type: " + callType);
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);

            call.addEventListener(CallEvents.Connected, function() {
                call_id = call.id();

                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                Logger.write("✅ OUTBOUND CALL CONNECTED [yandex]");
                Logger.write("   Call ID: " + call_id + " | Target: " + caller_number);
                if (CONTACT_NAME) Logger.write("   👤 Contact: " + CONTACT_NAME);
                Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                try {
                    call.record({ stereo: false, lossless: false, hd_audio: true });
                } catch(e) { Logger.write("⚠️ Recording failed: " + e); }

                resetSilenceTimer();

                // ⭐ Greeting сразу после Connected + короткая пауза на подъём RTP.
                // Ждать FirstAudioPacketReceived НЕЛЬЗЯ: при early media оно
                // приходит ДО Connected и второй раз не придёт → 4с тишины.
                Logger.write("⏳ Greeting in " + YANDEX_GREETING_DELAY_MS + "ms (RTP settle delay)...");
                yandexGreetingDelayId = setTimeout(function() {
                    yandexGreetingDelayId = null;
                    startYandexGreetingFlow("Connected +" + YANDEX_GREETING_DELAY_MS + "ms");
                }, YANDEX_GREETING_DELAY_MS);
            });

            // Диагностика: видно момент early media. На логику НЕ влияет.
            call.addEventListener(CallEvents.FirstAudioPacketReceived, function() {
                Logger.write("🎵 FirstAudioPacketReceived (early media / RTP up) — informational only");
            });

            attachCommonCallHandlers(call, "yandex");

        } else {
            Logger.write("❌ Unknown assistant_type: " + assistantType);
            VoxEngine.terminate();
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ГОТОВО
        // ══════════════════════════════════════════════════════════════════
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("✅ ALL HANDLERS READY");
        Logger.write("🎉 READY FOR OUTBOUND CONVERSATION (v5.6)");
        Logger.write("🔧 PRODUCTION v5.6 | Provider: " + assistantType);

        if (assistantType === "gemini") {
            Logger.write("   🤖 Model: " + GEMINI_MODEL + " (version=" + MODEL_VERSION + ")" +
                         (IS_31 ? " → sendRealtimeInput" : " → sendClientContent") +
                         (MODEL_VERSION === "3.8" ? " | thinkingConfig: not sent" : ""));
            Logger.write("   🔇 Mute: " + MUTE_DURATION + "ms");
            Logger.write("   👋 Greeting: Synced 'Алло' | 🎙️ Recording: ON");
            Logger.write("   🛡️ PSTN after Gemini ready: ENABLED");
            Logger.write("   🔄 Gemini retry: " + MAX_GEMINI_RETRIES + " (timeout: " + GEMINI_INIT_TIMEOUT + "ms)");
            Logger.write("   🆕 VAD: HIGH/HIGH | prefix " + VAD_PREFIX_PADDING_MS + "ms | silence " + VAD_SILENCE_DURATION_MS + "ms | proactiveAudio OFF");
            Logger.write("   🆕 Silence: ping " + (GEMINI_SILENCE_PING_MS / 1000) + "s (after MediaEnded) | hard " + (GEMINI_SILENCE_TIMEOUT_MS / 1000) + "s");
            Logger.write("   🆕 Session TTL: " + (GEMINI_SESSION_MAX_MS / 60000) + "min (warn at " + (GEMINI_SESSION_WARNING_MS / 60000) + "min) + GoAway handling");
        }
        if (assistantType === "yandex") {
            Logger.write("   🤖 Model: " + YANDEX_MODEL + " | actual: " + (yandexActualModel || "pending"));
            Logger.write("   🗣️ Voice: " + YANDEX_VOICE + (config.voice_role ? " (" + config.voice_role + ")" : ""));
            Logger.write("   🛡️ PSTN after Yandex ready: ENABLED (0₽ if Yandex fails)");
            Logger.write("   ⚡ Greeting: responseCreate at Connected +" + YANDEX_GREETING_DELAY_MS + "ms (NO FirstAudioPacket wait)");
            Logger.write("   🛡️ Greeting retry: " + YANDEX_MAX_GREETING_ATTEMPTS + " × " + (YANDEX_GREETING_TIMEOUT_MS / 1000) + "s → silent hangup");
            Logger.write("   🔇 Mic muted until greeting fully played (MUTE_DURATION ignored)");
            Logger.write("   🔧 Tools attach AFTER greeting (no tool-token leak into TTS)");
            Logger.write("   🔧 Dual greeting anchor (prompt + responseCreate), sanitized");
        }

        if (assistantType === "gemini") {
            Logger.write("   ⏱️ Silence: gemini-specific (ping + 180s), NOT the shared 20s");
        } else {
            Logger.write("   ⏱️ Silence hard-timeout: " + (SILENCE_TIMEOUT_MS / 1000) + "s");
        }
        Logger.write("   🔑 Session ID: " + call_session_history_id);
        Logger.write("   📋 CRM: " + (CONTACT_NAME ? "YES (" + CONTACT_NAME + ")" : "NO"));
        Logger.write("   📋 Call type: " + callType);
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    } catch(err) {
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("❌ CRITICAL ERROR: " + err);
        if (err.stack) Logger.write(err.stack);
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        VoxEngine.terminate();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v5.4: ОБЩИЕ ОБРАБОТЧИКИ ЗВОНКА (RecordStarted / Failed / Disconnected)
    // Вынесены из четырёх веток — были одинаковыми, кроме логов.
    // Объявление через function declaration → доступно из веток выше (hoisting).
    // ══════════════════════════════════════════════════════════════════════════
    function attachCommonCallHandlers(c, provider) {
        c.addEventListener(CallEvents.RecordStarted, function(event) {
            if (event.url) {
                record_url = event.url;
                Logger.write("🎙️ Recording started: " + record_url);
            }
        });

        c.addEventListener(CallEvents.RecordStopped, function(event) {
            Logger.write("🎙️ Recording stopped");
            if (event.cost !== undefined) Logger.write("   Record cost: " + event.cost);
            if (event.url) record_url = event.url;
        });

        c.addEventListener(CallEvents.Failed, function(event) {
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("❌ CALL FAILED [" + provider + "] | Code: " + event.code + " | Reason: " + event.reason);
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            if (event.cost !== undefined) call_cost = event.cost;
            if (event.duration !== undefined) call_duration = event.duration;
            terminateCall();
        });

        c.addEventListener(CallEvents.Disconnected, function(event) {
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            Logger.write("📴 OUTBOUND CALL DISCONNECTED [" + provider + "]");
            Logger.write("   Target was: " + caller_number);
            if (event.cost !== undefined) {
                call_cost = event.cost;
                Logger.write("💰 Event cost: " + call_cost);
            }
            if (event.duration !== undefined) {
                call_duration = event.duration;
                Logger.write("⏱️ Duration: " + call_duration + "s");
            }
            Logger.write("🔑 Session ID: " + call_session_history_id);
            Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            terminateCall();
        });
    }
});
