/*
 * Voximplant INBOUND GPT-Live Script v0.1 (экспериментально)
 * ====================================================================
 * Архитектура:
 *   Один WebSocket к Voicyfy: /ws/live/telephony/{assistant_id}.
 *   По нему в обе стороны ходит аудио звонка:
 *       call.sendMediaTo(ws)  → PCM16 16 кГц на сервер
 *       ws.sendMediaTo(call)  ← PCM16 16 кГц из сервера в трубку
 *   Сессия gpt-live-1 живёт на сервере. Модель full-duplex: сама решает,
 *   когда говорить и когда замолчать при перебивании. Функции ассистента
 *   выполняет сервер (delegation → бэкенд-модель → наш реестр функций).
 *
 * Чем отличается от inbound_fish:
 *   - нет VAD, turn_detection, watchdog, flush, батчинга текста — текста нет;
 *   - нет вызовов /api/voximplant/functions/execute — функции на сервере;
 *   - dialogLog не ведём: сервер отдаёт транскрипт в call_summary при
 *     завершении, сценарий кладёт его в финальный /api/voximplant/log
 *     (запись → R2, Telegram, списание по длительности — как раньше);
 *   - hangup_call пока не поддерживается.
 *
 * Pre-answer: сокет и сессия Live поднимаются ещё на гудках (config → WS →
 * call_started → live.started), и только по live.started отвечаем на звонок и
 * привязываем медиа. Так абонент не слышит 2-3 с тишины после ответа.
 * Приветствие сервер отправляет, когда Voximplant начал слать нам медиа.
 *
 * Сценарий рассчитан на номера, привязанные к OpenAI-ассистенту
 * (assistant_type === "openai" в /api/telephony/config).
 */

var LIVE_WS_BASE     = "wss://voicyfy.ru/ws/live/telephony/";
var SUMMARY_WAIT_MS  = 4000;   // ждём транскрипт от сервера после Disconnected
var ANSWER_TIMEOUT_MS = 6000;  // pre-answer: если live.started не пришёл — отвечаем всё равно

