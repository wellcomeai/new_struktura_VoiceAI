/*
 * Voximplant INBOUND Script — Yandex Realtime API v2.5-ttslive (voicyfy)
 * ====================================================================
 * ТЕСТОВАЯ КОПИЯ inbound_yandex v2.4 под модель Speech Realtime Max TTS Live.
 * Для проверки в кабинете Voximplant до раскатки; бэкенд не меняется.
 *
 *   • Модель берётся из TEST_MODEL (пусто — из конфига, как в v2.4).
 *   • Имя модели: Яндекс даёт URI gpt://<folder>/speech-realtime-max-tts-live/latest,
 *     а v2.4 передаёт коннектору короткое имя (speech-realtime-260528). Какой
 *     формат примет Voximplant для новой модели — неизвестно, поэтому каждая
 *     попытка подключения берёт следующий вариант из MODEL_NAME_VARIANTS.
 *     В логе: "🧪 MODEL VARIANT #N: ..." и "Actual session model".
 *   • Голоса: у LiveTTS свои голоса (sofia, vera, vasily, sergey, denis, irina),
 *     обычные (marina, dasha, ...) с ней несовместимы. Если голос ассистента не
 *     из LiveTTS — подставляется TEST_VOICE; амплуа, которого нет у голоса,
 *     не отправляется (голос говорит своим амплуа по умолчанию).
 *
 * Как проверить: номер привязать к любому Яндекс-ассистенту, правило номера
 * направить на этот сценарий, позвонить. Смотреть в логе: какой вариант имени
 * модели дал SessionCreated, нет ли Error после sessionUpdate (голос/амплуа),
 * задержку ответа, перебивания и вызов функций (hangup_call).
 * ====================================================================
 * Структура портирована с Gemini INBOUND v7.9.
 *
 * ══════════════════════════════════════════════════════════════════
 * ИЗМЕНЕНИЯ v2.4 (относительно v2.3):
 *   🔧 1. TOOLS РЕГИСТРИРУЮТСЯ В ПЕРВОМ sessionUpdate — ДО первого
 *      responseCreate (официальный паттерн Voximplant/Yandex).
 *      Причина: в v2.1–v2.3 tools подключались ВТОРЫМ sessionUpdate
 *      после приветствия. Сервер принимал их в состояние сессии
 *      (echo tools: 2), но пайплайн генерации НЕ начинал парсить
 *      tool-call токены → модель выдавала <function_call>{...}
 *      обычным текстом (звонок 10:50 15.07), функции не исполнялись.
 *   🔧 2. Флаг TOOL_CHOICE_GATING (default: false).
 *      false → точный официальный паттерн (tools сразу, без tool_choice).
 *      true  → tools сразу, но tool_choice: "none" на приветствии и
 *              "auto" после — защита, если утечка tool-токенов
 *              в приветствие (кейс v2.0/[TOOL_CALL_START]) вернётся.
 *   🔧 3. FALLBACK-ПАРСЕР текстовых вызовов: если модель всё же
 *      напечатает <function_call>{json}</function_call> в текст —
 *      перехватываем, исполняем через бэкенд, вычищаем маркап из
 *      CRM-логов. Страховка на случай багов модели.
 *   🔧 4. В system prompt добавлен запрет заявлять об успехе действия
 *      до получения результата функции (анти-галлюцинация
 *      "Готово, отправлено").
 * ══════════════════════════════════════════════════════════════════
 * ИЗМЕНЕНИЯ v2.3: двойной якорь первой фразы, sanitizeGreeting().
 * ИЗМЕНЕНИЯ v2.1: (упразднено в v2.4) tools после приветствия.
 * ══════════════════════════════════════════════════════════════════
 *
 * ФЛОУ:
 *   1. CallAlerting → call.ring() → клиент слышит гудки
 *   2. Загрузка конфига /api/telephony/config?phone=&caller=
 *   3. Retry подключения к Yandex Realtime (до 3 попыток × 3 сек)
 *   4. Path A: sessionUpdate #1 (ПОЛНЫЙ, С TOOLS) → call.answer()
 *      Path C: все попытки провалились → answer → TTS fallback → hangup
 *   5. Connected → запись звонка, таймеры сессии
 *   6. FirstAudioPacketReceived → sendMediaTo (односторонне) →
 *      greeting trigger через responseCreate({instructions})
 *   7. WebSocketMediaEnded (приветствие доиграло) → полный дуплекс →
 *      CONVERSATION (+ tool_choice → "auto", если гейтинг включён)
 *   8. Greeting timeout 7 сек → retry (до 2 попыток) → TTS fallback
 *   9. hangup_call: function_call_output → responseCreate(прощание) →
 *      WebSocketMediaEnded → hangup (+ safety-таймаут 8 сек)
 *
 * ЛОГИРОВАНИЕ: payload идентичен Gemini v7.9 (+ provider: "yandex").
 * ====================================================================
 */

require(Modules.Yandex);
require(Modules.Recorder);

// ====================================================================
// ЛОГИРОВАНИЕ
// ====================================================================
const LOG_LEVEL = "info"; // "debug" | "info" | "error"

function log(level, msg) {
    if (level === "error") {
        Logger.write("❌ " + msg);
    } else if (level === "info" && (LOG_LEVEL === "info" || LOG_LEVEL === "debug")) {
        Logger.write(msg);
    } else if (level === "debug" && LOG_LEVEL === "debug") {
        Logger.write("🔍 " + msg);
    }
}

// ====================================================================
// STATE MACHINE
// ====================================================================
const STATE = {
    INIT: "INIT",
    CONFIG_LOADING: "CONFIG_LOADING",
    YANDEX_CONNECTING: "YANDEX_CONNECTING",
    ANSWERING: "ANSWERING",
    WAITING_AUDIO: "WAITING_AUDIO",
    GREETING_SENT: "GREETING_SENT",
    CONVERSATION: "CONVERSATION",
    TERMINATING: "TERMINATING"
};

// ====================================================================
// КОНФИГУРАЦИЯ (дефолты — переопределяются конфигом voicyfy)
// ====================================================================
const SETUP_TIMEOUT_MS = 3000;          // ожидание SessionCreated на одну попытку
const MAX_RETRY_ATTEMPTS = 3;           // попыток подключения к Yandex
const MAX_GREETING_ATTEMPTS = 2;        // попыток приветствия
const GREETING_TIMEOUT_MS = 7000;       // ожидание начала речи ассистента
const SILENCE_TIMEOUT_MS = 180000;      // хард-таймаут обрыва при полной тишине (180с)
const SESSION_WARNING_MS = 9 * 60 * 1000;   // предупреждение о конце сессии
const SESSION_MAX_MS = 10 * 60 * 1000;      // максимум сессии (safety net)
const HANGUP_SAFETY_MS = 8000;          // если WebSocketMediaEnded не пришёл после hangup_call

// 🔧 v2.4: управление вызовами через tool_choice.
// false → официальный паттерн: tools в первом sessionUpdate, tool_choice
//         не отправляется вовсе (как в примере Voximplant).
// true  → tools в первом sessionUpdate + tool_choice "none" на приветствии,
//         переключение на "auto" после WebSocketMediaEnded приветствия.
//         Включать, если tool-токены полезут в текст приветствия.
const TOOL_CHOICE_GATING = false;

