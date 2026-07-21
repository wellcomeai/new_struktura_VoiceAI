require(Modules.OpenAI);
require(Modules.VoxTTS);

/*
 * Voximplant INBOUND scenario — Realtime half-cascade + VoxTTS
 * ====================================================================
 * Разворачивается под именем сценария "cartesia_inbound" (тип ассистента
 * в БД остаётся "cartesia"). Несмотря на имя, TTS здесь — VoxTTS, а не
 * Cartesia. Имя сохранено, чтобы не менять маршрутизацию/бекенд.
 *
 * Архитектура:
 *   - OpenAI Realtime API (output_modalities: text) — STT + turn detection
 *     + reasoning. Серверный VAD сам определяет конец реплики и перебивание,
 *     поэтому Silero/Pipecat/VoxTurnTaking здесь НЕ нужны.
 *   - VoxTTS Realtime TTS — один долгоживущий плеер на звонок, голос Anna.
 *     Дельты текста от LLM стримятся в плеер напрямую (без разбивки на
 *     предложения — VoxTTS синтезирует потоково).
 *   - Динамический конфиг из /api/telephony/config (ключ — CONFIG.api_key,
 *     пользовательский OpenAI-ключ; смена на платформенный — отдельным шагом).
 *   - Запись звонка + биллинг, function calls, структурированный dialogLog.
 *
 * База: cartesia_inbound v2.0. Отличие: TTS-слой Cartesia заменён на VoxTTS,
 * убрана вся машинерия context_id/generationRequest/флаша по предложениям и
 * пре-буферизация приветствия (VoxTTS стримит, приветствие идёт после ответа).
 */

// ============================================================================
// КОНСТАНТЫ
// ============================================================================
var MODEL_OVERRIDE = "gpt-realtime-2.1-mini"; // null = брать из CONFIG.model
var REASONING_EFFORT = "low";                 // модуль может игнорировать
var VOXTTS_VOICE = VoxTTS.VoiceList.Anna;     // голос синтеза
var MS_PER_CHAR = 95;                         // оценка длительности речи (farewell → hangup)

// ============================================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ БИЛЛИНГА
// ============================================================================
var call_session_history_id = null;
var record_url = null;
var call_cost = 0;
var call_duration = 0;

