/**
 * outbound_cascade — ИСХОДЯЩИЙ full-cascade Voice AI сценарий Voicyfy.
 *
 *   STT:  встроенный ASR (Yandex v2, streaming + interim), язык из конфига
 *   LLM:  OpenAI gpt-realtime-2.1-mini — Realtime API (WebSocket), режим ТОЛЬКО ТЕКСТ
 *   TTS:  VoxTTS (realtime-стриминг, голоса Anna/Sergey)
 *   Turn-taking: Silero VAD + Pipecat Smart Turn через VoxTurnTaking
 *
 * ПОЧЕМУ Realtime, а не Chat Completions (переход v2 -> v3):
 *  WS открыт с начала звонка (нет установки соединения на каждый ход), контекст
 *  диалога живёт на стороне OpenAI (шлём только новую реплику, старое идёт как
 *  cached-токены), сама модель дистиллирована под низкую задержку. TTFT падает
 *  с ~600мс до ~250мс. Прогрев (warmup) за ненадобностью удалён.
 *
 * ВАЖНО — TURN DETECTION У МОДЕЛИ ВЫКЛЮЧЕН:
 *  Realtime — чистый ТЕКСТОВЫЙ мозг: аудио в него не заводится вообще, в сессии
 *  audio.input.turn_detection = null. Момент «пора отвечать» определяет НАШ
 *  VoxTurnTaking и явно дёргает responseCreate().
 *
 * ОТЛИЧИЯ ОТ inbound_cascade:
 *  1. Точка входа — AppEvents.Started + VoxEngine.customData() (не CallAlerting).
 *  2. Мы САМИ звоним: VoxEngine.callPSTN(phone, caller_id).
 *  3. Конфиг — /api/telephony/outbound-config?assistant_id=...&assistant_type=cascade.
 *  4. Контекст звонка (задача + CRM) инжектится в system-промпт.
 *  5. READINESS-BEFORE-DIAL: WS к OpenAI / TTS / ASR готовим ДО дозвона — если
 *     что-то не поднялось, PSTN не набираем (0₽ телефонии).
 *  6. MUTE-окно: первые mute_duration_ms после ответа мик абонента закрыт
 *     (флаг micOpen) — «Алло»/шум при поднятии трубки не обрывают приветствие.
 *  7. TOOL CALLING: ассистент может вызывать функции (в т.ч. hangup_call, чтобы
 *     самому завершить звонок). Вызов приходит целиком в ResponseOutputItemDone.
 *  8. Silence hard-timeout ~180с (защита от автоответчика/тишины). У Realtime-
 *     сессии есть TTL, поэтому обрыв WS переживаем реконнектом (см. ниже).
 *
 * СПЕКУЛЯЦИЯ здесь не используется (как и в inbound после перехода на Realtime):
 * при TTFT ~250мс выигрыш копеечный, а с серверным контекстом спекулятивная
 * реплика отравляет историю диалога.
 *
 * ТРЕБОВАНИЯ:
 * 1. Правило outbound_cascade — цепочка [vox-turn-taking, outbound_cascade].
 * 2. Запуск: StartScenarios с script_custom_data (phone_number, assistant_id,
 *    caller_id, contact_name, task_title, task_description, custom_greeting, task).
 */

require(Modules.ASR);
require(Modules.OpenAI);
require(Modules.VoxTTS);
require(Modules.Recorder);
require(Modules.Silero);
require(Modules.Pipecat);