const DEFAULT_MODEL = "speech-realtime-260528";
const DEFAULT_VOICE = "marina";
const DEFAULT_VAD_THRESHOLD = 0.5;
const DEFAULT_VAD_SILENCE_MS = 500;

// ====================================================================
// 🧪 v2.5-ttslive: ТЕСТОВЫЕ НАСТРОЙКИ
// ====================================================================
const TEST_MODEL = "speech-realtime-max-tts-live/latest"; // "" — модель из конфига
const TEST_VOICE = "sofia";      // голос LiveTTS, если у ассистента обычный голос
const TEST_VOICE_ROLE = "";      // "" — амплуа голоса по умолчанию

// Голоса LiveTTS и их амплуа (первое — по умолчанию у Яндекса)
const LIVE_TTS_VOICES = {
    sofia:  ["support", "casual"],
    vera:   ["support", "casual"],
    vasily: ["support", "sales"],
    sergey: ["support", "sales"],
    denis:  ["neutral", "casual", "formal", "sales"],
    irina:  ["neutral", "formal", "support", "narrator", "sales"]
};

function isLiveTtsModel(model) {
    return String(model || "").indexOf("tts-live") !== -1;
}

// Варианты имени модели для попыток подключения (#1, #2, #3)
function modelNameVariants(model, folderId) {
    const m = String(model || "");
    if (m.indexOf("gpt://") === 0) return [m];
    const base = m.replace(/\/latest$/, "");
    const variants = [m];
    if (base !== m) variants.push(base);
    if (folderId) variants.push("gpt://" + folderId + "/" + base + "/latest");
    const out = [];
    for (let i = 0; i < variants.length; i++) {
        if (out.indexOf(variants[i]) === -1) out.push(variants[i]);
    }
    return out;
}

const TTS_FALLBACK_MESSAGE = "Извините, временные технические проблемы. Пожалуйста, перезвоните позже.";

// 🔧 v2.4: маркап текстового вызова функции (fallback-парсер)
const FUNCTION_CALL_TEXT_RE = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/i;

