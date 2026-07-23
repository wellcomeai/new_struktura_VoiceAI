/**
 * inbound_cascade — входящий full-cascade Voice AI сценарий Voicyfy.
 *
 *   STT:  встроенный ASR (Yandex v2, streaming + interim), язык из конфига
 *   LLM:  OpenAI gpt-5.4-nano — Chat Completions (stateless, ручная история)
 *   TTS:  VoxTTS (realtime-стриминг, голоса Anna/Sergey)
 *   Turn-taking: Silero VAD + Pipecat Smart Turn через VoxTurnTaking
 *
 * ПОЧЕМУ Chat Completions, а не Responses:
 *  - Responses + storeContext хранит диалог на сервере и цепляет ходы через
 *    previous_response_id. Это ломало спекуляцию (промах отравлял контекст) и не
 *    наследовал instructions. Chat Completions stateless: мы сами держим массив
 *    messages и шлём его целиком каждый ход. system-промпт — первый элемент.
 *
 * КАКОЕ СОБЫТИЕ СЛУШАЕМ (сверено по реальным логам):
 *  Коннектор на каждый токен эмитит три события — Chunk, Content, ContentDelta.
 *  Слушаем ТОЛЬКО `Chunk`, потому что лишь у него в payload есть completion-`id`
 *  (у ContentDelta/ContentDone его нет). Форма Chunk = сырой OpenAI-чанк:
 *    payload.id, payload.choices[0].delta.content, payload.choices[0].finish_reason
 *  Конец ответа = непустой finish_reason ("stop"/"length"/...).
 *
 * ГЕЙТИНГ ПОКОЛЕНИЙ (без опоры на metadata — его OpenAI не возвращает):
 *  - ДВА клиента: llmMain (подтверждённые ходы) и llmSpec (спекуляция). Потоки
 *    физически разделены — спекулятивное событие всегда приходит от llmSpec.
 *  - Внутри клиента лишние/устаревшие/оборванные стримы отсекаются по completion-
 *    `id`. Пока клиент ничего не «ждёт», любой пришедший id помечается устаревшим
 *    (stale) — так хвост прошлого ответа и вывод warmup не протекают дальше.
 *
 * WARMUP (прячет холодный первый токен ~1.5с под приветствие):
 *  WS к OpenAI открыт с начала звонка, но первая инференс-задержка холодная.
 *  Пока клиент слушает приветствие, шлём фиктивный запрос — его вывод гасится.
 *
 * СПЕКУЛЯЦИЯ:
 *  Runtime эмитит onSpeculativeTurn(input, version), когда interim выглядит
 *  завершённым, но EOU ещё не подтверждён -> запускаем LLM на llmSpec заранее.
 *
 * ЗАПИСЬ / СТОИМОСТЬ / ЛОГИРОВАНИЕ (перенесено из Gemini-сценария v7.9):
 *  - Запись звонка: call.record() на CallEvents.Connected, url ловим из
 *    CallEvents.RecordStarted.
 *  - call_session_history_id: из AppEvents.Started (sessionId) — сервер по нему
 *    берёт ПОЛНУЮ стоимость через GetCallHistory.
 *  - Стоимость/длительность: из события Disconnected/Failed (cost/duration).
 *  - Структурированный диалог (dialog) + user/assistant буферы копятся по ходу.
 *  - В конце звонка (terminateCall) один POST /api/voximplant/log со всем набором
 *    (запись, session id, стоимость, диалог). Per-turn /webhook/transcript УБРАН —
 *    сервер сам создаёт запись разговора, R2-запись, стоимость и Telegram по /log.
 *
 * ТРЕБОВАНИЯ:
 * 1. В правиле роутинга `vox-turn-taking` — ПЕРВЫМ, этот сценарий — ВТОРЫМ.
 * 2. Конфиг ассистента: GET /api/telephony/config.
 */

require(Modules.ASR);
require(Modules.OpenAI);
require(Modules.VoxTTS);
require(Modules.Recorder);

