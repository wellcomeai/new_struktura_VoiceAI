require(Modules.ASR);
require(Modules.Silero);
require(Modules.OpenAI);
require(Modules.VoxTTS);

/*
 * Voximplant INBOUND Cascade Script v4.0 — ASR → LLM → VoxTTS
 * ====================================================================
 * Тот же каскад, что inbound_fish v2.0, только голос — VoxTTS (Anna/Sergey),
 * встроенный в Voximplant, а не Fish через наш прокси:
 *
 *   звонок ─┬─► ASR Voximplant (Yandex v2 / Deepgram, interim) ── текст
 *           └─► Silero VAD (тишина = пресет паузы ассистента) ──── конец реплики
 *                        │
 *                        ▼  реплика целиком
 *        /ws/cascade/llm/{id} (прокси Voicyfy) ──► LLM_MODEL (стрим текста)
 *                        │  дельты текста
 *                        ▼
 *              VoxTTS.RealtimeTTSPlayer ──► звонок
 *
 *   - Конец реплики — простая тишина Silero (без Pipecat / VoxTurnTaking):
 *     длительность тишины — пресет «Пауза перед ответом» ассистента
 *     (silence_duration_ms: 300 / 650 / 1000). После тишины ждём
 *     SUBMIT_SETTLE_MS, чтобы ASR дослал хвост текста. Абонент продолжил
 *     фразу до звука ответа — куски склеиваются в одну реплику.
 *   - LLM через наш прокси (LLM_TRANSPORT = "proxy", handler_llm_proxy.py):
 *     модели с «/» уходят в OpenRouter на ключе платформы, остальные — в
 *     OpenAI на серверном ключе. URL — CONFIG.llm_proxy_url. Коннектор
 *     Voximplant (Chat Completions, CONFIG.api_key) — откат
 *     LLM_TRANSPORT = "connector". История диалога ведётся в сценарии и
 *     уходит в каждый запрос целиком (system статичен → кэш промпта), поэтому
 *     поздний финал ASR правит реплику в истории без лишнего запроса.
 *   - LLM-часть, ASR/VAD, склейка и перебивания — копия inbound_fish.js
 *     (правьте вместе с ним и outbound_cascade.js / outbound_fish.js).
 *   - VoxTTS: текст копится до первой границы (предложение или запятая от
 *     FIRST_FLUSH_MIN символов) и уходит с flush_context, дальше пачками;
 *     конец реплики — flush. Конец озвучки — PlayerEvents.
 *     AudioChunksPlaybackFinished (final ≠ false), плюс оценка длительности
 *     речи по MS_PER_CHAR на случай, если события не будет.
 *
 * Сценарий самодостаточный: VoxTurnTaking больше не нужен, но правило-цепочка
 * [vox-turn-taking, inbound_cascade] тоже работает (тот файл только
 * объявляет глобальный объект). Каскад бесплатен: токены уходят в /log
 * (cascade_usage) только для статистики.
 */

// ============================================================================
// КОНСТАНТЫ (крутить здесь, логику не трогать)
// ============================================================================
var ASR_PROVIDER     = "yandex";       // "yandex" | "deepgram"
var LLM_TRANSPORT    = "proxy";        // "proxy" — наш сокет /ws/cascade/llm/{id}; "connector" — клиент Chat Completions Voximplant (откат)
var LLM_MODEL        = "deepseek/deepseek-v4.1-flash"; // через OpenRouter (Together), как у Fish; откат — "gpt-6-luna"
var LLM_CONNECTOR_MODEL = "gpt-6-luna";  // коннектор Voximplant ходит только в OpenAI — модель для LLM_TRANSPORT = "connector"
var LLM_REASONING    = "none";         // reasoning_effort: none — без рассуждений; null — не передавать
var LLM_SERVICE_TIER = "priority";     // для моделей OpenAI; прокси для OpenRouter его убирает; null — обычная
var FAIL_PHRASE      = "Извините, у нас технические неполадки. Пожалуйста, перезвоните чуть позже.";
var SILENCE_MS_DEFAULT = 300;          // пауза перед ответом, если в конфиге нет silence_duration_ms
var SILENCE_MS_MIN   = 200;
var SILENCE_MS_MAX   = 1500;
var VAD_THRESHOLD    = 0.5;
var VAD_SPEECH_PAD_MS = 30;
var SUBMIT_SETTLE_MS = 50;             // ждём хвост текста от ASR после тишины
var EMPTY_TEXT_WAIT_MS = 900;          // сколько ждать текст, если ASR ещё молчит
var BARGE_IN_MIN_MS  = 300;            // речь поверх агента короче — не перебивание
var FIRST_FLUSH_MIN  = 18;             // ранний flush первого предложения реплики
var FIRST_CLAUSE_MIN = 18;             // ...или первой части фразы до запятой/тире
var TEXT_BATCH_MIN   = 40;             // копим дельты до этой длины перед отправкой
var LLM_WARMUP       = true;           // прогрев: пока звучит приветствие, шлём модели «Алло» с тем же промптом и выбрасываем ответ
var WARMUP_MAX_TOKENS = 16;            // ответ прогрева не нужен — режем сразу
var MS_PER_CHAR      = 95;             // оценка длительности речи VoxTTS (если событие конца не придёт)
var TTS_START_PAD_MS = 400;            // задержка синтеза до первого звука — тоже «агент звучит»
var TTS_CLEAR_GRACE_MS = 400;          // события плеера сразу после clearBuffer — хвост сброшенной фразы
var HANGUP_GUARD_MS  = 15000;          // потолок ожидания конца прощания
var HANGUP_EST_EXTRA_MS = 2500;        // запас к оценке длительности прощания
var HANGUP_TAIL_MS   = 250;            // запас после конца озвучки перед hangup
var LLM_FAIL_MAX     = 2;              // неудачных ходов подряд до извинения и hangup
var LLM_RETRY_DELAY_MS = 300;          // пауза перед повтором хода после ошибки
var LLM_STUCK_MS     = 20000;          // ответ не закрылся за это время — сброс
var LLM_PROXY_OPEN_MS = 5000;          // ждать открытия сокета к прокси модели

var TELEPHONY_STYLE_RULES =
    "\n\nПравила голосового ответа (телефония):\n" +
    "- Отвечай коротко, обычно 1-2 предложения, без списков, markdown и эмодзи.\n" +
    "- Числа, даты и время произноси словами.\n" +
    "- Если реплика оборвана или неясна — вежливо переспроси одним вопросом.";

function resolveSilenceMs(raw) {
    var v = Number(raw);
    if (!isFinite(v) || v <= 0) return SILENCE_MS_DEFAULT;
    return Math.min(SILENCE_MS_MAX, Math.max(SILENCE_MS_MIN, Math.round(v)));
}

function voxttsVoice(voiceId) {
    return VoxTTS.VoiceList[voiceId] || VoxTTS.VoiceList.Anna;
}

