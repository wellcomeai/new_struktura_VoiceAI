require(Modules.ASR);
require(Modules.Silero);
require(Modules.OpenAI);

/*
 * Voximplant INBOUND Fish Script v2.0 — full cascade
 * ====================================================================
 * Архитектура (ASR → LLM → TTS, каждое звено своё):
 *
 *   звонок ─┬─► ASR Voximplant (Yandex v2 / Deepgram, interim) ── текст
 *           └─► Silero VAD (тишина VAD_SILENCE_MS) ────────────── конец реплики
 *                        │
 *                        ▼  реплика целиком
 *        OpenAI Chat Completions (gpt-5.6-luna, стрим текста)
 *                        │  дельты текста
 *                        ▼
 *     /ws/fish/tts/{id} (прокси Voicyfy) ──► Fish Audio ──► PCM в звонок
 *
 *   - Конец реплики — простая тишина: Silero сообщает speechEndAt после
 *     VAD_SILENCE_MS тишины, ждём SUBMIT_SETTLE_MS, чтобы ASR дослал хвост
 *     текста, и отдаём реплику модели. Никакого Pipecat / Smart Turn.
 *   - ASR и VAD встроены в Voximplant: свои ключи Yandex/Deepgram не нужны,
 *     распознавание тарифицируется Voximplant отдельной строкой (ASR.Stopped).
 *   - LLM: клиент Chat Completions VoxEngine, ключ из конфига (CONFIG.api_key —
 *     свой ключ пользователя или серверный, выбирает бэкенд). История диалога
 *     хранится в сценарии и уходит в каждый запрос целиком (system-промпт
 *     статичен → кэш промпта), поэтому поздний финальный текст от ASR просто
 *     исправляет реплику в истории — лишнего запроса к модели не нужно.
 *     Responses-клиент не подошёл: на массив сообщений он отвечал
 *     «Missing required parameter: 'input'».
 *   - У клиента нет отмены ответа. Перебивание = гасим звук в
 *     звонке и у прокси + игнорируем остаток ответа; следующий запрос
 *     уходит, когда текущий ответ закрылся (один ответ за раз).
 *   - Fish-часть (сокет к прокси, flush/clear, speech_done, watchdog)
 *     перенесена из v1.0 без изменений.
 *
 * Бэкенд не менялся: конфиг тот же (/api/telephony/config). Поле
 * CONFIG.model (gpt-realtime-2.1) сценарий больше не использует — модель
 * задаётся константой LLM_MODEL ниже. outbound_fish.js остаётся на Realtime.
 */

// ============================================================================
// КОНСТАНТЫ (крутить здесь, логику не трогать)
// ============================================================================
var ASR_PROVIDER     = "yandex";       // "yandex" | "deepgram"
var LLM_MODEL        = "gpt-5.6-luna";
var LLM_REASONING    = "none";         // reasoning_effort: none — без рассуждений (у luna: none/low/medium/high/xhigh, minimal нет); null — не передавать
var FAIL_PHRASE      = "Извините, у нас технические неполадки. Пожалуйста, перезвоните чуть позже.";
var VAD_SILENCE_MS   = 500;            // тишина, после которой реплика закончена
var VAD_THRESHOLD    = 0.5;
var VAD_SPEECH_PAD_MS = 30;
var SUBMIT_SETTLE_MS = 150;            // ждём хвост текста от ASR после тишины
var EMPTY_TEXT_WAIT_MS = 900;          // сколько ждать текст, если ASR ещё молчит
var BARGE_IN_MIN_MS  = 300;            // речь поверх агента короче — не перебивание
var FIRST_FLUSH_MIN  = 25;             // ранний flush первого предложения реплики
var TEXT_BATCH_MIN   = 40;             // копим дельты до этой длины перед отправкой
var TTS_WATCHDOG_MS  = 4000;           // нет звука после отправки текста → тревога
var HANGUP_GUARD_MS  = 15000;          // потолок ожидания конца прощания
var HANGUP_TAIL_MS   = 250;            // запас после remaining_ms перед hangup
var TTS_REOPEN_MAX   = 2;              // попыток переоткрыть сокет к прокси
var LLM_FAIL_MAX     = 2;              // неудачных ходов подряд до извинения и hangup
var LLM_RETRY_DELAY_MS = 300;          // пауза перед повтором хода после ошибки
var LLM_STUCK_MS     = 20000;          // ответ не закрылся за это время — сброс

