/*
 * Voximplant OUTBOUND OpenAI Script v5.0 — GPT-Live (gpt-live-1)
 * ====================================================================
 * Замена v4.11 (Realtime API) по схеме inbound_openai v5.1: сессию gpt-live-1
 * открывает сам Voximplant (OpenAI.createLiveAPIClient), функции выполняет
 * бэкенд-модель (delegation.responses) через /api/voximplant/functions/execute.
 *
 * Порядок (сессия готова до набора — при сбое не звоним, 0 ₽ телефонии):
 *   customData → /api/telephony/outbound-config → live_session + контекст CRM
 *   → createLiveAPIClient → sessionStart → SessionStarted
 *   → тишина из URL-плеера в Live (таймлайн модели идёт, пока гудки)
 *   → callPSTN → Connected → запись + sendMediaBetween + приветствие
 * Поток в Live к моменту ответа уже поднят, поэтому указание с приветствием
 * принимается сразу и первое слово звучит ~0.7-1 с после «Алло».
 * Цена прогрева: секунды гудков тарифицируются OpenAI как время сессии Live —
 * /log списывает кошелёк по live_usage_seconds (сессия целиком, с гудками и
 * недозвонами), а не по длительности разговора.
 *
 * Контекст звонка из customData (voximplant_partner.start_outbound_call):
 * contact_name / task_title / task_description / task — дописываются в
 * instructions голосового слоя и бэкенд-модели; custom_greeting (первая фраза
 * от PreCall-оркестратора агента) приоритетнее приветствия ассистента.
 * В v4.11 эти поля не читались — агент звонил без задачи.
 *
 * Мьюта первых секунд (mute_duration_ms) нет: gpt-live-1 full-duplex и сам
 * отличает «Алло» и шум линии от реплики.
 *
 * Финальный /api/voximplant/log: диалог из транскрипт-дельт, запись, стоимость,
 * usage и voice_model = gpt-live-1 → списание по тарифу openai-live.
 * ====================================================================
 */

require(Modules.OpenAI);

var LIVE_START_TIMEOUT_MS = 8000;  // ждём SessionStarted до набора номера
var SESSION_CLOSE_WAIT_MS = 2000;  // ждём SessionClosed (итоговый usage) при завершении
var HANGUP_MAX_WAIT_MS    = 10000; // hangup_call: максимум ждём конца прощания
var HANGUP_NO_SPEECH_MS   = 4000;  // hangup_call: если прощание так и не зазвучало

var BASE_URL      = "https://voicyfy.ru";
var FUNCTIONS_URL = BASE_URL + "/api/voximplant/functions/execute";
var LOG_URL       = BASE_URL + "/api/voximplant/log";
var SILENCE_URL   = BASE_URL + "/static/audio/silence.wav"; // 5 с тишины, играется по кругу

// ────────────────────────────────────────────────────────────────────
// БИЛЛИНГ
// ────────────────────────────────────────────────────────────────────
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;