// ====================================================================
// 🔧 v2.3: САНИТИЗАЦИЯ ПЕРВОЙ ФРАЗЫ
// ====================================================================
function sanitizeGreeting(raw) {
    if (!raw) return "";
    let s = String(raw).trim();

    let prev = "";
    while (prev !== s) {
        prev = s;
        s = s.replace(/^(повтори(те)?\s+дословно\s*)/i, "");
        s = s.replace(/^(произнеси(те)?\s+(фразу|текст)\s*)/i, "");
        s = s.replace(/^(скажи(те)?\s+(фразу|текст|дословно)\s*)/i, "");
        s = s.replace(/^[:,\-—]\s*/, "");
        s = s.trim();
    }

    prev = "";
    while (prev !== s) {
        prev = s;
        s = s.replace(/^["'«„“”'‚]+/, "").replace(/["'»“”'‛]+$/, "").trim();
    }

    s = s.replace(/["«»„“”]/g, "").replace(/[\r\n]+/g, " ");
    s = s.replace(/\s{2,}/g, " ").trim();

    return s;
}

// ====================================================================
// SESSION ID
// ====================================================================
let call_session_history_id = null;

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("info", "🚀 APP STARTED (INBOUND Yandex v2.4)");
    log("info", "🔑 Session History ID: " + call_session_history_id);
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

VoxEngine.addEventListener(AppEvents.CallAlerting, async function(e) {
    const call = e.call;
    let realtimeAPIClient = null;
    let activePath = null;

    // ====================================================================
    // СОСТОЯНИЕ
    // ====================================================================
    let currentState = STATE.INIT;

    function setState(newState) {
        log("debug", "📊 STATE: " + currentState + " → " + newState);
        currentState = newState;
    }

    const chat_id = "vox_yandex_" + Math.random().toString(36).substring(2, 15);
    const caller_number = call.callerid() || "unknown";
    const called_number = e.destination || "unknown";
    const call_id = call.id();

    let record_url = null;
    let call_cost = 0;
    let call_duration = 0;

    // ====================================================================
    // 📞 ГУДКИ — СРАЗУ
    // ====================================================================
    call.ring();
    log("info", "📞 RING → клиент слышит гудки");

    // ====================================================================
    // ТАЙМЕРЫ
    // ====================================================================
    let greetingTimeoutId = null;
    let silenceTimeoutId = null;
    let sessionWarningTimeoutId = null;
    let sessionMaxTimeoutId = null;
    let hangupSafetyTimeoutId = null;

    function clearAllTimers() {
        if (greetingTimeoutId)       { clearTimeout(greetingTimeoutId);       greetingTimeoutId = null; }
        if (silenceTimeoutId)        { clearTimeout(silenceTimeoutId);        silenceTimeoutId = null; }
        if (sessionWarningTimeoutId) { clearTimeout(sessionWarningTimeoutId); sessionWarningTimeoutId = null; }
        if (sessionMaxTimeoutId)     { clearTimeout(sessionMaxTimeoutId);     sessionMaxTimeoutId = null; }
        if (hangupSafetyTimeoutId)   { clearTimeout(hangupSafetyTimeoutId);   hangupSafetyTimeoutId = null; }
    }

    function resetSilenceTimer() {
        if (silenceTimeoutId) clearTimeout(silenceTimeoutId);

        if (currentState === STATE.CONVERSATION) {
            silenceTimeoutId = setTimeout(function() {
                log("error", "⏱️ SILENCE TIMEOUT: " + (SILENCE_TIMEOUT_MS / 1000) + "s");
                terminateCall();
            }, SILENCE_TIMEOUT_MS);
        }
    }

    // ====================================================================
    // GREETING / HANGUP ФЛАГИ
    // ====================================================================
    let greetingMessage = "";
    let assistantStartedSpeaking = false;
    let greetingAttempt = 0;
    let greetingLogged = false;   // фейковый "Алло" уже добавлен в dialogLog
    let duplexActive = false;     // полный дуплекс открыт
    let hangupRequested = false;  // hangup_call вызван — ждём конца прощания
    let toolCallsEnabled = false; // v2.4: tool_choice переключён в "auto" (или гейтинг выключен)

    function determineGreeting(configFirstPhrase) {
        const cleaned = sanitizeGreeting(configFirstPhrase);
        if (cleaned) return cleaned;
        return "Здравствуйте! Чем могу помочь?";
    }

    // ====================================================================
    // GREETING TRIGGER — через responseCreate({instructions})
    // ====================================================================
    function sendGreetingTrigger() {
        greetingAttempt++;

        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("info", "👋 GREETING ATTEMPT #" + greetingAttempt + "/" + MAX_GREETING_ATTEMPTS);
        log("info", "   Expected: " + greetingMessage.substring(0, 60));
        log("info", "   Timeout: " + (GREETING_TIMEOUT_MS / 1000) + "s");
        log("info", "   v2.4: tools registered since sessionUpdate #1" +
            (TOOL_CHOICE_GATING ? " (tool_choice: none until greeting done)" : ""));
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        try {
            realtimeAPIClient.responseCreate({
                instructions: "Скажи дословно следующий текст и больше ничего. Не добавляй, не сокращай, не перефразируй и не комментируй:\n\n" + greetingMessage
            });
        } catch (err) {
            log("error", "responseCreate (greeting): " + err);
        }

        if (greetingTimeoutId) clearTimeout(greetingTimeoutId);
        greetingTimeoutId = setTimeout(function() {
            if (!assistantStartedSpeaking && currentState !== STATE.TERMINATING) {
                log("info", "⚠️ GREETING TIMEOUT (attempt #" + greetingAttempt + ")");

                if (greetingAttempt < MAX_GREETING_ATTEMPTS) {
                    log("info", "🔄 Retrying greeting...");
                    sendGreetingTrigger();
                } else {
                    greetingFailed();
                }
            }
        }, GREETING_TIMEOUT_MS);
    }

    // ====================================================================
    // GREETING FAILED → TTS FALLBACK + HANGUP
    // ====================================================================
    function greetingFailed() {
        if (currentState === STATE.TERMINATING) return;

        log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("error", "❌ GREETING FAILED after " + greetingAttempt + " attempts");
        log("error", "   Yandex не произнёс приветствие → TTS fallback → hangup");
        log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        try {
            if (realtimeAPIClient) realtimeAPIClient.stopMediaTo(call);
        } catch (err) {}

        call.say(TTS_FALLBACK_MESSAGE, { language: Language.RU_RUSSIAN_FEMALE });

        call.addEventListener(CallEvents.PlaybackFinished, function onFallbackDone() {
            log("info", "✅ TTS fallback finished → terminating");
            terminateCall();
        });
    }

    // ====================================================================
    // СТРУКТУРИРОВАННЫЙ ДИАЛОГ
    // ====================================================================
    let dialogLog = [];
    let userMessageBuffer = "";
    let assistantMessageBuffer = "";
    let lastFunctionResult = null;
    let logCounter = 0;

    // ====================================================================
    // КОНФИГУРАЦИЯ
    // ====================================================================
    let CONFIG = null;
    let ASSISTANT_ID = null;
    let functionNameToIdMap = {};
    let functionIdToNameMap = {};   // v2.4: обратная карта для fallback-парсера
    let yandexTools = [];
    let finalSystemPrompt = "";
    let YANDEX_MODEL = "";
    let YANDEX_VOICE = "";
    let YANDEX_VOICE_ROLE = "";
    let MODEL_NAME_VARIANTS = [];
    let actualSessionModel = null;

    // v2.4: дедупликация текстовых вызовов (один и тот же маркап может
    // прийти и в text.done, и в audio_transcript.done)
    const processedTextCalls = {};

    const CONFIG_URL = "https://voicyfy.ru/api/telephony/config?phone=" + called_number.replace(/\D/g, "") + "&caller=" + caller_number.replace(/\D/g, "");
    const FUNCTIONS_URL = "https://voicyfy.ru/api/voximplant/functions/execute";
    const LOG_URL = "https://voicyfy.ru/api/voximplant/log";

    log("info", "📞 INBOUND CALL (Yandex v2.5-ttslive)");
    log("info", "   From: " + caller_number + " → To: " + called_number);
    log("info", "   Call ID: " + call_id);

    // ====================================================================
    // v2.4: СБОРКА sessionUpdate.
    // Tools ВСЕГДА в сессии (пайплайн должен знать о них с первого
    // ответа — иначе tool-call токены утекают в текст, кейс v2.3).
    // allowToolCalls управляет только tool_choice — и только при
    // включённом TOOL_CHOICE_GATING. При выключенном гейтинге поле
    // tool_choice не отправляется вовсе (официальный паттерн).
    // ====================================================================
    function buildSessionUpdate(allowToolCalls) {
        const sessionUpdate = {
            session: {
                type: "realtime",
                instructions: finalSystemPrompt,
                output_modalities: ["audio"],
                audio: {
                    input: {
                        turn_detection: {
                            type: "server_vad",
                            threshold: (CONFIG.vad_threshold !== undefined) ? CONFIG.vad_threshold : DEFAULT_VAD_THRESHOLD,
                            silence_duration_ms: (CONFIG.vad_silence_ms !== undefined) ? CONFIG.vad_silence_ms : DEFAULT_VAD_SILENCE_MS
                        }
                    },
                    output: {
                        voice: YANDEX_VOICE
                    }
                }
            }
        };

        // Язык распознавания (если задан в конфиге)
        if (CONFIG.language) {
            const langMap = { ru: "ru-RU", kk: "kk-KZ", en: "en-US", uz: "uz-UZ" };
            const lang = langMap[CONFIG.language] || CONFIG.language;
            sessionUpdate.session.audio.input.languages = [lang];
        }

        // Амплуа голоса (если задано)
        if (YANDEX_VOICE_ROLE) {
            sessionUpdate.session.audio.output.role = YANDEX_VOICE_ROLE;
        }

        // v2.4: tools всегда, tool_choice — только при гейтинге
        if (yandexTools.length > 0) {
            sessionUpdate.session.tools = yandexTools;
            if (TOOL_CHOICE_GATING) {
                sessionUpdate.session.tool_choice = allowToolCalls ? "auto" : "none";
            }
        }

        return sessionUpdate;
    }

    // ====================================================================
    // v2.4: РАЗРЕШЕНИЕ ВЫЗОВОВ ПОСЛЕ ПРИВЕТСТВИЯ (идемпотентное).
    // При выключенном гейтинге — no-op (tools активны с самого старта).
    // При включённом — переключаем tool_choice none → auto.
    // ====================================================================
    function enableToolCallsPostGreeting() {
        if (toolCallsEnabled) return;
        toolCallsEnabled = true;

        if (yandexTools.length === 0) {
            log("info", "🔧 No tools (config has none)");
            return;
        }

        if (!TOOL_CHOICE_GATING) {
            log("info", "🔧 Tools active since session start (" + yandexTools.length + "), gating disabled — no-op");
            return;
        }

        try {
            realtimeAPIClient.sessionUpdate(buildSessionUpdate(true));
            log("info", "🔧 TOOL_CHOICE → auto (" + yandexTools.length + " tools registered since session start)");
        } catch (err) {
            toolCallsEnabled = false; // позволим повторить при следующем MediaEnded
            log("error", "enableToolCallsPostGreeting sessionUpdate: " + err);
        }
    }

    // ====================================================================
    // ЗАВЕРШЕНИЕ ЗВОНКА (идемпотентное)
    // ====================================================================
    let terminatePromise = null;

    const terminateCall = function() {
        if (terminatePromise) return terminatePromise;

        terminatePromise = (async function() {
            setState(STATE.TERMINATING);
            clearAllTimers();

            log("info", "📴 Terminating call... (active path: " + activePath + ")");

            if (realtimeAPIClient) {
                try { realtimeAPIClient.close(); } catch (err) {}
            }

            if (call && record_url) {
                try { call.stopRecord(); } catch (err) {}
            }

            await new Promise(function(resolve) { setTimeout(resolve, 500); });

            try {
                if (call) {
                    if (typeof call.cost === "function") call_cost = call.cost() || 0;
                    if (typeof call.duration === "function") call_duration = call.duration() || 0;
                }
            } catch (err) {}

            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            log("info", "💰 BILLING (Yandex v2.5-ttslive):");
            log("info", "   🔑 Session: " + (call_session_history_id || "NONE"));
            log("info", "   🛣️ Active Path: " + activePath);
            log("info", "   🤖 Model: " + YANDEX_MODEL + " | actual: " + (actualSessionModel || "n/a"));
            log("info", "   💰 Cost: " + call_cost + " | ⏱️ Duration: " + call_duration + "s");
            log("info", "   📝 Dialog turns: " + dialogLog.length);
            log("info", "   👋 Greeting attempts: " + greetingAttempt);
            log("info", "   🔧 Tool calls enabled: " + toolCallsEnabled + " | gating: " + TOOL_CHOICE_GATING);
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            if (userMessageBuffer || assistantMessageBuffer || dialogLog.length > 0) {
                try {
                    await sendConversationLog(true);
                    log("info", "✅ Final log sent");
                } catch (err) {
                    log("error", "Final log: " + err);
                }
            } else {
                log("info", "⚠️ No dialog to log");
            }

            if (call) {
                try { call.hangup(); } catch (err) {}
            }

            setTimeout(function() {
                log("info", "✅ Call terminated. Path: " + activePath +
                    " | Turns: " + dialogLog.length +
                    " | Greeting attempts: " + greetingAttempt);
                VoxEngine.terminate();
            }, 500);
        })();

        return terminatePromise;
    };

    // ====================================================================
    // ЛОГИРОВАНИЕ ДИАЛОГА (payload идентичен Gemini v7.9 + provider)
    // ====================================================================
    async function sendConversationLog(isFinal) {
        try {
            if (!userMessageBuffer && !assistantMessageBuffer && dialogLog.length === 0) {
                log("debug", "Empty dialog, skipping");
                return;
            }
            if (!ASSISTANT_ID) {
                log("error", "No ASSISTANT_ID");
                return;
            }

            logCounter++;
            log("info", "📤 LOG #" + logCounter + (isFinal ? " (FINAL)" : "") +
                " | User: " + userMessageBuffer.length + "ch" +
                " | Assistant: " + assistantMessageBuffer.length + "ch" +
                " | Turns: " + dialogLog.length);

            const payload = {
                assistant_id: ASSISTANT_ID,
                chat_id: chat_id,
                call_id: call_id,
                caller_number: "INBOUND:" + caller_number,
                type: "conversation",
                provider: "yandex",
                data: {
                    user_message: userMessageBuffer,
                    assistant_message: assistantMessageBuffer,
                    dialog: dialogLog,
                    function_result: lastFunctionResult
                }
            };

            if (isFinal) {
                if (record_url) payload.record_url = record_url;
                if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);
                payload.call_cost = call_cost;
                payload.call_duration = call_duration;
                payload.active_path = activePath;
                payload.greeting_attempts = greetingAttempt;
                payload.yandex_model = actualSessionModel || YANDEX_MODEL;
            }

            const response = await Net.httpRequestAsync(LOG_URL, {
                headers: ["Content-Type: application/json"],
                method: "POST",
                postData: JSON.stringify(payload)
            });

            if (response.code == 200) {
                log("info", "✅ Log #" + logCounter + " sent");
                if (!isFinal) {
                    userMessageBuffer = "";
                    assistantMessageBuffer = "";
                    dialogLog = [];
                }
            } else {
                log("error", "Log HTTP " + response.code + ": " + response.text);
            }
        } catch (error) {
            log("error", "sendConversationLog: " + error);
        }
    }

    // ====================================================================
    // ИСПОЛНЕНИЕ ФУНКЦИИ ЧЕРЕЗ БЭКЕНД (общее для native и fallback путей)
    // Возвращает результат (объект) либо { error: ... }.
    // ====================================================================
    async function executeBackendFunction(functionName, args) {
        const cleanArgs = Object.assign({}, args);
        const function_id = cleanArgs.function_id || functionNameToIdMap[functionName];
        delete cleanArgs.function_id;

        if (!function_id) {
            log("error", "No function_id for: " + functionName);
            return { error: "Function ID not found" };
        }

        const payload = {
            function_id: function_id,
            arguments: Object.assign({}, cleanArgs, { assistant_id: ASSISTANT_ID }),
            call_data: { call_id: call_id, chat_id: chat_id, assistant_id: ASSISTANT_ID, caller_number: caller_number }
        };

        const functionResponse = await Net.httpRequestAsync(FUNCTIONS_URL, {
            headers: ["Content-Type: application/json"],
            method: "POST",
            postData: JSON.stringify(payload)
        });

        if (functionResponse.code == 200) {
            const result = JSON.parse(functionResponse.text);
            log("info", "✅ Function result: " + JSON.stringify(result).substring(0, 200));
            lastFunctionResult = result;
            return result;
        }

        log("error", "Function HTTP " + functionResponse.code);
        return { error: "HTTP " + functionResponse.code };
    }

    // ====================================================================
    // ОБРАБОТКА НАТИВНОГО FUNCTION_CALL (item type "function_call")
    // Протокол Yandex: function_call_output через conversationItemCreate,
    // затем ОБЯЗАТЕЛЬНЫЙ responseCreate — иначе модель молчит.
    // ====================================================================
    async function handleFunctionCall(callId, functionName, argumentsStr) {
        try {
            let args = {};
            try { args = argumentsStr ? JSON.parse(argumentsStr) : {}; } catch (err) {}

            log("info", "🔧 FUNCTION (native): " + functionName + " | Args: " + JSON.stringify(args).substring(0, 200));

            // ─────────────── hangup_call — локально ───────────────
            if (functionName === "hangup_call") {
                log("info", "📴 HANGUP" + (args.farewell_message ? ": " + args.farewell_message : ""));

                lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
                hangupRequested = true;

                realtimeAPIClient.conversationItemCreate({
                    item: {
                        type: "function_call_output",
                        call_id: callId,
                        output: "Ok, call will be terminated after farewell"
                    }
                });

                const farewellText = sanitizeGreeting(args.farewell_message);
                const farewellInstruction = farewellText
                    ? "Скажи дословно следующий текст и больше ничего:\n\n" + farewellText
                    : "Коротко и вежливо попрощайся с собеседником.";
                realtimeAPIClient.responseCreate({ instructions: farewellInstruction });

                hangupSafetyTimeoutId = setTimeout(function() {
                    log("info", "⏱️ Hangup safety timeout → terminating");
                    terminateCall();
                }, HANGUP_SAFETY_MS);
                return;
            }

            // ─────────────── Функции через бэкенд voicyfy ───────────────
            const result = await executeBackendFunction(functionName, args);

            realtimeAPIClient.conversationItemCreate({
                item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) }
            });
            realtimeAPIClient.responseCreate({});

        } catch (error) {
            log("error", "handleFunctionCall: " + error);
            try {
                realtimeAPIClient.conversationItemCreate({
                    item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: String(error) }) }
                });
                realtimeAPIClient.responseCreate({});
            } catch (err) {}
        }
    }

    // ====================================================================
    // 🔧 v2.4: FALLBACK — ВЫЗОВ ФУНКЦИИ, НАПЕЧАТАННЫЙ ТЕКСТОМ.
    // Модель вместо нативного function_call item выдала в текст маркап
    // <function_call>{json}</function_call> (баг пайплайна Yandex,
    // кейс 15.07). Перехватываем, исполняем, результат возвращаем
    // модели через responseCreate({instructions}) — function_call_output
    // тут невозможен (нет call_id).
    // ====================================================================
    async function handleTextFunctionCall(rawJson) {
        try {
            // Дедупликация: тот же маркап приходит в нескольких done-событиях
            if (processedTextCalls[rawJson]) return;
            processedTextCalls[rawJson] = true;

            let args = {};
            try { args = JSON.parse(rawJson); } catch (err) {
                log("error", "FALLBACK: bad JSON in <function_call>: " + rawJson.substring(0, 200));
                return;
            }

            // Определяем имя функции: по function_id из аргументов
            // или единственной подходящей из карты
            let functionName = null;
            if (args.function_id && functionIdToNameMap[String(args.function_id)]) {
                functionName = functionIdToNameMap[String(args.function_id)];
            } else if (args.name && functionNameToIdMap[args.name]) {
                functionName = args.name;
            }

            if (!functionName) {
                log("error", "FALLBACK: cannot resolve function name from: " + rawJson.substring(0, 200));
                return;
            }

            log("info", "⚠️ FALLBACK: function call came as TEXT (not native item!)");
            log("info", "🔧 FUNCTION (text-fallback): " + functionName + " | Args: " + rawJson.substring(0, 200));

            // hangup_call текстом — завершаем по той же схеме
            if (functionName === "hangup_call") {
                lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
                hangupRequested = true;

                const farewellText = sanitizeGreeting(args.farewell_message);
                const farewellInstruction = farewellText
                    ? "Скажи дословно следующий текст и больше ничего:\n\n" + farewellText
                    : "Коротко и вежливо попрощайся с собеседником.";
                try { realtimeAPIClient.responseCreate({ instructions: farewellInstruction }); } catch (err) {}

                hangupSafetyTimeoutId = setTimeout(function() {
                    log("info", "⏱️ Hangup safety timeout → terminating");
                    terminateCall();
                }, HANGUP_SAFETY_MS);
                return;
            }

            const result = await executeBackendFunction(functionName, args);

            // Сообщаем модели результат (вместо function_call_output)
            const ok = result && !result.error && result.success !== false;
            try {
                realtimeAPIClient.responseCreate({
                    instructions: ok
                        ? "Функция " + functionName + " выполнена успешно. Результат: " +
                          JSON.stringify(result).substring(0, 300) +
                          "\nКоротко сообщи собеседнику, что действие выполнено. Не зачитывай сырые данные."
                        : "Функция " + functionName + " завершилась ошибкой: " +
                          JSON.stringify(result).substring(0, 300) +
                          "\nКоротко извинись и сообщи, что действие выполнить не удалось. Не зачитывай сырые данные."
                });
            } catch (err) {
                log("error", "FALLBACK responseCreate: " + err);
            }

        } catch (error) {
            log("error", "handleTextFunctionCall: " + error);
        }
    }

    // v2.4: вычистка маркапа из текста для CRM-логов + запуск fallback
    function extractAndCleanTextCalls(text) {
        if (!text) return text;
        let cleaned = text;
        let match;
        while ((match = FUNCTION_CALL_TEXT_RE.exec(cleaned)) !== null) {
            const rawJson = match[1];
            // исполняем асинхронно, транскрипт не ждёт
            handleTextFunctionCall(rawJson);
            cleaned = cleaned.replace(match[0], "").trim();
        }
        return cleaned;
    }

    // ====================================================================
    // ОБРАБОТЧИКИ СОБЫТИЙ YANDEX
    // ====================================================================
    function setupYandexEventHandlers(client) {

        // ──────────────────────────────────────────
        // SessionUpdated — подтверждение конфигурации
        // v2.4: логируем и tool_choice — ключевая диагностика
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.SessionUpdated, function(event) {
            const session = event.data && event.data.payload ? event.data.payload.session : null;
            const voice = session && session.audio && session.audio.output ? session.audio.output.voice : "unknown";
            const instrLen = session && session.instructions ? session.instructions.length : 0;
            const toolCount = session && session.tools ? session.tools.length : 0;
            const toolChoice = session && session.tool_choice ? session.tool_choice : "n/a";
            if (session && session.model) actualSessionModel = session.model;
            log("info", "🔄 SessionUpdated | voice: " + voice + " | instructions: " + instrLen + " chars" +
                " | tools: " + toolCount + " | tool_choice: " + toolChoice +
                (session && session.model ? " | model: " + session.model : ""));
        });

        // ──────────────────────────────────────────
        // ТРАНСКРИПЦИЯ ПОЛЬЗОВАТЕЛЯ (целая реплика)
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function(event) {
            if (activePath !== "A") return;
            const transcript = event.data && event.data.payload ? event.data.payload.transcript : null;
            if (!transcript) return;

            log("info", "👤 USER: " + transcript);
            dialogLog.push({ role: "user", text: transcript, ts: Date.now() });
            if (userMessageBuffer && !userMessageBuffer.endsWith(" ")) userMessageBuffer += " ";
            userMessageBuffer += transcript;
            resetSilenceTimer();
        });

        // ──────────────────────────────────────────
        // ТРАНСКРИПЦИЯ АССИСТЕНТА (целый ответ)
        // v2.4: сначала перехватываем текстовые <function_call>,
        // в CRM-лог идёт очищенный текст
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputAudioTranscriptDone, function(event) {
            if (activePath !== "A") return;
            let transcript = event.data && event.data.payload ? event.data.payload.transcript : null;
            if (!transcript) return;

            // Детект начала речи (страховка, если Media-событие не отработало)
            markAssistantSpeaking("transcript");

            // v2.4: fallback-парсер + очистка маркапа
            transcript = extractAndCleanTextCalls(transcript);

            // Фейковый "Алло" перед приветствием — для консистентности CRM
            if (!greetingLogged) {
                greetingLogged = true;
                dialogLog.push({ role: "user", text: "Алло", ts: Date.now() - 5000 });
                if (!userMessageBuffer) userMessageBuffer = "Алло";
            }

            if (!transcript) return; // ответ состоял только из маркапа

            log("info", "🤖 ASSISTANT: " + transcript.substring(0, 100) + (transcript.length > 100 ? "..." : ""));
            dialogLog.push({ role: "assistant", text: transcript, ts: Date.now() });
            if (assistantMessageBuffer && !assistantMessageBuffer.endsWith(" ")) assistantMessageBuffer += " ";
            assistantMessageBuffer += transcript;
            resetSilenceTimer();
        });

        // ──────────────────────────────────────────
        // FUNCTION CALLING (нативный путь)
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputItemDone, async function(event) {
            if (activePath !== "A") return;
            try {
                const item = event.data && event.data.payload ? event.data.payload.item : null;
                if (!item || item.type !== "function_call") return;
                if (!item.name) return;
                await handleFunctionCall(item.call_id, item.name, item.arguments);
            } catch (error) {
                log("error", "ResponseOutputItemDone: " + error);
            }
        });

        // ──────────────────────────────────────────
        // BARGE-IN: пользователь начал говорить → чистим буфер
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.InputAudioBufferSpeechStarted, function() {
            if (activePath !== "A") return;
            log("debug", "🔇 User speech started (barge-in)");
            try { client.clearMediaBuffer(); } catch (err) {}
            resetSilenceTimer();
        });

        // ──────────────────────────────────────────
        // МЕДИА: аудио от Yandex пошло / закончилось
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.Events.WebSocketMediaStarted, function() {
            log("debug", "🎵 Media started (audio from Yandex)");
            markAssistantSpeaking("media");
        });

        client.addEventListener(Yandex.Events.WebSocketMediaEnded, function() {
            log("debug", "🎵 Media ended");

            // ── Прощание доиграло → вешаем трубку ──
            if (hangupRequested) {
                log("info", "👋 Farewell finished → hangup");
                setTimeout(function() { terminateCall(); }, 500);
                return;
            }

            // ── Приветствие ПОЛНОСТЬЮ доиграло → полный дуплекс ──
            if (currentState === STATE.GREETING_SENT && assistantStartedSpeaking && !duplexActive) {
                duplexActive = true;
                setState(STATE.CONVERSATION);

                // v2.4: tools уже в сессии; здесь только снимаем гейтинг
                // (tool_choice → auto), если он включён
                enableToolCallsPostGreeting();

                VoxEngine.sendMediaBetween(call, realtimeAPIClient);
                log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                log("info", "🎙️ Full duplex ACTIVE (sendMediaBetween) — greeting fully played");
                log("info", "✅ Greeting complete (attempt #" + greetingAttempt + ") → CONVERSATION");
                log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                resetSilenceTimer();
            }
        });

        // ──────────────────────────────────────────
        // ОШИБКИ И ПРОЧЕЕ
        // ──────────────────────────────────────────
        client.addEventListener(Yandex.RealtimeAPIEvents.Error, function(event) {
            log("error", "Yandex Error: " + JSON.stringify(event.data));
        });

        client.addEventListener(Yandex.RealtimeAPIEvents.WebSocketError, function(event) {
            log("error", "Yandex WebSocketError: " + JSON.stringify(event.data));
        });

        client.addEventListener(Yandex.RealtimeAPIEvents.RateLimitsUpdated, function(event) {
            log("debug", "⏳ RateLimitsUpdated: " + JSON.stringify(event.data));
        });

        client.addEventListener(Yandex.RealtimeAPIEvents.Unknown, function(event) {
            log("debug", "⚠️ Unknown Yandex event: " + JSON.stringify(event));
        });
    }

    // Единая точка: "ассистент заговорил" (для greeting-логики)
    function markAssistantSpeaking(source) {
        if (assistantStartedSpeaking) return;
        if (currentState !== STATE.GREETING_SENT) return;

        assistantStartedSpeaking = true;

        if (greetingTimeoutId) {
            clearTimeout(greetingTimeoutId);
            greetingTimeoutId = null;
        }

        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("info", "✅ YANDEX STARTED SPEAKING (attempt #" + greetingAttempt + ", via " + source + ")");
        log("info", "   → waiting WebSocketMediaEnded for full duplex");
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }

    // ====================================================================
    // ПОДКЛЮЧЕНИЕ К YANDEX С RETRY
    // ====================================================================
    function attemptYandexConnection(attemptNum) {
        return new Promise(async function(resolve, reject) {
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            log("info", "🔌 ATTEMPT #" + attemptNum + "/" + MAX_RETRY_ATTEMPTS + ": Connecting to Yandex Realtime...");
            log("info", "   Model: " + YANDEX_MODEL);
            log("info", "   Timeout: " + SETUP_TIMEOUT_MS + "ms");
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            let sessionReceived = false;
            let timeoutId = null;
            let client = null;

            // 🧪 v2.5: каждая попытка — следующий формат имени модели
            const modelName = MODEL_NAME_VARIANTS.length > 0
                ? MODEL_NAME_VARIANTS[(attemptNum - 1) % MODEL_NAME_VARIANTS.length]
                : YANDEX_MODEL;
            log("info", "   🧪 MODEL VARIANT #" + attemptNum + ": " + modelName);

            try {
                client = await Yandex.createRealtimeAPIClient({
                    apiKey: CONFIG.api_key,
                    folderId: CONFIG.folder_id,
                    model: modelName,
                    onWebSocketClose: function(event) {
                        log("info", "🔌 Yandex WebSocket closed (attempt #" + attemptNum + ")" +
                            (event && event.code ? " code: " + event.code : ""));

                        if (!sessionReceived) {
                            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                            reject(new Error("WebSocket closed before SessionCreated"));
                        } else if (currentState !== STATE.TERMINATING && activePath === "A") {
                            terminateCall();
                        }
                    }
                });

                log("info", "   ✅ Client created, waiting SessionCreated...");

                client.addEventListener(Yandex.RealtimeAPIEvents.SessionCreated, function(event) {
                    if (sessionReceived) return;
                    sessionReceived = true;

                    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

                    const session = event.data && event.data.payload ? event.data.payload.session : null;
                    if (session && session.model) {
                        actualSessionModel = session.model;
                        log("info", "   🤖 Actual session model: " + session.model);
                    }

                    log("info", "   ✅ SessionCreated received! (attempt #" + attemptNum + ", model name: " + modelName + ")");
                    YANDEX_MODEL = modelName;
                    resolve(client);
                });

                timeoutId = setTimeout(function() {
                    if (!sessionReceived) {
                        log("info", "   ⚠️ TIMEOUT " + SETUP_TIMEOUT_MS + "ms (attempt #" + attemptNum + ")");
                        try { client.close(); } catch (err) {}
                        client = null;
                        reject(new Error("SessionCreated timeout"));
                    }
                }, SETUP_TIMEOUT_MS);

            } catch (err) {
                log("error", "   ❌ createRealtimeAPIClient error (attempt #" + attemptNum + "): " + err);
                if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                reject(err);
            }
        });
    }

    async function connectWithRetry() {
        for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
            if (currentState === STATE.TERMINATING) return null;

            try {
                const client = await attemptYandexConnection(attempt);
                return client;
            } catch (err) {
                log("info", "   ❌ Attempt #" + attempt + " failed: " + err.message);

                if (attempt >= MAX_RETRY_ATTEMPTS) {
                    log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    log("error", "❌ ALL " + MAX_RETRY_ATTEMPTS + " ATTEMPTS FAILED");
                    log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                }
            }
        }
        return null;
    }

    // ====================================================================
    // CONNECTED HANDLER
    // ====================================================================
    call.addEventListener(CallEvents.Connected, function() {
        log("info", "✅ CALL CONNECTED | Path: " + activePath + " | From: " + caller_number);

        call.record({ stereo: false, lossless: false, hd_audio: true });

        if (activePath === "A") {
            setState(STATE.WAITING_AUDIO);
            log("info", "⏳ Waiting for FirstAudioPacketReceived before greeting...");

            sessionWarningTimeoutId = setTimeout(function() {
                log("info", "⚠️ Session: 1 min remaining");
                if (realtimeAPIClient && currentState === STATE.CONVERSATION) {
                    try {
                        realtimeAPIClient.responseCreate({
                            instructions: "Вежливо предупреди собеседника, что время сессии подходит к концу, и предложи завершить разговор."
                        });
                    } catch (err) {}
                }
            }, SESSION_WARNING_MS);

            sessionMaxTimeoutId = setTimeout(function() {
                log("info", "⏱️ Session TTL reached");
                terminateCall();
            }, SESSION_MAX_MS);
        }
        else if (activePath === "C") {
            log("info", "🟡 PATH C: TTS fallback — Yandex unavailable");

            call.say(TTS_FALLBACK_MESSAGE, { language: Language.RU_RUSSIAN_FEMALE });

            call.addEventListener(CallEvents.PlaybackFinished, function onTTSDone() {
                log("info", "✅ TTS fallback finished → terminating");
                terminateCall();
            });
        }
    });

    // ====================================================================
    // FirstAudioPacketReceived — точка отправки greeting
    // ====================================================================
    call.addEventListener(CallEvents.FirstAudioPacketReceived, function() {
        if (activePath !== "A") return;
        if (currentState !== STATE.WAITING_AUDIO) return;

        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("info", "🎙️ FirstAudioPacketReceived — audio stream ready!");
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // Односторонний поток: Yandex → клиент.
        // Микрофон клиента НЕ идёт в Yandex до конца приветствия.
        realtimeAPIClient.sendMediaTo(call);
        log("info", "🔇 Client mic MUTED (Yandex→client only, waiting greeting)");

        setState(STATE.GREETING_SENT);
        sendGreetingTrigger();
    });

    // ====================================================================
    // MAIN FLOW
    // ====================================================================
    try {
        // ══════════════════════════════════════════════════════════════
        // ШАГ 1: ЗАГРУЗКА КОНФИГА
        // ══════════════════════════════════════════════════════════════
        setState(STATE.CONFIG_LOADING);
        log("info", "🔄 Loading config: " + CONFIG_URL);

        const configResponse = await Net.httpRequestAsync(CONFIG_URL);

        if (configResponse.code != 200) {
            log("error", "Config failed: HTTP " + configResponse.code);
            VoxEngine.terminate();
            return;
        }

        CONFIG = JSON.parse(configResponse.text);

        if (!CONFIG.success || CONFIG.assistant_type !== "yandex") {
            log("error", "Config invalid: success=" + CONFIG.success + " type=" + CONFIG.assistant_type);
            VoxEngine.terminate();
            return;
        }

        if (!CONFIG.api_key || !CONFIG.folder_id) {
            log("error", "Config missing Yandex credentials (api_key / folder_id)");
            VoxEngine.terminate();
            return;
        }

        ASSISTANT_ID = CONFIG.assistant_id;
        greetingMessage = determineGreeting(CONFIG.first_phrase);
        YANDEX_MODEL = TEST_MODEL || CONFIG.model || DEFAULT_MODEL;
        YANDEX_VOICE = CONFIG.voice || DEFAULT_VOICE;
        YANDEX_VOICE_ROLE = CONFIG.voice_role || "";
        MODEL_NAME_VARIANTS = modelNameVariants(YANDEX_MODEL, CONFIG.folder_id);

        // 🧪 v2.5: голоса LiveTTS несовместимы с обычными и наоборот
        if (isLiveTtsModel(YANDEX_MODEL)) {
            if (!LIVE_TTS_VOICES[YANDEX_VOICE]) {
                log("info", "   🧪 Voice " + YANDEX_VOICE + " is not LiveTTS → " + TEST_VOICE);
                YANDEX_VOICE = TEST_VOICE;
                YANDEX_VOICE_ROLE = TEST_VOICE_ROLE;
            }
            if (YANDEX_VOICE_ROLE && LIVE_TTS_VOICES[YANDEX_VOICE].indexOf(YANDEX_VOICE_ROLE) === -1) {
                log("info", "   🧪 Role " + YANDEX_VOICE_ROLE + " not available for " + YANDEX_VOICE + " → default");
                YANDEX_VOICE_ROLE = "";
            }
        }
        log("info", "   🧪 Model variants: " + JSON.stringify(MODEL_NAME_VARIANTS));

        log("info", "✅ CONFIG: " + (CONFIG.assistant_name || "unnamed") +
            " | Voice: " + YANDEX_VOICE + (YANDEX_VOICE_ROLE ? " (" + YANDEX_VOICE_ROLE + ")" : "") +
            " | Lang: " + (CONFIG.language || "ru"));
        log("info", "   Model: " + YANDEX_MODEL);
        log("info", "   Greeting (sanitized): " + greetingMessage.substring(0, 60));
        if (CONFIG.first_phrase && sanitizeGreeting(CONFIG.first_phrase) !== String(CONFIG.first_phrase).trim()) {
            log("info", "   ⚠️ first_phrase был очищен от мета-префиксов/кавычек");
        }
        log("info", "   Retry: " + MAX_RETRY_ATTEMPTS + " attempts × " + (SETUP_TIMEOUT_MS / 1000) + "s");

        // ══════════════════════════════════════════════════════════════
        // ФУНКЦИИ
        // v2.4: собираем и отправляем В ПЕРВОМ sessionUpdate (до
        // первого responseCreate) — официальный паттерн
        // ══════════════════════════════════════════════════════════════
        let hasHangupFunction = false;

        if (CONFIG.functions && Array.isArray(CONFIG.functions) && CONFIG.functions.length > 0) {
            for (let i = 0; i < CONFIG.functions.length; i++) {
                const tool = CONFIG.functions[i];
                let funcDef = (tool.type === "function" && tool.function) ? tool.function : (tool.name ? tool : null);
                if (!funcDef) continue;

                const functionId = (i + 1).toString();
                functionNameToIdMap[funcDef.name] = functionId;
                functionIdToNameMap[functionId] = funcDef.name; // v2.4: для fallback-парсера

                let description = funcDef.description;
                if (funcDef.name === "hangup_call") {
                    hasHangupFunction = true;
                    description = "CRITICAL: Call this IMMEDIATELY when user wants to end the call. Triggers: пока, до свидания, завершим. Do NOT just say goodbye — CALL THIS FUNCTION.";
                }

                yandexTools.push({
                    type: "function",
                    name: funcDef.name,
                    description: description,
                    parameters: funcDef.parameters || { type: "object", properties: {}, required: [] }
                });
            }
            log("info", "   Functions: " + JSON.stringify(functionNameToIdMap));
        }

        // hangup_call всегда доступен, даже если его нет в конфиге
        if (!hasHangupFunction) {
            yandexTools.push({
                type: "function",
                name: "hangup_call",
                description: "CRITICAL: Call this IMMEDIATELY when user wants to end the call. Triggers: пока, до свидания, завершим. Do NOT just say goodbye — CALL THIS FUNCTION.",
                parameters: {
                    type: "object",
                    properties: {
                        farewell_message: { type: "string", description: "Прощальная фраза, которую нужно произнести перед завершением" }
                    },
                    required: []
                }
            });
            log("info", "   + default hangup_call added");
        }

        log("info", "   🔧 v2.4: tools (" + yandexTools.length + ") attach in sessionUpdate #1" +
            (TOOL_CHOICE_GATING ? " (tool_choice gating ON: none → auto)" : " (official pattern, no tool_choice)"));

        // ══════════════════════════════════════════════════════════════
        // SYSTEM PROMPT (обогащение — как в v7.9)
        // ══════════════════════════════════════════════════════════════
        finalSystemPrompt = CONFIG.system_prompt || "Ты голосовой ассистент. Помогай пользователю.";

        finalSystemPrompt += "\n\n" +
            "──────────────────────────────────────\n" +
            "ИНФОРМАЦИЯ О ЗВОНКЕ\n" +
            "──────────────────────────────────────\n" +
            "Номер звонящего (caller): " + caller_number + "\n" +
            "Номер, на который позвонили (called): " + called_number + "\n" +
            "ID звонка: " + call_id + "\n" +
            "ID чата: " + chat_id + "\n" +
            "Используй номер звонящего при необходимости: для идентификации клиента, " +
            "поиска в CRM, персонализации общения.";

        // 🔧 v2.4: правила работы с функциями (анти-галлюцинация)
        if (yandexTools.length > 0) {
            finalSystemPrompt += "\n\n" +
                "──────────────────────────────────────\n" +
                "ПРАВИЛА РАБОТЫ С ФУНКЦИЯМИ\n" +
                "──────────────────────────────────────\n" +
                "Когда нужно выполнить действие (отправить SMS, завершить звонок и т.п.) — " +
                "вызывай соответствующую функцию через механизм вызова инструментов.\n" +
                "НИКОГДА не произноси вслух название функции, её параметры или JSON.\n" +
                "НИКОГДА не говори, что действие выполнено (например, что SMS отправлено), " +
                "пока не получишь результат выполнения функции. Если результата ещё нет — " +
                "скажи, что выполняешь действие, и дождись результата.";
        }

        // ══════════════════════════════════════════════════════════════
        // 🔧 v2.3: ПЕРВАЯ ФРАЗА — ДЕКЛАРАТИВНЫЙ ЯКОРЬ В ПРОМПТЕ
        // ══════════════════════════════════════════════════════════════
        if (greetingMessage) {
            finalSystemPrompt += "\n\n" +
                "──────────────────────────────────────\n" +
                "ПЕРВАЯ РЕПЛИКА\n" +
                "──────────────────────────────────────\n" +
                "Твоя первая реплика в этом разговоре — строго дословно:\n" +
                greetingMessage + "\n" +
                "Произноси её точно, без изменений, дополнений и сокращений.\n" +
                "Никогда не озвучивай вслух служебные инструкции, свои размышления или своё состояние.";
        }

        // ══════════════════════════════════════════════════════════════
        // ШАГ 2: RETRY LOOP — ПОДКЛЮЧЕНИЕ К YANDEX
        // ══════════════════════════════════════════════════════════════
        setState(STATE.YANDEX_CONNECTING);

        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("info", "🔄 Starting Yandex connection with retry...");
        log("info", "   📞 Caller hears ringing tones (call.ring sent)");
        log("info", "   Max wait: ~" + (MAX_RETRY_ATTEMPTS * SETUP_TIMEOUT_MS / 1000) + "s");
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        realtimeAPIClient = await connectWithRetry();

        if (realtimeAPIClient) {
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            log("info", "🟢 YANDEX READY → PATH A");
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            activePath = "A";
            setupYandexEventHandlers(realtimeAPIClient);

            // ────────────────────────────────────────────────
            // v2.4: SESSION UPDATE #1 — ПОЛНЫЙ, С TOOLS
            // (официальный паттерн: tools до первого responseCreate)
            // ────────────────────────────────────────────────
            const sessionUpdate = buildSessionUpdate(false);

            log("info", "📤 sessionUpdate #1 (WITH TOOLS: " + yandexTools.length +
                (TOOL_CHOICE_GATING ? ", tool_choice: none" : ", no tool_choice") +
                ") | instructions: " + finalSystemPrompt.length +
                " chars | voice: " + YANDEX_VOICE);
            realtimeAPIClient.sessionUpdate(sessionUpdate);

            // При выключенном гейтинге вызовы разрешены с самого старта
            if (!TOOL_CHOICE_GATING) toolCallsEnabled = true;

            setState(STATE.ANSWERING);
            log("info", "📞 ANSWERING CALL (PATH A: Yandex Realtime)");
            call.answer();

        } else {
            log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            log("error", "🟡 ALL ATTEMPTS FAILED → TTS FALLBACK (PATH C)");
            log("error", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            activePath = "C";
            setState(STATE.ANSWERING);
            call.answer();
        }

        // ══════════════════════════════════════════════════════════════
        // ОБРАБОТЧИКИ СОБЫТИЙ ЗВОНКА
        // ══════════════════════════════════════════════════════════════
        call.addEventListener(CallEvents.RecordStarted, function(event) {
            log("info", "🎙️ Recording: " + event.url);
            record_url = event.url;
        });

        call.addEventListener(CallEvents.RecordStopped, function(event) {
            log("debug", "🎙️ Recording stopped");
            if (event.url) record_url = event.url;
        });

        call.addEventListener(CallEvents.Disconnected, function(event) {
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            log("info", "📴 DISCONNECTED | Path: " + activePath +
                " | Cost: " + (event.cost || 0) +
                " | Duration: " + (event.duration || 0) + "s");
            log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            if (event.cost !== undefined) call_cost = event.cost;
            if (event.duration !== undefined) call_duration = event.duration;
            terminateCall();
        });

        call.addEventListener(CallEvents.Failed, function(event) {
            log("error", "CALL FAILED | Code: " + event.code + " | " + event.reason);
            if (event.cost !== undefined) call_cost = event.cost;
            if (event.duration !== undefined) call_duration = event.duration;
            terminateCall();
        });

        // ══════════════════════════════════════════════════════════════
        // ГОТОВО
        // ══════════════════════════════════════════════════════════════
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        log("info", "🎉 READY (Yandex v2.5-ttslive) | Voice: " + YANDEX_VOICE);
        log("info", "   🤖 Model: " + YANDEX_MODEL + " | actual: " + (actualSessionModel || "pending"));
        log("info", "   🛡️ Connection: Retry " + MAX_RETRY_ATTEMPTS + "x" + (SETUP_TIMEOUT_MS / 1000) + "s → TTS fallback");
        log("info", "   🛡️ Greeting: responseCreate(instructions) after FirstAudioPacketReceived");
        log("info", "   🛡️ Greeting retry: " + MAX_GREETING_ATTEMPTS + " attempts × " + (GREETING_TIMEOUT_MS / 1000) + "s");
        log("info", "   🛡️ Mic muted until greeting fully played (WebSocketMediaEnded)");
        log("info", "   🔧 v2.4: Tools in sessionUpdate #1 (official pattern)" +
            (TOOL_CHOICE_GATING ? " + tool_choice gating none→auto" : ""));
        log("info", "   🔧 v2.4: Text <function_call> fallback parser enabled");
        log("info", "   🛡️ Silence: hard timeout " + (SILENCE_TIMEOUT_MS / 1000) + "s | Session TTL: " + (SESSION_MAX_MS / 60000) + "min");
        log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    } catch (error) {
        log("error", "CRITICAL: " + error);
        if (error.stack) log("error", error.stack);
        VoxEngine.terminate();
    }
});