// ────────────────────────────────────────────────────────────────────────────
// ВСТРОЕННЫЙ VoxTurnTaking (самодостаточность).
// Идемпотентно: если правило — цепочка [vox-turn-taking, outbound_cascade], то
// vox-turn-taking.js уже объявил глобальный VoxTurnTaking (const) → typeof !==
// "undefined" → это определение ПРОПУСКАЕТСЯ (никакого переобъявления). Если же
// правило одиночное — объявляем VoxTurnTaking здесь. Так сценарий работает при
// любой конфигурации правила. Присваивание без const/var — чтобы не конфликтовать
// с const-объявлением в цепочечном режиме.
// ВАЖНО: держать в синхроне с voximplant_scenarios/vox-turn-taking.js.
// ────────────────────────────────────────────────────────────────────────────
if (typeof VoxTurnTaking === "undefined") {
    // eslint-disable-next-line no-global-assign, no-undef
    VoxTurnTaking = {
        DEFAULTS: {
            vadOptions: { threshold: 0.5, minSilenceDurationMs: 300, speechPadMs: 10 },
            turnDetectorOptions: { threshold: 0.5 },
            policy: {
                confidentEouProbability: 0.95,
                transcriptSettleFastMs: 120,
                transcriptSettleMs: 350,
                userSpeechTimeoutMs: 700,
                shortUtteranceExtensionMs: 900,
                fastShortUtteranceTimeoutMs: 500,
                shortUtteranceMaxChars: 12,
                shortUtteranceMaxWords: 2,
                lowConfidenceShortUtteranceThreshold: 0.75,
                continuationTokens: ["and", "but", "so", "well", "then", "uh", "um"],
                trailingContinuationTokens: [],
                completeShortAnswers: [],
                speculativeEouProbability: 0.7,
            },
        },

        async create(options) {
            const {
                call,
                stt,
                onUserTurn,
                onInterrupt,
                onSpeculativeTurn,
                enableLogging = false,
                logger = (line) => Logger.write(line),
            } = options;
            const vadOptions = Object.assign({}, this.DEFAULTS.vadOptions, options.vadOptions);
            const turnDetectorOptions = Object.assign(
                {},
                this.DEFAULTS.turnDetectorOptions,
                options.turnDetectorOptions
            );
            const policy = Object.assign({}, this.DEFAULTS.policy, options.policy);

            const vad = await Silero.createVAD(vadOptions);
            const turnDetector = await Pipecat.createTurnDetector(turnDetectorOptions);

            call.sendMediaTo(vad);
            call.sendMediaTo(turnDetector);

            const log = (line) => { if (enableLogging) logger(line); };
            const emitModuleEvent = (eventName, event) => {
                logger(`===${eventName}===`);
                if (event) logger(JSON.stringify(event));
            };

            let fallbackTimer;
            let settleTimer;
            let finalTranscript = "";
            let interimTranscript = "";
            let transcriptSeparator = "";
            let smartTurnComplete = false;
            let acceptingTranscript = false;
            let signalVersion = 0;
            let allowAgentAudio = true;
            let lastFinalConfidence = 1;
            let replaceableShortFinal = false;
            let shortExtensionApplied = false;
            let speculativeFiredForVersion = -1;

            const clearTimers = () => {
                if (fallbackTimer) clearTimeout(fallbackTimer);
                if (settleTimer) clearTimeout(settleTimer);
                fallbackTimer = null;
                settleTimer = null;
            };
            const normalizeConfidence = (value) => {
                if (typeof value !== "number" || Number.isNaN(value)) return null;
                return value > 1 ? value / 100 : value;
            };
            const isShortUtterance = (text) => {
                if (!text) return false;
                const words = text.trim().split(/\s+/).filter(Boolean);
                return (
                    text.length <= policy.shortUtteranceMaxChars &&
                    words.length <= policy.shortUtteranceMaxWords
                );
            };
            const startsWithContinuationToken = (text) => {
                if (!text) return false;
                const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase();
                return policy.continuationTokens.includes(firstWord);
            };
            const isCompleteShortAnswer = (text) => {
                const list = policy.completeShortAnswers || [];
                if (!list.length || !text) return false;
                const norm = text.trim().toLowerCase().replace(/[.,!?;:…]+$/u, "");
                return list.includes(norm);
            };
            const endsWithContinuationToken = (text) => {
                if (!text) return false;
                const tokens = policy.trailingContinuationTokens || [];
                if (!tokens.length) return false;
                const words = text.trim().split(/\s+/);
                const lastWord = words[words.length - 1]?.toLowerCase().replace(/[.,!?;:…]+$/u, "");
                return tokens.includes(lastWord);
            };
            const buildInput = () => {
                let input = finalTranscript;
                if (interimTranscript) {
                    if (input) input += transcriptSeparator;
                    input += interimTranscript;
                }
                return input.trim();
            };

            const submitCurrentTurn = (reason) => {
                const input = buildInput();
                if (!input) return false;
                const isWhitelisted = isCompleteShortAnswer(input);
                if (
                    !isWhitelisted &&
                    reason !== "FALLBACK_END_OF_TURN" &&
                    endsWithContinuationToken(input) &&
                    !shortExtensionApplied
                ) {
                    shortExtensionApplied = true;
                    log(`===HOLD_TRAILING=== ${input}`);
                    startHardTimeout(signalVersion, policy.shortUtteranceExtensionMs);
                    return false;
                }
                if (!isWhitelisted && replaceableShortFinal && !shortExtensionApplied) {
                    shortExtensionApplied = true;
                    startHardTimeout(signalVersion, policy.shortUtteranceExtensionMs);
                    return false;
                }
                log(`===${reason}===`);
                log(`===USER=== ${input}`);
                allowAgentAudio = true;
                onUserTurn(input, signalVersion, reason);
                finalTranscript = "";
                interimTranscript = "";
                transcriptSeparator = "";
                smartTurnComplete = false;
                acceptingTranscript = false;
                lastFinalConfidence = 1;
                replaceableShortFinal = false;
                shortExtensionApplied = false;
                signalVersion += 1;
                clearTimers();
                return true;
            };

            const startHardTimeout = (version, delay = policy.userSpeechTimeoutMs) => {
                clearTimers();
                fallbackTimer = setTimeout(() => {
                    if (version !== signalVersion) return;
                    const input = buildInput();
                    if (!input) return;
                    submitCurrentTurn("FALLBACK_END_OF_TURN");
                }, delay);
            };

            [Silero.VADEvents.ConnectorInformation, Silero.VADEvents.Error].forEach((eventName) => {
                vad.addEventListener(eventName, (event) => emitModuleEvent(eventName, event));
            });
            [Pipecat.TurnEvents.ConnectorInformation, Pipecat.TurnEvents.Error].forEach((eventName) => {
                turnDetector.addEventListener(eventName, (event) => emitModuleEvent(eventName, event));
            });

            stt.addEventListener(ASREvents.InterimResult, (event) => {
                if (!acceptingTranscript) return;
                const text = event?.text?.trim();
                if (!text) return;
                if (!transcriptSeparator && finalTranscript) transcriptSeparator = " ";
                interimTranscript = text;
            });

            stt.addEventListener(ASREvents.Result, (event) => {
                if (!acceptingTranscript) return;
                const text = event?.text?.trim();
                if (!text) return;
                const confidence = normalizeConfidence(event?.confidence);
                const hadCommittedPrefix = !!finalTranscript;
                if (replaceableShortFinal) {
                    finalTranscript = text;
                } else {
                    if (finalTranscript) finalTranscript += transcriptSeparator || " ";
                    finalTranscript += text;
                }
                interimTranscript = "";
                transcriptSeparator = " ";
                lastFinalConfidence = confidence === null ? 1 : confidence;
                replaceableShortFinal =
                    isShortUtterance(text) &&
                    (hadCommittedPrefix ||
                        lastFinalConfidence < policy.lowConfidenceShortUtteranceThreshold ||
                        startsWithContinuationToken(text));
                shortExtensionApplied = false;
                log(`===STT Final: ${event.text}`);
                if (isShortUtterance(text) && !replaceableShortFinal && !smartTurnComplete) {
                    startHardTimeout(
                        signalVersion,
                        Math.min(policy.userSpeechTimeoutMs, policy.fastShortUtteranceTimeoutMs)
                    );
                }
                if (smartTurnComplete) submitCurrentTurn("TURN_DETECT: FINAL_TRANSCRIPT");
            });

            vad.addEventListener(Silero.VADEvents.Result, (event) => {
                if (event.speechStartAt) {
                    signalVersion += 1;
                    clearTimers();
                    smartTurnComplete = false;
                    acceptingTranscript = true;
                    allowAgentAudio = false;
                    if (finalTranscript || interimTranscript) transcriptSeparator = " ... ";
                    log("===BARGE-IN===");
                    if (onInterrupt) onInterrupt();
                }
                if (event.speechEndAt) {
                    startHardTimeout(signalVersion);
                    turnDetector.predict();
                }
            });

            turnDetector.addEventListener(Pipecat.TurnEvents.Result, (event) => {
                const probability = event?.probability;
                log(`===Pipecat.TurnEvents.Result=== ${JSON.stringify(probability)}`);
                if (
                    !event.endOfTurn &&
                    typeof probability === "number" &&
                    probability >= policy.speculativeEouProbability &&
                    speculativeFiredForVersion !== signalVersion
                ) {
                    const speculativeInput = buildInput();
                    if (speculativeInput) {
                        speculativeFiredForVersion = signalVersion;
                        log(`===SPECULATIVE_READY=== p=${probability} :: ${speculativeInput}`);
                        if (onSpeculativeTurn) onSpeculativeTurn(speculativeInput, signalVersion);
                    }
                }
                if (!event.endOfTurn) return;
                smartTurnComplete = true;
                const confident =
                    (typeof probability === "number" && probability >= policy.confidentEouProbability) ||
                    isCompleteShortAnswer(buildInput());
                const settleMs = confident ? policy.transcriptSettleFastMs : policy.transcriptSettleMs;
                if (finalTranscript) {
                    if (confident) {
                        submitCurrentTurn("TURN_DETECT: END_OF_TURN");
                        return;
                    }
                    if (settleTimer) clearTimeout(settleTimer);
                    const v = signalVersion;
                    settleTimer = setTimeout(() => {
                        if (v !== signalVersion) return;
                        submitCurrentTurn("TURN_DETECT: END_OF_TURN_SETTLED");
                    }, settleMs);
                    return;
                }
                if (settleTimer) clearTimeout(settleTimer);
                const version = signalVersion;
                settleTimer = setTimeout(() => {
                    if (version !== signalVersion) return;
                    submitCurrentTurn("TURN_DETECT: ASR_GRACE");
                }, settleMs);
            });

            return {
                vad,
                turnDetector,
                canPlayAgentAudio() { return allowAgentAudio; },
                currentVersion() { return signalVersion; },
                close() { clearTimers(); vad?.close(); turnDetector?.close(); },
            };
        },
    };
}

