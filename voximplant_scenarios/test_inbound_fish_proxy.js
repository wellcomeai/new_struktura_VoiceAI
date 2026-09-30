/*
 * inbound_fish.js с LLM_TRANSPORT = "proxy": модель через наш сокет
 * /ws/fish/llm/{id} вместо коннектора Voximplant. Заглушки те же по духу,
 * что в test_inbound_fish.js; здесь проверяем протокол прокси и отмену.
 *
 *   node voximplant_scenarios/test_inbound_fish_proxy.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONFIG = {
    success: true, assistant_type: "fish", assistant_id: ID, assistant_name: "Тестовый Fish",
    api_key: "sk-test", model: "gpt-realtime-2.1", system_prompt: "Ты ассистент.",
    first_phrase: "Здравствуйте! Чем помочь?", language: "ru",
    fish_voice_id: "voice123", fish_model: "s2.1-pro", fish_latency: "balanced", sample_rate: 8000,
    fish_tts_url: "wss://voicyfy.ru/ws/fish/tts/" + ID,
    functions: [],
};

const appHandlers = {};
const logs = [];

function Emitter() {
    this._h = {};
    this.addEventListener = (ev, cb) => { (this._h[ev] = this._h[ev] || []).push(cb); };
    this.fire = (ev, payload) => (this._h[ev] || []).forEach((cb) => cb(payload));
}
class FakeSocket extends Emitter {
    constructor(url) { super(); this.url = url; this.sent = []; this.cleared = 0; this.closed = false; }
    send(data) { this.sent.push(JSON.parse(data)); }
    sendMediaTo(u) { this.mediaTo = u; }
    clearMediaBuffer() { this.cleared++; }
    close() { this.closed = true; }
}
class FakeCall extends Emitter {
    constructor() { super(); this.mediaTo = []; this.hungup = false; }
    id() { return "call-1"; }
    callerid() { return "+70000000000"; }
    answer() { this.answered = true; }
    record() {}
    sendMediaTo(u) { this.mediaTo.push(u); }
    hangup() { this.hungup = true; }
}

let tts = null;
const llmSockets = [];
let vad = null;
let asr = null;
let connectorUsed = false;

const sandbox = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Array, Object, RegExp, Error, Number,
    require: () => {},
    Modules: { ASR: "ASR", Silero: "Silero", OpenAI: "OpenAI" },
    Logger: { write: (m) => logs.push(String(m)) },
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
        createVAD: async () => { vad = new Emitter(); vad.close = () => {}; return vad; },
    },
    VoxEngine: {
        addEventListener: (ev, cb) => { appHandlers[ev] = cb; },
        createWebSocket: (url) => {
            const s = new FakeSocket(url);
            if (url.indexOf("/ws/fish/llm/") !== -1) llmSockets.push(s); else tts = s;
            return s;
        },
        createASR: () => { asr = new Emitter(); asr.stop = () => {}; return asr; },
        terminate: () => {},
    },
    Net: {
        httpRequestAsync: async (url) => (url.indexOf("/telephony/config") !== -1
            ? { code: 200, text: JSON.stringify(CONFIG) } : { code: 200, text: "{}" }),
    },
    OpenAI: {
        ChatCompletionsAPIEvents: { ContentDelta: "C.ContentDelta", ContentDone: "C.ContentDone",
                                    Chunk: "C.Chunk", ChatCompletionsAPIError: "C.Error" },
        createChatCompletionsAPIClient: async () => { connectorUsed = true; throw new Error("connector"); },
    },
};
sandbox.global = sandbox;
vm.createContext(sandbox);
const source = fs.readFileSync(path.join(__dirname, "inbound_fish.js"), "utf8");
if (!/var LLM_TRANSPORT\s*=\s*"proxy"/.test(source)) throw new Error("в сценарии LLM_TRANSPORT не \"proxy\"");
vm.runInContext(source, sandbox, { filename: "inbound_fish.js" });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
    if (!cond) {
        console.error("❌ " + msg);
        logs.forEach((l) => console.error("   " + l));
        process.exit(1);
    }
}

const llm = () => llmSockets[llmSockets.length - 1];
const requests = () => llmSockets.flatMap((s) => s.sent.filter((m) => m.event === "request"));
const lastReq = () => requests().slice(-1)[0];
const server = (msg) => llm().fire("WebSocket.Message", { text: JSON.stringify(msg) });
const chunk = (id, delta, finish) =>
    server({ event: "chunk", id, payload: { choices: [{ index: 0, delta, finish_reason: finish || null }] } });
function reply(id, text) {
    for (const part of text.match(/.{1,4}/g)) chunk(id, { content: part });
    chunk(id, {}, "stop");
    server({ event: "chunk", id, payload: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
    server({ event: "done", id });
}
async function userSays(text) {
    vad.fire("Silero.VAD.Result", { speechStartAt: 1 });
    asr.fire("ASR.InterimResult", { text });
    vad.fire("Silero.VAD.Result", { speechEndAt: 2 });
    await tick(250);
}
const ttsTexts = () => tts.sent.filter((m) => m.event === "text").map((m) => m.text);

(async () => {
    appHandlers.Started({ sessionId: "sess-1" });
    const call = new FakeCall();
    const done = appHandlers.CallAlerting({ call, destination: "74951234567" });
    await tick(10);

    // ── сокет к прокси модели: URL от fish_tts_url, звонок ждёт его OPEN ───
    assert(llmSockets.length === 1, "сокет к прокси модели не создан");
    assert(llm().url === "wss://voicyfy.ru/ws/fish/llm/" + ID, "неверный URL прокси модели: " + llm().url);
    assert(!call.answered, "звонок отвечен до открытия сокета модели");
    llm().fire("WebSocket.Open");
    await done;
    assert(call.answered && !connectorUsed, "звонок не отвечен или использован коннектор Voximplant");
    tts.fire("WebSocket.Open");
    await tick();
    tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    assert(requests().length === 0, "при first_phrase ушёл запрос (прогрева больше нет)");
    console.log("✅ подключение: /ws/fish/llm/{id}, звонок ждёт сокет модели, прогрева нет");

    // ── ход: request с телом Chat Completions, ключа в нём нет ─────────────
    await userSays("какие у вас бани");
    let req = lastReq();
    assert(req && req.id === 1, "запрос не ушёл в прокси: " + JSON.stringify(llm().sent));
    assert(req.payload.model === "gpt-6-luna" && req.payload.service_tier === "priority", "тело запроса неверно");
    assert(req.payload.messages[0].role === "system" && req.payload.messages.slice(-1)[0].content === "какие у вас бани",
           "история не ушла в запрос");
    assert(JSON.stringify(req).indexOf("sk-test") === -1, "ключ OpenAI ушёл в прокси");

    tts.sent = [];
    reply(1, "Здравствуйте, слушаю. У нас есть сауна, баня и хамам.");
    await tick();
    const flushAt = tts.sent.findIndex((m) => m.event === "flush");
    const beforeFlush = tts.sent.slice(0, flushAt).filter((m) => m.event === "text").map((m) => m.text).join("");
    assert(beforeFlush === "Здравствуйте, слушаю.", "первый flush не на коротком предложении: «" + beforeFlush + "»");
    assert(ttsTexts().join("") === "Здравствуйте, слушаю. У нас есть сауна, баня и хамам.", "текст склеился неверно");
    tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ ход: request → чанки → Fish, первый flush на «Здравствуйте, слушаю.»");

    // ── перебивание: ответ обрывается cancel, поздние чанки не звучат ─────
    await userSays("а цены");
    assert(lastReq().id === 2, "второй ход не ушёл");
    chunk(2, { content: "Цены такие: сауна от тысячи рублей, " });
    await tick();
    vad.fire("Silero.VAD.Result", { speechStartAt: 3 });
    await tick(400);                                     // > BARGE_IN_MIN_MS
    assert(llm().sent.some((m) => m.event === "cancel" && m.id === 2), "перебивание не отменило ответ в прокси");
    tts.sent = [];
    chunk(2, { content: "баня от двух тысяч." });
    chunk(2, {}, "stop");
    await tick();
    assert(ttsTexts().length === 0, "остаток оборванного ответа ушёл в синтез");
    asr.fire("ASR.InterimResult", { text: "а для детей" });
    vad.fire("Silero.VAD.Result", { speechEndAt: 4 });
    await tick(250);
    assert(lastReq().id === 3, "реплика после перебивания не ушла сразу");
    reply(3, "Для детей скидка.");
    await tick();
    tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ перебивание: cancel в прокси, остаток ответа не звучит, новый ход сразу");

    // ── продолжение фразы до звука: старый запрос отменён, новый — сразу ──
    await userSays("запишите меня");
    assert(lastReq().id === 4, "реплика не ушла");
    vad.fire("Silero.VAD.Result", { speechStartAt: 5 });
    asr.fire("ASR.InterimResult", { text: "на завтра" });
    vad.fire("Silero.VAD.Result", { speechEndAt: 6 });
    await tick(250);
    assert(llm().sent.some((m) => m.event === "cancel" && m.id === 4), "склейка не отменила прошлый запрос");
    req = lastReq();
    assert(req.id === 5 && req.payload.messages.slice(-1)[0].content === "запишите меня на завтра",
           "склеенная реплика не ушла сразу: " + JSON.stringify(req.payload.messages.slice(-1)));
    reply(5, "Записала.");
    await tick();
    tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ склейка: прошлый запрос отменён, склеенная реплика ушла без ожидания");

    // ── ошибка OpenAI через прокси: reasoning убираем, ход повторяем ───────
    await userSays("спасибо");
    server({ event: "error", id: 6, message: "HTTP 400: Unsupported value: 'reasoning_effort'" });
    await tick(400);
    req = lastReq();
    assert(req.id === 7 && !req.payload.reasoning_effort, "после ошибки reasoning ход не повторён без него");
    reply(7, "Пожалуйста.");
    await tick();
    tts.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ ошибка: текст OpenAI из прокси, повтор без reasoning_effort");

    // ── обрыв сокета прокси: переподключение и повтор хода ────────────────
    await userSays("ещё вопрос");
    const dead = llm();
    dead.fire("WebSocket.Close", { code: 1006, reason: "gone" });
    await tick(10);
    assert(llmSockets.length === 2, "после обрыва сокет к прокси не переоткрыт");
    llm().fire("WebSocket.Open");
    await tick(400);
    req = llm().sent.filter((m) => m.event === "request").pop();
    assert(req && req.payload.messages.slice(-1)[0].content === "ещё вопрос", "после переподключения ход не повторён");
    console.log("✅ обрыв: новый сокет к прокси, тот же ход повторён");

    if (process.env.DUMP_LOG) logs.forEach((l) => console.log("   " + l));
    console.log("\nвсе проверки inbound_fish (прокси модели) пройдены");
    process.exit(0);   // таймеры сценария (стоп-таймер ответа и т.п.) не ждём
})();
