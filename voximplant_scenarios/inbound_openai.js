/*
 * Voximplant INBOUND OpenAI Script v5.1 — GPT-Live (gpt-live-1)
 * ====================================================================
 * Замена v4.10 (Realtime API). Голос ведёт gpt-live-1 — full-duplex модель:
 * слушает и говорит одновременно, сама решает, когда отвечать и когда
 * замолчать при перебивании. Сложные вещи и функции делает бэкенд-модель
 * (delegation.responses, по умолчанию gpt-5.6-terra).
 *
 * Сессию открывает сам Voximplant (OpenAI.createLiveAPIClient), без нашего
 * сервера на пути аудио. Серверный мост inbound_live.js оставлен для отката.
 *
 * Порядок звонка (абонент слышит гудки, пока идёт подготовка):
 *   конфиг (/api/telephony/config) → createLiveAPIClient → sessionStart
 *   → SessionStarted → тишина из URL-плеера в Live + указание с приветствием
 *   → SessionInstructionsAppended → answer + запись + sendMediaBetween
 * Прогрев тишиной (v5.1): таймлайн Live идёт только пока в сессию поступает
 * аудио, и первый медиапоток коннектор поднимает ~2 с. Раньше это было после
 * answer — абонент слышал ~3 с тишины. Теперь поток запускается на гудках,
 * а отвечаем, когда модель приняла приветствие (до первого слова ~0.7 с).
 * Если сессия не поднялась за LIVE_START_TIMEOUT_MS — сбрасываем звонок;
 * если приветствие не принято за GREETING_ANSWER_TIMEOUT_MS — отвечаем всё равно.
 *
 * Настройки сессии целиком приходят с бэкенда (CONFIG.live_session):
 * промпт голосового слоя, голос Live, промпт и функции бэкенд-модели.
 *
 * Функции: бэкенд-модель зовёт их через OpenAI.LiveAPIEvents.ResponseEvent
 * (вложенный response.output_item.done). Копим вызовы по delegation_id и
 * выполняем на response.completed/done: результаты → responseItemCreate,
 * затем один responseCreate. hangup_call — локально: прощание и hangup,
 * когда ассистент договорил (AgentStoppedSpeaking).
 *
 * Транскрипт: SessionInput/OutputTranscriptDelta без границ реплик —
 * новая реплика начинается при смене говорящего. Диалог, запись, стоимость,
 * длительность и usage уходят одним POST /api/voximplant/log в конце
 * (voice_model = gpt-live-1 → списание по тарифу openai-live).
 * ====================================================================
 */

require(Modules.OpenAI);