VoxEngine.addEventListener(AppEvents.Started, async function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (OUTBOUND OpenAI v5.0 - GPT-Live)");
    Logger.write("🔑 Session History ID: " + call_session_history_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── Входные данные ───────────────────────────────────────────────
    var callData;
    try {
        callData = JSON.parse(VoxEngine.customData());
    } catch (err) {
        Logger.write("❌ Failed to parse custom data: " + err);
        VoxEngine.terminate();
        return;
    }

    var PHONE_NUMBER          = callData.phone_number;
    var ASSISTANT_ID          = callData.assistant_id;
    var CALLER_ID             = callData.caller_id || "+1234567890";
    var FIRST_PHRASE_OVERRIDE = callData.first_phrase || null;
    var CONTACT_NAME          = callData.contact_name || "";
    var TASK_TITLE            = callData.task_title || "";
    var TASK_DESCRIPTION      = callData.task_description || "";
    var API_TASK              = callData.task || "";
    var CUSTOM_GREETING       = callData.custom_greeting || "";

    if (!PHONE_NUMBER || !ASSISTANT_ID) {
        Logger.write("❌ Missing required parameters: phone_number or assistant_id");
        VoxEngine.terminate();
        return;
    }

    var caller_number = "OUTBOUND: " + PHONE_NUMBER;
    var chat_id = 'vox_' + Math.random().toString(36).substring(2, 15);
    var call_id = null;
    var call = null;

    var CONFIG = null;
    var GREETING = "";
    var functionIds = {};        // имя функции → function_id для /functions/execute

    var liveClient = null;
    var sessionStarted = false;
    var sessionClosed = false;
    var sessionClosedResolve = null;
    var liveSessionId = null;
    var usageSeconds = null;
    var liveStartedAt = 0;       // запасной замер длительности сессии, если SessionClosed не пришёл
    var backendUsage = { prompt_tokens: 0, cached_prompt_tokens: 0, completion_tokens: 0 };

    var isConnected = false;
    var connectedAt = 0;
    var isHangingUp = false;
    var startTimer = null;
    var greetingSent = false;
    var greetingKicked = false;
    var warmupPlayer = null;     // тишина в Live, пока идут гудки

    // Функции бэкенда: вызовы копятся по delegation_id до response.completed
    var pendingCalls = {};
    var handledCallIds = {};
    var lastFunctionResult = null;

    // hangup_call
    var hangupRequested = false;
    var farewellSpeechStarted = false;
    var hangupTimers = [];

    // Транскрипт: фрагменты {role, text, start, seq}
    var fragments = [];
    var fragmentSeq = 0;

    var CONFIG_URL = BASE_URL + "/api/telephony/outbound-config?assistant_id=" + ASSISTANT_ID + "&assistant_type=openai";

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("📞 OUTBOUND CALL PREPARING (OpenAI v5.0 - GPT-Live)");
    Logger.write("   Target: " + PHONE_NUMBER);
    Logger.write("   Caller ID: " + CALLER_ID);
    Logger.write("   Assistant: " + ASSISTANT_ID);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    function payloadOf(event) {
        return (event && event.data && (event.data.payload || event.data)) || {};
    }

    function shortId(prefix) {
        return prefix + Math.random().toString(36).substring(2, 14);
    }

    // ═══════════════════════════════════════════════════════════════
    // КОНТЕКСТ ЗВОНКА → В ПРОМПТ
    // ═══════════════════════════════════════════════════════════════
    // Задача и карточка контакта известны только бэкенду в момент звонка:
    // один голос обзванивает разных людей по разным поводам. Как в outbound_fish.
    function buildContextBlock() {
        var block = "";
        if (API_TASK) {
            block += "ЗАДАЧА НА ЭТОТ ЗВОНОК\n" + API_TASK + "\nВыполни эту задачу — это главная цель звонка.\n\n";
        }
        if (CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION) {
            block += "КОНТЕКСТ ЗВОНКА (CRM)\n";
            if (CONTACT_NAME)     block += "Клиент: " + CONTACT_NAME + " (обращайся по имени).\n";
            if (TASK_TITLE)       block += "Задача: " + TASK_TITLE + "\n";
            if (TASK_DESCRIPTION) block += "Подробности: " + TASK_DESCRIPTION + "\n";
            block += "\n";
        }
        return block;
    }

    // Реальные номера и время: без них бэкенд не вызовет send_sms и путается в датах
    function buildCallInfoBlock() {
        var mskTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
        return "Информация о звонке:\n" +
            "- Номер клиента (caller_number): " + PHONE_NUMBER + "\n" +
            "- Наш номер (called_number): " + CALLER_ID + "\n" +
            "- Текущее время: " + mskTime + " (МСК)";
    }

    function withCallContext(session) {
        var s = JSON.parse(JSON.stringify(session));
        var extra = buildContextBlock() + buildCallInfoBlock();
        s.instructions = (s.instructions || "") + "\n\n" + extra;
        var resp = s.delegation && s.delegation.responses;
        if (resp) resp.instructions = (resp.instructions || "") + "\n\n" + extra;
        return s;
    }

    // ═══════════════════════════════════════════════════════════════
    // ТРАНСКРИПТ → РЕПЛИКИ
    // ═══════════════════════════════════════════════════════════════
    function addFragment(role, p) {
        var text = p.delta || p.transcript || "";
        if (!text) return;
        fragments.push({
            role: role,
            text: text,
            start: (typeof p.start_ms === "number") ? p.start_ms : null,
            seq: fragmentSeq++
        });
    }

    function buildDialog() {
        var ordered = fragments.slice();
        var allTimed = ordered.length > 0 && ordered.every(function(f) { return f.start !== null; });
        if (allTimed) {
            ordered.sort(function(a, b) {
                if (a.start !== b.start) return a.start - b.start;
                if (a.role !== b.role) return a.role === "user" ? -1 : 1;
                return a.seq - b.seq;
            });
        }
        var turns = [];
        for (var i = 0; i < ordered.length; i++) {
            var f = ordered[i];
            // Фрагменты Live режутся посреди слов и сами несут нужные пробелы — клеим как есть
            if (turns.length && turns[turns.length - 1].role === f.role) {
                turns[turns.length - 1].text += f.text;
            } else {
                turns.push({ role: f.role, text: f.text, ts: Date.now() });
            }
        }
        var out = [];
        for (var j = 0; j < turns.length; j++) {
            var t = turns[j].text.split(/\s+/).join(" ").trim();
            if (t) out.push({ role: turns[j].role, text: t, ts: turns[j].ts });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════════
    // ФИНАЛЬНЫЙ ЛОГ
    // ═══════════════════════════════════════════════════════════════
    async function sendFinalLog() {
        try {
            var dialog = buildDialog();
            var userText = [], asstText = [];
            for (var i = 0; i < dialog.length; i++) {
                if (dialog[i].role === "user") userText.push(dialog[i].text);
                else asstText.push(dialog[i].text);
            }

            var payload = {
                assistant_id:  ASSISTANT_ID,
                chat_id:       chat_id,
                call_id:       call_id || "unknown",
                caller_number: caller_number,
                type:          "conversation",
                voice_model:   "gpt-live-1",
                data: {
                    user_message:       userText.join(" "),
                    assistant_message:  asstText.join(" "),
                    function_result:    lastFunctionResult,
                    dialog:             dialog,
                    transport:          "gpt-live-1",
                    live_session_id:    liveSessionId,
                    // По нему /log списывает кошелёк: сессия Live платная целиком, с гудками
                    live_usage_seconds: usageSeconds !== null ? usageSeconds
                        : (liveStartedAt ? Math.round((Date.now() - liveStartedAt) / 1000) : null)
                },
                usage:         backendUsage,
                call_cost:     call_cost,
                call_duration: call_duration
            };
            if (record_url)              payload.record_url = record_url;
            if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);

            Logger.write("📤 FINAL LOG — turns: " + dialog.length + ", duration=" + call_duration +
                "s, cost=" + call_cost + ", live=" + usageSeconds + "s, record=" + (record_url ? "YES" : "NO") +
                ", backend tokens in/cached/out=" + backendUsage.prompt_tokens + "/" +
                backendUsage.cached_prompt_tokens + "/" + backendUsage.completion_tokens);

            var r = await Net.httpRequestAsync(LOG_URL, {
                headers:  ["Content-Type: application/json"],
                method:   'POST',
                postData: JSON.stringify(payload)
            });
            Logger.write("📡 Log → HTTP " + r.code);
            if (r.code != 200) Logger.write("   Response: " + (r.text || "").substring(0, 200));
        } catch (err) {
            Logger.write("❌ Error sending log: " + err);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ЗАВЕРШЕНИЕ
    // ═══════════════════════════════════════════════════════════════
    function waitSessionClosed(ms) {
        if (sessionClosed) return Promise.resolve();
        return new Promise(function(resolve) {
            sessionClosedResolve = resolve;
            setTimeout(resolve, ms);
        });
    }

    function stopWarmup() {
        if (!warmupPlayer) return;
        try { warmupPlayer.stopMediaTo(liveClient); } catch (err) {}
        try { warmupPlayer.stop(); } catch (err) {}
        warmupPlayer = null;
    }

    var callEndHandler = async function(event) {
        if (isHangingUp) return;
        isHangingUp = true;

        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        stopWarmup();
        for (var i = 0; i < hangupTimers.length; i++) clearTimeout(hangupTimers[i]);

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("📴 OUTBOUND CALL ENDED" + (event && event.reason ? " (" + event.reason + ")" : ""));

        if (event && event.cost !== undefined)     call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;
        if (!call_duration && connectedAt) call_duration = Math.round((Date.now() - connectedAt) / 1000);

        // Закрываем сессию Live штатно — SessionClosed несёт итоговый usage
        if (liveClient) {
            if (sessionStarted && !sessionClosed) {
                try { liveClient.sessionClose(); } catch (err) {}
                await waitSessionClosed(SESSION_CLOSE_WAIT_MS);
            }
            try { liveClient.close(); } catch (err) {}
        }

        if (call) {
            try { call.stopRecord(); } catch (err) {}
            // Ждём RecordStopped, чтобы забрать record_url
            await new Promise(function(resolve) { setTimeout(resolve, 500); });
            await sendFinalLog();
        }

        Logger.write("✅ Terminated");
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        VoxEngine.terminate();
    };

    // Завершить звонок со стороны сценария: Disconnected/Failed придёт с
    // длительностью и стоимостью; страховка — если событие не пришло.
    function endCall(reason) {
        if (isHangingUp) return;
        Logger.write("📴 Hanging up: " + reason);
        if (!call) { callEndHandler({}); return; }
        try { call.hangup(); } catch (err) {}
        setTimeout(function() { callEndHandler({}); }, 3000);
    }

    // ═══════════════════════════════════════════════════════════════
    // НАБОР И ПРИВЕТСТВИЕ
    // ═══════════════════════════════════════════════════════════════
    function greetingText() {
        var phrase = GREETING.split(/\s+/).join(" ").trim();
        return phrase
            ? "Клиент только что взял трубку. Начни разговор первым: скажи дословно «" + phrase +
              "» и после этого жди ответа. Если он сказал «Алло» — это не вопрос, просто начни. " +
              "Не повторяй приветствие позже."
            : "Клиент только что взял трубку. Начни разговор первым: коротко поздоровайся, " +
              "представься и назови цель звонка. Потом жди ответа.";
    }

    // SessionStarted: в Live идёт тишина (таймлайн модели запущен), затем набор
    function warmupAndDial() {
        try {
            warmupPlayer = VoxEngine.createURLPlayer({ url: SILENCE_URL }, { loop: true });
            warmupPlayer.sendMediaTo(liveClient);
            Logger.write("🔇 Warm-up: silence → gpt-live-1");
        } catch (err) {
            Logger.write("⚠️ Warm-up player failed: " + err + " — dialing without it");
            warmupPlayer = null;
        }

        Logger.write("📞 Dialing " + PHONE_NUMBER + " from " + CALLER_ID);
        call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);
        call_id = call.id();

        call.addEventListener(CallEvents.Connected, function() {
            isConnected = true;
            connectedAt = Date.now();
            Logger.write("✅ OUTBOUND CALL CONNECTED (" + call_id + ")");
            try {
                call.record({ stereo: false, lossless: false, hd_audio: true });
            } catch (recordError) {
                Logger.write("⚠️ Failed to start recording: " + recordError);
            }
            // Вход Live переключается с тишины на абонента (новый поток заменяет прежний)
            VoxEngine.sendMediaBetween(call, liveClient);
            stopWarmup();
            greetingSent = true;
            liveClient.sessionInstructionsAppend({ content: greetingText(), delegation_id: null });
            Logger.write("👋 Greeting sent: \"" + GREETING.substring(0, 60) + "\"");
        });
        call.addEventListener(CallEvents.Disconnected, callEndHandler);
        call.addEventListener(CallEvents.Failed, function(event) {
            Logger.write("❌ OUTBOUND CALL FAILED: code=" + event.code + " reason=" + event.reason);
            callEndHandler(event);
        });
        call.addEventListener(CallEvents.RecordStarted, function(event) {
            if (event.url) record_url = event.url;
            Logger.write("🎙️ Recording started");
        });
        call.addEventListener(CallEvents.RecordStopped, function(event) {
            if (event.url) record_url = event.url;
            Logger.write("🎙️ Recording stopped");
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // ФУНКЦИИ
    // ═══════════════════════════════════════════════════════════════
    function scheduleHangupAfterFarewell() {
        hangupRequested = true;
        hangupTimers.push(setTimeout(function() {
            if (!farewellSpeechStarted) endCall("hangup_call: farewell not heard");
        }, HANGUP_NO_SPEECH_MS));
        hangupTimers.push(setTimeout(function() { endCall("hangup_call: max wait"); }, HANGUP_MAX_WAIT_MS));
    }

    async function executeFunction(item) {
        var name = item.name;
        var args = {};
        try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch (err) {
            Logger.write("⚠️ Bad arguments for " + name + ": " + err);
        }
        Logger.write("🔧 FUNCTION CALL: " + name + " " + JSON.stringify(args).substring(0, 200));

        var functionId = functionIds[name];
        if (!functionId) {
            Logger.write("❌ Unknown function: " + name);
            return { error: "Unknown function: " + name };
        }
        args.function_id = functionId;

        try {
            var r = await Net.httpRequestAsync(FUNCTIONS_URL, {
                headers:  ["Content-Type: application/json"],
                method:   'POST',
                postData: JSON.stringify({
                    function_id: functionId,
                    arguments:   args,
                    call_data: {
                        call_id:       call_id,
                        chat_id:       chat_id,
                        assistant_id:  ASSISTANT_ID,
                        caller_number: caller_number
                    }
                })
            });
            if (r.code == 200) {
                var result = JSON.parse(r.text);
                Logger.write("✅ Function executed: " + name);
                lastFunctionResult = result;
                return result;
            }
            Logger.write("❌ Function failed: HTTP " + r.code);
            return { error: "Function execution failed" };
        } catch (err) {
            Logger.write("❌ Function error: " + err);
            return { error: "Function execution failed" };
        }
    }

    async function runPendingCalls(delegationId) {
        var calls = pendingCalls[delegationId] || [];
        delete pendingCalls[delegationId];
        if (!calls.length || isHangingUp) return;

        var hangupItem = null;
        var results = await Promise.all(calls.map(function(item) {
            if (item.name === "hangup_call") {
                hangupItem = item;
                return Promise.resolve({ success: true, action: "call_terminated" });
            }
            return executeFunction(item);
        }));
        if (isHangingUp) return;

        for (var i = 0; i < calls.length; i++) {
            liveClient.responseItemCreate({
                event_id: shortId("fnres_"),
                item: {
                    type:    "function_call_output",
                    call_id: calls[i].call_id,
                    output:  JSON.stringify(results[i])
                }
            });
        }

        if (hangupItem) {
            var hArgs = {};
            try { hArgs = hangupItem.arguments ? JSON.parse(hangupItem.arguments) : {}; } catch (err) {}
            Logger.write("📴 HANGUP CALL requested: " + (hArgs.reason || "-"));
            lastFunctionResult = { action: "call_terminated", reason: hArgs.reason || "user request" };
            var farewell = (hArgs.farewell_message || "").trim();
            liveClient.sessionCommentaryAppend({
                content: farewell
                    ? "Разговор завершается. Попрощайся с клиентом словами: «" + farewell + "»."
                    : "Разговор завершается. Коротко и вежливо попрощайся с клиентом.",
                delegation_id: delegationId || null
            });
            scheduleHangupAfterFarewell();
            return;
        }

        // Продолжить работу бэкенда с результатами
        liveClient.responseCreate({ event_id: shortId("cont_") });
    }

    function addBackendUsage(response) {
        var u = response && response.usage;
        if (!u) return;
        var cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
        backendUsage.prompt_tokens        += Math.max(0, (u.input_tokens || 0) - cached);
        backendUsage.cached_prompt_tokens += cached;
        backendUsage.completion_tokens    += (u.output_tokens || 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // ОСНОВНАЯ ЛОГИКА
    // ═══════════════════════════════════════════════════════════════
    try {
        // ── 1. Конфиг ────────────────────────────────────────────────
        Logger.write("🔄 Loading config: " + CONFIG_URL);
        var configResponse = await Net.httpRequestAsync(CONFIG_URL);
        if (configResponse.code != 200) {
            Logger.write("❌ Failed to get config: HTTP " + configResponse.code);
            VoxEngine.terminate();
            return;
        }
        CONFIG = JSON.parse(configResponse.text);
        if (!CONFIG.success || !CONFIG.api_key) {
            Logger.write("❌ Config unavailable (success=" + CONFIG.success + ", key=" + (CONFIG.api_key ? "yes" : "no") +
                ") — wallet balance too low or assistant not found");
            VoxEngine.terminate();
            return;
        }
        if (!CONFIG.live_session) {
            Logger.write("❌ Config has no live_session (backend not updated?)");
            VoxEngine.terminate();
            return;
        }
        functionIds = CONFIG.live_function_ids || {};
        GREETING = (CUSTOM_GREETING || FIRST_PHRASE_OVERRIDE || CONFIG.first_phrase || "").trim();
        var session = withCallContext(CONFIG.live_session);

        var responsesCfg = (session.delegation && session.delegation.responses) || {};
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("✅ CONFIG LOADED:");
        Logger.write("   📋 Assistant: " + CONFIG.assistant_name + " (" + ASSISTANT_ID + ")");
        Logger.write("   🎤 Voice: " + (session.audio && session.audio.output && session.audio.output.voice));
        Logger.write("   🧠 Backend: " + responsesCfg.model);
        Logger.write("   🔧 Functions: " + ((responsesCfg.tools && responsesCfg.tools.length) || 0));
        Logger.write("   👋 Greeting: " + (GREETING ? "\"" + GREETING.substring(0, 60) + "\"" : "(model decides)") +
            (CUSTOM_GREETING ? " [custom_greeting]" : ""));
        if (CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION || API_TASK) {
            Logger.write("   📇 CRM: " + (CONTACT_NAME || "без имени") + (TASK_TITLE ? " | " + TASK_TITLE : ""));
        }
        Logger.write("   💳 Billing: " + CONFIG.billing_mode);
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // ── 2. Клиент GPT-Live (до набора: при сбое не звоним) ──────
        liveClient = await OpenAI.createLiveAPIClient({
            apiKey: CONFIG.api_key,
            onWebSocketClose: function(event) {
                Logger.write("🔌 OpenAI Live WebSocket closed: " + JSON.stringify(event));
                sessionClosed = true;
                if (sessionClosedResolve) sessionClosedResolve();
                if (!isHangingUp) endCall("live websocket closed");
            }
        });

        // ── 3. События ───────────────────────────────────────────────
        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionStarted, function(event) {
            var p = payloadOf(event);
            sessionStarted = true;
            liveStartedAt = Date.now();
            if (startTimer) { clearTimeout(startTimer); startTimer = null; }
            liveSessionId = (p.session && p.session.id) || p.session_id || null;
            Logger.write("✅ Live session started: " + liveSessionId);
            warmupAndDial();
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionInstructionsAppended, function() {
            // Первое принятое указание после ответа — приветствие: просим начать
            if (!greetingSent || greetingKicked) return;
            greetingKicked = true;
            liveClient.sessionCommentaryAppend({
                content: "Begin the conversation now, following the instructions provided.",
                delegation_id: null
            });
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionInputTranscriptDelta, function(event) {
            addFragment("user", payloadOf(event));
        });
        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionOutputTranscriptDelta, function(event) {
            addFragment("assistant", payloadOf(event));
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.AgentStartedSpeaking, function() {
            if (hangupRequested) farewellSpeechStarted = true;
        });
        liveClient.addEventListener(OpenAI.LiveAPIEvents.AgentStoppedSpeaking, function() {
            if (hangupRequested && farewellSpeechStarted) {
                hangupTimers.push(setTimeout(function() { endCall("hangup_call: farewell done"); }, 300));
            }
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionDelegationCreated, function(event) {
            var p = payloadOf(event);
            Logger.write("🧠 Delegation created: " + (p.delegation_id || (p.delegation && p.delegation.id) || "-"));
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.ResponseEvent, function(event) {
            var p = payloadOf(event);
            var delegationId = p.delegation_id || "";
            var inner = p.event || {};

            if (inner.type === "response.output_item.done") {
                var item = inner.item || {};
                if (item.type !== "function_call" || !item.call_id || handledCallIds[item.call_id]) return;
                handledCallIds[item.call_id] = true;
                (pendingCalls[delegationId] = pendingCalls[delegationId] || []).push(item);
                return;
            }
            if (inner.type === "response.completed" || inner.type === "response.done") {
                addBackendUsage(inner.response);
                runPendingCalls(delegationId);
                return;
            }
            if (inner.type === "response.failed") {
                Logger.write("❌ Backend response failed: " + JSON.stringify(inner.response && inner.response.error));
            }
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionUsageUpdated, function(event) {
            var u = payloadOf(event).usage;
            if (u && typeof u.seconds === "number") usageSeconds = u.seconds;
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionClosed, function(event) {
            var p = payloadOf(event);
            if (p.usage && typeof p.usage.seconds === "number") usageSeconds = p.usage.seconds;
            Logger.write("🔚 Live session closed: reason=" + p.reason + ", usage=" + usageSeconds + "s");
            sessionClosed = true;
            if (sessionClosedResolve) sessionClosedResolve();
            if (!isHangingUp) endCall("live session closed");
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.Error, function(event) {
            var p = payloadOf(event);
            var err = p.error || p;
            var clientEventId = String(err.client_event_id || p.client_event_id || "");
            Logger.write("❌ Live error: code=" + err.code + " message=" + err.message +
                " client_event_id=" + (clientEventId || "-"));
            // Отклонён результат функции или продолжение бэкенда — иначе голосовая
            // модель будет молча ждать бэкенд, а бэкенд — результат.
            if (clientEventId.indexOf("fnres_") === 0 || clientEventId.indexOf("cont_") === 0) {
                liveClient.sessionInstructionsAppend({
                    content: "Результат последнего действия не удалось передать. Не жди его: коротко скажи " +
                        "клиенту, что проверить сейчас не получилось, и предложи повторить или уточнить.",
                    delegation_id: null
                });
            }
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.WebSocketError, function(event) {
            Logger.write("❌ Live WebSocket error: " + JSON.stringify(payloadOf(event)));
        });

        // ── 4. Старт сессии ──────────────────────────────────────────
        liveClient.sessionStart({ session: session });
        Logger.write("🔌 sessionStart sent (gpt-live-1), waiting for SessionStarted...");

        startTimer = setTimeout(function() {
            if (!sessionStarted) {
                Logger.write("⚠️ SessionStarted not received in " + LIVE_START_TIMEOUT_MS + "ms — not dialing");
                endCall("live start timeout");
            }
        }, LIVE_START_TIMEOUT_MS);

    } catch (error) {
        Logger.write("❌ CRITICAL ERROR: " + error);
        if (error && error.stack) Logger.write("   Stack: " + error.stack);
        endCall("critical error");
    }
});