VoxEngine.addEventListener(AppEvents.Started, function(e) {
    call_session_history_id = e.sessionId;
    Logger.write("🚀 APP STARTED (INBOUND Realtime+VoxTTS) — session " + call_session_history_id);
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
    var realtimeAPIClient = null;
    var ttsPlayer = null;          // один долгоживущий VoxTTS-плеер на звонок
    var callAnswered = false;
    var sessionConfigured = false;
    var playerReady = false;
    var greetingStarted = false;
    var isInterrupted = false;
    var isHangingUp = false;

    // ── Структурированный диалог ────────────────────────────────────────────
    var userMessageBuffer = "";
    var assistantMessageBuffer = "";
    var dialogLog = [];
    var lastFunctionResult = null;
    var logCounter = 0;

    // ── Конфиг ──────────────────────────────────────────────────────────────
    var CONFIG = null;
    var ASSISTANT_ID = null;
    var functionNameToIdMap = {};

    var CONFIG_URL = "https://voicyfy.ru/api/telephony/config?phone=" + called_number.replace(/\D/g, '');
    var FUNCTIONS_URL = "https://voicyfy.ru/api/voximplant/functions/execute";
    var LOG_URL = "https://voicyfy.ru/api/voximplant/log";

    Logger.write("📞 INBOUND CALL (Realtime+VoxTTS) from " + caller_number + " to " + called_number + " (call " + call_id + ")");

    // =========================================================================
    // ФУНКЦИЯ ЛОГИРОВАНИЯ
    // =========================================================================
    async function sendConversationLog(isFinal) {
        try {
            logCounter++;
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
                payload.call_cost     = call_cost;
                payload.call_duration = call_duration;
            }

            var logResponse = await Net.httpRequestAsync(LOG_URL, {
                headers: ["Content-Type: application/json"],
                method: 'POST',
                postData: JSON.stringify(payload)
            });

            Logger.write("📤 Log #" + logCounter + (isFinal ? " (FINAL)" : "") + " → HTTP " + logResponse.code);

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

        Logger.write("📴 CALL DISCONNECTED");

        if (event && event.cost !== undefined)     call_cost = event.cost;
        if (event && event.duration !== undefined) call_duration = event.duration;

        if (realtimeAPIClient) { try { realtimeAPIClient.close(); } catch (err) {} }
        if (ttsPlayer)         { try { ttsPlayer.stop(); } catch (err) {} ttsPlayer = null; }
        if (call)              { try { call.stopRecord(); } catch (err) {} }

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

    if (configResponse.code != 200) { Logger.write("❌ Config HTTP " + configResponse.code); VoxEngine.terminate(); return; }
    try { CONFIG = JSON.parse(configResponse.text); }
    catch (err) { Logger.write("❌ Config parse error: " + err); VoxEngine.terminate(); return; }
    if (!CONFIG.success) { Logger.write("❌ Config success=false"); VoxEngine.terminate(); return; }
    if (CONFIG.assistant_type !== "cartesia") {
        Logger.write("❌ Wrong assistant type: " + CONFIG.assistant_type + " (expected cartesia)");
        VoxEngine.terminate();
        return;
    }

    ASSISTANT_ID = CONFIG.assistant_id;
    var LLM_MODEL = MODEL_OVERRIDE || CONFIG.model || "gpt-realtime";

    Logger.write("✅ CONFIG: " + CONFIG.assistant_name + " (" + ASSISTANT_ID + "), lang " +
        (CONFIG.language || "ru") + ", model " + LLM_MODEL + ", voice VoxTTS/" + VOXTTS_VOICE +
        ", functions " + (CONFIG.functions ? CONFIG.functions.length : 0));

    // =========================================================================
    // ПОДГОТОВКА ФУНКЦИЙ
    // =========================================================================
    var voximplantTools = [];
    if (CONFIG.functions && Array.isArray(CONFIG.functions)) {
        for (var i = 0; i < CONFIG.functions.length; i++) {
            var tool = CONFIG.functions[i];
            if (tool.type === "function" && tool.function) {
                var functionId = (i + 1).toString();
                functionNameToIdMap[tool.function.name] = functionId;
                voximplantTools.push({
                    type: "function",
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters
                });
            }
        }
    }

    // =========================================================================
    // ПОДКЛЮЧЕНИЕ К OPENAI REALTIME (STT + turn detection + reasoning)
    // =========================================================================
    Logger.write("🔌 Connecting OpenAI Realtime (" + LLM_MODEL + ")...");
    try {
        realtimeAPIClient = await OpenAI.createRealtimeAPIClient({
            apiKey: CONFIG.api_key,
            model: LLM_MODEL,
            type: OpenAI.RealtimeAPIClientType.REALTIME,
            onWebSocketClose: function() {
                Logger.write("[OpenAI] WS closed");
                if (!isHangingUp) callEndHandler({ cost: 0, duration: 0 });
            },
            onWebSocketError: function(err) {
                Logger.write("[OpenAI] WS error: " + JSON.stringify(err));
            }
        });
    } catch (err) {
        Logger.write("❌ OpenAI connect failed: " + err);
        call.answer();
        call.addEventListener(CallEvents.Disconnected, callEndHandler);
        call.addEventListener(CallEvents.Failed, callEndHandler);
        return;
    }
    Logger.write("✅ OpenAI connected");

    // Приветствие запускаем, только когда И сессия сконфигурирована, И VoxTTS-плеер
    // подключён к звонку — иначе первые дельты приветствия улетят в никуда.
    function maybeStartGreeting() {
        if (!sessionConfigured || !playerReady || greetingStarted) return;
        greetingStarted = true;

        var greetInput = CONFIG.first_phrase
            ? 'Скажи так: "' + CONFIG.first_phrase + '"'
            : "Поприветствуй звонящего одной короткой фразой и спроси, чем можешь помочь.";

        realtimeAPIClient.conversationItemCreate({
            item: { type: "message", role: "user", content: [{ type: "input_text", text: greetInput }] }
        });
        realtimeAPIClient.responseCreate({});
        Logger.write("[OpenAI] Greeting requested");
    }

    // =========================================================================
    // SESSION CREATED — конфигурируем сессию
    // =========================================================================
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.SessionCreated,
        function() {
            if (sessionConfigured) return;
            sessionConfigured = true;
            Logger.write("[OpenAI] Session created — configuring");

            realtimeAPIClient.sessionUpdate({
                session: {
                    type: "realtime",
                    output_modalities: ["text"],
                    instructions: CONFIG.system_prompt,
                    reasoning: { effort: REASONING_EFFORT },
                    audio: {
                        input: {
                            transcription: {
                                model: "gpt-4o-transcribe",
                                language: CONFIG.language || "ru"
                            }
                        }
                    },
                    tools: voximplantTools,
                    tool_choice: voximplantTools.length > 0 ? "auto" : "none",
                    turn_detection: {
                        type: "server_vad",
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                        create_response: true,
                        interrupt_response: true
                    }
                }
            });

            maybeStartGreeting();
        }
    );

    // =========================================================================
    // ДЕЛЬТЫ ТЕКСТА → VoxTTS (потоковый синтез, без разбивки на предложения)
    // =========================================================================
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.ResponseOutputTextDelta,
        function(event) {
            if (!callAnswered || isInterrupted || !ttsPlayer) return;
            var delta =
                (event && event.data && event.data.delta) ||
                (event && event.data && event.data.payload && event.data.payload.delta) || "";
            if (!delta) return;
            ttsPlayer.send({ send_text: { text: delta } });
        }
    );

    // Полный ответ ассистента: лог + форс-синтез хвоста
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.ResponseOutputTextDone,
        function(event) {
            var text =
                (event && event.data && event.data.text) ||
                (event && event.data && event.data.payload && event.data.payload.text) || "";
            if (!text || !text.trim() || isInterrupted) return;

            Logger.write("🤖 AGENT: \"" + text.substring(0, 80) + "\"");
            dialogLog.push({ role: 'assistant', text: text.trim(), ts: Date.now() });
            if (assistantMessageBuffer) assistantMessageBuffer += " ";
            assistantMessageBuffer += text.trim();

            if (ttsPlayer) ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
        }
    );

    // Новая реплика ассистента — сброс флага перебивания
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.ResponseCreated,
        function() {
            if (callAnswered) { isInterrupted = false; }
        }
    );

    // Перебивание пользователем (серверный VAD)
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.InputAudioBufferSpeechStarted,
        function() {
            if (!callAnswered) return;
            Logger.write("[OpenAI] INTERRUPTION — clear VoxTTS buffer");
            isInterrupted = true;
            try { realtimeAPIClient.clearMediaBuffer(); } catch (err) {}
            if (ttsPlayer) { try { ttsPlayer.clearBuffer(); } catch (err) {} }
        }
    );

    // Транскрипция пользователя
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted,
        function(event) {
            try {
                var payload = event.data && event.data.payload;
                var transcript = payload && payload.transcript;
                if (transcript && transcript.trim()) {
                    Logger.write("👤 USER: \"" + transcript + "\"");
                    dialogLog.push({ role: 'user', text: transcript.trim(), ts: Date.now() });
                    if (userMessageBuffer) userMessageBuffer += " ";
                    userMessageBuffer += transcript.trim();
                }
            } catch (err) { Logger.write("❌ USER handler: " + err); }
        }
    );

    // Function calls
    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.ResponseOutputItemDone,
        async function(event) {
            try {
                var payload = event.data && event.data.payload;
                var item = payload && payload.item;
                if (!item || item.type !== "function_call") return;

                var functionName = item.name;
                var callId = item.call_id;
                var args = JSON.parse(item.arguments);
                Logger.write("🔧 FUNCTION CALL: " + functionName);

                if (functionName === "hangup_call") {
                    lastFunctionResult = { action: "call_terminated", reason: args.reason || "user request" };
                    if (args.farewell_message) {
                        var farewell = args.farewell_message.trim();
                        if (ttsPlayer) ttsPlayer.send({ send_text: { text: farewell, flush_context: {} } });
                        var waitMs = Math.max(3000, farewell.length * MS_PER_CHAR + 1500);
                        setTimeout(function() { call.hangup(); }, waitMs);
                    } else {
                        call.hangup();
                    }
                    return;
                }

                var function_id = functionNameToIdMap[functionName];
                if (!function_id) {
                    realtimeAPIClient.conversationItemCreate({
                        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "Unknown function: " + functionName }) }
                    });
                    realtimeAPIClient.responseCreate();
                    return;
                }

                args.function_id = function_id;
                var functionResponse = await Net.httpRequestAsync(FUNCTIONS_URL, {
                    headers: ["Content-Type: application/json"],
                    method: 'POST',
                    postData: JSON.stringify({
                        function_id: function_id,
                        arguments: args,
                        call_data: { call_id: call_id, chat_id: chat_id, assistant_id: ASSISTANT_ID, caller_number: caller_number }
                    })
                });

                if (functionResponse.code == 200) {
                    var result = JSON.parse(functionResponse.text);
                    lastFunctionResult = result;
                    realtimeAPIClient.conversationItemCreate({
                        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) }
                    });
                    realtimeAPIClient.responseCreate();
                    Logger.write("✅ Function executed: " + functionName);
                } else {
                    realtimeAPIClient.conversationItemCreate({
                        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: "Function execution failed" }) }
                    });
                    realtimeAPIClient.responseCreate();
                    Logger.write("❌ Function failed: HTTP " + functionResponse.code);
                }
            } catch (err) { Logger.write("❌ function handler: " + err); }
        }
    );

    realtimeAPIClient.addEventListener(
        OpenAI.RealtimeAPIEvents.Error,
        function(event) { Logger.write("[OpenAI] Error: " + JSON.stringify(event && event.data)); }
    );

    // =========================================================================
    // ОТВЕТ НА ЗВОНОК + ЗАПИСЬ + VoxTTS-плеер
    // =========================================================================
    callAnswered = true;
    call.answer();
    call.addEventListener(CallEvents.Disconnected, callEndHandler);
    call.addEventListener(CallEvents.Failed, callEndHandler);
    Logger.write("[Call] Answered");

    try {
        call.record({ stereo: false, lossless: false, hd_audio: true });
    } catch (recordError) { Logger.write("⚠️ Recording failed: " + recordError); }

    call.addEventListener(CallEvents.RecordStarted, function(event) {
        if (event.url) { record_url = event.url; Logger.write("🎙️ RecordStarted: " + record_url); }
    });
    call.addEventListener(CallEvents.RecordStopped, function(event) {
        if (event.url) record_url = event.url;
    });

    // Один долгоживущий VoxTTS-плеер (голос Anna) на весь звонок
    ttsPlayer = VoxTTS.createRealtimeTTSPlayer({
        createContextParameters: {
            create: { modelId: VoxTTS.ModelList.VoxTTS, voiceId: VOXTTS_VOICE }
        }
    });
    ttsPlayer.sendMediaTo(call);
    playerReady = true;
    Logger.write("[VoxTTS] Player ready (voice " + VOXTTS_VOICE + ")");

    // Аудио звонящего → OpenAI (STT + серверный VAD)
    call.sendMediaTo(realtimeAPIClient);
    Logger.write("[OpenAI] call → OpenAI audio connected");

    // Если сессия уже сконфигурировалась до готовности плеера — запускаем приветствие
    maybeStartGreeting();

    Logger.write("🎉 READY (Realtime+VoxTTS, model " + LLM_MODEL + ")");
});