// ============================================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ БИЛЛИНГА
// ============================================================================
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;
var asr_cost = 0;
var record_cost = 0;

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (INBOUND Cascade v4.0)");
    Logger.write("🔑 Session History ID: " + call_session_history_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

// ============================================================================
// ОСНОВНОЙ ОБРАБОТЧИК ВХОДЯЩЕГО ЗВОНКА
// ============================================================================
VoxEngine.addEventListener(AppEvents.CallAlerting, async function(e) {
    var call = e.call;
    var caller_number = call.callerid() || "unknown";
    var called_number = e.destination || "unknown";
    var call_id = call.id();
    var chat_id = 'vox_' + Math.random().toString(36).substring(2, 15);

    // ── Состояние сценария ──────────────────────────────────────────────────
    var callAnswered = false;
    var greetingStarted = false;
    var isInterrupted = false;
    var isHangingUp = false;

    // ── Распознавание и VAD ─────────────────────────────────────────────────
    var asr = null;
    var vad = null;
    var VAD_SILENCE_MS = SILENCE_MS_DEFAULT;
    var userSpeaking = false;
    var speechSeg = 0;           // номер сегмента речи по VAD
    var turnFinal = "";          // финальные куски ASR текущей реплики
    var turnInterim = "";        // текущий interim ASR
    var submitTimer = null;
    var submitWaitStarted = 0;
    var bargeTimer = null;
    var submitted = null;        // последняя отправленная реплика {seg, text, item, dialogEntry}
    var retractedText = "";      // кусок, который retract вернул в реплику (ждём его поздний финал ASR)

    // ── LLM ─────────────────────────────────────────────────────────────────
    var llm = null;
    var llmFailures = 0;         // неудачных ходов подряд
    var llmFailedHard = false;   // модель недоступна — только прощаемся
    var llmBusy = false;         // ответ модели в процессе
    var llmDiscard = false;      // остаток текущего ответа игнорируем
    var llmWarmup = false;       // идёт прогревочный запрос
    var llmPending = false;      // после закрытия ответа нужен новый запрос
    var llmStuckTimer = null;
    var mWarmupSent = 0;
    var llmReasoning = LLM_REASONING;
    var llmServiceTier = LLM_SERVICE_TIER;
    var toolsInFlight = 0;
    var history = [];            // сообщения диалога (без system)
    var needsFollowUp = false;   // после функций нужен ответ модели
    var lastTurnMessages = null; // сообщения последнего запроса (для повтора)
    var respText = "";           // текст текущего ответа (ContentDelta)
    var respChunkText = "";      // он же из сырых чанков — запасной источник
    var respToolCalls = {};      // вызовы функций текущего ответа по index
    var respFinished = false;
    var greetingInput = null;    // разовые сообщения вместо истории (приветствие, повтор)

    // ── VoxTTS ──────────────────────────────────────────────────────────────
    var tts = null;
    var ttsAttached = false;     // sendMediaTo(call) уже вызван
    var flushesSent = 0;         // flush_context, отправленные в плеер
    var flushesDone = 0;         // ...и доигранные (AudioChunksPlaybackFinished)
    var awaitingEnd = false;     // реплика закрыта flush'ем — ждём конца озвучки
    var lastSendFlushed = true;  // последний отправленный кусок закрыт flush'ем
    var ttsClearedAt = 0;
    var agentAudioEndAt = 0;     // оценка: когда агент договорит

    // ── Состояние текущей реплики ассистента ────────────────────────────────
    var turnFullText = "";
    var turnStarted = false;     // в TTS по этой реплике что-то уже уходило
    var firstFlushDone = false;  // ранний flush первого предложения сделан
    var deltaBuffer    = "";     // дельты, ещё не ушедшие в синтез

    // ── Завершение по прощанию ──────────────────────────────────────────────
    var hangupAfterSpeech = false;
    var hangupGuardTimer = null;

    // ── Метрики ─────────────────────────────────────────────────────────────
    var mVadStop = 0, mReqSent = 0, mFirstDelta = 0;
    var stats = { turns: 0, bargeIns: 0, retracts: 0, corrections: 0, dropped: 0,
                  inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

    // ── Структурированный диалог ────────────────────────────────────────────
    var userMessageBuffer = "";
    var assistantMessageBuffer = "";
    var dialogLog = [];
    var lastFunctionResult = null;
    var logCounter = 0;

    // ── Конфиг ──────────────────────────────────────────────────────────────
    var CONFIG = null;
    var ASSISTANT_ID = null;
    var INSTRUCTIONS = "";
    var functionNameToIdMap = {};

    // caller → бэкенд ищет контакт звонящего в базе агента и дописывает
    // карточку клиента в system_prompt + подставляет имя в first_phrase.
    var CONFIG_URL = "https://voicyfy.ru/api/telephony/config?phone=" + called_number.replace(/\D/g, '') + "&caller=" + caller_number.replace(/\D/g, '');
    var FUNCTIONS_URL = "https://voicyfy.ru/api/voximplant/functions/execute";
    var LOG_URL = "https://voicyfy.ru/api/voximplant/log";

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("📞 INBOUND CALL (Cascade v4.0)");
    Logger.write("   From: " + caller_number);
    Logger.write("   To: " + called_number);
    Logger.write("   Call ID: " + call_id);
    Logger.write("   Session ID: " + call_session_history_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // =========================================================================
    // ФУНКЦИЯ ЛОГИРОВАНИЯ ДИАЛОГА НА БЕКЕНД
    // =========================================================================
    async function sendConversationLog(isFinal) {
        try {
            logCounter++;
            Logger.write("📤 SENDING LOG #" + logCounter + (isFinal ? " (FINAL)" : "") +
                " — dialog turns: " + dialogLog.length);

            var payload = {
                assistant_id: ASSISTANT_ID,
                chat_id: chat_id,
                call_id: call_id,
                caller_number: "INBOUND: " + caller_number,
                type: "conversation",
                data: {
                    user_message: userMessageBuffer,
                    assistant_message: assistantMessageBuffer,
                    function_result: lastFunctionResult,
                    dialog: dialogLog
                }
            };

            if (isFinal) {
                if (record_url)              payload.record_url = record_url;
                if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);
                // Fallback-стоимость: то, что видно сценарию. ASR в cost звонка
                // не входит — добавляем сами. Полный счёт бэкенд берёт из
                // GetCallHistory по call_session_history_id.
                payload.call_cost     = Math.round((call_cost + asr_cost + record_cost) * 1e6) / 1e6;
                payload.call_cost_parts = { telephony: call_cost, asr: asr_cost, record: record_cost };
                payload.call_duration = call_duration;
                // Каскад бесплатен — токены только для статистики
                // (списание по ним — за флагом CASCADE_CREDITS_BILLING, выключен).
                payload.cascade_usage = {
                    prompt_tokens: Math.max(0, stats.inputTokens - stats.cachedTokens),
                    cached_prompt_tokens: stats.cachedTokens,
                    completion_tokens: stats.outputTokens,
                    model: llmModel()
                };

                Logger.write("📊 Billing: record=" + (record_url ? "YES" : "NO") +
                    ", cost=" + payload.call_cost + " (asr=" + asr_cost + ", record=" + record_cost + ")" +
                    ", duration=" + call_duration + "s");
            }

            var logResponse = await Net.httpRequestAsync(LOG_URL, {
                headers: ["Content-Type: application/json"],
                method: 'POST',
                postData: JSON.stringify(payload)
            });

            Logger.write("📡 Log #" + logCounter + " → HTTP " + logResponse.code);

            if (logResponse.code == 200 && isFinal) {
                userMessageBuffer = "";
                assistantMessageBuffer = "";
                dialogLog = [];
                lastFunctionResult = null;
            }
        } catch (error) {
            Logger.write("❌ Error sending log: " + error);
        }
    }

    // =========================================================================
    // ОБРАБОТЧИК ЗАВЕРШЕНИЯ ЗВОНКА
    // =========================================================================
    var callEndHandler = async function(event) {
        if (isHangingUp) return;
        isHangingUp = true;

        Logger.write("📴 INBOUND CALL DISCONNECTED");

        if (event && event.cost !== undefined)     call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;

        if (hangupGuardTimer) { clearTimeout(hangupGuardTimer); hangupGuardTimer = null; }
        clearTurnTimers();
        if (llmStuckTimer) { clearTimeout(llmStuckTimer); llmStuckTimer = null; }

        if (llm) { try { llm.close(); } catch (err) {} }
        if (vad) { try { vad.close(); } catch (err) {} }
        if (asr) { try { asr.stop(); } catch (err) {} }

        Logger.write("===TURN_STATS=== silence=" + VAD_SILENCE_MS + "ms " + JSON.stringify(stats));

        // Запись завершается вместе со звонком. Ждём RecordStopped (и
        // ASR.Stopped со стоимостью распознавания) до отправки финального лога.
        await new Promise(function(resolve) { setTimeout(resolve, 500); });

        if (userMessageBuffer || assistantMessageBuffer || call_session_history_id || dialogLog.length > 0) {
            try { await sendConversationLog(true); } catch (err) { Logger.write("❌ final log: " + err); }
        }

        Logger.write("✅ Terminated. Total logs: " + logCounter);
        VoxEngine.terminate();
    };

    // =========================================================================
    // ЗАГРУЗКА КОНФИГА
    // =========================================================================
    Logger.write("🔄 Loading config for phone: " + called_number);

    var configResponse;
    try {
        configResponse = await Net.httpRequestAsync(CONFIG_URL);
    } catch (err) {
        Logger.write("❌ Config request failed: " + err);
        call.answer();
        call.addEventListener(CallEvents.Disconnected, callEndHandler);
        call.addEventListener(CallEvents.Failed, callEndHandler);
        return;
    }

    if (configResponse.code != 200) {
        Logger.write("❌ Config HTTP error: " + configResponse.code);
        VoxEngine.terminate();
        return;
    }

    try {
        CONFIG = JSON.parse(configResponse.text);
    } catch (err) {
        Logger.write("❌ Config parse error: " + err);
        VoxEngine.terminate();
        return;
    }

    if (!CONFIG.success) {
        Logger.write("❌ Config returned success=false");
        VoxEngine.terminate();
        return;
    }

    if (CONFIG.assistant_type !== "cascade") {
        Logger.write("❌ Wrong assistant type: " + CONFIG.assistant_type + " (expected: cascade)");
        VoxEngine.terminate();
        return;
    }

    if (LLM_TRANSPORT === "proxy" && !CONFIG.llm_proxy_url) {
        Logger.write("❌ Config has no llm_proxy_url — модели не к чему подключаться");
        VoxEngine.terminate();
        return;
    }

    ASSISTANT_ID = CONFIG.assistant_id;
    VAD_SILENCE_MS = resolveSilenceMs(CONFIG.silence_duration_ms);

    if (CONFIG.tts_provider && CONFIG.tts_provider !== "voxtts") {
        Logger.write("⚠️ tts_provider='" + CONFIG.tts_provider + "' не поддержан — озвучиваем VoxTTS");
    }

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("✅ CONFIG LOADED:");
    Logger.write("   📋 Assistant: " + CONFIG.assistant_name);
    Logger.write("   🆔 ID: " + ASSISTANT_ID);
    Logger.write("   🌐 Language: " + (CONFIG.asr_lang || CONFIG.language || "ru"));
    Logger.write("   👂 ASR: " + ASR_PROVIDER + " | VAD silence " + VAD_SILENCE_MS + "ms");
    Logger.write("   🧠 LLM: " + llmModel() + " via " + LLM_TRANSPORT + " (reasoning " + (llmReasoning || "default") + ")");
    Logger.write("   🔊 VoxTTS voice: " + voxttsVoice(CONFIG.tts_voice));
    Logger.write("   🔧 Functions: " + (CONFIG.functions ? CONFIG.functions.length : 0));
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // =========================================================================
    // ПОДГОТОВКА ФУНКЦИЙ И ИНСТРУКЦИЙ
    // =========================================================================
    var voximplantTools = [];

    if (CONFIG.functions && Array.isArray(CONFIG.functions)) {
        for (var i = 0; i < CONFIG.functions.length; i++) {
            var tool = CONFIG.functions[i];
            if (tool.type === "function" && tool.function) {
                var functionId = (i + 1).toString();
                functionNameToIdMap[tool.function.name] = functionId;
                Logger.write("   🔧 Function: " + tool.function.name + " → ID: " + functionId);
                var description = tool.function.description;
                if (tool.function.name === "hangup_call") {
                    // Без нажима модель «прощается словами» и держит линию.
                    description = "КРИТИЧЕСКИ ВАЖНО: вызови эту функцию НЕМЕДЛЕННО, " +
                        "когда задача звонка выполнена или собеседник хочет закончить " +
                        "разговор («пока», «до свидания», «всё, спасибо»). Не прощайся " +
                        "просто словами — вызови функцию.";
                }
                voximplantTools.push({
                    type: "function",
                    function: {
                        name: tool.function.name,
                        description: description,
                        parameters: tool.function.parameters
                    }
                });
            }
        }
    }

    // Инструкции собираются один раз и не меняются до конца звонка — так
    // префикс запроса одинаковый и модель кэширует его между ходами.
    INSTRUCTIONS = (CONFIG.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;
    if (CONFIG.first_phrase) {
        INSTRUCTIONS += "\n\nТы уже поприветствовал абонента фразой: «" +
            CONFIG.first_phrase.trim() + "». Не здоровайся повторно.";
    }
    // Реальные номера и время: без них модель не может корректно вызвать
    // send_sms (некуда отправлять) и путается в датах. МСК (UTC+3).
    var mskTime = new Date(Date.now() + 3 * 3600 * 1000)
        .toISOString().replace("T", " ").slice(0, 16);
    INSTRUCTIONS += "\n\nИнформация о звонке:\n" +
        "- Номер клиента (caller_number): " + caller_number + "\n" +
        "- Наш номер (called_number): " + called_number + "\n" +
        "- Текущее время: " + mskTime + " (МСК)\n\n" +
        "Это телефонный разговор: реплики абонента приходят из распознавания " +
        "речи и могут содержать ошибки. Пиши только то, что нужно произнести: " +
        "без markdown, списков и эмодзи — текст сразу озвучивается.";

    // =========================================================================
    // TTS: ПОДГОТОВКА ТЕКСТА
    // =========================================================================

    // Модель иногда пишет ответ в несколько строк — "  \n" ломает синтез.
    function cleanForTTS(text) {
        return text.replace(/\s*\n+\s*/g, " ");
    }

    // Точка — конец предложения, а не десятичный разделитель и не инициал.
    function isSentenceDot(s, i) {
        var prev = i > 0 ? s.charAt(i - 1) : "";
        var next = i + 1 < s.length ? s.charAt(i + 1) : "";
        if (/\d/.test(prev) && /\d/.test(next)) return false;           // 1.5, 12.30
        if (/[A-Za-zА-Яа-яЁё]/.test(prev)) {
            var before = i >= 2 ? s.charAt(i - 2) : "";
            if (before === "" || before === " ") return false;          // "А.", "т.е."
        }
        return true;
    }

    function hasSentenceEnd(s) {
        var TERM = ".!?…";
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (TERM.indexOf(ch) === -1) continue;
            if (ch === "." && !isSentenceDot(s, i)) continue;
            return true;
        }
        return false;
    }

    // =========================================================================
    // TTS: ПЛЕЕР VoxTTS
    // =========================================================================
    // Плеер создаётся до ответа на звонок, в звонок подключается после answer.
    // VoxTTS синтезирует накопленный текст по flush_context (на длинном тексте
    // сам делает промежуточные авто-flush). Конец озвучки — событие
    // AudioChunksPlaybackFinished: final=false у промежуточного авто-flush.
    // Одному событию не доверяем: «звучит ли агент» считаем ещё и по оценке
    // длительности речи (MS_PER_CHAR), как в v3, — флаг не залипнет.

    function createTts() {
        tts = VoxTTS.createRealtimeTTSPlayer({
            createContextParameters: {
                create: {
                    modelId: VoxTTS.ModelList.VoxTTS,
                    voiceId: voxttsVoice(CONFIG.tts_voice)
                }
            }
        });
        tts.addEventListener(PlayerEvents.AudioChunksPlaybackFinished, function(ev) {
            if (ev && ev.final === false) return;                       // промежуточный авто-flush
            if (Date.now() - ttsClearedAt < TTS_CLEAR_GRACE_MS) return; // хвост сброшенной фразы
            flushesDone++;
            if (awaitingEnd && flushesDone >= flushesSent) onSpeechDone("playback finished");
        });
        tts.addEventListener(PlayerEvents.Error, function(ev) {
            Logger.write("[TTS] ❌ " + JSON.stringify(ev && (ev.error || ev.reason || ev.code || ev)));
        });
    }

    // sendMediaTo можно звать только когда есть и плеер, и отвеченный звонок.
    function attachTtsToCall() {
        if (ttsAttached || !tts || !callAnswered) return;
        try {
            tts.sendMediaTo(call);
            ttsAttached = true;
            Logger.write("[TTS] 🔊 VoxTTS → call");
        } catch (err) {
            Logger.write("[TTS] ❌ sendMediaTo failed: " + err);
        }
    }

    function ttsSend(text, flush) {
        if (!tts) return;
        var msg = { send_text: { text: text } };
        if (flush) {
            msg.send_text.flush_context = {};
            flushesSent++;
        }
        lastSendFlushed = !!flush;
        try {
            tts.send(msg);
        } catch (err) {
            Logger.write("[TTS] ❌ send failed: " + err);
        }
    }

    // Оценка: кусок текста продлевает ожидаемый конец речи.
    function noteAgentAudio(text) {
        var now = Date.now();
        var start = agentAudioEndAt > now ? agentAudioEndAt : now + TTS_START_PAD_MS;
        agentAudioEndAt = start + Math.max(300, text.length * MS_PER_CHAR);
    }

    // Агент звучит (или вот-вот зазвучит). Нужно, чтобы отличить перебивание
    // от обычной реплики абонента.
    function isAgentAudible() {
        return Date.now() < agentAudioEndAt;
    }

    function onSpeechDone(reason) {
        awaitingEnd = false;
        agentAudioEndAt = Date.now();
        Logger.write("[TTS] ⏹ speech done (" + reason + ")");
        if (hangupAfterSpeech) scheduleHangup(0);
    }

    // Единственная точка отправки текста в синтез.
    function speak(text, final) {
        if (!text || !text.trim() || isHangingUp) return;

        var clean = cleanForTTS(text);
        noteAgentAudio(clean);
        ttsSend(clean, final);
        awaitingEnd = !!final;

        Logger.write("[TTS] → \"" + clean.substring(0, 60) + "\"" + (final ? " (final)" : ""));

        if (!turnStarted) {
            turnStarted = true;
            logTurnTiming();
        }
    }

    // Закрыть реплику, когда весь текст уже ушёл: если последний кусок уже
    // был с flush, второй (пустой) flush не шлём — событие на него может
    // не прийти.
    function closeTtsTurn() {
        if (lastSendFlushed) {
            awaitingEnd = true;
            if (flushesDone >= flushesSent) onSpeechDone("already played");
        } else {
            ttsSend(" ", true);
            awaitingEnd = true;
        }
    }

    // Дельты модели копим и отдаём пачками. До первого flush ничего не шлём:
    // текст, ушедший раньше, попал бы в первый синтез целиком — так flush
    // резал бы фразу на полуслове. Отрезает maybeEarlyFlush, остаток дожмёт
    // endTurn.
    function pushDelta(delta) {
        deltaBuffer  += delta;
        turnFullText += delta;

        if (!firstFlushDone) return;

        if (deltaBuffer.length >= TEXT_BATCH_MIN || hasSentenceEnd(deltaBuffer)) {
            var out = deltaBuffer;
            deltaBuffer = "";
            speak(out, false);
        }
    }

    // Конец реплики: дожимаем остаток накопленного и закрываем flush'ем.
    function endTurn() {
        var out = deltaBuffer;
        deltaBuffer = "";

        if (out && out.trim()) {
            speak(out, true);
        } else if (turnStarted) {
            closeTtsTurn();
        }
    }

    // Запятая, тире, двоеточие — граница части фразы. Запятая между цифрами
    // (1,5) границей не считается.
    function hasClauseEnd(s) {
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (ch === "—" || ch === ";" || ch === ":") return true;
            if (ch === ",") {
                var prev = i > 0 ? s.charAt(i - 1) : "";
                var next = i + 1 < s.length ? s.charAt(i + 1) : "";
                if (/\d/.test(prev) && /\d/.test(next)) continue;
                return true;
            }
        }
        return false;
    }

    // Длина куска до первой границы, на которой можно делать ранний flush:
    // конец предложения (от FIRST_FLUSH_MIN символов) или запятая/тире/
    // двоеточие (от FIRST_CLAUSE_MIN). Точка или запятая сразу после цифры
    // в конце текста — ещё не граница: следом может прийти «12.30» / «1,5».
    function firstFlushCut(s) {
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            var isEnd = ".!?…".indexOf(ch) !== -1;
            var isClause = ",—;:".indexOf(ch) !== -1;
            if (!isEnd && !isClause) continue;
            var prev = i > 0 ? s.charAt(i - 1) : "";
            var next = i + 1 < s.length ? s.charAt(i + 1) : "";
            if ((ch === "." || ch === ",") && /\d/.test(prev) && (next === "" || /\d/.test(next))) continue;
            if (ch === "." && !isSentenceDot(s, i)) continue;
            if (i + 1 >= (isEnd ? FIRST_FLUSH_MIN : FIRST_CLAUSE_MIN)) {
                return { len: i + 1, bySentence: isEnd };
            }
        }
        return null;
    }

    // Синтез начинается по flush и захватывает весь накопленный кусок, поэтому
    // первый flush делаем уже на запятой, если кусок не слишком короткий:
    // звук пойдёт раньше. В синтез уходит ровно кусок до границы — хвост
    // ждёт следующей пачки.
    function maybeEarlyFlush() {
        if (firstFlushDone || isInterrupted) return;
        var cut = firstFlushCut(turnFullText);
        if (!cut) return;
        firstFlushDone = true;
        var alreadySent = turnFullText.length - deltaBuffer.length;
        var take = Math.max(0, cut.len - alreadySent);
        var head = deltaBuffer.substring(0, take);
        deltaBuffer = deltaBuffer.substring(take);
        if (head && head.trim()) {
            var clean = cleanForTTS(head);
            noteAgentAudio(clean);
            ttsSend(clean, true);
            awaitingEnd = false;     // реплика ещё не закончена
            Logger.write("[TTS] → \"" + clean.substring(0, 60) + "\" (early flush)");
            if (!turnStarted) { turnStarted = true; logTurnTiming(); }
        }
        Logger.write("[TTS] ⚡ early flush " + (cut.bySentence ? "первого предложения" : "по запятой"));
    }

    // Перебивание: гасим буфер плеера (мгновенно) — и то, что уже звучит, и
    // то, что VoxTTS ещё синтезирует.
    function stopSpeaking() {
        if (tts) {
            try { tts.clearBuffer(); } catch (err) {
                Logger.write("[TTS] clearBuffer failed: " + err);
            }
        }
        ttsClearedAt = Date.now();
        flushesDone = flushesSent;
        awaitingEnd = false;
        lastSendFlushed = true;
        agentAudioEndAt = 0;
    }

    function resetTurnState() {
        turnFullText = "";
        turnStarted = false;
        firstFlushDone = false;
        deltaBuffer    = "";
        mVadStop = 0; mReqSent = 0; mFirstDelta = 0;
    }

    // Метрика хода: от конца речи абонента до отправки текста в синтез
    // (до звука добавляется задержка VoxTTS).
    function logTurnTiming() {
        if (!mVadStop) return;
        var now = Date.now();
        Logger.write("⏱ TURN: vad→llm=" + (mReqSent ? (mReqSent - mVadStop) : -1) + "ms" +
            " vad→token=" + (mFirstDelta ? (mFirstDelta - mVadStop) : -1) + "ms" +
            " vad→tts=" + (now - mVadStop) + "ms");
    }

    // =========================================================================
    // ЗАВЕРШЕНИЕ ПО ПРОЩАНИЮ
    // =========================================================================

    // Потолок ожидания конца прощания: оценка длительности + запас.
    function armHangupGuard() {
        if (hangupGuardTimer) clearTimeout(hangupGuardTimer);
        var left = Math.max(0, agentAudioEndAt - Date.now());
        var ms = Math.min(HANGUP_GUARD_MS, left + HANGUP_EST_EXTRA_MS);
        hangupGuardTimer = setTimeout(function() { finishHangup("guard timeout"); }, ms);
    }

    function scheduleHangup(remainingMs) {
        if (!hangupAfterSpeech || isHangingUp) return;
        var delay = Math.max(0, remainingMs) + HANGUP_TAIL_MS;
        Logger.write("📴 Прощание отзвучало — вешаем трубку через " + delay + "ms");
        setTimeout(function() { finishHangup("speech done"); }, delay);
    }

    function finishHangup(reason) {
        if (!hangupAfterSpeech || isHangingUp) return;
        hangupAfterSpeech = false;
        if (hangupGuardTimer) { clearTimeout(hangupGuardTimer); hangupGuardTimer = null; }
        Logger.write("📴 Hangup after farewell (" + reason + ")");
        try { call.hangup(); } catch (err) {}
    }

    // =========================================================================
    // ДИАЛОГ: ЗАПИСЬ РЕПЛИК
    // =========================================================================

    function logDialog(role, text) {
        var entry = { role: role, text: text, ts: Date.now() };
        dialogLog.push(entry);
        if (role === "user") {
            if (userMessageBuffer) userMessageBuffer += " ";
            userMessageBuffer += text;
        } else {
            if (assistantMessageBuffer) assistantMessageBuffer += " ";
            assistantMessageBuffer += text;
        }
        Logger.write("   📝 [DIALOG] Added " + role.toUpperCase() + " turn #" + dialogLog.length);
        return entry;
    }

    function normText(s) {
        return String(s || "").toLowerCase().replace(/[^0-9a-zа-яё ]+/g, " ")
            .replace(/\s+/g, " ").trim();
    }

    function wordCount(s) {
        var n = normText(s);
        return n ? n.split(" ").length : 0;
    }

    // =========================================================================
    // LLM: CHAT COMPLETIONS ЧЕРЕЗ ПРОКСИ
    // =========================================================================
    // История сообщений ведётся здесь и уходит целиком в каждый запрос,
    // ответ — стримом. Интерфейс клиента — как у коннектора Voximplant
    // (createChatCompletions + события ChatCompletionsAPIEvents), поэтому
    // откат на коннектор — одна константа.

    // Модели с «/» (OpenRouter) доступны только через наш прокси.
    function llmModel() {
        return (LLM_TRANSPORT !== "proxy" && LLM_MODEL.indexOf("/") !== -1) ? LLM_CONNECTOR_MODEL : LLM_MODEL;
    }

    function eventPayload(event) {
        return (event && event.data && event.data.payload) || (event && event.data) || {};
    }

    // Прогрев. Первое обращение к модели за звонок самое медленное. Пока
    // звучит приветствие, шлём тот же префикс (tools + system + приветствие) с
    // репликой «Алло» и выбрасываем ответ: первая настоящая реплика абонента
    // идёт уже вторым запросом. Реплика, пришедшая раньше, ждёт закрытия
    // прогрева (не обрываем его — иначе разгон пришлось бы платить заново).
    function warmupLlm() {
        if (!LLM_WARMUP || llmBusy || !llm || isHangingUp || llmFailedHard) return;
        var params = {
            model: llmModel(),
            messages: [{ role: "system", content: INSTRUCTIONS }].concat(history)
                .concat([{ role: "user", content: "Алло" }]),
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: WARMUP_MAX_TOKENS
        };
        if (voximplantTools.length > 0) {
            params.tools = voximplantTools;
            params.tool_choice = "auto";
        }
        if (llmReasoning) params.reasoning_effort = llmReasoning;
        if (llmServiceTier) params.service_tier = llmServiceTier;

        llmBusy = true;
        llmDiscard = true;
        llmWarmup = true;
        respFinished = false;
        mWarmupSent = Date.now();
        if (llmStuckTimer) clearTimeout(llmStuckTimer);
        llmStuckTimer = setTimeout(function() {
            llmStuckTimer = null;
            if (llmBusy && llmWarmup) onLlmError("прогрев не закрылся за " + LLM_STUCK_MS + "ms");
        }, LLM_STUCK_MS);
        try {
            llm.createChatCompletions(params);
            Logger.write("[LLM] 🔥 прогрев");
        } catch (err) {
            onLlmError("warmup failed: " + err);
        }
    }

    // Один ответ за раз. Если ответ ещё идёт — выбрасываем его: прокси
    // обрывает запрос сразу, а у коннектора отмены нет, и новый запрос уйдёт,
    // когда текущий закроется (finish_reason / ошибка).
    function requestResponse() {
        if (isHangingUp) return;
        if (llmBusy) {
            llmPending = true;
            if (llmWarmup) { Logger.write("[LLM] ждём закрытия прогрева"); return; }
            if (!discardResponse()) Logger.write("[LLM] ответ ещё идёт — новый запрос после его закрытия");
            return;
        }
        sendRequest();
    }

    // Выбросить текущий ответ. true — оборван сразу (прокси), дальше
    // onResponseClosed → maybeContinue; false — дочитываем и игнорируем.
    function discardResponse() {
        if (!llmBusy || llmWarmup) return false;
        llmDiscard = true;
        if (!llm || !llm.cancel) return false;
        llm.cancel();
        onResponseClosed("cancelled");
        return true;
    }

    function sendRequest() {
        if (isHangingUp || !llm || llmFailedHard) return;

        var turnMessages = greetingInput || history;
        greetingInput = null;
        var messages = [{ role: "system", content: INSTRUCTIONS }].concat(turnMessages);

        var params = {
            model: llmModel(),
            messages: messages,
            stream: true,
            stream_options: { include_usage: true }
        };
        if (voximplantTools.length > 0) {
            params.tools = voximplantTools;
            params.tool_choice = "auto";
        }
        if (llmReasoning) params.reasoning_effort = llmReasoning;
        if (llmServiceTier) params.service_tier = llmServiceTier;

        llmBusy = true;
        llmDiscard = false;
        llmPending = false;
        isInterrupted = false;
        respText = "";
        respChunkText = "";
        respToolCalls = {};
        respFinished = false;
        lastTurnMessages = turnMessages;
        var vadStop = mVadStop;
        resetTurnState();
        mVadStop = vadStop;          // метрику текущего хода сохраняем
        mReqSent = Date.now();

        if (llmStuckTimer) clearTimeout(llmStuckTimer);
        llmStuckTimer = setTimeout(function() {
            llmStuckTimer = null;
            if (!llmBusy) return;
            onLlmError("ответ не закрылся за " + LLM_STUCK_MS + "ms");
        }, LLM_STUCK_MS);

        try {
            llm.createChatCompletions(params);
            Logger.write("[LLM] → request (" + messages.length + " messages)");
        } catch (err) {
            onLlmError("createChatCompletions failed: " + err);
        }
    }

    // Ответ закрылся — решаем, что дальше: продолжение после функций,
    // отложенная реплика абонента или ничего.
    function onResponseClosed(reason) {
        if (!llmBusy) return;
        llmBusy = false;
        if (llmStuckTimer) { clearTimeout(llmStuckTimer); llmStuckTimer = null; }
        if (llmWarmup) {
            llmWarmup = false;
            Logger.write("[LLM] 🔥 прогрев готов +" + (Date.now() - mWarmupSent) + "ms");
            maybeContinue();
            return;
        }
        Logger.write("[LLM] response closed (" + reason + ")" + (llmDiscard ? " [discarded]" : ""));
        maybeContinue();
    }

    function maybeContinue() {
        if (llmBusy || toolsInFlight > 0 || isHangingUp || !llm) return;
        if (llmPending || needsFollowUp) {
            needsFollowUp = false;
            sendRequest();
        }
    }

    // Ошибка хода. Тот же ход повторяем (после переподключения, если сокет
    // закрылся вслед за ошибкой). reasoning_effort / service_tier, которые
    // модель не приняла, убираем без счёта попыток. После LLM_FAIL_MAX неудач
    // подряд извиняемся и кладём трубку — молчать в трубку хуже.
    function onLlmError(text) {
        Logger.write("❌ [LLM] " + String(text).substring(0, 500));
        if (!llmBusy) return;
        llmBusy = false;
        if (llmStuckTimer) { clearTimeout(llmStuckTimer); llmStuckTimer = null; }

        // Прогрев не удался — не страшно: попыток не считаем и не повторяем.
        if (llmWarmup) {
            llmWarmup = false;
            setTimeout(maybeContinue, LLM_RETRY_DELAY_MS);
            return;
        }

        if (llmReasoning && /reasoning/i.test(text)) {
            Logger.write("[LLM] модель не приняла reasoning_effort — повтор без него");
            llmReasoning = null;
        } else if (llmServiceTier && /service_tier/i.test(text)) {
            Logger.write("[LLM] service_tier не принят — повтор без него");
            llmServiceTier = null;
        } else {
            llmFailures++;
        }
        if (llmFailures > LLM_FAIL_MAX) { failGracefully(); return; }

        if (!llmDiscard) {
            greetingInput = lastTurnMessages === history ? null : lastTurnMessages;
            llmPending = true;
        }
        // Сокет после ошибки обычно закрывается следом — даём ему это сделать,
        // повтор тогда уйдёт из обработчика переподключения.
        setTimeout(maybeContinue, LLM_RETRY_DELAY_MS);
    }

    function failGracefully() {
        if (llmFailedHard) return;
        llmFailedHard = true;
        llmPending = false;
        needsFollowUp = false;
        Logger.write("❌ [LLM] модель недоступна — извиняемся и завершаем звонок");
        if (isHangingUp || hangupAfterSpeech) return;
        stopSpeaking();
        resetTurnState();
        logDialog("assistant", FAIL_PHRASE);
        hangupAfterSpeech = true;
        speak(FAIL_PHRASE, true);
        armHangupGuard();
    }

    async function connectLlm() {
        var client;
        if (LLM_TRANSPORT === "proxy") {
            client = await createProxyLlmClient(function(ev) { onLlmSocketClosed(client, ev); });
        } else {
            client = await OpenAI.createChatCompletionsAPIClient({
                apiKey: CONFIG.api_key,
                storeContext: false,
                onWebSocketClose: function(ev) { onLlmSocketClosed(client, ev); }
            });
        }
        attachLlmListeners(client);
        llm = client;
    }

    function onLlmSocketClosed(client, ev) {
        if (client !== llm) return;          // закрылся уже заменённый клиент
        Logger.write("[LLM] WS closed: " + JSON.stringify(ev && { code: ev.code, reason: ev.reason }));
        llm = null;
        if (isHangingUp || llmFailedHard) return;
        if (llmBusy) onLlmError("сокет закрылся посреди ответа");
        if (llmFailedHard) return;
        Logger.write("[LLM] переподключение");
        connectLlm().then(function() {
            Logger.write("[LLM] ✅ переподключено");
            maybeContinue();
        }).catch(function(err) {
            Logger.write("❌ [LLM] reconnect failed: " + err);
            failGracefully();
        });
    }

    // Клиент нашего прокси /ws/cascade/llm/{id} с тем же интерфейсом, что у
    // коннектора Voximplant: createChatCompletions(params) + события
    // ContentDelta / Chunk / ChatCompletionsAPIError. Плюс cancel(): прокси
    // обрывает запрос к модели. Сообщения чужого (оборванного) запроса
    // отбрасываются по id.
    function createProxyLlmClient(onClose) {
        var url = String(CONFIG.llm_proxy_url || "");
        var E = OpenAI.ChatCompletionsAPIEvents;
        var handlers = {};
        var seq = 0;
        var curId = null;
        var opened = false;
        var closed = false;
        var ws = VoxEngine.createWebSocket(url);
        var client = {
            addEventListener: function(name, cb) { (handlers[name] = handlers[name] || []).push(cb); },
            createChatCompletions: function(params) {
                if (closed) throw new Error("proxy socket closed");
                curId = ++seq;
                ws.send(JSON.stringify({ event: "request", id: curId, payload: params }));
            },
            cancel: function() {
                if (curId === null) return;
                try { ws.send(JSON.stringify({ event: "cancel", id: curId })); } catch (err) {}
                curId = null;
            },
            close: function() { closed = true; try { ws.close(); } catch (err) {} }
        };
        function fire(name, payload) {
            var list = handlers[name] || [];
            for (var i = 0; i < list.length; i++) list[i]({ data: { payload: payload } });
        }
        return new Promise(function(resolve, reject) {
            var openTimer = setTimeout(function() {
                if (opened) return;
                closed = true;
                try { ws.close(); } catch (err) {}
                reject(new Error("LLM proxy не открылся за " + LLM_PROXY_OPEN_MS + "ms"));
            }, LLM_PROXY_OPEN_MS);
            ws.addEventListener(WebSocketEvents.OPEN, function() {
                opened = true;
                clearTimeout(openTimer);
                Logger.write("[LLM] ✅ proxy socket open: " + url);
                resolve(client);
            });
            ws.addEventListener(WebSocketEvents.MESSAGE, function(e) {
                var msg;
                try { msg = JSON.parse(e.text); } catch (err) { return; }
                if (!msg || msg.id === undefined || msg.id !== curId) return;
                if (msg.event === "chunk") {
                    var p = msg.payload || {};
                    var c = p.choices && p.choices[0];
                    if (c && c.delta && c.delta.content) fire(E.ContentDelta, { delta: c.delta.content });
                    fire(E.Chunk, p);
                } else if (msg.event === "error") {
                    curId = null;
                    fire(E.ChatCompletionsAPIError, { text: msg.message || "proxy error" });
                } else if (msg.event === "done") {
                    curId = null;
                    if (msg.openai_first_ms !== undefined) {
                        Logger.write("[LLM] proxy: model first chunk " + msg.openai_first_ms +
                                     "ms, total " + msg.total_ms + "ms (сервер Voicyfy → " + LLM_MODEL + ")");
                    }
                    // На случай стрима без finish_reason — закрыть ответ всё равно.
                    fire(E.Chunk, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                }
            });
            function onEnd(ev) {
                if (closed) return;
                closed = true;
                if (!opened) {
                    clearTimeout(openTimer);
                    reject(new Error("LLM proxy: " + JSON.stringify(ev && { code: ev.code, reason: ev.reason })));
                    return;
                }
                onClose(ev);
            }
            ws.addEventListener(WebSocketEvents.CLOSE, onEnd);
            ws.addEventListener(WebSocketEvents.ERROR, onEnd);
        });
    }

    function attachLlmListeners(client) {
        // Дельты текста → в VoxTTS пачками
        client.addEventListener(OpenAI.ChatCompletionsAPIEvents.ContentDelta, function(event) {
            if (client !== llm || !llmBusy || llmDiscard || isHangingUp) return;
            var delta = eventPayload(event).delta || "";
            if (!delta) return;
            if (!mFirstDelta) {
                mFirstDelta = Date.now();
                Logger.write("[LLM] first token +" + (mFirstDelta - mReqSent) + "ms");
            }
            respText += delta;
            if (isInterrupted || !callAnswered) return;
            pushDelta(cleanForTTS(delta));
            maybeEarlyFlush();
        });

        // Сырые чанки: вызовы функций, конец ответа, расход токенов
        client.addEventListener(OpenAI.ChatCompletionsAPIEvents.Chunk, function(event) {
            if (client !== llm) return;
            var p = eventPayload(event);
            if (p.usage) {
                stats.inputTokens += p.usage.prompt_tokens || 0;
                stats.outputTokens += p.usage.completion_tokens || 0;
                var det = p.usage.prompt_tokens_details;
                stats.cachedTokens += (det && det.cached_tokens) || 0;
            }
            var choice = p.choices && p.choices[0];
            if (!choice || !llmBusy) return;
            var d = choice.delta || {};
            if (d.content) respChunkText += d.content;
            if (d.tool_calls) {
                for (var i = 0; i < d.tool_calls.length; i++) {
                    var tc = d.tool_calls[i];
                    var key = tc.index !== undefined ? tc.index : i;
                    var acc = respToolCalls[key] || (respToolCalls[key] = { id: "", name: "", arguments: "" });
                    if (tc.id) acc.id = tc.id;
                    if (tc.function && tc.function.name) acc.name += tc.function.name;
                    if (tc.function && tc.function.arguments) acc.arguments += tc.function.arguments;
                }
            }
            if (choice.finish_reason) finishResponse(choice.finish_reason);
        });

        client.addEventListener(OpenAI.ChatCompletionsAPIEvents.ChatCompletionsAPIError, function(event) {
            if (client !== llm) return;
            onLlmError(JSON.stringify(eventPayload(event)));
        });
    }

    // Ответ модели целиком: текст — в историю и дожать в синтез, вызовы
    // функций — выполнить. Одно сообщение assistant на ответ (текст +
    // tool_calls вместе), иначе следующий запрос модель отклонит.
    function finishResponse(reason) {
        if (respFinished) return;
        respFinished = true;

        if (llmDiscard || isHangingUp) { onResponseClosed(reason); return; }

        llmFailures = 0;
        var text = (respText || respChunkText).trim();
        var calls = [];
        for (var k in respToolCalls) {
            if (respToolCalls[k].name) calls.push(respToolCalls[k]);
        }

        var msg = { role: "assistant", content: text || null };
        if (calls.length > 0) {
            msg.tool_calls = calls.map(function(c, i) {
                if (!c.id) c.id = "call_" + Date.now() + "_" + i;
                return { id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } };
            });
        }
        if (text || calls.length > 0) history.push(msg);

        if (text) {
            Logger.write("🤖 AGENT: \"" + text.substring(0, 80) + "\"");
            logDialog("assistant", text);
            if (!isInterrupted) {
                if (!turnStarted && !deltaBuffer) {
                    // Дельты не приходили (ответ отдан одним куском) — озвучиваем целиком.
                    turnFullText = cleanForTTS(text);
                    speak(turnFullText, true);
                } else {
                    endTurn();
                }
            }
        }

        for (var j = 0; j < calls.length; j++) handleFunctionCall(calls[j]);

        onResponseClosed(reason);
    }

    // =========================================================================
    // FUNCTION CALLS
    // =========================================================================
    async function handleFunctionCall(tc) {
        var functionName = tc.name;
        var callId = tc.id;
        var args = {};
        try { args = JSON.parse(tc.arguments || "{}"); } catch (err) {}
        Logger.write("🔧 FUNCTION CALL: " + functionName);

        if (functionName === "hangup_call") {
            Logger.write("📴 HANGUP CALL requested");
            lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
            history.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(lastFunctionResult) });
            llmPending = false;
            needsFollowUp = false;

            if (args.farewell_message && args.farewell_message.trim()) {
                var farewell = cleanForTTS(args.farewell_message.trim());
                logDialog("assistant", farewell);
                resetTurnState();
                turnFullText = farewell;
                hangupAfterSpeech = true;
                speak(farewell, true);
                armHangupGuard();
            } else if (isAgentAudible()) {
                // Модель попрощалась текстом в том же ответе — дадим договорить.
                hangupAfterSpeech = true;
                armHangupGuard();
            } else {
                call.hangup();
            }
            return;
        }

        // Пара tool_calls + tool обязательна в истории: без ответа функции
        // следующий запрос модель отклонит.
        toolsInFlight++;
        needsFollowUp = true;

        var output;
        var function_id = functionNameToIdMap[functionName];
        try {
            if (!function_id) {
                Logger.write("❌ Unknown function: " + functionName);
                output = { error: "Unknown function: " + functionName };
            } else {
                args.function_id = function_id;
                var functionResponse = await Net.httpRequestAsync(FUNCTIONS_URL, {
                    headers: ["Content-Type: application/json"],
                    method: 'POST',
                    postData: JSON.stringify({
                        function_id: function_id,
                        arguments: args,
                        call_data: {
                            call_id: call_id,
                            chat_id: chat_id,
                            assistant_id: ASSISTANT_ID,
                            caller_number: caller_number,
                            called_number: called_number
                        }
                    })
                });
                if (functionResponse.code == 200) {
                    output = JSON.parse(functionResponse.text);
                    lastFunctionResult = output;
                    Logger.write("✅ Function executed: " + functionName);
                } else {
                    Logger.write("❌ Function failed: HTTP " + functionResponse.code);
                    output = { error: "Function execution failed" };
                }
            }
        } catch (err) {
            Logger.write("❌ function handler: " + err);
            output = { error: "Function execution failed" };
        }

        history.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(output) });
        toolsInFlight--;
        maybeContinue();
    }

    // =========================================================================
    // ХОД АБОНЕНТА: VAD + ASR
    // =========================================================================

    function clearTurnTimers() {
        if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
        if (bargeTimer) { clearTimeout(bargeTimer); bargeTimer = null; }
    }

    function currentTurnText() {
        return (turnFinal + " " + turnInterim).replace(/\s+/g, " ").trim();
    }

    function bargeIn(reason) {
        if (bargeTimer) { clearTimeout(bargeTimer); bargeTimer = null; }
        if (hangupAfterSpeech) return;          // прощание не перебиваем
        if (!isAgentAudible() && !llmBusy) return;
        stats.bargeIns++;
        Logger.write("[TURN] ✋ перебивание (" + reason + ") — обрываем озвучку");
        isInterrupted = true;
        stopSpeaking();
        discardResponse();
        turnStarted = false;
        firstFlushDone = false;
        deltaBuffer = "";
    }

    // Абонент продолжил говорить, а ответ на его прошлый кусок ещё не зазвучал:
    // это одна реплика с паузой, а не две. Забираем прошлый кусок обратно в
    // текущую реплику, ответ на него выбрасываем.
    function retractSubmitted() {
        if (!submitted || !llmBusy || turnStarted || hangupAfterSpeech) return false;
        if (history[history.length - 1] !== submitted.item) return false;
        history.pop();
        var idx = dialogLog.indexOf(submitted.dialogEntry);
        if (idx !== -1) dialogLog.splice(idx, 1);
        turnFinal = (submitted.text + " " + turnFinal).trim();
        retractedText = submitted.text;
        submitted = null;
        discardResponse();
        stats.retracts++;
        Logger.write("[TURN] ↩ абонент продолжил — объединяем с \"" + retractedText.substring(0, 60) + "\"");
        return true;
    }

    function onSpeechStart() {
        userSpeaking = true;
        speechSeg++;
        if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }

        if (isAgentAudible()) {
            // Речь поверх агента: эхо и кашель короче BARGE_IN_MIN_MS, поэтому
            // перебиваем только если речь продержалась (или ASR дал текст).
            if (bargeTimer) clearTimeout(bargeTimer);
            bargeTimer = setTimeout(function() {
                bargeTimer = null;
                if (userSpeaking) bargeIn("vad");
            }, BARGE_IN_MIN_MS);
        } else if (llmBusy) {
            retractSubmitted();
        }
    }

    function onSpeechEnd() {
        userSpeaking = false;
        if (bargeTimer) { clearTimeout(bargeTimer); bargeTimer = null; }
        mVadStop = Date.now();
        submitWaitStarted = Date.now();
        scheduleSubmit(SUBMIT_SETTLE_MS);
    }

    function scheduleSubmit(ms) {
        if (submitTimer) clearTimeout(submitTimer);
        submitTimer = setTimeout(trySubmit, ms);
    }

    function trySubmit() {
        submitTimer = null;
        if (userSpeaking || isHangingUp) return;
        if (hangupAfterSpeech) return;          // прощаемся — новых ответов не будет

        var text = currentTurnText();
        if (!text) {
            // Тишина пришла раньше текста — ASR ещё не отдал interim. Ждём
            // немного; если текста так и нет — это был шум, а не реплика.
            if (Date.now() - submitWaitStarted < EMPTY_TEXT_WAIT_MS) {
                scheduleSubmit(100);
            } else {
                stats.dropped++;
                Logger.write("[TURN] сегмент без текста — шум, пропускаем");
            }
            return;
        }

        turnFinal = "";
        turnInterim = "";
        retractedText = "";
        stats.turns++;

        Logger.write("👤 USER: \"" + text + "\"");
        var item = { role: "user", content: text };
        history.push(item);
        submitted = { seg: speechSeg, text: text, item: item, dialogEntry: logDialog("user", text) };

        // Абонент заговорил, пока агент звучал, но перебивание не сработало
        // (короткая реплика) — гасим агента сейчас, отвечать будем на новое.
        if (isAgentAudible() && !hangupAfterSpeech) bargeIn("turn");

        requestResponse();
    }

    // Поздний текст от ASR по уже отправленной реплике (Yandex досылает
    // финал через несколько секунд). Историю правим на месте — модель увидит
    // полный текст в следующем запросе, отдельный запрос не нужен.
    // Короче по буквам, но не по словам финал — это исправленное слово
    // («баня уфимская» → «баня финская»), его берём; interim или меньше
    // слов — недослушанный кусок, не лучше.
    function correctSubmitted(text, isFinal) {
        if (!submitted) return false;
        if (userSpeaking || speechSeg !== submitted.seg) return false;
        if (currentTurnText()) return false;
        if (normText(text) === normText(submitted.text)) return true;
        if (text.length < submitted.text.length &&
            (!isFinal || wordCount(text) < wordCount(submitted.text))) return true;
        Logger.write("[TURN] ✏️ уточнение: \"" + submitted.text + "\" → \"" + text + "\"");
        submitted.text = text;
        submitted.item.content = text;
        if (submitted.dialogEntry) submitted.dialogEntry.text = text;
        stats.corrections++;
        return true;
    }

    function stripSubmittedPrefix(text) {
        if (!submitted) return text;
        var n = normText(text), s = normText(submitted.text);
        if (s && n.indexOf(s + " ") === 0) {
            var words = submitted.text.trim().split(/\s+/).length;
            return text.trim().split(/\s+/).slice(words).join(" ");
        }
        return text;
    }

    // Retract вернул в реплику кусок, собранный из interim, а финал ASR по
    // этому же куску приходит позже отдельным событием — без этой проверки
    // он дописывался второй раз. Совпал или короче — выбрасываем, начинается
    // с него — берём хвост, та же длина в словах — это исправленный вариант,
    // подменяем.
    function stripRetracted(text, isFinal) {
        if (!retractedText) return text;
        var n = normText(text), r = normText(retractedText);
        if (!n || !r) return text;
        var out = text;
        if (n === r || r.indexOf(n) === 0) {
            out = "";
        } else if (n.indexOf(r + " ") === 0) {
            out = text.trim().split(/\s+/).slice(retractedText.trim().split(/\s+/).length).join(" ");
        } else if (isFinal && n.split(" ").length === r.split(" ").length &&
                   n.split(" ")[0] === r.split(" ")[0] &&
                   turnFinal.indexOf(retractedText) === 0) {
            turnFinal = (text.trim() + turnFinal.substring(retractedText.length)).trim();
            out = "";
        } else {
            return text;
        }
        if (isFinal) retractedText = "";
        return out;
    }

    function onAsrInterim(text) {
        if (correctSubmitted(text, false)) return;
        turnInterim = stripSubmittedPrefix(stripRetracted(text, false));
        // Настоящее перебивание: агент звучит, а от абонента уже пошёл текст.
        if (userSpeaking && isAgentAudible()) bargeIn("interim");
    }

    function onAsrResult(text) {
        if (correctSubmitted(text, true)) { turnInterim = ""; return; }
        text = stripSubmittedPrefix(stripRetracted(text, true));
        if (text) turnFinal = (turnFinal + " " + text).trim();
        turnInterim = "";
        // Финал пришёл, пока ждали текст после тишины — отправляем сразу.
        if (!userSpeaking && submitTimer) scheduleSubmit(0);
    }

    function asrOptions() {
        var lang = (CONFIG.asr_lang || CONFIG.language || "ru").toLowerCase();
        if (ASR_PROVIDER === "deepgram") {
            return {
                profile: lang.indexOf("en") === 0 ? ASRProfileList.Deepgram.en_US : ASRProfileList.Deepgram.ru,
                model: ASRModelList.Deepgram.nova2_general,
                interimResults: true
            };
        }
        var profiles = {
            ru: ASRProfileList.Yandex.ru_RU,
            en: ASRProfileList.Yandex.en_US,
            de: ASRProfileList.Yandex.de_DE,
            es: ASRProfileList.Yandex.es_ES,
            fr: ASRProfileList.Yandex.fr_FR
        };
        return {
            profile: profiles[lang.substring(0, 2)] || ASRProfileList.Yandex.ru_RU,
            model: ASRModelList.Yandex.general,
            interimResults: true
        };
    }

    // =========================================================================
    // ПОДКЛЮЧЕНИЕ: LLM + VAD + VoxTTS (до ответа на звонок)
    // =========================================================================
    Logger.write("🔌 Connecting to LLM (" + LLM_TRANSPORT + ") + Silero VAD...");

    try {
        await connectLlm();
        vad = await Silero.createVAD({
            threshold: VAD_THRESHOLD,
            minSilenceDurationMs: VAD_SILENCE_MS,
            speechPadMs: VAD_SPEECH_PAD_MS
        });
        createTts();
    } catch (err) {
        Logger.write("❌ Failed to connect LLM/VAD/TTS: " + err);
        call.answer();
        call.addEventListener(CallEvents.Disconnected, callEndHandler);
        call.addEventListener(CallEvents.Failed, callEndHandler);
        return;
    }

    Logger.write("✅ LLM + VAD + VoxTTS ready");

    // Именно «поле присутствует», а не «истинно»: speechStartAt === 0
    // (начало сессии) — валидное значение.
    vad.addEventListener(Silero.VADEvents.Result, function(event) {
        if (!callAnswered || isHangingUp) return;
        var hasStart = event && event.speechStartAt !== undefined && event.speechStartAt !== null;
        var hasEnd = event && event.speechEndAt !== undefined && event.speechEndAt !== null;
        if (hasStart) onSpeechStart();
        if (hasEnd) onSpeechEnd();
    });
    vad.addEventListener(Silero.VADEvents.Error, function(event) {
        Logger.write("❌ [VAD] " + JSON.stringify(event && event.reason));
    });

    // Приветствие.
    //  - Есть first_phrase: озвучиваем напрямую, без раунда к модели. Модель
    //    узнаёт об этом из инструкций, её первый ответ — уже на реплику абонента.
    //  - Нет first_phrase: просим поздороваться саму модель разовым запросом;
    //    в историю попадает только сам ответ.
    function startGreeting() {
        if (greetingStarted || !callAnswered) return;
        greetingStarted = true;

        if (CONFIG.first_phrase) {
            var phrase = cleanForTTS(CONFIG.first_phrase.trim());
            Logger.write("🤖 AGENT (greeting): \"" + phrase + "\"");
            history.push({ role: "assistant", content: phrase });
            logDialog("assistant", phrase);
            turnFullText = phrase;
            speak(phrase, true);
            warmupLlm();
            return;
        }

        greetingInput = [{ role: "user", content:
            "Звонок только что начался. Поприветствуй звонящего одной короткой фразой и спроси, чем можешь помочь." }];
        requestResponse();
        Logger.write("[LLM] Greeting requested from model");
    }

    // =========================================================================
    // ОТВЕТ НА ЗВОНОК + ЗАПИСЬ
    // =========================================================================
    callAnswered = true;
    call.answer();
    call.addEventListener(CallEvents.Disconnected, callEndHandler);
    call.addEventListener(CallEvents.Failed, callEndHandler);
    Logger.write("[Call] Answered");

    attachTtsToCall();

    try {
        call.record({ stereo: false, lossless: false, hd_audio: true });
        Logger.write("🎙️ Recording started");
    } catch (recordError) {
        Logger.write("⚠️ Recording failed to start: " + recordError);
    }

    call.addEventListener(CallEvents.RecordStarted, function(event) {
        if (event.url) { record_url = event.url; Logger.write("🎙️ RecordStarted: " + record_url); }
    });
    call.addEventListener(CallEvents.RecordStopped, function(event) {
        if (event.url) record_url = event.url;
        // Запись тарифицируется отдельно и в cost звонка не входит.
        if (event.cost !== undefined) record_cost = Number(event.cost) || 0;
    });

    // Аудио звонящего → ASR (текст) и VAD (границы речи)
    asr = VoxEngine.createASR(asrOptions());
    asr.addEventListener(ASREvents.InterimResult, function(event) {
        var text = event && event.text && String(event.text).trim();
        if (text) onAsrInterim(text);
    });
    asr.addEventListener(ASREvents.Result, function(event) {
        var text = event && event.text && String(event.text).trim();
        if (text) onAsrResult(text);
    });
    // ASR тарифицируется отдельной строкой и в cost звонка не входит.
    asr.addEventListener(ASREvents.Stopped, function(event) {
        if (event && event.cost !== undefined) asr_cost = Number(event.cost) || 0;
    });
    asr.addEventListener(ASREvents.ASRError, function(event) {
        Logger.write("❌ [ASR] " + JSON.stringify(event && (event.error || event.reason || event)));
    });

    call.sendMediaTo(asr);
    call.sendMediaTo(vad);
    Logger.write("[Call] call → ASR (" + ASR_PROVIDER + ") + VAD connected");

    startGreeting();

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🎉 READY FOR CONVERSATION (Cascade v4.0)");
    Logger.write("   🔑 Session: " + call_session_history_id);
    Logger.write("   👂 ASR: " + ASR_PROVIDER + " → 🧠 " + llmModel() + " → 🔊 VoxTTS " + voxttsVoice(CONFIG.tts_voice));
    Logger.write("   🎧 VAD silence: " + VAD_SILENCE_MS + "ms");
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
