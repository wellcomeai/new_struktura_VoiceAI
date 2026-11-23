/*
 * ТЕСТ: Yandex Speech Realtime Max TTS Live в Voximplant (без бэкенда Voicyfy)
 * ====================================================================
 * Проверяем одно: открывает ли модуль Voximplant Yandex новую модель
 * speech-realtime-max-tts-live и как она говорит в звонке.
 * Конфиг не грузится, функции на наш сервер не ходят, лог не шлётся.
 *
 * КАК ЗАПУСТИТЬ
 *   1. Вписать YANDEX_API_KEY и YANDEX_FOLDER_ID ниже (только в кабинете
 *      Voximplant, в репозиторий ключ не коммитить).
 *   2. Сценарий + правило на номер/SIP, позвонить.
 *
 * ЧТО СМОТРЕТЬ В ЛОГЕ
 *   • "🧪 TRY model: ..." → "✅ SessionCreated" — какой формат имени модели
 *     принят. Пробуются по очереди варианты из MODEL_VARIANTS.
 *   • "❌ Yandex Error" после sessionUpdate — не принят голос/амплуа/поле.
 *   • "⏱️ ответ через N мс" — от конца реплики абонента до звука модели.
 *   • 👤 / 🤖 — распознанные реплики; перебивания; вызов hangup_call
 *     («пока» / «до свидания» → модель прощается и кладёт трубку).
 * ====================================================================
 */

require(Modules.Yandex);

// ─────────────── НАСТРОЙКИ ТЕСТА ───────────────
const YANDEX_API_KEY = "<API_key_value>";
const YANDEX_FOLDER_ID = "<folder_id>";

// Пробуются по порядку, пока одна не даст SessionCreated
const MODEL_VARIANTS = [
    "speech-realtime-max-tts-live/latest",
    "speech-realtime-max-tts-live",
    "gpt://" + YANDEX_FOLDER_ID + "/speech-realtime-max-tts-live/latest"
];

// Голоса LiveTTS: sofia, vera (support|casual), vasily, sergey (support|sales),
// denis (neutral|casual|formal|sales), irina (neutral|formal|support|narrator|sales).
// Обычные голоса (marina, dasha, ...) с LiveTTS несовместимы.
const VOICE = "sofia";
const VOICE_ROLE = "";          // "" — амплуа голоса по умолчанию

const SESSION_TIMEOUT_MS = 4000;    // ожидание SessionCreated на вариант
const MAX_CALL_MS = 5 * 60 * 1000;  // страховка: тестовый звонок не дольше 5 мин

const INSTRUCTIONS =
    "Ты — вежливый голосовой ассистент компании Voicyfy. Говоришь по-русски, " +
    "коротко и естественно, как человек по телефону. Это тестовый звонок: " +
    "поддерживай разговор, отвечай на вопросы. Когда собеседник прощается " +
    "(пока, до свидания, всё, спасибо) — вызови функцию hangup_call.";

const GREETING = "Здравствуйте! Это тестовый звонок Voicyfy. Чем могу помочь?";

const TOOLS = [{
    type: "function",
    name: "hangup_call",
    description: "Завершить звонок. Вызывай, когда собеседник прощается или хочет закончить разговор.",
    parameters: {
        type: "object",
        properties: {
            farewell_message: { type: "string", description: "Короткая прощальная фраза" }
        },
        required: []
    }
}];

// ─────────────── СЦЕНАРИЙ ───────────────
function log(msg) { Logger.write(msg); }