var LIVE_START_TIMEOUT_MS = 8000;  // ждём SessionStarted, абонент при этом слышит гудки
var SESSION_CLOSE_WAIT_MS = 2000;  // ждём SessionClosed (итоговый usage) при завершении
var HANGUP_MAX_WAIT_MS    = 10000; // hangup_call: максимум ждём конца прощания
var HANGUP_NO_SPEECH_MS   = 4000;  // hangup_call: если прощание так и не зазвучало
var GREETING_ANSWER_TIMEOUT_MS = 5000; // прогрев: не дождались SessionInstructionsAppended — отвечаем

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

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("🚀 APP STARTED (INBOUND OpenAI v5.1 - GPT-Live)");
    Logger.write("🔑 Session History ID: " + call_session_history_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

// ────────────────────────────────────────────────────────────────────
// ВХОДЯЩИЙ ЗВОНОК
// ────────────────────────────────────────────────────────────────────
VoxEngine.addEventListener(AppEvents.CallAlerting, async function(e) {
    var call = e.call;
    var caller_number = call.callerid() || "unknown";
    var called_number = e.destination || "unknown";
    var call_id = call.id();
    var chat_id = 'vox_' + Math.random().toString(36).substring(2, 15);

    var CONFIG = null;
    var ASSISTANT_ID = null;
    var functionIds = {};        // имя функции → function_id для /functions/execute

    var liveClient = null;
    var sessionStarted = false;
    var sessionClosed = false;
    var sessionClosedResolve = null;
    var liveSessionId = null;
    var usageSeconds = null;
    var liveStartedAt = 0;       // запасной замер длительности сессии, если SessionClosed не пришёл
    var backendUsage = { prompt_tokens: 0, cached_prompt_tokens: 0, completion_tokens: 0 };

    var isCallAnswered = false;
    var answeredAt = 0;
    var isHangingUp = false;
    var startTimer = null;
    var greetingKicked = false;
    var warmupPlayer = null;     // тишина в Live до ответа на звонок
    var greetingTimer = null;

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

    var CONFIG_URL = BASE_URL + "/api/telephony/config?phone=" + called_number.replace(/\D/g, '') +
        "&caller=" + caller_number.replace(/\D/g, '');

    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("📞 INBOUND CALL (OpenAI v5.1 - GPT-Live)");
    Logger.write("   From: " + caller_number);
    Logger.write("   To:   " + called_number);
    Logger.write("   Call ID: " + call_id);
    Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    function payloadOf(event) {
        return (event && event.data && (event.data.payload || event.data)) || {};
    }

    function shortId(prefix) {
        return prefix + Math.random().toString(36).substring(2, 14);
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
                call_id:       call_id,
                caller_number: "INBOUND: " + caller_number,
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

    var callEndHandler = async function(event) {
        if (isHangingUp) return;
        isHangingUp = true;

        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
        stopWarmup();
        for (var i = 0; i < hangupTimers.length; i++) clearTimeout(hangupTimers[i]);

        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("📴 INBOUND CALL ENDED");

        if (event && event.cost !== undefined)     call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;
        if (!call_duration && answeredAt) call_duration = Math.round((Date.now() - answeredAt) / 1000);

        // Закрываем сессию Live штатно — SessionClosed несёт итоговый usage
        if (liveClient) {
            if (sessionStarted && !sessionClosed) {
                try { liveClient.sessionClose(); } catch (err) {}
                await waitSessionClosed(SESSION_CLOSE_WAIT_MS);
            }
            try { liveClient.close(); } catch (err) {}
        }

        try { call.stopRecord(); } catch (err) {}
        // Ждём RecordStopped, чтобы забрать record_url
        await new Promise(function(resolve) { setTimeout(resolve, 500); });

        if (ASSISTANT_ID) await sendFinalLog();

        Logger.write("✅ Terminated");
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        VoxEngine.terminate();
    };

    // Завершить звонок со стороны сценария: Disconnected/Failed придёт с
    // длительностью и стоимостью; страховка — если событие не пришло.
    function endCall(reason) {
        if (isHangingUp) return;
        Logger.write("📴 Hanging up: " + reason);
        try { call.hangup(); } catch (err) {}
        setTimeout(function() { callEndHandler({}); }, 3000);
    }

    call.addEventListener(CallEvents.Disconnected, callEndHandler);
    call.addEventListener(CallEvents.Failed,       callEndHandler);

    call.addEventListener(CallEvents.RecordStarted, function(event) {
        if (event.url) record_url = event.url;
        Logger.write("🎙️ Recording started");
    });
    call.addEventListener(CallEvents.RecordStopped, function(event) {
        if (event.url) record_url = event.url;
        Logger.write("🎙️ Recording stopped");
    });

    // ═══════════════════════════════════════════════════════════════
    // ПРОГРЕВ И ОТВЕТ НА ЗВОНОК
    // ═══════════════════════════════════════════════════════════════
    function greetingText() {
        var phrase = (CONFIG.first_phrase || "").split(/\s+/).join(" ").trim();
        return phrase
            ? "Разговор только начался, собеседник ещё ничего не сказал. Начни первым: скажи дословно «" +
              phrase + "» и после этого жди ответа. Не повторяй приветствие позже."
            : "Разговор только начался, собеседник ещё ничего не сказал. Начни первым: коротко поздоровайся " +
              "и спроси, чем можешь помочь. Потом жди ответа.";
    }

    function stopWarmup() {
        if (!warmupPlayer) return;
        try { warmupPlayer.stopMediaTo(liveClient); } catch (err) {}
        try { warmupPlayer.stop(); } catch (err) {}
        warmupPlayer = null;
    }

    // SessionStarted: ещё на гудках запускаем в Live поток тишины и отдаём
    // приветствие. Ответим на звонок, когда модель его примет.
    function warmupAndGreet() {
        try {
            warmupPlayer = VoxEngine.createURLPlayer({ url: SILENCE_URL }, { loop: true });
            warmupPlayer.sendMediaTo(liveClient);
            Logger.write("🔇 Warm-up: silence → gpt-live-1 (call still ringing)");
        } catch (err) {
            Logger.write("⚠️ Warm-up player failed: " + err + " — answering now");
            warmupPlayer = null;
            answerAndBridge("warm-up failed");
        }
        liveClient.sessionInstructionsAppend({ content: greetingText(), delegation_id: null });
        greetingTimer = setTimeout(function() {
            Logger.write("⚠️ Greeting not accepted in " + GREETING_ANSWER_TIMEOUT_MS + "ms");
            answerAndBridge("greeting timeout");
        }, GREETING_ANSWER_TIMEOUT_MS);
    }

    function answerAndBridge(reason) {
        if (isCallAnswered || isHangingUp) return;
        isCallAnswered = true;
        answeredAt = Date.now();
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }

        call.answer(null, { disableDtxForAudio: true });
        try {
            call.record({ stereo: false, lossless: false, hd_audio: true });
        } catch (recordError) {
            Logger.write("⚠️ Failed to start recording: " + recordError);
        }
        // Вход Live переключается с тишины на абонента (новый поток заменяет прежний)
        VoxEngine.sendMediaBetween(call, liveClient);
        stopWarmup();
        Logger.write("📲 Answered (" + reason + "), media bridged to gpt-live-1");
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
        // ── 1. Конфиг (абонент слышит гудки) ─────────────────────────
        Logger.write("🔄 Loading config: " + CONFIG_URL);
        var configResponse = await Net.httpRequestAsync(CONFIG_URL);
        if (configResponse.code != 200) {
            Logger.write("❌ Failed to get config: HTTP " + configResponse.code);
            endCall("config http " + configResponse.code);
            return;
        }
        CONFIG = JSON.parse(configResponse.text);
        if (!CONFIG.success) {
            Logger.write("❌ Config success=false (no assistant for this number)");
            endCall("no config");
            return;
        }
        if (CONFIG.assistant_type !== "openai") {
            Logger.write("❌ Wrong assistant type: " + CONFIG.assistant_type + " (need openai)");
            endCall("wrong assistant type");
            return;
        }
        if (!CONFIG.api_key) {
            Logger.write("❌ No API key (wallet balance too low or no server key)");
            endCall("no api key");
            return;
        }
        if (!CONFIG.live_session) {
            Logger.write("❌ Config has no live_session (backend not updated?)");
            endCall("no live_session");
            return;
        }
        ASSISTANT_ID = CONFIG.assistant_id;
        functionIds = CONFIG.live_function_ids || {};

        var responsesCfg = (CONFIG.live_session.delegation && CONFIG.live_session.delegation.responses) || {};
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Logger.write("✅ CONFIG LOADED:");
        Logger.write("   📋 Assistant: " + CONFIG.assistant_name + " (" + ASSISTANT_ID + ")");
        Logger.write("   🎤 Voice: " + (CONFIG.live_session.audio && CONFIG.live_session.audio.output &&
            CONFIG.live_session.audio.output.voice));
        Logger.write("   🧠 Backend: " + responsesCfg.model);
        Logger.write("   🔧 Functions: " + ((responsesCfg.tools && responsesCfg.tools.length) || 0));
        Logger.write("   👋 First phrase: " + (CONFIG.first_phrase ? "yes" : "no"));
        Logger.write("   💳 Billing: " + CONFIG.billing_mode);
        Logger.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // ── 2. Клиент GPT-Live ───────────────────────────────────────
        liveClient = await OpenAI.createLiveAPIClient({
            apiKey: CONFIG.api_key,
            onWebSocketClose: function(event) {
                Logger.write("🔌 OpenAI Live WebSocket closed: " + JSON.stringify(event));
                sessionClosed = true;
                if (sessionClosedResolve) sessionClosedResolve();
                if (!isHangingUp) endCall("live websocket closed");
            }
        });
        if (isHangingUp) { try { liveClient.close(); } catch (err) {} return; }

        // ── 3. События ───────────────────────────────────────────────
        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionStarted, function(event) {
            var p = payloadOf(event);
            sessionStarted = true;
            liveStartedAt = Date.now();
            liveSessionId = (p.session && p.session.id) || p.session_id || null;
            Logger.write("✅ Live session started: " + liveSessionId);
            warmupAndGreet();
        });

        liveClient.addEventListener(OpenAI.LiveAPIEvents.SessionInstructionsAppended, function() {
            // Первое принятое указание — приветствие: отвечаем на звонок и просим
            // модель начать разговор (первое слово ~0.7 с после этого события)
            if (greetingKicked) return;
            greetingKicked = true;
            answerAndBridge("greeting accepted");
            liveClient.sessionCommentaryAppend({
                content: "Begin the conversation now, following the instructions provided.",
                delegation_id: null
            });
            Logger.write("👋 Greeting triggered");
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
        liveClient.sessionStart({ session: CONFIG.live_session });
        Logger.write("🔌 sessionStart sent (gpt-live-1), waiting for SessionStarted...");

        startTimer = setTimeout(function() {
            if (!sessionStarted) {
                Logger.write("⚠️ SessionStarted not received in " + LIVE_START_TIMEOUT_MS + "ms");
                endCall("live start timeout");
            }
        }, LIVE_START_TIMEOUT_MS);

    } catch (error) {
        Logger.write("❌ CRITICAL ERROR: " + error);
        if (error && error.stack) Logger.write("   Stack: " + error.stack);
        endCall("critical error");
    }
});
