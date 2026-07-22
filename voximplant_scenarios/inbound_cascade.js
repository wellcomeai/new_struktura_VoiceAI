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
 *  Пока клиент слушает приветствие, шлём фиктивный запрос — его вывод гасится
 *  (клиент не «ждёт», completion-id уходит в stale). К первому реальному ходу
 *  соединение/модель уже тёплые.
 *
 * СПЕКУЛЯЦИЯ:
 *  Runtime эмитит onSpeculativeTurn(input, version), когда interim выглядит
 *  завершённым, но EOU ещё не подтверждён -> запускаем LLM на llmSpec заранее,
 *  копим дельты, НЕ озвучиваем. Приходит onUserTurn: текст совпал (HIT) ->
 *  промоутим спекуляцию (флашим буфер + озвучиваем остаток live); текст изменился
 *  (MISS) -> буфер выбрасываем, генерим заново на llmMain.
 *
 * ТРЕБОВАНИЯ:
 * 1. В правиле роутинга `vox-turn-taking` — ПЕРВЫМ, этот сценарий — ВТОРЫМ.
 * 2. Конфиг ассистента: GET /api/telephony/config.
 */

require(Modules.ASR);
require(Modules.OpenAI);
require(Modules.VoxTTS);

const BACKEND_URL = "https://voicyfy.ru";
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

