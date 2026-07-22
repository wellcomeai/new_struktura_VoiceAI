/**
 * outbound_cascade — ИСХОДЯЩИЙ full-cascade Voice AI сценарий Voicyfy.
 *
 *   STT:  встроенный ASR (Yandex v2, streaming + interim), язык из конфига
 *   LLM:  OpenAI gpt-5.4-nano — Chat Completions (stateless, ручная история) + tool calling
 *   TTS:  VoxTTS (realtime-стриминг, голоса Anna/Sergey)
 *   Turn-taking: Silero VAD + Pipecat Smart Turn через VoxTurnTaking
 *
 * ОТЛИЧИЯ ОТ inbound_cascade:
 *  1. Точка входа — AppEvents.Started + VoxEngine.customData() (не CallAlerting).
 *  2. Мы САМИ звоним: VoxEngine.callPSTN(phone, caller_id).
 *  3. Конфиг — /api/telephony/outbound-config?assistant_id=...&assistant_type=cascade.
 *  4. Контекст звонка (задача + CRM) инжектится в system-промпт.
 *  5. READINESS-BEFORE-DIAL: клиент OpenAI / TTS / ASR готовим ДО дозвона — если
 *     что-то не поднялось, PSTN не набираем (0₽ телефонии).
 *  6. MUTE-окно: первые mute_duration_ms после ответа мик абонента закрыт
 *     (флаг micOpen) — «Алло»/шум при поднятии трубки не обрывают приветствие.
 *  7. TOOL CALLING: ассистент может вызывать функции (в т.ч. hangup_call, чтобы
 *     самому завершить звонок). Разбор tool_calls из сырого OpenAI-чанка.
 *  8. Silence hard-timeout ~180с (защита от автоответчика/тишины). Session-TTL
 *     НЕ нужен (это лимит Gemini Live; у Chat Completions его нет).
 *
 * СПЕКУЛЯЦИЯ здесь НЕ используется (в отличие от inbound): в реальных тестах она
 * не срабатывала (быстрый endpointing её вытесняет), а совмещать её с tool-calling
 * небезопасно (спекулятивно выполнять функцию нельзя). Один LLM-клиент, гейтинг
 * по completion-id сохранён.
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
const LLM_MODEL = "gpt-5.4-nano";
const LLM_REASONING_EFFORT = "none";
const SILENCE_HARD_TIMEOUT_MS = 180000;

const CC = OpenAI.ChatCompletionsAPIEvents;

function ccPayload(event) {
    return event?.data?.payload ?? event?.data ?? {};
}
function extractDelta(event) {
    const p = ccPayload(event);
    return p?.choices?.[0]?.delta?.content ?? "";
}
function extractCompletionId(event) {
    const p = ccPayload(event);
    return p?.id ?? p?.choices?.[0]?.id ?? "";
}
function extractFinishReason(event) {
    const p = ccPayload(event);
    const fr = p?.choices?.[0]?.finish_reason;
    return typeof fr === "string" && fr.length > 0 ? fr : "";
}
function extractToolCallDeltas(event) {
    const p = ccPayload(event);
    const tc = p?.choices?.[0]?.delta?.tool_calls;
    return Array.isArray(tc) ? tc : null;
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
    let llm;
    let ttsPlayer;
    let turnTaking;
    let greeting = "";

    const messages = []; // [0]=system, далее user/assistant/tool
    const main = { accepting: false, id: null, text: "", toolCalls: {}, version: -1 };
    const mainStaleIds = new Set();

    let tools = [];
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
        if (text) ttsPlayer.send({ send_text: { text } });
    };
    const ttsFlush = () => {
        ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
    };

    const sendCompletion = (msgs) => {
        const req = {
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            messages: msgs,
        };
        if (tools.length) {
            req.tools = tools;
            req.tool_choice = "auto";
        }
        llm.createChatCompletions(req);
    };

    const warmup = () => {
        llm.createChatCompletions({
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            messages: [{ role: "user", content: "привет" }],
        });
    };

    const startMain = (msgs, version) => {
        if (main.id) mainStaleIds.add(main.id);
        main.accepting = true;
        main.id = null;
        main.text = "";
        main.toolCalls = {};
        main.version = version;
        sendCompletion(msgs);
        resetHardTimeout();
    };

    const finalizeMain = () => {
        const text = main.text;
        if (text) {
            messages.push({ role: "assistant", content: text });
            Logger.write(`[OUT-CASCADE] ===AGENT=== ${text}`);
            logDialog("assistant", text);
        }
        if (canPlay()) ttsFlush();
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        main.text = "";
        main.toolCalls = {};
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
                        caller_number: caller_number,
                    },
                }),
            });
            if (resp.code === 200) return resp.text || "{}";
            return `Error: HTTP ${resp.code}`;
        } catch (e) {
            return `Error: ${e}`;
        }
    };

    // Разбор и выполнение tool_calls (Chat Completions manual tool loop).
    const handleToolCalls = async (version) => {
        const calls = Object.keys(main.toolCalls)
            .map((k) => main.toolCalls[k])
            .filter((c) => c && c.name);

        // Останавливаем гейтинг текущей генерации.
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        const pendingText = main.text;
        main.text = "";
        main.toolCalls = {};

        // Ассистентское сообщение с tool_calls в историю.
        messages.push({
            role: "assistant",
            content: pendingText || null,
            tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.args || "{}" },
            })),
        });

        // hangup_call — ассистент сам завершает звонок.
        const hangup = calls.find((c) => c.name === "hangup_call");
        if (hangup) {
            let farewell = "";
            try {
                farewell = (JSON.parse(hangup.args || "{}").farewell_message) || "";
            } catch (e) { /* noop */ }
            Logger.write(`[OUT-CASCADE] ===HANGUP=== ${farewell}`);
            if (farewell) {
                logDialog("assistant", farewell);
                if (canPlay()) { ttsSendText(farewell); ttsFlush(); }
            }
            setTimeout(() => terminateCall(), farewell ? 3500 : 300);
            return;
        }

        // Остальные функции: выполнить, вернуть результат в историю.
        for (const c of calls) {
            let args = {};
            try { args = JSON.parse(c.args || "{}"); } catch (e) { /* noop */ }
            Logger.write(`[OUT-CASCADE] ===FUNCTION=== ${c.name} ${c.args || ""}`);
            const result = await executeFunction(c.name, args);
            messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
        }
        if (terminating) return;
        // Повторный запрос — модель озвучит ответ по результатам функций.
        startMain(messages.slice(), version);
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

            if (main.accepting && main.text) logDialog("assistant", main.text);

            await new Promise((r) => setTimeout(r, 400));

            Logger.write(
                `[OUT-CASCADE] ===BILLING=== cost=${call_cost} dur=${call_duration}s ` +
                `turns=${dialogLog.length} rec=${record_url ? "yes" : "no"} session=${call_session_history_id || "none"}`
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

    // --- Обработчик стрима LLM (единственный клиент; текст + tool_calls) ---
    const attachLlmHandler = () => {
        llm.addEventListener(CC.Chunk, (event) => {
            if (terminating) return;
            logShapeOnce("Chunk", event);
            const id = extractCompletionId(event);
            if (id && mainStaleIds.has(id)) return;
            if (!main.accepting) {
                if (id) mainStaleIds.add(id);
                return;
            }
            if (main.id === null) {
                main.id = id || "";
            } else if (id && id !== main.id) {
                return;
            }

            const text = extractDelta(event);
            if (text) {
                main.text += text;
                if (canPlay()) {
                    logFirstDelta("");
                    ttsSendText(text);
                }
            }

            const toolDeltas = extractToolCallDeltas(event);
            if (toolDeltas) {
                logShapeOnce("Chunk.tool_calls", event);
                for (const tc of toolDeltas) {
                    const idx = tc.index != null ? tc.index : 0;
                    if (!main.toolCalls[idx]) main.toolCalls[idx] = { id: "", name: "", args: "" };
                    const slot = main.toolCalls[idx];
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = tc.function.name;
                    if (tc.function?.arguments) slot.args += tc.function.arguments;
                }
            }

            const fr = extractFinishReason(event);
            if (fr === "tool_calls") {
                handleToolCalls(main.version);
            } else if (fr) {
                finalizeMain();
            }
        });

        llm.addEventListener(CC.ChatCompletionsAPIError, (event) => {
            Logger.write("[OUT-CASCADE] ===LLM_ERROR===");
            if (event?.data) Logger.write(JSON.stringify(event.data));
        });
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
                    transcriptSettleMs: 350,
                    userSpeechTimeoutMs: 700,
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
                    startMain(messages.slice(), version);
                },

                onInterrupt: () => {
                    if (terminating || !micOpen) return;
                    ttsPlayer?.clearBuffer();
                    main.accepting = false;
                    if (main.id) mainStaleIds.add(main.id);
                    main.id = null;
                    main.text = "";
                    main.toolCalls = {};
                },
            });

            // Приветствие (фиксированная фраза, мимо LLM).
            messages.push({ role: "assistant", content: greeting });
            logDialog("assistant", greeting);
            ttsPlayer.send({ send_text: { text: greeting, flush_context: {} } });
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

        greeting = determineGreeting(config.first_phrase);

        // system-промпт: контекст (задача + CRM) + база + стиль + анти-повтор приветствия.
        let systemPrompt = buildContextBlock();
        systemPrompt += (config.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;
        systemPrompt +=
            `\n\nТип звонка: ИСХОДЯЩИЙ (ты звонишь абоненту, номер ${PHONE_NUMBER}). ` +
            `Разговор уже начат: приветствие собеседнику уже произнесено. ` +
            `Не здоровайся и не представляйся заново — сразу переходи к цели звонка.`;
        messages.push({ role: "system", content: systemPrompt });

        // Функции ассистента -> tools для Chat Completions.
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
                    function: { name: fn.name, description: desc, parameters: fn.parameters },
                });
            }
            tools = decls;
            Logger.write(`[OUT-CASCADE] Functions: ${JSON.stringify(functionNameToIdMap)}`);
        }

        // READINESS: готовим ASR / LLM / TTS ДО дозвона.
        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            model: asrModelForLang(config.asr_lang),
            interimResults: true,
        });

        llm = await OpenAI.createChatCompletionsAPIClient({ apiKey: config.api_key });
        attachLlmHandler();

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

        // Прогрев LLM пока идёт дозвон (первый ход абонента будет быстрым).
        warmup();

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
