/*
 * Прогон outbound_fish.js (v2.0, каскад ASR → прокси модели → Fish) на
 * заглушках VoxEngine. Общую с входящим логику (склейка, retract, ошибки
 * модели, переподключение) проверяют test_inbound_fish*.js — здесь то, что
 * есть только в исходящем: сокеты и прогрев до набора номера, контекст
 * звонка из customData, мьют, неперебиваемое приветствие, hangup_call.
 *
 *   node voximplant_scenarios/test_outbound_fish.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONFIG = {
    success: true, assistant_type: "fish", assistant_id: ID, assistant_name: "Тестовый Fish",
    api_key: "sk-test", model: "gpt-realtime-2.1", system_prompt: "Ты ассистент.",
    first_phrase: "Здравствуйте, это Войсифай.", language: "ru",
    fish_voice_id: "voice123", fish_model: "s2.1-pro", fish_latency: "balanced", sample_rate: 8000,
    fish_tts_url: "wss://voicyfy.ru/ws/fish/tts/" + ID,
    functions: [{ type: "function", function: { name: "hangup_call", description: "Положить трубку",
        parameters: { type: "object", properties: { farewell_message: { type: "string" } } } } }],
};
const GREETING = "Иван, добрый день! Это Светлана из спа-центра.";

function makeSandbox(customData, opts) {
    const st = { appHandlers: {}, logs: [], tts: null, llmSockets: [], vad: null, asr: null,
                 call: null, dialed: null, terminated: false, httpPosts: [] };
    function Emitter() {
        this._h = {};
        this.addEventListener = (ev, cb) => { (this._h[ev] = this._h[ev] || []).push(cb); };
        this.fire = (ev, payload) => (this._h[ev] || []).forEach((cb) => cb(payload));
    }
    class FakeSocket extends Emitter {
        constructor(url) { super(); this.url = url; this.sent = []; this.cleared = 0; this.mediaTo = null; }
        send(data) { this.sent.push(JSON.parse(data)); }
        sendMediaTo(u) { this.mediaTo = u; }
        clearMediaBuffer() { this.cleared++; }
        close() { this.closed = true; }
    }
    class FakeCall extends Emitter {
        constructor() { super(); this.mediaTo = []; this.hungup = false; this.recording = false; }
        id() { return "call-out-1"; }
        record() { this.recording = true; }
        sendMediaTo(u) { this.mediaTo.push(u); }
        hangup() { this.hungup = true; }
    }
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Array, Object, RegExp, Error, Number,
        require: () => {},
        Modules: { ASR: "ASR", Silero: "Silero", OpenAI: "OpenAI" },
        Logger: { write: (m) => st.logs.push(String(m)) },
        AppEvents: { Started: "Started", CallAlerting: "CallAlerting" },
        CallEvents: { Connected: "Connected", Disconnected: "Disconnected", Failed: "Failed",
                      RecordStarted: "RecordStarted", RecordStopped: "RecordStopped" },
        WebSocketEvents: { OPEN: "WebSocket.Open", MESSAGE: "WebSocket.Message", CLOSE: "WebSocket.Close",
                           ERROR: "WebSocket.Error", MEDIA_STARTED: "WebSocket.MediaStarted",
                           MEDIA_ENDED: "WebSocket.MediaEnded" },
        ASREvents: { InterimResult: "ASR.InterimResult", Result: "ASR.Result", Stopped: "ASR.Stopped", ASRError: "ASR.Error" },
        ASRProfileList: { Yandex: { ru_RU: "yandex-ru" }, Deepgram: { ru: "deepgram-ru" } },
        ASRModelList: { Yandex: { general: "yandex-general" }, Deepgram: { nova2_general: "nova2-general" } },
        Silero: {
            VADEvents: { Result: "Silero.VAD.Result", Error: "Silero.VAD.Error" },
            createVAD: async () => { st.vad = new Emitter(); st.vad.close = () => {}; return st.vad; },
        },
        VoxEngine: {
            addEventListener: (ev, cb) => { st.appHandlers[ev] = cb; },
            createWebSocket: (url) => {
                const s = new FakeSocket(url);
                if (url.indexOf("/ws/fish/llm/") !== -1) st.llmSockets.push(s); else st.tts = s;
                return s;
            },
            createASR: () => { st.asr = new Emitter(); st.asr.stop = () => {}; return st.asr; },
            customData: () => customData,
            callPSTN: (num, cid) => { st.dialed = { num, cid }; st.call = new FakeCall(); return st.call; },
            terminate: () => { st.terminated = true; },
        },
        Net: {
            httpRequestAsync: async (url, o) => {
                if (url.indexOf("/telephony/outbound-config") !== -1) return { code: 200, text: JSON.stringify(CONFIG) };
                if (o && o.postData) st.httpPosts.push({ url, body: JSON.parse(o.postData) });
                return { code: 200, text: "{}" };
            },
        },
        OpenAI: {
            ChatCompletionsAPIEvents: { ContentDelta: "C.ContentDelta", ContentDone: "C.ContentDone",
                                        Chunk: "C.Chunk", ChatCompletionsAPIError: "C.Error" },
            createChatCompletionsAPIClient: async () => { throw new Error("connector"); },
        },
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, "outbound_fish.js"), "utf8");
    if (!/var LLM_TRANSPORT\s*=\s*"proxy"/.test(source)) throw new Error("в сценарии LLM_TRANSPORT не \"proxy\"");
    vm.runInContext(source, sandbox, { filename: "outbound_fish.js" });
    return st;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let st;
function assert(cond, msg) {
    if (!cond) {
        console.error("❌ " + msg);
        st.logs.forEach((l) => console.error("   " + l));
        process.exit(1);
    }
}

const llm = () => st.llmSockets[st.llmSockets.length - 1];
const requests = () => st.llmSockets.flatMap((s) => s.sent.filter((m) => m.event === "request"));
const lastReq = () => requests().slice(-1)[0];
const server = (msg) => llm().fire("WebSocket.Message", { text: JSON.stringify(msg) });
const chunk = (id, delta, finish) =>
    server({ event: "chunk", id, payload: { choices: [{ index: 0, delta, finish_reason: finish || null }] } });
function reply(id, text) {
    for (const part of text.match(/.{1,4}/g)) chunk(id, { content: part });
    chunk(id, {}, "stop");
    server({ event: "done", id, openai_first_ms: 250, total_ms: 400 });
}
const ttsTexts = () => st.tts.sent.filter((m) => m.event === "text").map((m) => m.text);
const speechDone = (ms) => st.tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: ms || 0 }) });

async function mainFlow() {
    st = makeSandbox(JSON.stringify({
        phone_number: "+79990000000", assistant_id: ID, caller_id: "+74951234567",
        mute_duration_ms: 100, contact_name: "Иван", task_title: "Напомнить о записи",
        custom_greeting: GREETING,
    }));
    const done = st.appHandlers.Started({ sessionId: "sess-out" });
    await tick(10);

    // ── до набора: оба сокета, набор ждёт открытия сокета модели ──────────
    assert(st.tts && st.tts.url === CONFIG.fish_tts_url, "сокет синтеза не открыт до набора");
    assert(st.llmSockets.length === 1 && llm().url === "wss://voicyfy.ru/ws/fish/llm/" + ID,
           "сокет прокси модели не создан или URL неверен");
    assert(!st.dialed, "номер набран до открытия сокета модели");
    llm().fire("WebSocket.Open");
    await done;
    assert(st.dialed && st.dialed.num === "+79990000000" && st.dialed.cid === "+74951234567",
           "неверные параметры набора: " + JSON.stringify(st.dialed));

    // ── прогрев во время гудков: тот же префикс, что у первого хода ───────
    assert(requests().length === 1, "прогрев не ушёл до ответа абонента");
    const warm = requests()[0];
    const sys = warm.payload.messages[0];
    assert(sys.role === "system" && sys.content.indexOf("Клиент: Иван") !== -1 &&
           sys.content.indexOf("Напомнить о записи") !== -1, "контекст CRM не попал в system-промпт");
    assert(sys.content.indexOf("«" + GREETING + "»") !== -1, "custom_greeting не упомянут в промпте");
    assert(sys.content.indexOf("+79990000000") !== -1, "номер клиента не в промпте");
    assert(warm.payload.messages[1].role === "assistant" && warm.payload.messages[1].content === GREETING &&
           warm.payload.messages[2].content === "Алло" && warm.payload.max_completion_tokens <= 16,
           "прогрев не совпадает с первым ходом: " + JSON.stringify(warm.payload.messages.slice(1)));
    assert(warm.payload.model === "deepseek/deepseek-v4.1-flash", "модель не та: " + warm.payload.model);
    const hang = warm.payload.tools.find((t) => t.function.name === "hangup_call");
    assert(hang && hang.function.description.indexOf("НЕМЕДЛЕННО") !== -1, "hangup_call без усиленного описания");
    reply(1, "Да, слушаю.");
    await tick();
    assert(st.logs.some((l) => l.indexOf("прогрев готов") !== -1), "прогрев не закрылся");
    console.log("✅ до набора: сокеты открыты, прогрев с контекстом CRM во время гудков");

    // ── абонент снял трубку ───────────────────────────────────────────────
    st.tts.fire("WebSocket.Open");
    await tick();
    assert(st.tts.mediaTo === null, "sendMediaTo до ответа абонента");
    st.call.fire("Connected");
    await tick();
    assert(st.tts.mediaTo === st.call && st.call.recording, "синтез не привязан к звонку или нет записи");
    assert(ttsTexts()[0] === GREETING && st.tts.sent[1].event === "flush", "приветствие не ушло в синтез");
    assert(st.call.mediaTo.length === 0, "аудио абонента в ASR/VAD без мьюта");
    await tick(160);
    assert(st.call.mediaTo.indexOf(st.asr) !== -1 && st.call.mediaTo.indexOf(st.vad) !== -1,
           "после мьюта аудио не подключено к ASR/VAD");
    assert(requests().length === 1, "лишний запрос к модели на ответе абонента");
    console.log("✅ Connected: custom_greeting в синтез, ASR/VAD подключены после мьюта");

    // ── речь поверх приветствия не перебивает его ─────────────────────────
    st.tts.sent = [];
    st.vad.fire("Silero.VAD.Result", { speechStartAt: 1 });
    st.asr.fire("ASR.InterimResult", { text: "да слушаю" });
    await tick(400);                                      // > BARGE_IN_MIN_MS
    st.vad.fire("Silero.VAD.Result", { speechEndAt: 2 });
    await tick(250);
    assert(st.tts.cleared === 0 && !st.tts.sent.some((m) => m.event === "clear"), "приветствие перебито");
    let req = lastReq();
    assert(req.id === 2 && req.payload.messages.slice(-1)[0].content === "да слушаю", "реплика не ушла модели");
    reply(2, "Иван, напоминаю: вы записаны на завтра.");
    await tick();
    assert(ttsTexts().join("") === "Иван, напоминаю: вы записаны на завтра.", "ответ не встал в синтез за приветствием");
    speechDone(0);                                        // приветствие договорено
    await tick(10);
    assert(st.logs.some((l) => l.indexOf("Приветствие отзвучало") !== -1), "приветствие не завершилось по speech_done");
    speechDone(0);
    console.log("✅ приветствие: не перебивается, ответ ставится в очередь синтеза");

    // ── после приветствия перебивание работает ────────────────────────────
    st.vad.fire("Silero.VAD.Result", { speechStartAt: 3 });
    st.asr.fire("ASR.InterimResult", { text: "а во сколько" });
    st.vad.fire("Silero.VAD.Result", { speechEndAt: 4 });
    await tick(250);
    assert(lastReq().id === 3, "ход не ушёл");
    chunk(3, { content: "В десять утра, " });
    chunk(3, { content: "вас ждём в холле." });
    await tick();
    st.vad.fire("Silero.VAD.Result", { speechStartAt: 5 });
    await tick(400);
    assert(llm().sent.some((m) => m.event === "cancel" && m.id === 3) && st.tts.cleared === 1,
           "перебивание после приветствия не сработало");
    st.asr.fire("ASR.InterimResult", { text: "всё понял спасибо до свидания" });
    st.vad.fire("Silero.VAD.Result", { speechEndAt: 6 });
    await tick(250);
    console.log("✅ после приветствия перебивание обрывает ответ (cancel + clear)");

    // ── hangup_call с прощанием: трубка после speech_done ─────────────────
    req = lastReq();
    assert(req.id === 4, "реплика после перебивания не ушла");
    chunk(4, { tool_calls: [{ index: 0, id: "c1", function: { name: "hangup_call",
        arguments: JSON.stringify({ farewell_message: "Всего доброго!" }) } }] });
    chunk(4, {}, "tool_calls");
    await tick();
    assert(ttsTexts().slice(-1)[0] === "Всего доброго!", "прощание не ушло в синтез");
    assert(!st.call.hungup, "трубка положена до конца прощания");
    speechDone(0);
    await tick(300);
    assert(st.call.hungup, "трубка не положена после прощания");
    st.call.fire("Disconnected", { cost: 1.2, duration: 30 });
    await tick(600);
    const log = st.httpPosts.find((p) => p.url.indexOf("/voximplant/log") !== -1);
    assert(log && log.body.caller_number === "OUTBOUND: +79990000000" && log.body.call_duration === 30 &&
           log.body.data.dialog[0].text === GREETING, "финальный лог неверен: " + JSON.stringify(log && log.body));
    assert(st.terminated, "сессия не завершена");
    console.log("✅ hangup_call: прощание, трубка после speech_done, финальный лог OUTBOUND");
}

async function failFlow() {
    // Прокси модели не открылся — номер не набираем.
    st = makeSandbox(JSON.stringify({ phone_number: "+79990000000", assistant_id: ID }));
    const done = st.appHandlers.Started({ sessionId: "sess-out-2" });
    await tick(10);
    llm().fire("WebSocket.Close", { code: 1006, reason: "refused" });
    await done;
    assert(!st.dialed && st.terminated, "при недоступной модели номер набран");
    console.log("✅ модель недоступна: звонок не совершается");
}

(async () => {
    await mainFlow();
    await failFlow();
    if (process.env.DUMP_LOG) st.logs.forEach((l) => console.log("   " + l));
    console.log("\nвсе проверки outbound_fish пройдены");
    process.exit(0);
})();