function sendTranscript(assistantId, callId, role, transcript) {
    if (!assistantId || !transcript) return;
    Net.httpRequestAsync(`${BACKEND_URL}/api/voximplant/webhook/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        postData: JSON.stringify({
            assistant_id: assistantId,
            call_id: callId,
            role: role,
            transcript: transcript,
            timestamp: new Date().toISOString(),
        }),
    }).catch((e) => Logger.write(`[CASCADE] Transcript send error: ${e}`));
}

VoxEngine.addEventListener(AppEvents.CallAlerting, async ({ call }) => {
    let stt;
    let llmMain; // клиент для подтверждённых ходов
    let llmSpec; // клиент для спекулятивной генерации
    let ttsPlayer;
    let turnTaking;

    // Ручная история диалога (stateless Chat Completions).
    const messages = []; // [0]=system, далее user/assistant

    // Состояние главного (подтверждённого) потока.
    const main = { accepting: false, id: null, text: "", version: -1 };
    const mainStaleIds = new Set();

    // Состояние спекуляции (null, когда её нет).
    // { version, inputNorm, userText, id, text, done, promoted }
    let spec = null;
    const specStaleIds = new Set();

    // Замер TTFB голоса.
    let firstDeltaLoggedForTurn = false;
    let turnStartedAt = 0;

    // Разовый лог формы события — чтобы по звонку сверить payload.
    const loggedShapes = new Set();

    let systemPrompt;
    let assistantId;
    let callId;

    const terminate = () => {
        try { stt?.stop(); } catch (e) { /* noop */ }
        turnTaking?.close();
        VoxEngine.terminate();
    };
    call.addEventListener(CallEvents.Disconnected, terminate);
    call.addEventListener(CallEvents.Failed, terminate);

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
        // Форсируем синтез остатка буфера.
        ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
    };

    const sendCompletion = (client, msgs) => {
        client.createChatCompletions({
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            messages: msgs,
        });
    };

    // Фиктивный прогрев: соединение/модель тёплые к первому реальному ходу.
    // Вывод гасится idle-guard'ом обработчика (клиент ничего не «ждёт»).
    const warmup = (client) => {
        sendCompletion(client, [{ role: "user", content: "привет" }]);
    };

    // Запуск подтверждённой генерации на главном клиенте.
    const startMain = (msgs, version) => {
        if (main.id) mainStaleIds.add(main.id);
        main.accepting = true;
        main.id = null;
        main.text = "";
        main.version = version;
        sendCompletion(llmMain, msgs);
    };

    // Запуск спекулятивной генерации на спек-клиенте.
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
            sendTranscript(assistantId, callId, "assistant", text);
        }
        if (turnTaking.canPlayAgentAudio()) ttsFlush();
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        main.text = "";
    };

    const finalizeSpec = () => {
        const text = spec.text;
        if (text) {
            messages.push({ role: "assistant", content: text });
            Logger.write(`[CASCADE] ===AGENT=== ${text}`);
            sendTranscript(assistantId, callId, "assistant", text);
        }
        if (turnTaking.canPlayAgentAudio()) ttsFlush();
        if (spec.id) specStaleIds.add(spec.id);
        spec = null;
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
        // Анти-повтор приветствия. ВАЖНО: без дословной фразы в инструкции —
        // если вписать сюда текст first_phrase, модель начинает echo'ить его в
        // КАЖДОМ ответе (эффект «не думай о розовом слоне»). Даём только нейтральный
        // запрет повторного приветствия.
        if (config.first_phrase) {
            systemPrompt +=
                `\n\nРазговор уже начат: приветствие собеседнику уже произнесено. ` +
                `Не здоровайся и не представляйся заново — сразу отвечай по сути вопроса.`;
        }
        messages.push({ role: "system", content: systemPrompt });

        Logger.write(`[CASCADE] Assistant: ${config.assistant_name} (${assistantId})`);
        Logger.write(`[CASCADE] LLM: ${LLM_MODEL} via ChatCompletions (Chunk-gated + speculation + warmup)`);

        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            model: asrModelForLang(config.asr_lang),
            interimResults: true,
        });

        // Два независимых клиента: WS открываются заранее.
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
                return; // другой/устаревший стрим на этом клиенте
            }
            const text = extractDelta(event);
            if (text) {
                main.text += text;
                if (turnTaking.canPlayAgentAudio()) {
                    logFirstDelta("");
                    ttsSendText(text);
                }
            }
            if (extractFinishReason(event)) finalizeMain();
        });

        // --- Спек-клиент: один обработчик `Chunk` ---
        llmSpec.addEventListener(CC.Chunk, (event) => {
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
                // До подтверждения хода не озвучиваем — только копим. После HIT
                // (promoted) остаток идёт в озвучку live.
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

        // Ошибки на обоих клиентах.
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
            // 0.85 держал ход слишком долго: p≈0.83 не подтверждался и мы падали
            // в 700-мс страховочный фолбэк. 0.7 подтверждает такие фразы сразу.
            turnDetectorOptions: { threshold: 0.7 },
            policy: {
                // Порог «уверенного конца» -> быстрый settle (120мс вместо 350).
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
                // Ниже turnDetector.threshold (0.7): спекуляция стартует в полосе
                // [0.6, 0.7), пока endOfTurn ещё false.
                speculativeEouProbability: 0.6,
            },
            enableLogging: true,

            onSpeculativeTurn: (input, version) => {
                if (!input) return;
                if (spec && spec.version === version) return;
                if (spec) abandonSpec();
                Logger.write(`[CASCADE] ===SPEC_START=== v${version} :: ${input}`);
                startSpec(input, version);
            },

            onUserTurn: (input, version) => {
                firstDeltaLoggedForTurn = false;
                turnStartedAt = Date.now();
                Logger.write(`[CASCADE] ===USER=== ${input}`);
                sendTranscript(assistantId, callId, "user", input);
                messages.push({ role: "user", content: input });

                const inputNorm = normalizeForMatch(input);

                // HIT: спекуляция угадала ход — промоутим её как активную.
                if (spec && spec.inputNorm === inputNorm) {
                    Logger.write(`[CASCADE] ===SPEC_HIT=== v${version}`);
                    main.accepting = false; // ход обслуживает спек-клиент
                    spec.promoted = true;
                    if (spec.text && turnTaking.canPlayAgentAudio()) {
                        logFirstDelta("(SPEC_HIT)");
                        ttsSendText(spec.text); // флашим накопленное
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
                ttsPlayer?.clearBuffer();
                abandonSpec();
                main.accepting = false;
                if (main.id) mainStaleIds.add(main.id);
                main.id = null;
                main.text = "";
            },
        });

        call.sendMediaTo(stt);
        ttsPlayer.sendMediaTo(call);

        // --- Приветствие ---
        if (config.first_phrase) {
            messages.push({ role: "assistant", content: config.first_phrase });
            sendTranscript(assistantId, callId, "assistant", config.first_phrase);
            ttsPlayer.send({ send_text: { text: config.first_phrase, flush_context: {} } });
            // Приветствие идёт мимо LLM -> греем ОБА клиента, пока абонент слушает.
            warmup(llmMain);
            warmup(llmSpec);
        } else {
            // Приветствие генерирует LLM -> llmMain и так «греется» этим запросом,
            // отдельно греем только спек-клиент.
            warmup(llmSpec);
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
        terminate();
    }
});