VoxEngine.addEventListener(AppEvents.CallAlerting, async function(e) {
    const call = e.call;
    let client = null;
    let modelUsed = null;
    let terminating = false;
    let hangupRequested = false;
    let speechStoppedAt = 0;
    const startedAt = Date.now();

    log("📞 TEST Yandex TTS Live | from " + e.callerid + " → " + e.destination);

    function finish(reason) {
        if (terminating) return;
        terminating = true;
        log("🏁 FINISH: " + reason + " | model: " + (modelUsed || "none") +
            " | " + Math.round((Date.now() - startedAt) / 1000) + " с");
        try { if (client) client.close(); } catch (err) {}
        try { call.hangup(); } catch (err) {}
        setTimeout(function() { VoxEngine.terminate(); }, 500);
    }

    call.addEventListener(CallEvents.Disconnected, function() { finish("абонент положил трубку"); });
    call.addEventListener(CallEvents.Failed, function() { finish("call failed"); });
    setTimeout(function() { finish("лимит длительности теста"); }, MAX_CALL_MS);

    if (YANDEX_API_KEY.indexOf("<") === 0 || YANDEX_FOLDER_ID.indexOf("<") === 0) {
        log("❌ Не заполнены YANDEX_API_KEY / YANDEX_FOLDER_ID");
        call.answer();
        call.addEventListener(CallEvents.Connected, function() {
            call.say("Не заполнены ключ и каталог Яндекса в сценарии.", { language: Language.RU_RUSSIAN_FEMALE });
            call.addEventListener(CallEvents.PlaybackFinished, function() { finish("нет ключей"); });
        });
        return;
    }

    call.ring();

    // ── Подключение: перебор форматов имени модели ──
    function tryModel(model) {
        return new Promise(async function(resolve) {
            let done = false;
            let c = null;
            const timer = setTimeout(function() {
                if (done) return;
                done = true;
                log("   ⚠️ нет SessionCreated за " + SESSION_TIMEOUT_MS + " мс");
                try { if (c) c.close(); } catch (err) {}
                resolve(null);
            }, SESSION_TIMEOUT_MS);

            try {
                log("🧪 TRY model: " + model);
                c = await Yandex.createRealtimeAPIClient({
                    apiKey: YANDEX_API_KEY,
                    folderId: YANDEX_FOLDER_ID,
                    model: model,
                    onWebSocketClose: function(ev) {
                        log("🔌 WebSocket closed" + (ev && ev.code ? " code " + ev.code : "") +
                            (ev && ev.reason ? " reason " + ev.reason : ""));
                        if (!done) {
                            done = true;
                            clearTimeout(timer);
                            resolve(null);
                        } else if (modelUsed === model) {
                            finish("Яндекс закрыл соединение");
                        }
                    }
                });
                c.addEventListener(Yandex.RealtimeAPIEvents.Error, function(ev) {
                    log("❌ Yandex Error: " + JSON.stringify(ev.data));
                });
                c.addEventListener(Yandex.RealtimeAPIEvents.SessionCreated, function(ev) {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    const s = ev.data && ev.data.payload ? ev.data.payload.session : null;
                    log("✅ SessionCreated | model name: " + model +
                        (s && s.model ? " | session.model: " + s.model : ""));
                    resolve(c);
                });
            } catch (err) {
                log("   ❌ createRealtimeAPIClient: " + err);
                if (!done) { done = true; clearTimeout(timer); resolve(null); }
            }
        });
    }

    for (let i = 0; i < MODEL_VARIANTS.length && !client && !terminating; i++) {
        client = await tryModel(MODEL_VARIANTS[i]);
        if (client) modelUsed = MODEL_VARIANTS[i];
    }

    if (!client) {
        log("❌ Ни один вариант имени модели не подключился");
        call.answer();
        call.addEventListener(CallEvents.Connected, function() {
            call.say("Модель Яндекса не подключилась. Смотрите лог сценария.", { language: Language.RU_RUSSIAN_FEMALE });
            call.addEventListener(CallEvents.PlaybackFinished, function() { finish("модель не подключилась"); });
        });
        return;
    }

    // ── События модели ──
    client.addEventListener(Yandex.RealtimeAPIEvents.SessionUpdated, function(ev) {
        const s = ev.data && ev.data.payload ? ev.data.payload.session : null;
        const out = s && s.audio && s.audio.output ? s.audio.output : {};
        log("🔄 SessionUpdated | voice: " + (out.voice || "?") + (out.role ? " (" + out.role + ")" : "") +
            " | tools: " + (s && s.tools ? s.tools.length : 0) + (s && s.model ? " | model: " + s.model : ""));
    });

    client.addEventListener(Yandex.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function(ev) {
        const t = ev.data && ev.data.payload ? ev.data.payload.transcript : "";
        if (t) log("👤 USER: " + t);
    });

    client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputAudioTranscriptDone, function(ev) {
        const t = ev.data && ev.data.payload ? ev.data.payload.transcript : "";
        if (t) log("🤖 BOT: " + t);
    });

    client.addEventListener(Yandex.RealtimeAPIEvents.InputAudioBufferSpeechStarted, function() {
        log("🗣️ абонент заговорил (перебивание → чистим буфер)");
        try { client.clearMediaBuffer(); } catch (err) {}
    });

    if (Yandex.RealtimeAPIEvents.InputAudioBufferSpeechStopped) {
        client.addEventListener(Yandex.RealtimeAPIEvents.InputAudioBufferSpeechStopped, function() {
            speechStoppedAt = Date.now();
        });
    }

    client.addEventListener(Yandex.Events.WebSocketMediaStarted, function() {
        if (speechStoppedAt) {
            log("⏱️ ответ через " + (Date.now() - speechStoppedAt) + " мс после конца реплики");
            speechStoppedAt = 0;
        } else {
            log("🎵 модель говорит");
        }
    });

    client.addEventListener(Yandex.Events.WebSocketMediaEnded, function() {
        if (hangupRequested) {
            log("👋 прощание доиграло");
            setTimeout(function() { finish("hangup_call"); }, 500);
        }
    });

    client.addEventListener(Yandex.RealtimeAPIEvents.ResponseOutputItemDone, function(ev) {
        const item = ev.data && ev.data.payload ? ev.data.payload.item : null;
        if (!item || item.type !== "function_call") return;
        log("🔧 FUNCTION: " + item.name + " " + (item.arguments || ""));
        let args = {};
        try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch (err) {}

        client.conversationItemCreate({
            item: { type: "function_call_output", call_id: item.call_id, output: "ok" }
        });
        if (item.name === "hangup_call") {
            hangupRequested = true;
            client.responseCreate({
                instructions: args.farewell_message
                    ? "Скажи дословно и больше ничего: " + args.farewell_message
                    : "Коротко попрощайся."
            });
            setTimeout(function() { finish("hangup_call (страховка)"); }, 8000);
        } else {
            client.responseCreate({});
        }
    });

    if (Yandex.RealtimeAPIEvents.Unknown) {
        client.addEventListener(Yandex.RealtimeAPIEvents.Unknown, function(ev) {
            log("❔ Unknown event: " + JSON.stringify(ev.data || ev).substring(0, 300));
        });
    }

    // ── Сессия ──
    const output = { voice: VOICE };
    if (VOICE_ROLE) output.role = VOICE_ROLE;
    const sessionUpdate = {
        session: {
            type: "realtime",
            instructions: INSTRUCTIONS,
            output_modalities: ["audio"],
            audio: {
                input: {
                    languages: ["ru-RU"],
                    turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 500 }
                },
                output: output
            },
            tools: TOOLS
        }
    };
    log("📤 sessionUpdate | voice: " + VOICE + (VOICE_ROLE ? " (" + VOICE_ROLE + ")" : ""));
    client.sessionUpdate(sessionUpdate);

    // ── Ответ на звонок и приветствие ──
    call.addEventListener(CallEvents.Connected, function() {
        log("✅ CALL CONNECTED");
        VoxEngine.sendMediaBetween(call, client);
        client.responseCreate({
            instructions: "Поздоровайся с собеседником этой фразой, дословно: " + GREETING
        });
    });
    call.answer();
});