// ============================================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ БИЛЛИНГА
// ============================================================================
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;
var asr_cost = 0;

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (INBOUND Fish v2.0 cascade)");
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
    var userSpeaking = false;
    var speechSeg = 0;           // номер сегмента речи по VAD
    var turnFinal = "";          // финальные куски ASR текущей реплики
    var turnInterim = "";        // текущий interim ASR
    var submitTimer = null;
    var submitWaitStarted = 0;
    var bargeTimer = null;
    var submitted = null;        // последняя отправленная реплика {seg, text, item, dialogEntry}

    // ── LLM ─────────────────────────────────────────────────────────────────
    var llm = null;
    var llmFailures = 0;         // неудачных ходов подряд
    var llmFailedHard = false;   // модель недоступна — только прощаемся
    var llmBusy = false;         // ответ модели в процессе
    var llmDiscard = false;      // остаток текущего ответа игнорируем
    var llmPending = false;      // после закрытия ответа нужен новый запрос
    var llmStuckTimer = null;
    var llmReasoning = LLM_REASONING;
    var toolsInFlight = 0;
    var history = [];            // сообщения диалога (без system)
    var needsFollowUp = false;   // после функций нужен ответ модели
    var lastTurnMessages = null; // сообщения последнего запроса (для повтора)
    var respText = "";           // текст текущего ответа (ContentDelta)
    var respChunkText = "";      // он же из сырых чанков — запасной источник
    var respToolCalls = {};      // вызовы функций текущего ответа по index
    var respFinished = false;
    var greetingInput = null;    // разовые сообщения вместо истории (приветствие, повтор)

    // ── Сокет к прокси синтеза ──────────────────────────────────────────────
    var ttsSocket = null;
    var ttsOpen = false;
    var ttsAttached = false;     // sendMediaTo(call) уже вызван
    var ttsQueue = [];           // текст, накопленный до открытия сокета
    var ttsFlushQueued = false;  // в очереди есть незакрытая реплика
    var ttsReopens = 0;
    var ttsMediaAccepted = false;  // пришёл ли MEDIA_STARTED (StartEvent принят)
    var agentTextPending = false;  // текст ушёл в синтез, speech_done ещё не было
    var agentAudioEndAt = 0;       // когда доиграет буфер Voximplant

    // ── Состояние текущей реплики ассистента ────────────────────────────────
    var turnFullText = "";
    var turnStarted = false;     // в TTS по этой реплике что-то уже уходило
    var firstFlushDone = false;  // ранний flush первого предложения сделан
    var deltaBuffer    = "";     // дельты, ещё не ушедшие в синтез
    var audioConfirmed = false;  // прокси подтвердил начало звука

    // ── Watchdog / завершение по прощанию ───────────────────────────────────
    var watchdogTimer = null;
    var watchdogDisabled = false;
    var hangupAfterSpeech = false;
    var hangupGuardTimer = null;

    // ── Метрики ─────────────────────────────────────────────────────────────
    var mVadStop = 0, mReqSent = 0, mFirstDelta = 0, mFirstText = 0;
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
    Logger.write("📞 INBOUND CALL (Fish v2.0 cascade)");
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
                payload.call_cost     = Math.round((call_cost + asr_cost) * 1e6) / 1e6;
                payload.call_cost_parts = { telephony: call_cost, asr: asr_cost };
                payload.call_duration = call_duration;

                Logger.write("📊 Billing: record=" + (record_url ? "YES" : "NO") +
                    ", cost=" + payload.call_cost + " (asr=" + asr_cost + ")" +
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

        disarmWatchdog();
        if (hangupGuardTimer) { clearTimeout(hangupGuardTimer); hangupGuardTimer = null; }
        clearTurnTimers();
        if (llmStuckTimer) { clearTimeout(llmStuckTimer); llmStuckTimer = null; }

        if (llm) { try { llm.close(); } catch (err) {} }
        if (vad) { try { vad.close(); } catch (err) {} }
        if (asr) { try { asr.stop(); } catch (err) {} }
        closeTtsSocket();

        Logger.write("===TURN_STATS=== " + JSON.stringify(stats));

        // Запись останавливать вручную нечем: метода stopRecord в API нет,
        // она завершается вместе со звонком. Ждём RecordStopped (и ASR.Stopped
        // со стоимостью распознавания) до отправки финального лога.
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

    if (CONFIG.assistant_type !== "fish") {
        Logger.write("❌ Wrong assistant type: " + CONFIG.assistant_type + " (expected: fish)");
        VoxEngine.terminate();
        return;
    }

    if (!CONFIG.fish_tts_url) {
        Logger.write("❌ Config has no fish_tts_url — озвучивать нечем");
        VoxEngine.terminate();
        return;
    }

    ASSISTANT_ID = CONFIG.assistant_id;

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("✅ CONFIG LOADED:");
    Logger.write("   📋 Assistant: " + CONFIG.assistant_name);
    Logger.write("   🆔 ID: " + ASSISTANT_ID);
    Logger.write("   🌐 Language: " + CONFIG.language);
    Logger.write("   👂 ASR: " + ASR_PROVIDER + " | VAD silence " + VAD_SILENCE_MS + "ms");
    Logger.write("   🧠 LLM: " + LLM_MODEL + " (reasoning " + (llmReasoning || "default") + ")");
    Logger.write("   🐟 Fish voice: " + CONFIG.fish_voice_id + " / " + CONFIG.fish_model +
                 " (" + CONFIG.fish_latency + ", " + CONFIG.sample_rate + " Hz)");
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
                voximplantTools.push({
                    type: "function",
                    function: {
                        name: tool.function.name,
                        description: tool.function.description,
                        parameters: tool.function.parameters
                    }
                });
            }
        }
    }

    // Инструкции собираются один раз и не меняются до конца звонка — так
    // префикс запроса одинаковый и OpenAI кэширует его между ходами.
    INSTRUCTIONS = CONFIG.system_prompt || "";
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
    // TTS: СОКЕТ К ПРОКСИ
    // =========================================================================
    // Разделения на чанки, как у Cartesia, здесь нет: Fish буферизует текст
    // сам (chunk_length / latency) и начинает синтез, не дожидаясь конца
    // реплики. Наша задача — вовремя дать flush: один раз на первом
    // законченном предложении (чтобы звук пошёл раньше) и один раз в конце
    // реплики.

    function openTtsSocket() {
        Logger.write("[Fish] Opening TTS socket: " + CONFIG.fish_tts_url);

        ttsSocket = VoxEngine.createWebSocket(CONFIG.fish_tts_url);

        ttsSocket.addEventListener(WebSocketEvents.OPEN, function() {
            ttsOpen = true;
            Logger.write("[Fish] ✅ TTS socket open");

            // Маршрутизируем аудио из сокета в звонок. Если звонок ещё не
            // отвечен, привяжем позже — в attachTtsToCall().
            attachTtsToCall();

            // Досылаем текст, накопленный пока сокет поднимался.
            var queued = ttsQueue;
            ttsQueue = [];
            for (var i = 0; i < queued.length; i++) {
                sendToTts({ event: "text", text: queued[i] });
            }
            if (ttsFlushQueued) {
                ttsFlushQueued = false;
                sendToTts({ event: "flush" });
            }
        });

        // Voximplant подтверждает, что StartEvent принят и поток привязан.
        // Если этого события нет — аудио в трубку не попадёт вообще, каким бы
        // исправным ни выглядел остальной лог.
        ttsSocket.addEventListener(WebSocketEvents.MEDIA_STARTED, function(ev) {
            ttsMediaAccepted = true;
            Logger.write("[Fish] ✅ MEDIA_STARTED — поток принят, кодек " +
                (ev && ev.encoding));
        });

        ttsSocket.addEventListener(WebSocketEvents.MEDIA_ENDED, function() {
            Logger.write("[Fish] MEDIA_ENDED — поток закрыт");
        });

        // Прокси присылает служебные сообщения о границах реплики.
        ttsSocket.addEventListener(WebSocketEvents.MESSAGE, function(ev) {
            var msg;
            try {
                msg = JSON.parse(ev && ev.text);
            } catch (err) {
                return;
            }
            if (!msg || !msg.event) return;

            if (msg.event === "speech_started") {
                confirmAudio();
            } else if (msg.event === "speech_done") {
                var remaining = typeof msg.remaining_ms === "number" ? msg.remaining_ms : 0;
                Logger.write("[Fish] ⏹ speech done, ещё " + remaining + "ms в буфере");
                agentTextPending = false;
                agentAudioEndAt = Date.now() + remaining;
                if (hangupAfterSpeech) scheduleHangup(remaining);
            }
        });

        ttsSocket.addEventListener(WebSocketEvents.ERROR, function(ev) {
            Logger.write("[Fish] ❌ TTS socket error: " + JSON.stringify(ev));
        });

        ttsSocket.addEventListener(WebSocketEvents.CLOSE, function(ev) {
            ttsOpen = false;
            ttsAttached = false;
            Logger.write("[Fish] TTS socket closed: " + (ev && ev.reason));

            if (isHangingUp) return;
            if (ttsReopens >= TTS_REOPEN_MAX) {
                Logger.write("[Fish] ❌ Переоткрытия исчерпаны — озвучки не будет");
                return;
            }
            ttsReopens++;
            Logger.write("[Fish] Переоткрываем сокет (попытка " + ttsReopens + ")");
            openTtsSocket();
        });
    }

    // sendMediaTo можно звать только когда есть и сокет, и отвеченный звонок.
    // Порядок этих двух событий не гарантирован, поэтому вызываем из обоих.
    function attachTtsToCall() {
        if (ttsAttached || !ttsOpen || !callAnswered || !ttsSocket) return;
        try {
            ttsSocket.sendMediaTo(call);
            ttsAttached = true;
            Logger.write("[Fish] 🔊 TTS media → call");
        } catch (err) {
            Logger.write("[Fish] ❌ sendMediaTo failed: " + err);
        }
    }

    function sendToTts(msg) {
        if (!ttsSocket || !ttsOpen) return false;
        try {
            ttsSocket.send(JSON.stringify(msg));
            return true;
        } catch (err) {
            Logger.write("[Fish] ❌ send failed: " + err);
            return false;
        }
    }

    function closeTtsSocket() {
        if (!ttsSocket) return;
        try { sendToTts({ event: "stop" }); } catch (err) {}
        try { ttsSocket.close(); } catch (err) {}
        ttsSocket = null;
        ttsOpen = false;
        ttsAttached = false;
    }

    // Агент звучит: текст ушёл в синтез и speech_done ещё не было, либо
    // буфер Voximplant ещё доигрывает. Нужно, чтобы отличить перебивание от
    // обычной реплики абонента.
    function isAgentAudible() {
        return agentTextPending || Date.now() < agentAudioEndAt;
    }

    // Единственная точка отправки текста в синтез.
    function speak(text, final) {
        if (!text || !text.trim() || isHangingUp) return;

        var clean = cleanForTTS(text);

        if (!ttsOpen) {
            // Сокет ещё поднимается — копим, дошлём в OPEN.
            ttsQueue.push(clean);
            if (final) ttsFlushQueued = true;
        } else {
            sendToTts({ event: "text", text: clean });
            if (final) sendToTts({ event: "flush" });
        }
        agentTextPending = true;

        Logger.write("[Fish] → \"" + clean.substring(0, 60) + "\"" + (final ? " (final)" : ""));

        if (!turnStarted) {
            turnStarted = true;
            if (mVadStop && !mFirstText) mFirstText = Date.now();
            armWatchdog(TTS_WATCHDOG_MS);
        }
    }

    // Ранний flush: как только в реплике набралось законченное предложение,
    // просим Fish начать синтез, не дожидаясь конца ответа модели.
    // Дельты модели копим и отдаём пачками: Fish буферизует текст сам, кадр
    // на каждый токен ничего не ускоряет.
    function pushDelta(delta) {
        deltaBuffer  += delta;
        turnFullText += delta;

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
            if (ttsOpen) sendToTts({ event: "flush" });
            else ttsFlushQueued = true;
        }
    }

    function maybeEarlyFlush() {
        if (firstFlushDone || isInterrupted) return;
        if (turnFullText.length < FIRST_FLUSH_MIN) return;
        if (!hasSentenceEnd(turnFullText)) return;
        firstFlushDone = true;
        if (ttsOpen) sendToTts({ event: "flush" });
        else ttsFlushQueued = true;
        Logger.write("[Fish] ⚡ early flush первого предложения");
    }

    // Перебивание: гасим очередь Voximplant (мгновенно) и рвём генерацию у
    // прокси. Одного clearMediaBuffer мало — Fish продолжит присылать хвост
    // прерванной фразы, и он доиграет поверх следующей реплики.
    function stopSpeaking() {
        if (ttsSocket && ttsOpen) {
            try { ttsSocket.clearMediaBuffer(); } catch (err) {
                Logger.write("[Fish] clearMediaBuffer failed: " + err);
            }
            sendToTts({ event: "clear" });
        }
        ttsQueue = [];
        ttsFlushQueued = false;
        agentTextPending = false;
        agentAudioEndAt = 0;
    }

    function resetTurnState() {
        turnFullText = "";
        turnStarted = false;
        firstFlushDone = false;
        deltaBuffer    = "";
        audioConfirmed = false;
        mVadStop = 0; mReqSent = 0; mFirstDelta = 0; mFirstText = 0;
    }

    // =========================================================================
    // TTS: WATCHDOG И МЕТРИКИ
    // =========================================================================

    function armWatchdog(ms) {
        disarmWatchdog();
        if (watchdogDisabled) return;
        watchdogTimer = setTimeout(onTtsSilent, ms);
    }

    function disarmWatchdog() {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    }

    // Метрика меряется до РЕАЛЬНОГО звука (прокси подтверждает, что media
    // ушло в звонок), а не до отправки текста в Fish.
    function confirmAudio() {
        disarmWatchdog();
        if (audioConfirmed) return;
        audioConfirmed = true;

        if (mVadStop) {
            var now = Date.now();
            var toReq = mReqSent ? (mReqSent - mVadStop) : -1;
            var toFirstToken = mFirstDelta ? (mFirstDelta - mVadStop) : -1;
            var toTts = mFirstText ? (mFirstText - mVadStop) : -1;
            Logger.write("⏱ TURN: vad→llm=" + toReq + "ms" +
                " vad→token=" + toFirstToken + "ms" +
                " vad→tts=" + toTts + "ms" +
                " vad→audio=" + (now - mVadStop) + "ms");
        }
    }

    // Звука нет. Если сокет отвалился, переоткрытие уже идёт из обработчика
    // CLOSE. Здесь остаётся только зафиксировать проблему: вставлять
    // заглушку вслепую хуже, чем промолчать.
    function onTtsSilent() {
        watchdogTimer = null;
        if (isInterrupted || isHangingUp || audioConfirmed) return;

        Logger.write("⚠️ [Fish] нет подтверждения звука за " + TTS_WATCHDOG_MS + "ms" +
            " (socket " + (ttsOpen ? "open" : "closed") + ")");

        if (!ttsOpen) {
            Logger.write("⚠️ [Fish] сокет закрыт — ждём переоткрытия");
            return;
        }

        if (!ttsMediaAccepted) {
            Logger.write("❌ [Fish] MEDIA_STARTED так и не пришёл — Voximplant " +
                "не принял StartEvent прокси. Аудио в трубку не пойдёт: " +
                "проверьте mediaFormat.encoding (для 8 кГц это PCM8) и что " +
                "в StartEvent нет tag.");
            return;
        }

        // Сокет жив, а подтверждения нет — вероятнее всего, служебное
        // сообщение просто не дошло. Снимаем watchdog до конца звонка.
        watchdogDisabled = true;
        Logger.write("⚠️ [Fish] WATCHDOG DISABLED до конца звонка");
    }

    function scheduleHangup(remainingMs) {
        if (!hangupAfterSpeech || isHangingUp) return;
        var delay = Math.max(0, remainingMs) + HANGUP_TAIL_MS;
        Logger.write("📴 Прощание отзвучит через " + delay + "ms — вешаем трубку");
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

    // =========================================================================
    // LLM: CHAT COMPLETIONS (gpt-5.6-luna)
    // =========================================================================
    // Клиент Chat Completions VoxEngine: история сообщений ведётся здесь и
    // уходит целиком в каждый запрос (storeContext: false), ответ — стримом.
    // Responses-клиент на проде отвечал «Missing required parameter: 'input'»
    // на массив сообщений (в примерах Voximplant input у него только строка),
    // а для Chat Completions ровно этот режим описан в документации.

    function eventPayload(event) {
        return (event && event.data && event.data.payload) || (event && event.data) || {};
    }

    // Один ответ за раз: у клиента нет отмены, поэтому новый запрос уходит
    // только после того, как текущий ответ закрылся (finish_reason / ошибка).
    // Если в этот момент ответ ещё идёт — помечаем его «выбросить» и ставим
    // новый запрос в очередь.
    function requestResponse() {
        if (isHangingUp) return;
        if (llmBusy) {
            llmDiscard = true;
            llmPending = true;
            Logger.write("[LLM] ответ ещё идёт — новый запрос после его закрытия");
            return;
        }
        sendRequest();
    }

    function sendRequest() {
        if (isHangingUp || !llm || llmFailedHard) return;

        var turnMessages = greetingInput || history;
        greetingInput = null;
        var messages = [{ role: "system", content: INSTRUCTIONS }].concat(turnMessages);

        var params = {
            model: LLM_MODEL,
            messages: messages,
            stream: true,
            stream_options: { include_usage: true }
        };
        if (voximplantTools.length > 0) {
            params.tools = voximplantTools;
            params.tool_choice = "auto";
        }
        if (llmReasoning) params.reasoning_effort = llmReasoning;

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
    // закрылся вслед за ошибкой). reasoning_effort, который модель не приняла,
    // убираем без счёта попыток. После LLM_FAIL_MAX неудач подряд извиняемся
    // и кладём трубку — молчать в трубку хуже.
    function onLlmError(text) {
        Logger.write("❌ [LLM] " + String(text).substring(0, 500));
        if (!llmBusy) return;
        llmBusy = false;
        if (llmStuckTimer) { clearTimeout(llmStuckTimer); llmStuckTimer = null; }

        if (llmReasoning && /reasoning/i.test(text)) {
            Logger.write("[LLM] модель не приняла reasoning_effort — повтор без него");
            llmReasoning = null;
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
        hangupGuardTimer = setTimeout(function() { finishHangup("guard timeout"); }, HANGUP_GUARD_MS);
    }

    async function connectLlm() {
        var client = await OpenAI.createChatCompletionsAPIClient({
            apiKey: CONFIG.api_key,
            storeContext: false,
            onWebSocketClose: function(ev) {
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
        });
        attachLlmListeners(client);
        llm = client;
    }

    function attachLlmListeners(client) {
        // Дельты текста → в Fish пачками
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

    // Ответ модели целиком: текст — в историю и дожать в Fish, вызовы функций —
    // выполнить. Одно сообщение assistant на ответ (текст + tool_calls вместе),
    // иначе следующий запрос OpenAI отклонит.
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
                // Потолок на случай, если speech_done не придёт
                hangupGuardTimer = setTimeout(function() {
                    finishHangup("guard timeout");
                }, HANGUP_GUARD_MS);
            } else if (isAgentAudible()) {
                // Модель попрощалась текстом в том же ответе — дадим договорить.
                hangupAfterSpeech = true;
                hangupGuardTimer = setTimeout(function() {
                    finishHangup("guard timeout");
                }, HANGUP_GUARD_MS);
            } else {
                call.hangup();
            }
            return;
        }

        // Пара tool_calls + tool обязательна в истории: без ответа функции
        // следующий запрос OpenAI отклонит.
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
                            caller_number: caller_number
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
        disarmWatchdog();
        stopSpeaking();
        if (llmBusy) llmDiscard = true;
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
        llmDiscard = true;
        stats.retracts++;
        Logger.write("[TURN] ↩ абонент продолжил — объединяем с \"" + submitted.text.substring(0, 60) + "\"");
        submitted = null;
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
    function correctSubmitted(text) {
        if (!submitted) return false;
        if (userSpeaking || speechSeg !== submitted.seg) return false;
        if (currentTurnText()) return false;
        if (normText(text) === normText(submitted.text)) return true;
        if (text.length < submitted.text.length) return true;   // короче — не лучше
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

    function onAsrInterim(text) {
        if (correctSubmitted(text)) return;
        turnInterim = stripSubmittedPrefix(text);
        // Настоящее перебивание: агент звучит, а от абонента уже пошёл текст.
        if (userSpeaking && isAgentAudible()) bargeIn("interim");
    }

    function onAsrResult(text) {
        if (correctSubmitted(text)) { turnInterim = ""; return; }
        text = stripSubmittedPrefix(text);
        if (text) turnFinal = (turnFinal + " " + text).trim();
        turnInterim = "";
        // Финал пришёл, пока ждали текст после тишины — отправляем сразу.
        if (!userSpeaking && submitTimer) scheduleSubmit(0);
    }

    function asrOptions() {
        var lang = (CONFIG.language || "ru").toLowerCase();
        var en = lang.indexOf("en") === 0;
        if (ASR_PROVIDER === "deepgram") {
            return {
                profile: en ? ASRProfileList.Deepgram.en_US : ASRProfileList.Deepgram.ru,
                model: ASRModelList.Deepgram.nova2_general,
                interimResults: true
            };
        }
        return {
            profile: en ? ASRProfileList.Yandex.en_US : ASRProfileList.Yandex.ru_RU,
            model: ASRModelList.Yandex.general,
            interimResults: true
        };
    }

    // Сокет поднимаем заранее — пока идут гудки.
    openTtsSocket();

    // =========================================================================
    // ПОДКЛЮЧЕНИЕ: LLM + VAD (до ответа на звонок)
    // =========================================================================
    Logger.write("🔌 Connecting to OpenAI Chat Completions + Silero VAD...");

    try {
        await connectLlm();
        vad = await Silero.createVAD({
            threshold: VAD_THRESHOLD,
            minSilenceDurationMs: VAD_SILENCE_MS,
            speechPadMs: VAD_SPEECH_PAD_MS
        });
    } catch (err) {
        Logger.write("❌ Failed to connect LLM/VAD: " + err);
        call.answer();
        call.addEventListener(CallEvents.Disconnected, callEndHandler);
        call.addEventListener(CallEvents.Failed, callEndHandler);
        return;
    }

    Logger.write("✅ LLM + VAD ready");

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

    // Сокет мог открыться раньше ответа на звонок — привязываем медиа теперь.
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
    Logger.write("🎉 READY FOR CONVERSATION (Fish v2.0 cascade)");
    Logger.write("   🔑 Session: " + call_session_history_id);
    Logger.write("   👂 ASR: " + ASR_PROVIDER + " → 🧠 " + LLM_MODEL + " → 🐟 Fish " + CONFIG.fish_model);
    Logger.write("   🎧 VAD silence: " + VAD_SILENCE_MS + "ms");
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