// ============================================================================
// БИЛЛИНГ
// ============================================================================
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (INBOUND GPT-Live v0.1)");
    Logger.write("🔑 Session History ID: " + call_session_history_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

// ============================================================================
// ВХОДЯЩИЙ ЗВОНОК
// ============================================================================
VoxEngine.addEventListener(AppEvents.CallAlerting, async function(e) {
    var call = e.call;
    var caller_number = call.callerid() || "unknown";
    var called_number = e.destination || "unknown";
    var call_id = call.id();
    var chat_id = 'vox_' + Math.random().toString(36).substring(2, 15);

    var CONFIG = null;
    var ASSISTANT_ID = null;
    var ws = null;
    var wsOpen = false;
    var mediaAttached = false;
    var mediaAccepted = false;   // MEDIA_STARTED: Voximplant принял наш StartEvent
    var callAnswered = false;
    var isHangingUp = false;
    var liveSessionId = null;
    var answerTimer = null;
    var tAlert = Date.now();

    // Транскрипт от сервера (приходит в call_summary при завершении)
    var recordStartedAt = 0;      // для перевода замеров сервера в таймлайн записи
    var summaryDialog = null;
    var summaryUsage = null;
    var summaryResolve = null;

    var CONFIG_URL = "https://voicyfy.ru/api/telephony/config?phone=" + called_number.replace(/\D/g, '') + "&caller=" + caller_number.replace(/\D/g, '');
    var LOG_URL = "https://voicyfy.ru/api/voximplant/log";

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("📞 INBOUND CALL (GPT-Live v0.1)");
    Logger.write("   From: " + caller_number);
    Logger.write("   To: " + called_number);
    Logger.write("   Call ID: " + call_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // =========================================================================
    // ФИНАЛЬНЫЙ ЛОГ (диалог от сервера + биллинг)
    // =========================================================================
    async function sendFinalLog() {
        try {
            var dialog = summaryDialog || [];
            var userText = [], asstText = [];
            for (var i = 0; i < dialog.length; i++) {
                if (dialog[i].role === "user") userText.push(dialog[i].text);
                else asstText.push(dialog[i].text);
            }
            var payload = {
                assistant_id: ASSISTANT_ID,
                chat_id: chat_id,
                call_id: call_id,
                caller_number: "INBOUND: " + caller_number,
                type: "conversation",
                data: {
                    user_message: userText.join(" "),
                    assistant_message: asstText.join(" "),
                    function_result: null,
                    dialog: dialog,
                    transport: "gpt-live-1",
                    live_session_id: liveSessionId,
                    live_usage_seconds: summaryUsage
                },
                call_cost: call_cost,
                call_duration: call_duration
            };
            if (record_url)              payload.record_url = record_url;
            if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);

            Logger.write("📤 FINAL LOG — turns: " + dialog.length + ", duration=" + call_duration +
                "s, cost=" + call_cost + ", record=" + (record_url ? "YES" : "NO"));

            var r = await Net.httpRequestAsync(LOG_URL, {
                headers: ["Content-Type: application/json"],
                method: 'POST',
                postData: JSON.stringify(payload)
            });
            Logger.write("📡 Log → HTTP " + r.code);
        } catch (err) {
            Logger.write("❌ Error sending log: " + err);
        }
    }

    function waitForSummary(ms) {
        if (summaryDialog !== null) return Promise.resolve();
        return new Promise(function(resolve) {
            summaryResolve = resolve;
            setTimeout(resolve, ms);
        });
    }

    // =========================================================================
    // ЗАВЕРШЕНИЕ ЗВОНКА
    // =========================================================================
    var callEndHandler = async function(event) {
        if (isHangingUp) return;
        isHangingUp = true;
        Logger.write("📴 INBOUND CALL DISCONNECTED");

        if (event && event.cost !== undefined)     call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;
        if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }

        // Просим сервер закрыть сессию Live и отдать транскрипт
        if (ws && wsOpen) {
            try { ws.send(JSON.stringify({ type: "call_ended" })); } catch (err) {}
            await waitForSummary(SUMMARY_WAIT_MS);
        }
        if (summaryDialog === null) Logger.write("⚠️ call_summary не получен — диалог сохранит сервер");
        try { if (ws) ws.close(); } catch (err) {}

        // Ждём RecordStopped, чтобы забрать record_url
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        await sendFinalLog();

        Logger.write("✅ Terminated");
        VoxEngine.terminate();
    };

    // =========================================================================
    // КОНФИГ
    // =========================================================================
    var configResponse;
    try {
        configResponse = await Net.httpRequestAsync(CONFIG_URL);
    } catch (err) {
        Logger.write("❌ Config request failed: " + err);
        VoxEngine.terminate();
        return;
    }
    if (configResponse.code != 200) { Logger.write("❌ Config HTTP " + configResponse.code); VoxEngine.terminate(); return; }
    try { CONFIG = JSON.parse(configResponse.text); } catch (err) { Logger.write("❌ Config parse: " + err); VoxEngine.terminate(); return; }
    if (!CONFIG.success) { Logger.write("❌ Config success=false"); VoxEngine.terminate(); return; }
    if (CONFIG.assistant_type !== "openai") {
        Logger.write("❌ Wrong assistant type: " + CONFIG.assistant_type + " (expected: openai)");
        VoxEngine.terminate();
        return;
    }
    ASSISTANT_ID = CONFIG.assistant_id;

    Logger.write("✅ CONFIG: " + CONFIG.assistant_name + " (" + ASSISTANT_ID + "), functions: " +
        (CONFIG.functions ? CONFIG.functions.length : 0) + ", first_phrase: " + (CONFIG.first_phrase ? "yes" : "no"));

    // =========================================================================
    // ОТВЕТ НА ЗВОНОК (pre-answer: по live.started или по таймауту)
    // =========================================================================
    function answerCall(reason) {
        if (callAnswered || isHangingUp) return;
        if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
        callAnswered = true;
        call.answer();
        Logger.write("[Call] Answered (" + reason + ", +" + (Date.now() - tAlert) + "ms от CallAlerting)");
        attachMedia();

        try {
            // stereo: абонент и агент попадают в разные каналы. Без этого они
            // смешаны в один и по записи нельзя измерить ни задержку ответа,
            // ни наличие эха агента во входящем канале.
            call.record({ stereo: true, lossless: false, hd_audio: true });
            Logger.write("🎙️ Recording started");
        } catch (recordError) {
            Logger.write("⚠️ Recording failed: " + recordError);
        }
    }

    // =========================================================================
    // WEBSOCKET К СЕРВЕРУ
    // =========================================================================
    function attachMedia() {
        if (mediaAttached || !wsOpen || !callAnswered || !ws) return;
        try {
            // Аудио абонента → сервер (PCM16 16 кГц, GPT-Live принимает без ресемплинга)
            call.sendMediaTo(ws, { encoding: WebSocketAudioEncoding.PCM16_16KHZ });
            // Аудио модели ← сервер → в трубку
            ws.sendMediaTo(call);
            mediaAttached = true;
            Logger.write("[Live] 🔊 media attached both ways");
        } catch (err) {
            Logger.write("[Live] ❌ media attach failed: " + err);
        }
    }

    function openSocket() {
        var url = LIVE_WS_BASE + ASSISTANT_ID;
        Logger.write("[Live] Opening " + url);
        ws = VoxEngine.createWebSocket(url);

        ws.addEventListener(WebSocketEvents.OPEN, function() {
            wsOpen = true;
            Logger.write("[Live] ✅ socket open");
            // Данные звонка — до ответа: сервер сразу поднимает сессию Live.
            // system_prompt из конфига несёт карточку звонящего: сервер отдаёт её
            // бэкенд-модели, голосовому слою — только имя.
            ws.send(JSON.stringify({
                type: "call_started",
                call_id: call_id,
                chat_id: chat_id,
                caller_number: caller_number,
                called_number: called_number,
                first_phrase: CONFIG.first_phrase || null,
                system_prompt: CONFIG.system_prompt || null,
                session_history_id: call_session_history_id ? String(call_session_history_id) : null,
                audio: { encoding: "PCM16", sampleRate: 16000 }
            }));
            attachMedia();   // если звонок уже отвечен по таймауту
        });

        ws.addEventListener(WebSocketEvents.MEDIA_STARTED, function(ev) {
            mediaAccepted = true;
            Logger.write("[Live] ✅ MEDIA_STARTED — StartEvent принят, кодек " + (ev && ev.encoding));
        });
        ws.addEventListener(WebSocketEvents.MEDIA_ENDED, function() {
            Logger.write("[Live] MEDIA_ENDED");
        });

        ws.addEventListener(WebSocketEvents.MESSAGE, function(ev) {
            var msg;
            try { msg = JSON.parse(ev && ev.text); } catch (err) { return; }
            if (!msg || !msg.type) return;   // медиа-события сервера обрабатывает сам Voximplant

            if (msg.type === "live.started") {
                liveSessionId = msg.session_id;
                Logger.write("[Live] 🎙 session " + msg.session_id + " voice=" + msg.voice +
                    " backend=" + msg.backend_model + " functions=" + (msg.functions || []).join(","));
                answerCall("live.started");
            } else if (msg.type === "barge_in") {
                // Абонент перебил ассистента. Сервер уже выбросил свою очередь,
                // но полторы секунды речи (LEAD_LIMIT_MS) успели уйти в Voximplant
                // и доиграют, если их не погасить здесь. У GPT-Live своего события
                // о перебивании нет — сервер определяет его сам и присылает нам.
                try {
                    ws.clearMediaBuffer();
                    Logger.write("[Live] ✂️ barge-in — буфер Voximplant очищен");
                } catch (err) {
                    Logger.write("[Live] ⚠️ clearMediaBuffer failed: " + err);
                }
            } else if (msg.type === "function_call") {
                Logger.write("🔧 FUNCTION CALL: " + msg.name + " " + JSON.stringify(msg.arguments));
            } else if (msg.type === "function_result") {
                Logger.write("✅ FUNCTION RESULT: " + msg.name + " → " + JSON.stringify(msg.result).substring(0, 200));
            } else if (msg.type === "call_summary") {
                summaryDialog = msg.dialog || [];
                summaryUsage = msg.usage_seconds;
                Logger.write("[Live] 📝 call_summary: " + summaryDialog.length + " turns, usage=" + summaryUsage +
                    "s, barge-in: " + (msg.barge_ins || 0) + " (сброшено " + (msg.barge_in_dropped_ms || 0) + " мс)");
                // Вклад нашего сервера в задержку: от первой дельты модели до первого
                // кадра, ушедшего в Voximplant. Всё, что сверх этого, — телефонная сеть.
                Logger.write("[Live] ⏱ сервер держал реплику: медиана " + (msg.serve_ms_median === null ||
                    msg.serve_ms_median === undefined ? "н/д" : msg.serve_ms_median + " мс") +
                    ", все: [" + (msg.serve_ms || []).join(", ") + "]");
                Logger.write("[Live] ⏱ скорость генерации (×10 от реального времени): медиана " +
                    (msg.gen_speed_x10_median === null || msg.gen_speed_x10_median === undefined ? "н/д" :
                     msg.gen_speed_x10_median) + ", все: [" + (msg.gen_speed_x10 || []).join(", ") + "]");
                // Прямой аналог браузерного замера (там медиана 359 мс): конец речи
                // абонента → первый звук модели, но точкой отсчёта служит момент,
                // когда звук абонента дошёл ДО НАС.
                Logger.write("[Live] ⏱ модель ответила через: медиана " +
                    (msg.model_ms_median === null || msg.model_ms_median === undefined ? "н/д" :
                     msg.model_ms_median + " мс") + ", все: [" + (msg.model_ms || []).join(", ") + "]");
                // Те же моменты в таймлайне записи. Сверив их с реальными концами фраз
                // на стереодорожке, получаем лаг доставки аудио Voximplant → сервер.
                // Фактический запас аудио в буфере Voximplant. Он же — постоянная
                // добавка к задержке: абонент слышит каждый звук на столько позже.
                Logger.write("[Live] ⏱ запас в буфере Voximplant: медиана " +
                    (msg.lead_ms_median === null || msg.lead_ms_median === undefined ? "н/д" :
                     msg.lead_ms_median + " мс") + ", все: [" + (msg.lead_ms || []).join(", ") + "]");
                if (recordStartedAt && (msg.speech_end_epoch || []).length) {
                    var rel = msg.speech_end_epoch.map(function(e) {
                        return ((e - recordStartedAt) / 1000).toFixed(2);
                    });
                    Logger.write("[Live] ⏱ сервер услышал концы фраз на (сек от начала записи): [" +
                        rel.join(", ") + "]");
                }
                for (var i = 0; i < summaryDialog.length; i++) {
                    Logger.write("   " + (summaryDialog[i].role === "user" ? "👤 USER: " : "🤖 AGENT: ") +
                        String(summaryDialog[i].text).substring(0, 100));
                }
                if (summaryResolve) { summaryResolve(); summaryResolve = null; }
            } else if (msg.type === "error") {
                Logger.write("[Live] ❌ server error: " + JSON.stringify(msg.error));
                if (!isHangingUp) { try { call.hangup(); } catch (err) {} }
            } else if (msg.type === "connection_status") {
                Logger.write("[Live] server ready (" + msg.model + ")");
            }
        });

        ws.addEventListener(WebSocketEvents.ERROR, function(ev) {
            Logger.write("[Live] ❌ socket error: " + JSON.stringify(ev));
        });

        ws.addEventListener(WebSocketEvents.CLOSE, function(ev) {
            wsOpen = false;
            mediaAttached = false;
            Logger.write("[Live] socket closed: " + (ev && ev.reason));
            // Сессия Live умерла вместе с сокетом — разговор продолжать нечем.
            if (!isHangingUp) { try { call.hangup(); } catch (err) {} }
        });
    }

    call.addEventListener(CallEvents.Disconnected, callEndHandler);
    call.addEventListener(CallEvents.Failed, callEndHandler);
    openSocket();

    // Pre-answer: ждём live.started (обычно ~3 с от CallAlerting), абонент
    // слышит гудки. Потолок — ANSWER_TIMEOUT_MS, дальше отвечаем всё равно.
    answerTimer = setTimeout(function() {
        Logger.write("⚠️ live.started не пришёл за " + ANSWER_TIMEOUT_MS + "ms — отвечаем по таймауту");
        answerCall("timeout");
    }, ANSWER_TIMEOUT_MS);

    call.addEventListener(CallEvents.RecordStarted, function(event) {
        recordStartedAt = Date.now();
        if (event.url) { record_url = event.url; Logger.write("🎙️ RecordStarted: " + record_url); }
    });
    call.addEventListener(CallEvents.RecordStopped, function(event) {
        if (event.url) record_url = event.url;
    });

    Logger.write("🎉 READY (GPT-Live v0.1, pre-answer) — session " + call_session_history_id);
});