const BACKEND_URL = "https://voicyfy.ru";
const LOG_URL = BACKEND_URL + "/api/voximplant/log";
const FUNCTIONS_URL = BACKEND_URL + "/api/voximplant/functions/execute";
const LLM_MODEL = "gpt-realtime-2.1-mini";
// У 2.1-mini есть reasoning-токены (тарифицируются как output). "low" —
// компромисс качество/задержка, проверенный в cartesia_inbound.
const LLM_REASONING_EFFORT = "low";
const SILENCE_HARD_TIMEOUT_MS = 180000;
// Сколько ждём SessionCreated после подключения WS.
const SESSION_READY_TIMEOUT_MS = 6000;
// Сколько раз пробуем поднять WS заново, если он оборвался посреди звонка.
const MAX_RECONNECTS = 2;

const RT = OpenAI.RealtimeAPIEvents;

// --- Извлечение данных из событий Realtime (провайдерский payload в data) ---
function rtPayload(event) {
    return event?.data?.payload ?? event?.data ?? {};
}
// Дельта текста (response.output_text.delta).
function rtDelta(event) {
    const d = event?.data;
    if (typeof d?.delta === "string" && d.delta) return d.delta;
    const p = d?.payload;
    if (typeof p?.delta === "string" && p.delta) return p.delta;
    return "";
}
// Полный текст ответа (response.output_text.done).
function rtDoneText(event) {
    const d = event?.data;
    if (typeof d?.text === "string" && d.text) return d.text;
    const p = d?.payload;
    if (typeof p?.text === "string" && p.text) return p.text;
    return "";
}
// id генерации: в дельтах лежит плоско (response_id), в response.* — вложенно.
function rtResponseId(event) {
    const p = rtPayload(event);
    return p?.response_id ?? p?.response?.id ?? "";
}
// usage приходит в response.done.
function rtUsage(event) {
    const p = rtPayload(event);
    return p?.response?.usage ?? p?.usage ?? null;
}
// Модель иногда пишет ответ в несколько строк — "  \n" ломает потоковый синтез.
function cleanForTTS(text) {
    return (text || "").replace(/\s*\n+\s*/g, " ");
}

const TELEPHONY_STYLE_RULES = `

Правила голосового ответа (телефония):
- Отвечай коротко, обычно 1-2 предложения, без списков, markdown и эмодзи.
- Числа, даты и время произноси словами.
- Если реплика оборвана или неясна — вежливо переспроси одним вопросом.`;