const BACKEND_URL = "https://voicyfy.ru";
const LOG_URL = BACKEND_URL + "/api/voximplant/log";
const FUNCTIONS_URL = BACKEND_URL + "/api/voximplant/functions/execute";
const LLM_MODEL = "gpt-5.4-nano";
// Для GPT-5.x reasoning обязателен к отключению: с ним TTFT растёт с ~0.6с до
// 5-8с. У gpt-5.4-nano значение "none" (у более старых моделей — "minimal").
const LLM_REASONING_EFFORT = "none";

const CC = OpenAI.ChatCompletionsAPIEvents;

// --- Извлечение данных из события `Chunk` (сырой OpenAI-чанк в data.payload) ---
function ccPayload(event) {
    return event?.data?.payload ?? event?.data ?? {};
}
function extractDelta(event) {
    const p = ccPayload(event);
    return (
        p?.choices?.[0]?.delta?.content ??
        p?.delta?.content ??
        (typeof p?.delta === "string" ? p.delta : undefined) ??
        p?.content ??
        ""
    );
}
// Уникальный id completion — присутствует в каждом чанке одного ответа OpenAI.
function extractCompletionId(event) {
    const p = ccPayload(event);
    return p?.id ?? p?.choices?.[0]?.id ?? "";
}
// Непустой finish_reason => ответ завершён.
function extractFinishReason(event) {
    const p = ccPayload(event);
    const fr = p?.choices?.[0]?.finish_reason;
    return typeof fr === "string" && fr.length > 0 ? fr : "";
}
// Дельты tool_calls из сырого OpenAI-чанка (Chat Completions tool-calling).
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
function normalizeForMatch(text) {
    return (text || "")
        .trim()
        .toLowerCase()
        .replace(/[.,!?;:…—-]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

async function fetchConfig(phone, caller) {
    const url =
        `${BACKEND_URL}/api/telephony/config` +
        `?phone=${encodeURIComponent(phone)}` +
        (caller ? `&caller=${encodeURIComponent(caller)}` : "");
    const response = await Net.httpRequestAsync(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (response.code !== 200 || !response.text) {
        Logger.write(`[CASCADE] Config HTTP error: ${response.code}`);
        return null;
    }
    try {
        const config = JSON.parse(response.text);
        return config && config.success ? config : null;
    } catch (e) {
        Logger.write(`[CASCADE] Config parse error: ${e}`);
        return null;
    }
}

// --- Session ID для расчёта полной стоимости на сервере (GetCallHistory) ---
let call_session_history_id = null;
VoxEngine.addEventListener(AppEvents.Started, (e) => {
    call_session_history_id = e.sessionId;
    Logger.write(`[CASCADE] Session History ID: ${call_session_history_id}`);
});

VoxEngine.addEventListener(AppEvents.CallAlerting, async ({ call }) => {
    let stt;
    let llmMain; // клиент для подтверждённых ходов
    let llmSpec; // клиент для спекулятивной генерации
    let ttsPlayer;
    let turnTaking;

    // Ручная история диалога (stateless Chat Completions).
    const messages = []; // [0]=system, далее user/assistant

    // Состояние главного (подтверждённого) потока.
    const main = { accepting: false, id: null, text: "", toolCalls: {}, version: -1 };
    const mainStaleIds = new Set();

    // Состояние спекуляции (null, когда её нет).
    let spec = null;
    const specStaleIds = new Set();

    // Tool-calling (функции ассистента). Спекуляция несовместима с tool-calling,
    // поэтому при наличии функций она отключается (см. onSpeculativeTurn).
    let tools = [];
    let toolsEnabled = false;
    const functionNameToIdMap = {};

    // Замер TTFB голоса.
    let firstDeltaLoggedForTurn = false;
    let turnStartedAt = 0;

    // Разовый лог формы события.
    const loggedShapes = new Set();

    let systemPrompt;
    let assistantId;
    let callId;

    // --- Данные для /log (запись, стоимость, диалог) ---
    const chat_id = "vox_" + Math.random().toString(36).substring(2, 15);
    const caller_number = call.callerid() || "unknown";
    const called_number = call.number() || "unknown";
    let record_url = null;
    let call_cost = 0;
    let call_duration = 0;
    const dialogLog = []; // [{ role, text, ts }]
    let userMessageBuffer = "";
    let assistantMessageBuffer = "";
    let terminating = false;

    const logDialog = (role, text) => {
        if (!text) return;
        dialogLog.push({ role, text, ts: Date.now() });
        if (role === "user") {
            userMessageBuffer += (userMessageBuffer ? "\n" : "") + text;
        } else {
            assistantMessageBuffer += (assistantMessageBuffer ? "\n" : "") + text;
        }
    };

    const sendConversationLog = async () => {
        if (!assistantId) return;
        if (!userMessageBuffer && !assistantMessageBuffer && dialogLog.length === 0) return;
        const payload = {
            assistant_id: assistantId,
            chat_id: chat_id,
            call_id: callId,
            caller_number: "INBOUND:" + caller_number,
            type: "conversation",
            call_cost: call_cost,
            call_duration: call_duration,
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
            Logger.write(`[CASCADE] /log HTTP ${resp.code} (turns=${dialogLog.length})`);
        } catch (e) {
            Logger.write(`[CASCADE] /log error: ${e}`);
        }
    };

    // Завершение звонка: финализация -> пауза (запись/событие оседают) ->
    // POST /log -> hangup -> VoxEngine.terminate. Guard от двойного вызова.
    let terminatePromise = null;
    const terminateCall = () => {
        if (terminatePromise) return terminatePromise;
        terminating = true;
        terminatePromise = (async () => {
            try { stt?.stop(); } catch (e) { /* noop */ }
            try { turnTaking?.close(); } catch (e) { /* noop */ }

            // Дописать незавершённый ответ ассистента (звонок мог оборваться
            // посреди генерации).
            if (main.accepting && main.text) {
                logDialog("assistant", main.text);
            } else if (spec && spec.promoted && spec.text && !spec.done) {
                logDialog("assistant", spec.text);
            }

            // Дать записи/финальным событиям осесть.
            await new Promise((r) => setTimeout(r, 400));

            Logger.write(
                `[CASCADE] ===BILLING=== cost=${call_cost} dur=${call_duration}s ` +
                `turns=${dialogLog.length} rec=${record_url ? "yes" : "no"} session=${call_session_history_id || "none"}`
            );
            await sendConversationLog();

            try { call.hangup(); } catch (e) { /* noop */ }
            setTimeout(() => VoxEngine.terminate(), 400);
        })();
        return terminatePromise;
    };

    // --- События записи и жизненного цикла звонка ---
    call.addEventListener(CallEvents.RecordStarted, (event) => {
        record_url = event.url;
        Logger.write(`[CASCADE] Recording started: ${event.url}`);
    });
    call.addEventListener(CallEvents.RecordStopped, (event) => {
        if (event && event.url) record_url = event.url;
    });
    call.addEventListener(CallEvents.Connected, () => {
        try {
            call.record({ stereo: false, lossless: false, hd_audio: true });
        } catch (e) {
            Logger.write(`[CASCADE] record() error: ${e}`);
        }
    });
    call.addEventListener(CallEvents.Disconnected, (event) => {
        if (event && event.cost !== undefined) call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;
        Logger.write(`[CASCADE] ===DISCONNECTED=== cost=${call_cost} dur=${call_duration}s`);
        terminateCall();
    });
    call.addEventListener(CallEvents.Failed, (event) => {
        if (event && event.cost !== undefined) call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;
        Logger.write(`[CASCADE] ===CALL_FAILED=== code=${event?.code} ${event?.reason || ""}`);
        terminateCall();
    });

    const logShapeOnce = (tag, event) => {
        if (loggedShapes.has(tag)) return;
        loggedShapes.add(tag);
        try {
            Logger.write(`[CASCADE] ===SHAPE ${tag}=== ${JSON.stringify(event?.data)}`);
        } catch (e) {
            Logger.write(`[CASCADE] SHAPE ${tag} stringify error`);
        }
    };

    const logFirstDelta = (tag) => {
        if (firstDeltaLoggedForTurn) return;
        firstDeltaLoggedForTurn = true;
        const dt = turnStartedAt ? Date.now() - turnStartedAt : -1;
        Logger.write(`[CASCADE] ===FIRST_DELTA=== +${dt}ms${tag ? " " + tag : ""}`);
    };

    const ttsSendText = (text) => {
        if (!text) return;
        ttsPlayer.send({ send_text: { text } });
    };
    const ttsFlush = () => {
        ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
    };

    const sendCompletion = (client, msgs, useTools) => {
        const req = {
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            messages: msgs,
        };
        if (useTools && tools.length) {
            req.tools = tools;
            req.tool_choice = "auto";
        }
        client.createChatCompletions(req);
    };

    const warmup = (client) => {
        sendCompletion(client, [{ role: "user", content: "привет" }]);
    };

    const startMain = (msgs, version) => {
        if (main.id) mainStaleIds.add(main.id);
        main.accepting = true;
        main.id = null;
        main.text = "";
        main.toolCalls = {};
        main.version = version;
        sendCompletion(llmMain, msgs, toolsEnabled);
    };

    const startSpec = (input, version) => {
        spec = {
            version,
            inputNorm: normalizeForMatch(input),
            userText: input,
            id: null,
            text: "",
            done: false,
            promoted: false,
        };
        sendCompletion(llmSpec, messages.concat({ role: "user", content: input }));
    };

    const abandonSpec = () => {
        if (!spec) return;
        if (spec.id) specStaleIds.add(spec.id);
        spec = null;
    };

    const finalizeMain = () => {
        const text = main.text;
        if (text) {
            messages.push({ role: "assistant", content: text });
            Logger.write(`[CASCADE] ===AGENT=== ${text}`);
            logDialog("assistant", text);
        }
        if (turnTaking.canPlayAgentAudio()) ttsFlush();
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        main.text = "";
        main.toolCalls = {};
    };

    const finalizeSpec = () => {
        const text = spec.text;
        if (text) {
            messages.push({ role: "assistant", content: text });
            Logger.write(`[CASCADE] ===AGENT=== ${text}`);
            logDialog("assistant", text);
        }
        if (turnTaking.canPlayAgentAudio()) ttsFlush();
        if (spec.id) specStaleIds.add(spec.id);
        spec = null;
    };

    // --- Tool-calling: выполнение функций ассистента через бекенд ---
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
                    arguments: Object.assign({}, clean, { assistant_id: assistantId }),
                    call_data: {
                        call_id: callId || "unknown",
                        chat_id: chat_id,
                        assistant_id: assistantId,
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
            Logger.write(`[CASCADE] ===HANGUP=== ${farewell}`);
            if (farewell) {
                logDialog("assistant", farewell);
                if (turnTaking.canPlayAgentAudio()) { ttsSendText(farewell); ttsFlush(); }
            }
            setTimeout(() => terminateCall(), farewell ? 3500 : 300);
            return;
        }

        // Остальные функции: выполнить, вернуть результат в историю.
        for (const c of calls) {
            let args = {};
            try { args = JSON.parse(c.args || "{}"); } catch (e) { /* noop */ }
            Logger.write(`[CASCADE] ===FUNCTION=== ${c.name} ${c.args || ""}`);
            const result = await executeFunction(c.name, args);
            messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
        }
        if (terminating) return;
        // Повторный запрос — модель озвучит ответ по результатам функций.
        startMain(messages.slice(), version);
    };

    try {
        call.answer();

        const config = await fetchConfig(call.number(), call.callerid());
        if (!config) {
            Logger.write("[CASCADE] No config for this number, hanging up");
            call.hangup();
            return;
        }

        assistantId = config.assistant_id;
        callId = call.id();
        systemPrompt = (config.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;
        // Анти-повтор приветствия. БЕЗ дословной фразы в инструкции — иначе модель
        // echo'ит её в каждом ответе (эффект «не думай о розовом слоне»).
        if (config.first_phrase) {
            systemPrompt +=
                `\n\nРазговор уже начат: приветствие собеседнику уже произнесено. ` +
                `Не здоровайся и не представляйся заново — сразу отвечай по сути вопроса.`;
        }
        messages.push({ role: "system", content: systemPrompt });

        // Функции ассистента -> tools для Chat Completions. При наличии функций
        // спекуляция отключается (несовместима с tool-calling), работаем одним
        // клиентом llmMain как в исходящем сценарии.
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
            if (decls.length > 0) {
                tools = decls;
                toolsEnabled = true;
                Logger.write(`[CASCADE] Functions: ${JSON.stringify(functionNameToIdMap)} (speculation OFF)`);
            }
        }

        Logger.write(`[CASCADE] Assistant: ${config.assistant_name} (${assistantId})`);
        Logger.write(`[CASCADE] Call: ${caller_number} -> ${called_number} | id=${callId}`);
        Logger.write(`[CASCADE] LLM: ${LLM_MODEL} via ChatCompletions (Chunk-gated + speculation + warmup)`);

        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            model: asrModelForLang(config.asr_lang),
            interimResults: true,
        });

        [llmMain, llmSpec] = await Promise.all([
            OpenAI.createChatCompletionsAPIClient({ apiKey: config.api_key }),
            OpenAI.createChatCompletionsAPIClient({ apiKey: config.api_key }),
        ]);

        if (config.tts_provider && config.tts_provider !== "voxtts") {
            Logger.write(`[CASCADE] ⚠️ tts_provider='${config.tts_provider}' не поддержан, fallback VoxTTS/Anna`);
        }
        ttsPlayer = VoxTTS.createRealtimeTTSPlayer({
            createContextParameters: {
                create: {
                    modelId: VoxTTS.ModelList.VoxTTS,
                    voiceId: voxttsVoice(config.tts_voice),
                },
            },
        });

        // --- Главный клиент: один обработчик `Chunk` (дельта + финал по id) ---
        llmMain.addEventListener(CC.Chunk, (event) => {
            if (terminating) return;
            logShapeOnce("main.Chunk", event);
            const id = extractCompletionId(event);
            if (id && mainStaleIds.has(id)) return;
            if (!main.accepting) {
                // Клиент ничего не ждёт (warmup / хвост прошлого ответа) — гасим
                // весь этот стрим по его id, чтобы он не протёк в следующий ход.
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
                if (turnTaking.canPlayAgentAudio()) {
                    logFirstDelta("");
                    ttsSendText(text);
                }
            }

            // Сбор дельт tool_calls (только когда включены функции).
            if (toolsEnabled) {
                const toolDeltas = extractToolCallDeltas(event);
                if (toolDeltas) {
                    logShapeOnce("main.Chunk.tool_calls", event);
                    for (const tc of toolDeltas) {
                        const idx = tc.index != null ? tc.index : 0;
                        if (!main.toolCalls[idx]) main.toolCalls[idx] = { id: "", name: "", args: "" };
                        const slot = main.toolCalls[idx];
                        if (tc.id) slot.id = tc.id;
                        if (tc.function?.name) slot.name = tc.function.name;
                        if (tc.function?.arguments) slot.args += tc.function.arguments;
                    }
                }
            }

            const fr = extractFinishReason(event);
            if (fr === "tool_calls") {
                handleToolCalls(main.version);
            } else if (fr) {
                finalizeMain();
            }
        });

        // --- Спек-клиент: один обработчик `Chunk` ---
        llmSpec.addEventListener(CC.Chunk, (event) => {
            if (terminating) return;
            logShapeOnce("spec.Chunk", event);
            const id = extractCompletionId(event);
            if (id && specStaleIds.has(id)) return;
            if (!spec) {
                if (id) specStaleIds.add(id);
                return;
            }
            if (spec.id === null) {
                spec.id = id || "";
            } else if (id && id !== spec.id) {
                return;
            }
            const text = extractDelta(event);
            if (text) {
                spec.text += text;
                if (spec.promoted && turnTaking.canPlayAgentAudio()) {
                    logFirstDelta("(SPEC_LIVE)");
                    ttsSendText(text);
                }
            }
            if (extractFinishReason(event)) {
                spec.done = true;
                if (spec.promoted) {
                    finalizeSpec();
                } else {
                    Logger.write("[CASCADE] ===SPEC_DONE=== буфер готов, ждём подтверждения хода");
                }
            }
        });

        [llmMain, llmSpec].forEach((client) => {
            client.addEventListener(CC.ChatCompletionsAPIError, (event) => {
                Logger.write("[CASCADE] ===LLM_ERROR===");
                if (event?.data) Logger.write(JSON.stringify(event.data));
            });
        });

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

            onSpeculativeTurn: (input, version) => {
                if (terminating) return;
                if (toolsEnabled) return; // спекуляция несовместима с tool-calling
                if (!input) return;
                if (spec && spec.version === version) return;
                if (spec) abandonSpec();
                Logger.write(`[CASCADE] ===SPEC_START=== v${version} :: ${input}`);
                startSpec(input, version);
            },

            onUserTurn: (input, version) => {
                if (terminating) return;
                firstDeltaLoggedForTurn = false;
                turnStartedAt = Date.now();
                Logger.write(`[CASCADE] ===USER=== ${input}`);
                logDialog("user", input);
                messages.push({ role: "user", content: input });

                const inputNorm = normalizeForMatch(input);

                // HIT: спекуляция угадала ход — промоутим её как активную.
                if (spec && spec.inputNorm === inputNorm) {
                    Logger.write(`[CASCADE] ===SPEC_HIT=== v${version}`);
                    main.accepting = false;
                    spec.promoted = true;
                    if (spec.text && turnTaking.canPlayAgentAudio()) {
                        logFirstDelta("(SPEC_HIT)");
                        ttsSendText(spec.text);
                    }
                    if (spec.done) finalizeSpec();
                    return;
                }

                // MISS / спекуляции не было — генерим по-настоящему на llmMain.
                if (spec) {
                    Logger.write(`[CASCADE] ===SPEC_MISS=== spec="${spec.userText}" real="${input}"`);
                    abandonSpec();
                }
                startMain(messages.slice(), version);
            },

            onInterrupt: () => {
                if (terminating) return;
                ttsPlayer?.clearBuffer();
                abandonSpec();
                main.accepting = false;
                if (main.id) mainStaleIds.add(main.id);
                main.id = null;
                main.text = "";
                main.toolCalls = {};
            },
        });

        call.sendMediaTo(stt);
        ttsPlayer.sendMediaTo(call);

        // --- Приветствие ---
        if (config.first_phrase) {
            messages.push({ role: "assistant", content: config.first_phrase });
            logDialog("assistant", config.first_phrase);
            ttsPlayer.send({ send_text: { text: config.first_phrase, flush_context: {} } });
            warmup(llmMain);
            if (!toolsEnabled) warmup(llmSpec);
        } else {
            if (!toolsEnabled) warmup(llmSpec);
            startMain(
                messages.concat({
                    role: "user",
                    content: "Поприветствуй звонящего одной короткой фразой и спроси, чем можешь помочь.",
                }),
                turnTaking.currentVersion()
            );
        }
    } catch (error) {
        Logger.write("[CASCADE] ===UNHANDLED_ERROR===");
        Logger.write(String(error));
        terminateCall();
    }
});