function asrProfileForLang(lang) {
    const map = {
        ru: ASRProfileList.Yandex.ru_RU,
        en: ASRProfileList.Yandex.en_US,
        de: ASRProfileList.Yandex.de_DE,
        es: ASRProfileList.Yandex.es_ES,
        fr: ASRProfileList.Yandex.fr_FR,
    };
    return map[(lang || "ru").toLowerCase()] || ASRProfileList.Yandex.ru_RU;
}
function asrModelForLang() {
    return ASRModelList.Yandex.general;
}
function voxttsVoice(voiceId) {
    return VoxTTS.VoiceList[voiceId] || VoxTTS.VoiceList.Anna;
}

async function fetchOutboundConfig(assistantId) {
    const url =
        `${BACKEND_URL}/api/telephony/outbound-config` +
        `?assistant_id=${encodeURIComponent(assistantId)}&assistant_type=cascade`;
    const response = await Net.httpRequestAsync(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (response.code !== 200 || !response.text) {
        Logger.write(`[OUT-CASCADE] Config HTTP error: ${response.code}`);
        return null;
    }
    try {
        const config = JSON.parse(response.text);
        return config && config.success ? config : null;
    } catch (e) {
        Logger.write(`[OUT-CASCADE] Config parse error: ${e}`);
        return null;
    }
}

let call_session_history_id = null;

VoxEngine.addEventListener(AppEvents.Started, async (e) => {
    call_session_history_id = e.sessionId;
    Logger.write(`[OUT-CASCADE] Session History ID: ${call_session_history_id}`);

    // --- Параметры звонка из customData ---
    let callData;
    try {
        callData = JSON.parse(VoxEngine.customData());
    } catch (err) {
        Logger.write(`[OUT-CASCADE] Bad customData: ${err}`);
        VoxEngine.terminate();
        return;
    }

    const PHONE_NUMBER = callData.phone_number;
    const ASSISTANT_ID = callData.assistant_id;
    const CALLER_ID = callData.caller_id || "";
    if (!PHONE_NUMBER || !ASSISTANT_ID) {
        Logger.write("[OUT-CASCADE] Missing phone_number/assistant_id");
        VoxEngine.terminate();
        return;
    }
    const MUTE_DURATION_MS = callData.mute_duration_ms || 3000;
    const CONTACT_NAME = callData.contact_name || "";
    const TASK_TITLE = callData.task_title || "";
    const TASK_DESCRIPTION = callData.task_description || "";
    const CUSTOM_GREETING = callData.custom_greeting || "";
    const API_TASK = callData.task || "";
    const FIRST_PHRASE_OVERRIDE = callData.first_phrase || "";

    const chat_id = "vox_" + Math.random().toString(36).substring(2, 15);
    const caller_number = "OUTBOUND: " + PHONE_NUMBER;

    let callType = "API";
    const isCrmCall = !!(CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION);
    if (isCrmCall && API_TASK) callType = "CRM+Task";
    else if (isCrmCall) callType = "CRM";
    else if (API_TASK) callType = "API+Task";

    // --- Состояние LLM/каскада ---
    let call;
    let stt;
    let realtime; // OpenAI.RealtimeAPIClient — текстовый мозг каскада
    let ttsPlayer;
    let turnTaking;
    let greeting = "";
    let systemPrompt = "";
    let apiKey = "";
    let reconnectAttempts = 0;

    // Локальная копия диалога. В запросы НЕ уходит (контекст живёт на стороне
    // OpenAI), нужна только для восстановления после обрыва WS.
    const messages = []; // [0]=system, далее user/assistant

    // Состояние текущей генерации. Одна активная за раз.
    const main = { active: false, responseId: null, text: "", version: -1 };

    let realtimeTools = [];
    const functionNameToIdMap = {};

    let micOpen = false; // мик абонента открывается после mute-окна
    let terminating = false;
    let firstDeltaLoggedForTurn = false;
    let turnStartedAt = 0;
    const loggedShapes = new Set();

    // --- Данные для /log ---
    let record_url = null;
    let call_cost = 0;
    let call_duration = 0;
    // Учёт токенов LLM для списания кредитов каскада. Cached считаем отдельно:
    // ставка за них на порядок ниже, и именно в них уходит история диалога.
    let totalPromptTokens = 0;
    let totalCachedPromptTokens = 0;
    let totalCompletionTokens = 0;
    let usageEventsSeen = 0;
    const dialogLog = [];
    let userMessageBuffer = "";
    let assistantMessageBuffer = "";

    // --- Silence hard-timeout ---
    let hardTimer = null;
    const resetHardTimeout = () => {
        if (hardTimer) clearTimeout(hardTimer);
        hardTimer = setTimeout(() => {
            Logger.write(`[OUT-CASCADE] ===SILENCE_TIMEOUT=== ${SILENCE_HARD_TIMEOUT_MS / 1000}s`);
            terminateCall();
        }, SILENCE_HARD_TIMEOUT_MS);
    };

    const logShapeOnce = (tag, event) => {
        if (loggedShapes.has(tag)) return;
        loggedShapes.add(tag);
        try {
            Logger.write(`[OUT-CASCADE] ===SHAPE ${tag}=== ${JSON.stringify(event?.data)}`);
        } catch (e) {
            Logger.write(`[OUT-CASCADE] SHAPE ${tag} stringify error`);
        }
    };
    const logFirstDelta = (tag) => {
        if (firstDeltaLoggedForTurn) return;
        firstDeltaLoggedForTurn = true;
        const dt = turnStartedAt ? Date.now() - turnStartedAt : -1;
        Logger.write(`[OUT-CASCADE] ===FIRST_DELTA=== +${dt}ms${tag ? " " + tag : ""}`);
    };

    const logDialog = (role, text) => {
        if (!text) return;
        dialogLog.push({ role, text, ts: Date.now() });
        if (role === "user") {
            userMessageBuffer += (userMessageBuffer ? "\n" : "") + text;
        } else {
            assistantMessageBuffer += (assistantMessageBuffer ? "\n" : "") + text;
        }
    };

    const canPlay = () => turnTaking && turnTaking.canPlayAgentAudio();
    const ttsSendText = (text) => {
        if (text) ttsPlayer.send({ send_text: { text: cleanForTTS(text) } });
    };
    const ttsFlush = () => {
        ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
    };

    // --- Учёт токенов из response.done ---
    const accountUsage = (usage) => {
        usageEventsSeen++;
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        const cachedRaw = Number(usage?.input_token_details?.cached_tokens) || 0;
        const cached = Math.min(Math.max(0, cachedRaw), input);
        totalCachedPromptTokens += cached;
        totalPromptTokens += input - cached;
        totalCompletionTokens += output;
    };

    // --- Гейтинг: событие относится к текущей активной генерации? ---
    const isCurrent = (event) => {
        if (!main.active) return false;
        const id = rtResponseId(event);
        if (!id) return true;
        if (!main.responseId) {
            main.responseId = id;
            return true;
        }
        return id === main.responseId;
    };

    // --- Отдать реплику абонента модели и запросить ответ ---
    const sendUserText = (text) => {
        realtime.conversationItemCreate({
            item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: text }],
            },
        });
    };
    const requestResponse = (version) => {
        main.active = true;
        main.responseId = null;
        main.text = "";
        main.version = version;
        realtime.responseCreate({});
        resetHardTimeout();
    };

    const finalizeTurn = (text) => {
        const clean = (text || "").trim();
        if (clean) {
            messages.push({ role: "assistant", content: clean });
            Logger.write(`[OUT-CASCADE] ===AGENT=== ${clean}`);
            logDialog("assistant", clean);
        }
        if (canPlay()) ttsFlush();
        main.active = false;
        main.responseId = null;
        main.text = "";
        resetHardTimeout();
    };

    const executeFunction = async (name, args) => {
        const function_id = args.function_id || functionNameToIdMap[name];
        const clean = Object.assign({}, args);
        delete clean.function_id;
        if (!function_id) return `Error: function_id not found for ${name}`;
        try {
            const resp = await Net.httpRequestAsync(FUNCTIONS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                postData: JSON.stringify({
                    function_id: function_id,
                    arguments: Object.assign({}, clean, { assistant_id: ASSISTANT_ID }),
                    call_data: {
                        call_id: call ? call.id() : "unknown",
                        chat_id: chat_id,
                        assistant_id: ASSISTANT_ID,
                        // Чистые номера для функций (send_sms и т.п.): caller_number —
                        // клиент (кому звоним), called_number — наш номер (caller_id).
                        caller_number: PHONE_NUMBER,
                        called_number: CALLER_ID,
                    },
                }),
            });
            if (resp.code === 200) return resp.text || "{}";
            return `Error: HTTP ${resp.code}`;
        } catch (e) {
            return `Error: ${e}`;
        }
    };

    // Вызов функции приходит целиком в ResponseOutputItemDone (в отличие от
    // Chat Completions, где tool_calls собирались по дельтам).
    const handleFunctionCall = async (item) => {
        const name = item.name;
        const callIdRef = item.call_id;
        let args = {};
        try { args = JSON.parse(item.arguments || "{}"); } catch (e) { /* noop */ }
        Logger.write(`[OUT-CASCADE] ===FUNCTION=== ${name} ${item.arguments || ""}`);

        // Текущая генерация закончилась вызовом функции — снимаем гейт, чтобы
        // хвостовые события старого response не влияли на следующий.
        const pendingText = main.text;
        main.active = false;
        main.responseId = null;
        main.text = "";
        if (pendingText.trim()) {
            messages.push({ role: "assistant", content: pendingText.trim() });
            logDialog("assistant", pendingText.trim());
        }

        // hangup_call — ассистент сам завершает звонок.
        if (name === "hangup_call") {
            const farewell = args.farewell_message || "";
            Logger.write(`[OUT-CASCADE] ===HANGUP=== ${farewell}`);
            if (farewell) {
                logDialog("assistant", farewell);
                if (canPlay()) { ttsSendText(farewell); ttsFlush(); }
            }
            setTimeout(() => terminateCall(), farewell ? 3500 : 300);
            return;
        }

        const result = await executeFunction(name, args);
        if (terminating) return;

        realtime.conversationItemCreate({
            item: {
                type: "function_call_output",
                call_id: callIdRef,
                output: String(result),
            },
        });
        // Модель озвучит ответ по результату функции.
        requestResponse(main.version);
    };

    const sendConversationLog = async () => {
        if (!userMessageBuffer && !assistantMessageBuffer && dialogLog.length === 0) return;
        const payload = {
            assistant_id: ASSISTANT_ID,
            chat_id: chat_id,
            call_id: call ? call.id() : "unknown",
            caller_number: caller_number,
            type: "conversation",
            call_type: callType,
            call_cost: call_cost,
            call_duration: call_duration,
            cascade_usage: {
                prompt_tokens: totalPromptTokens,
                cached_prompt_tokens: totalCachedPromptTokens,
                completion_tokens: totalCompletionTokens,
                model: LLM_MODEL,
            },
            context: {
                contact_name: CONTACT_NAME,
                task_title: TASK_TITLE,
                task_description: TASK_DESCRIPTION,
                api_task: API_TASK,
            },
            data: {
                user_message: userMessageBuffer,
                assistant_message: assistantMessageBuffer,
                dialog: dialogLog,
            },
        };
        if (record_url) payload.record_url = record_url;
        if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);
        try {
            const resp = await Net.httpRequestAsync(LOG_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                postData: JSON.stringify(payload),
            });
            Logger.write(`[OUT-CASCADE] /log HTTP ${resp.code} (turns=${dialogLog.length})`);
        } catch (e) {
            Logger.write(`[OUT-CASCADE] /log error: ${e}`);
        }
    };

    let terminatePromise = null;
    const terminateCall = () => {
        if (terminatePromise) return terminatePromise;
        terminating = true;
        terminatePromise = (async () => {
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
            try { stt?.stop(); } catch (e) { /* noop */ }
            try { turnTaking?.close(); } catch (e) { /* noop */ }
            try { realtime?.close(); } catch (e) { /* noop */ }

            if (main.active && main.text) logDialog("assistant", main.text);

            await new Promise((r) => setTimeout(r, 400));

            Logger.write(
                `[OUT-CASCADE] ===BILLING=== cost=${call_cost} dur=${call_duration}s ` +
                `turns=${dialogLog.length} rec=${record_url ? "yes" : "no"} ` +
                `session=${call_session_history_id || "none"} ` +
                `tokens(in=${totalPromptTokens} cached=${totalCachedPromptTokens} out=${totalCompletionTokens} events=${usageEventsSeen})`
            );
            await sendConversationLog();

            try { call?.hangup(); } catch (e) { /* noop */ }
            setTimeout(() => VoxEngine.terminate(), 400);
        })();
        return terminatePromise;
    };

    function determineGreeting(configFirstPhrase) {
        if (CUSTOM_GREETING) return CUSTOM_GREETING;
        if (FIRST_PHRASE_OVERRIDE) return FIRST_PHRASE_OVERRIDE;
        if (configFirstPhrase) return configFirstPhrase;
        return "Здравствуйте!";
    }

    function buildContextBlock() {
        let block = "";
        if (API_TASK) {
            block +=
                "══════════════════════════════════════\n" +
                "ЗАДАЧА НА ЭТОТ ЗВОНОК\n" +
                "══════════════════════════════════════\n" +
                API_TASK + "\n" +
                "Выполни эту задачу — это главная цель звонка.\n" +
                "══════════════════════════════════════\n\n";
        }
        if (CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION) {
            block +=
                "══════════════════════════════════════\n" +
                "КОНТЕКСТ ЗВОНКА (CRM)\n" +
                "══════════════════════════════════════\n";
            if (CONTACT_NAME) block += `Клиент: ${CONTACT_NAME} (обращайся по имени).\n`;
            if (TASK_TITLE) block += `Задача: ${TASK_TITLE}\n`;
            if (TASK_DESCRIPTION) block += `Подробности: ${TASK_DESCRIPTION}\n`;
            block += "══════════════════════════════════════\n\n";
        }
        return block;
    }

    // --- Конфигурация Realtime-сессии ---
    // withHistory=true только при реконнекте: контекст на стороне OpenAI умер
    // вместе с сессией, отдаём его стенограммой прямо в instructions. Это
    // надёжнее, чем пересоздавать items (формат assistant-item зависит от версии API).
    const buildSessionConfig = (withHistory) => {
        let instructions = systemPrompt;
        if (withHistory && messages.length > 1) {
            const transcript = messages
                .filter((m) => m.role !== "system" && m.content)
                .map((m) => (m.role === "user" ? "Собеседник: " : "Ты: ") + m.content)
                .join("\n");
            if (transcript) {
                instructions +=
                    `\n\nСтенограмма уже состоявшейся части разговора ` +
                    `(соединение обрывалось, продолжай с этого места):\n${transcript}`;
            }
        }
        return {
            type: "realtime",
            output_modalities: ["text"], // голос синтезирует VoxTTS, не модель
            instructions: instructions,
            reasoning: { effort: LLM_REASONING_EFFORT },
            tools: realtimeTools,
            tool_choice: realtimeTools.length > 0 ? "auto" : "none",
            // Ход определяем МЫ (VoxTurnTaking), серверный VAD не нужен.
            // Аудио в клиент не заводится вовсе — это вторая линия защиты.
            audio: { input: { turn_detection: null } },
        };
    };

    // --- Обработчики стрима Realtime (единственный клиент; текст + функции) ---
    const attachRealtimeHandlers = (client) => {
        client.addEventListener(RT.ResponseCreated, (event) => {
            if (terminating) return;
            if (main.active && !main.responseId) {
                main.responseId = rtResponseId(event) || "";
            }
        });

        client.addEventListener(RT.ResponseOutputTextDelta, (event) => {
            if (terminating) return;
            logShapeOnce("ResponseOutputTextDelta", event);
            if (!isCurrent(event)) return;
            const delta = rtDelta(event);
            if (!delta) return;
            main.text += delta;
            if (canPlay()) {
                logFirstDelta("");
                ttsSendText(delta);
            }
        });

        client.addEventListener(RT.ResponseOutputTextDone, (event) => {
            if (terminating) return;
            if (!isCurrent(event)) return;
            finalizeTurn(rtDoneText(event) || main.text);
        });

        client.addEventListener(RT.ResponseOutputItemDone, async (event) => {
            if (terminating) return;
            try {
                const payload = rtPayload(event);
                const item = payload && payload.item;
                if (!item || item.type !== "function_call") return;
                logShapeOnce("ResponseOutputItemDone.function_call", event);
                await handleFunctionCall(item);
            } catch (e) {
                Logger.write(`[OUT-CASCADE] function handler error: ${e}`);
            }
        });

        // Финал генерации: токены для биллинга + страховка на случай, если
        // ResponseOutputTextDone не пришёл, а текст накоплен.
        client.addEventListener(RT.ResponseDone, (event) => {
            logShapeOnce("ResponseDone", event);
            const usage = rtUsage(event);
            if (usage) {
                accountUsage(usage);
            } else {
                Logger.write("[OUT-CASCADE] ⚠️ ResponseDone без usage — токены этого хода не учтены");
            }
            if (terminating) return;
            if (main.active && isCurrent(event) && main.text) {
                finalizeTurn(main.text);
            }
        });

        client.addEventListener(RT.Error, (event) => {
            Logger.write("[OUT-CASCADE] ===LLM_ERROR===");
            try { Logger.write(JSON.stringify(event?.data)); } catch (e) { /* noop */ }
        });
    };

    // Поднять WS и дождаться готовности сессии (SessionCreated -> sessionUpdate).
    const connectRealtime = async (withHistory) => {
        const client = await OpenAI.createRealtimeAPIClient({
            apiKey: apiKey,
            model: LLM_MODEL,
            type: OpenAI.RealtimeAPIClientType.REALTIME,
            onWebSocketClose: () => {
                Logger.write("[OUT-CASCADE] [OpenAI] WS closed");
                handleRealtimeClose();
            },
            onWebSocketError: (err) => {
                Logger.write(`[OUT-CASCADE] [OpenAI] WS error: ${JSON.stringify(err)}`);
            },
        });

        await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("SessionCreated timeout"));
            }, SESSION_READY_TIMEOUT_MS);

            client.addEventListener(RT.SessionCreated, () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    client.sessionUpdate({ session: buildSessionConfig(withHistory) });
                    Logger.write("[OUT-CASCADE] [OpenAI] Session configured (text-only, turn_detection=null)");
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });

        attachRealtimeHandlers(client);
        return client;
    };

    // Обрыв WS посреди звонка: TTL сессии, сеть, рестарт на стороне OpenAI.
    // Поднимаем заново и отдаём историю стенограммой.
    const handleRealtimeClose = async () => {
        if (terminating) return;
        // До дозвона обрыв означает неготовность — звонок ещё не начался,
        // readiness-блок разберётся сам.
        if (!call) return;
        if (reconnectAttempts >= MAX_RECONNECTS) {
            Logger.write("[OUT-CASCADE] ===RT_RECONNECT_GIVEUP=== завершаем звонок");
            terminateCall();
            return;
        }
        reconnectAttempts++;
        Logger.write(`[OUT-CASCADE] ===RT_RECONNECT=== попытка ${reconnectAttempts}/${MAX_RECONNECTS}`);
        main.active = false;
        main.responseId = null;
        main.text = "";
        try {
            realtime = await connectRealtime(true);
            Logger.write("[OUT-CASCADE] ===RT_RECONNECT_OK===");
        } catch (e) {
            Logger.write(`[OUT-CASCADE] ===RT_RECONNECT_FAILED=== ${e}`);
            terminateCall();
        }
    };

    // --- Обработчики звонка (навешиваем на созданный call) ---
    const attachCallHandlers = () => {
        call.addEventListener(CallEvents.RecordStarted, (event) => {
            record_url = event.url;
            Logger.write(`[OUT-CASCADE] Recording started: ${event.url}`);
        });
        call.addEventListener(CallEvents.RecordStopped, (event) => {
            if (event && event.url) record_url = event.url;
        });
        call.addEventListener(CallEvents.Failed, (event) => {
            if (event && event.cost !== undefined) call_cost = event.cost;
            if (event && event.duration !== undefined) call_duration = event.duration;
            Logger.write(`[OUT-CASCADE] ===CALL_FAILED=== code=${event?.code} ${event?.reason || ""}`);
            terminateCall();
        });
        call.addEventListener(CallEvents.Disconnected, (event) => {
            if (event && event.cost !== undefined) call_cost = event.cost;
            if (event && event.duration !== undefined) call_duration = event.duration;
            Logger.write(`[OUT-CASCADE] ===DISCONNECTED=== cost=${call_cost} dur=${call_duration}s`);
            terminateCall();
        });

        call.addEventListener(CallEvents.Connected, async () => {
            Logger.write(`[OUT-CASCADE] ===CONNECTED=== ${caller_number}`);
            try {
                call.record({ stereo: false, lossless: false, hd_audio: true });
            } catch (e) {
                Logger.write(`[OUT-CASCADE] record() error: ${e}`);
            }

            ttsPlayer.sendMediaTo(call);

            turnTaking = await VoxTurnTaking.create({
                call,
                stt,
                vadOptions: { threshold: 0.5, minSilenceDurationMs: 200, speechPadMs: 10 },
                turnDetectorOptions: { threshold: 0.7 },
                policy: {
                    confidentEouProbability: 0.8,
                    transcriptSettleFastMs: 120,
                    // Подрезано под быстрый TTFT Realtime: раньше ждали дольше,
                    // потому что LLM всё равно думал ~600мс. Теперь ожидание
                    // endpointing'а — самая жирная строка бюджета задержки.
                    transcriptSettleMs: 250,
                    userSpeechTimeoutMs: 500,
                    shortUtteranceExtensionMs: 900,
                    fastShortUtteranceTimeoutMs: 500,
                    shortUtteranceMaxChars: 12,
                    shortUtteranceMaxWords: 2,
                    lowConfidenceShortUtteranceThreshold: 0.75,
                    continuationTokens: [
                        "и", "а", "но", "ну", "вот", "так", "значит",
                        "короче", "эм", "ээ", "мм", "это",
                    ],
                    trailingContinuationTokens: [
                        "чтобы", "потому", "который", "которая", "которое", "которые",
                        "про", "либо", "если", "когда", "пока", "хотя",
                    ],
                    completeShortAnswers: [
                        "да", "нет", "ок", "окей", "хорошо", "ага", "угу", "не",
                        "стоп", "верно", "точно", "конечно", "давай", "давайте",
                        "спасибо", "понятно", "нет спасибо", "да давайте",
                    ],
                    speculativeEouProbability: 0.6,
                },
                enableLogging: true,

                onUserTurn: (input, version) => {
                    if (terminating || !micOpen) return;
                    firstDeltaLoggedForTurn = false;
                    turnStartedAt = Date.now();
                    Logger.write(`[OUT-CASCADE] ===USER=== ${input}`);
                    logDialog("user", input);
                    messages.push({ role: "user", content: input });
                    sendUserText(input);
                    requestResponse(version);
                },

                onInterrupt: () => {
                    if (terminating || !micOpen) return;
                    ttsPlayer?.clearBuffer();
                    if (main.active) {
                        // Останавливаем генерацию НА СЕРВЕРЕ — иначе модель
                        // досчитывает ответ, который никто не услышит, и мы за него платим.
                        try { realtime.responseCancel(); } catch (e) { /* noop */ }
                    }
                    main.active = false;
                    main.responseId = null;
                    main.text = "";
                },
            });

            // Приветствие (фиксированная фраза, мимо LLM).
            messages.push({ role: "assistant", content: greeting });
            logDialog("assistant", greeting);
            ttsPlayer.send({ send_text: { text: cleanForTTS(greeting), flush_context: {} } });
            resetHardTimeout();

            // MUTE-окно: открываем мик абонента только после mute_duration_ms,
            // чтобы «Алло»/шум при поднятии трубки не оборвали приветствие.
            setTimeout(() => {
                if (terminating) return;
                call.sendMediaTo(stt);
                micOpen = true;
                Logger.write(`[OUT-CASCADE] MIC OPEN (after ${MUTE_DURATION_MS}ms mute)`);
            }, MUTE_DURATION_MS);
        });
    };

    try {
        Logger.write(`[OUT-CASCADE] Outbound -> ${PHONE_NUMBER} (caller_id=${CALLER_ID}) type=${callType}`);

        const config = await fetchOutboundConfig(ASSISTANT_ID);
        if (!config || !config.api_key) {
            Logger.write("[OUT-CASCADE] No outbound config / api_key — abort (no dial)");
            VoxEngine.terminate();
            return;
        }

        apiKey = config.api_key;
        greeting = determineGreeting(config.first_phrase);

        // system-промпт: контекст (задача + CRM) + база + стиль + анти-повтор приветствия.
        systemPrompt = buildContextBlock();
        systemPrompt += (config.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;
        systemPrompt +=
            `\n\nТип звонка: ИСХОДЯЩИЙ (ты звонишь абоненту, номер ${PHONE_NUMBER}). ` +
            `Разговор уже начат: приветствие собеседнику уже произнесено. ` +
            `Не здоровайся и не представляйся заново — сразу переходи к цели звонка.`;
        // Информация о звонке в промпт: реальные номера и текущее время, чтобы
        // модель могла корректно вызывать функции (например, send_sms) и
        // ориентироваться во времени. Для исходящего caller_number — номер
        // клиента (кому звоним), called_number — наш номер (caller_id). МСК (UTC+3).
        const mskTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
        systemPrompt +=
            `\n\nИнформация о звонке:\n` +
            `- Номер клиента (caller_number): ${PHONE_NUMBER}\n` +
            `- Наш номер (called_number): ${CALLER_ID}\n` +
            `- Текущее время: ${mskTime} (МСК)`;
        messages.push({ role: "system", content: systemPrompt });

        // Функции ассистента -> tools Realtime (ПЛОСКИЙ формат: name/description/
        // parameters на верхнем уровне, в отличие от вложенного у Chat Completions).
        if (config.functions && config.functions.length > 0) {
            const decls = [];
            for (let i = 0; i < config.functions.length; i++) {
                const t = config.functions[i];
                const fn = (t.type === "function" && t.function) ? t.function : (t.name ? t : null);
                if (!fn) continue;
                functionNameToIdMap[fn.name] = String(i + 1);
                let desc = fn.description;
                if (fn.name === "hangup_call") {
                    desc = "КРИТИЧЕСКИ ВАЖНО: вызови эту функцию НЕМЕДЛЕННО, когда задача звонка выполнена или собеседник хочет завершить разговор («пока», «до свидания», «всё, спасибо»). Не прощайся просто словами — вызови функцию.";
                }
                decls.push({
                    type: "function",
                    name: fn.name,
                    description: desc,
                    parameters: fn.parameters,
                });
            }
            realtimeTools = decls;
            Logger.write(`[OUT-CASCADE] Functions: ${JSON.stringify(functionNameToIdMap)}`);
        }

        Logger.write(`[OUT-CASCADE] LLM: ${LLM_MODEL} via Realtime WS (text-only, наш turn-taking)`);

        // READINESS: готовим ASR / LLM / TTS ДО дозвона. WS к OpenAI поднимается
        // здесь же — если сессия не встала, PSTN не набираем вовсе (0₽ телефонии).
        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            model: asrModelForLang(config.asr_lang),
            interimResults: true,
        });

        realtime = await connectRealtime(false);

        if (config.tts_provider && config.tts_provider !== "voxtts") {
            Logger.write(`[OUT-CASCADE] ⚠️ tts_provider='${config.tts_provider}' не поддержан, fallback VoxTTS/Anna`);
        }
        ttsPlayer = VoxTTS.createRealtimeTTSPlayer({
            createContextParameters: {
                create: {
                    modelId: VoxTTS.ModelList.VoxTTS,
                    voiceId: voxttsVoice(config.tts_voice),
                },
            },
        });

        // Прогрев больше не нужен: WS открыт и сессия сконфигурирована ещё до
        // дозвона, первый ход абонента и так уходит в тёплое соединение.
        Logger.write(`[OUT-CASCADE] Ready -> dialing PSTN ${PHONE_NUMBER}`);
        call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);
        attachCallHandlers();
    } catch (error) {
        Logger.write("[OUT-CASCADE] ===UNHANDLED_ERROR===");
        Logger.write(String(error));
        if (call) terminateCall();
        else VoxEngine.terminate();
    }
});
