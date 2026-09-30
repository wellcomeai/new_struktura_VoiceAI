/*
 * Прогон inbound_fish.js (v2.0, каскад ASR → LLM → Fish) на заглушках VoxEngine.
 * Проверяем реальный код сценария, а не его копию: подменяем платформенные
 * глобалы, прокручиваем звонок и смотрим, что ушло в модель и в сокет синтеза.
 *
 *   node voximplant_scenarios/test_inbound_fish.js
 */
const fs = require("fs");
const vm = require("vm");

const SCENARIO = require("path").join(__dirname, "inbound_fish.js");

const CONFIG = {
    success: true,
    assistant_type: "fish",
    assistant_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    assistant_name: "Тестовый Fish",
    api_key: "sk-test",
    model: "gpt-realtime-2.1",
    system_prompt: "Ты ассистент.",
    first_phrase: "Здравствуйте! Чем помочь?",
    language: "ru",
    fish_voice_id: "voice123",
    fish_model: "s2.1-pro",
    fish_latency: "balanced",
    sample_rate: 8000,
    fish_tts_url: "wss://voicyfy.ru/ws/fish/tts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    functions: [
        { type: "function", function: { name: "get_price", description: "Цена",
          parameters: { type: "object", properties: {} } } },
    ],
};

// ── заглушки платформы ──────────────────────────────────────────────────────
const appHandlers = {};
const logs = [];
const httpCalls = [];

function Emitter() {
    this._h = {};
    this.addEventListener = (ev, cb) => { (this._h[ev] = this._h[ev] || []).push(cb); };
    this.fire = (ev, payload) => (this._h[ev] || []).forEach((cb) => cb(payload));
}

class FakeSocket extends Emitter {
    constructor(url) {
        super();
        this.url = url;
        this.sent = [];
        this.mediaTo = null;
        this.cleared = 0;
        this.closed = false;
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    sendMediaTo(unit) { this.mediaTo = unit; }
    clearMediaBuffer() { this.cleared++; }
    close() { this.closed = true; }
}

class FakeCall extends Emitter {
    constructor() {
        super();
        this.answered = false;
        this.recording = false;
        this.hungup = false;
        this.mediaTo = [];
    }
    id() { return "call-1"; }
    callerid() { return "+70000000000"; }
    answer() { this.answered = true; }
    record() { this.recording = true; }
    sendMediaTo(u) { this.mediaTo.push(u); }
    hangup() { this.hungup = true; }
}

let createdSocket = null;
let llm = null;
const llmClients = [];
let vad = null;
let vadParams = null;
let asr = null;
let asrParams = null;

const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Array, Object, RegExp, Error, Number,
    require: () => {},
    Modules: { ASR: "ASR", Silero: "Silero", OpenAI: "OpenAI" },
    Logger: { write: (m) => logs.push(String(m)) },
    AppEvents: { Started: "Started", CallAlerting: "CallAlerting" },
    CallEvents: {
        Connected: "Connected", Disconnected: "Disconnected", Failed: "Failed",
        RecordStarted: "RecordStarted", RecordStopped: "RecordStopped",
    },
    WebSocketEvents: {
        OPEN: "WebSocket.Open", MESSAGE: "WebSocket.Message",
        CLOSE: "WebSocket.Close", ERROR: "WebSocket.Error",
        MEDIA_STARTED: "WebSocket.MediaStarted", MEDIA_ENDED: "WebSocket.MediaEnded",
    },
    ASREvents: {
        InterimResult: "ASR.InterimResult", Result: "ASR.Result",
        Stopped: "ASR.Stopped", ASRError: "ASR.Error",
    },
    ASRProfileList: {
        Yandex: { ru_RU: "yandex-ru", en_US: "yandex-en" },
        Deepgram: { ru: "deepgram-ru", en_US: "deepgram-en" },
    },
    ASRModelList: {
        Yandex: { general: "yandex-general" },
        Deepgram: { nova2_general: "nova2-general" },
    },
    Silero: {
        VADEvents: { Result: "Silero.VAD.Result", Error: "Silero.VAD.Error" },
        createVAD: async (params) => {
            vadParams = params;
            vad = new Emitter();
            vad.close = () => {};
            return vad;
        },
    },
    VoxEngine: {
        addEventListener: (ev, cb) => { appHandlers[ev] = cb; },
        createWebSocket: (url) => { createdSocket = new FakeSocket(url); return createdSocket; },
        createASR: (params) => {
            asrParams = params;
            asr = new Emitter();
            asr.stop = () => {};
            return asr;
        },
        terminate: () => { sandbox.__terminated = true; },
    },
    Net: {
        httpRequestAsync: async (url, opts) => {
            httpCalls.push({ url, opts });
            if (url.indexOf("/telephony/config") !== -1) {
                return { code: 200, text: JSON.stringify(CONFIG) };
            }
            if (url.indexOf("/functions/execute") !== -1) {
                return { code: 200, text: JSON.stringify({ price: 1000 }) };
            }
            return { code: 200, text: "{}" };
        },
    },
    OpenAI: {
        ChatCompletionsAPIEvents: {
            ContentDelta: "C.ContentDelta", ContentDone: "C.ContentDone",
            Chunk: "C.Chunk", ChatCompletionsAPIError: "C.Error",
        },
        createChatCompletionsAPIClient: async (params) => {
            const client = new Emitter();
            client.params = params;
            client.requests = llm ? llm.requests : [];   // общий журнал запросов между переподключениями
            client.createChatCompletions = (p) => client.requests.push(JSON.parse(JSON.stringify(p)));
            client.close = () => {};
            llmClients.push(client);
            llm = client;
            return client;
        },
    },
};
sandbox.global = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SCENARIO, "utf8"), sandbox, { filename: "inbound_fish.js" });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
    if (!cond) {
        console.error("❌ " + msg);
        console.error("--- лог сценария ---");
        logs.forEach((l) => console.error("   " + l));
        process.exit(1);
    }
}

// ── помощники: абонент и модель ─────────────────────────────────────────────
const speechStart = () => vad.fire("Silero.VAD.Result", { vad, speechStartAt: 1.0 });
const speechEnd = () => vad.fire("Silero.VAD.Result", { vad, speechEndAt: 2.0 });
const interim = (text) => asr.fire("ASR.InterimResult", { text });
const final = (text) => asr.fire("ASR.Result", { text });

async function userSays(text, { finalToo = false } = {}) {
    speechStart();
    interim(text);
    if (finalToo) final(text);
    speechEnd();
    await tick(250);   // SUBMIT_SETTLE_MS + запас
}

const chunk = (payload) => llm.fire("C.Chunk", { data: { payload } });

function modelReplies(text) {
    for (const ch of text.match(/.{1,5}/g)) {
        llm.fire("C.ContentDelta", { data: { payload: { delta: ch } } });
        chunk({ choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
    }
    llm.fire("C.ContentDone", { data: { payload: { content: text } } });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10,
                                  prompt_tokens_details: { cached_tokens: 80 } } });
}

function modelCallsTool(name, args, id) {
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function",
            function: { name, arguments: "" } }] }, finish_reason: null }] });
    const a = JSON.stringify(args);
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, 5) } }] } }] });
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
}

const lastRequest = () => llm.requests[llm.requests.length - 1];
const userItems = (req) => req.messages.filter((i) => i.role === "user").map((i) => i.content);

(async () => {
    appHandlers.Started({ sessionId: "sess-1" });

    const call = new FakeCall();
    const done = appHandlers.CallAlerting({ call, destination: "74951234567" });

    await tick(10);   // конфиг + подключение LLM и VAD

    // ── сокет к прокси поднят до ответа на звонок ───────────────────────────
    assert(createdSocket, "сокет к прокси не создан");
    assert(createdSocket.url === CONFIG.fish_tts_url, "неверный URL прокси: " + createdSocket.url);
    assert(createdSocket.mediaTo === null, "sendMediaTo вызван до ответа на звонок");

    await done;
    assert(call.answered, "звонок не отвечен");

    // ── пайплайн: ASR + VAD на аудио звонка, LLM на ключе из конфига ────────
    assert(asr && call.mediaTo.includes(asr), "аудио звонящего не подключено к ASR");
    assert(vad && call.mediaTo.includes(vad), "аудио звонящего не подключено к VAD");
    assert(asrParams.profile === "yandex-ru" && asrParams.interimResults === true,
           "ASR настроен неверно: " + JSON.stringify(asrParams));
    assert(vadParams.minSilenceDurationMs === 500, "тишина VAD не 500 мс: " + JSON.stringify(vadParams));
    assert(llm.params.apiKey === CONFIG.api_key, "LLM создан не на ключе из конфига");
    console.log("✅ пайплайн: звонок → ASR (Yandex, interim) + Silero VAD 500 мс, LLM на api_key");

    // ── приветствие ушло в очередь, пока сокет закрыт ───────────────────────
    assert(createdSocket.sent.length === 0, "текст ушёл в неоткрытый сокет");
    assert(llm.requests.length === 0, "при first_phrase приветствие не должно идти через модель");

    createdSocket.fire("WebSocket.Open");
    await tick();

    assert(createdSocket.mediaTo === call, "аудио прокси не направлено в звонок после OPEN");
    let msgs = createdSocket.sent;
    assert(msgs[0] && msgs[0].event === "text", "первым не ушёл текст приветствия: " + JSON.stringify(msgs[0]));
    assert(msgs[0].text === CONFIG.first_phrase, "приветствие искажено: " + msgs[0].text);
    assert(msgs[1] && msgs[1].event === "flush", "приветствие не закрыто flush");
    createdSocket.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ приветствие: накопилось до OPEN, ушло текстом + flush");

    // ── шум без текста не становится репликой ──────────────────────────────
    speechStart();
    speechEnd();
    await tick(1100);   // EMPTY_TEXT_WAIT_MS + запас
    assert(llm.requests.length === 0, "сегмент без текста ушёл в модель");
    console.log("✅ шум: сегмент VAD без текста ASR в модель не уходит");

    // ── ход абонента: тишина → запрос в модель ─────────────────────────────
    await userSays("сколько стоит");
    assert(llm.requests.length === 1, "реплика не ушла в модель после тишины");
    let req = lastRequest();
    assert(req.model === "gpt-5.6-luna", "не та модель: " + req.model);
    assert(req.stream === true, "запрос не стримовый");
    assert(req.messages[0].role === "system" && req.messages[0].content.indexOf("Ты ассистент.") === 0,
           "первым сообщением не system_prompt");
    assert(req.messages[0].content.indexOf("Не здоровайся повторно") !== -1, "в system нет пометки о приветствии");
    assert(req.messages[1].role === "assistant" && req.messages[1].content === CONFIG.first_phrase,
           "приветствие не попало в историю первым");
    assert(JSON.stringify(userItems(req)) === JSON.stringify(["сколько стоит"]),
           "реплика абонента искажена: " + JSON.stringify(req.messages));
    assert(req.tools && req.tools[0].function.name === "get_price", "функции не переданы модели");
    assert(req.reasoning_effort === "none", "reasoning_effort не передан");
    assert(llm.params.storeContext === false, "storeContext должен быть false — историю ведёт сценарий");
    console.log("✅ ход: тишина VAD → запрос в gpt-5.6-luna (Chat Completions) с историей и функциями");

    // ── ответ модели дельтами → Fish ───────────────────────────────────────
    createdSocket.sent = [];
    const reply = "Конечно, помогу вам с этим. ";
    modelReplies(reply);
    await tick();

    msgs = createdSocket.sent;
    const texts = msgs.filter((m) => m.event === "text");
    const flushes = msgs.filter((m) => m.event === "flush");
    assert(texts.length > 0, "ответ не ушёл в синтез");
    assert(texts.length < 5, "батчинг не работает: " + texts.length + " кадров на 6 дельт");
    assert(flushes.length >= 1, "ответ не закрыт flush");
    const joined = texts.map((m) => m.text).join("");
    assert(joined === reply, "текст склеился неверно:\n  ожидали: " + JSON.stringify(reply) +
                             "\n  получили: " + JSON.stringify(joined));
    console.log("✅ ответ: " + texts.length + " кадров на 6 дельт, текст склеивается побайтово");

    // ── поздний финал ASR правит историю без нового запроса ────────────────
    final("сколько стоит доставка");
    await tick(50);
    assert(llm.requests.length === 1, "поздний финал ASR вызвал лишний запрос к модели");

    // ── перебивание: речь поверх агента дольше BARGE_IN_MIN_MS ─────────────
    createdSocket.sent = [];
    const clearedBefore = createdSocket.cleared;
    speechStart();
    await tick(100);
    assert(createdSocket.cleared === clearedBefore, "перебивание сработало раньше BARGE_IN_MIN_MS");
    await tick(300);
    assert(createdSocket.cleared === clearedBefore + 1, "буфер Voximplant не сброшен при перебивании");
    assert(createdSocket.sent.filter((m) => m.event === "clear").length === 1,
           "прокси не получил clear при перебивании");
    console.log("✅ перебивание: после 300 мс речи — clearMediaBuffer + clear в прокси");

    interim("а для юрлиц");
    speechEnd();
    await tick(250);
    assert(llm.requests.length === 2, "реплика после перебивания не ушла в модель");
    req = lastRequest();
    assert(JSON.stringify(userItems(req)) === JSON.stringify(["сколько стоит доставка", "а для юрлиц"]),
           "история после уточнения неверна: " + JSON.stringify(userItems(req)));
    assert(req.messages.some((i) => i.role === "assistant" && i.content === reply.trim()),
           "ответ агента не попал в историю");
    console.log("✅ уточнение: финал ASR исправил реплику в истории без лишнего запроса");

    // ── абонент продолжил фразу до звука ответа → одна реплика ─────────────
    // ответ на "а для юрлиц" ещё идёт (нет ни одной дельты), абонент продолжает
    speechStart();
    interim("тоже есть скидка");
    speechEnd();
    await tick(250);
    assert(llm.requests.length === 2, "новый запрос ушёл, пока прошлый ответ не закрылся");
    // старый ответ закрывается — его текст выбрасываем, уходит объединённая реплика
    createdSocket.sent = [];
    modelReplies("Это ответ, который никто не услышит.");
    await tick();
    assert(createdSocket.sent.filter((m) => m.event === "text").length === 0,
           "выброшенный ответ ушёл в синтез");
    assert(llm.requests.length === 3, "отложенная реплика не ушла после закрытия ответа");
    req = lastRequest();
    const users = userItems(req);
    assert(users[users.length - 1] === "а для юрлиц тоже есть скидка",
           "реплика с паузой не склеилась: " + JSON.stringify(users));
    assert(!req.messages.some((i) => i.content === "Это ответ, который никто не услышит."),
           "выброшенный ответ попал в историю");
    console.log("✅ пауза посреди фразы: куски склеены, недозвучавший ответ выброшен");

    // ── вызов функции: результат уходит обратно в модель ───────────────────
    modelCallsTool("get_price", { item: "массаж" }, "call_1");
    await tick(20);
    const fnCall = httpCalls.filter((c) => c.url.indexOf("/functions/execute") !== -1).pop();
    assert(fnCall, "функция не вызвана на бэкенде");
    assert(JSON.parse(fnCall.opts.postData).arguments.item === "массаж",
           "аргументы функции склеились неверно: " + fnCall.opts.postData);
    assert(llm.requests.length === 4, "после функции модель не вызвана повторно");
    req = lastRequest();
    const fc = req.messages.find((i) => i.role === "assistant" && i.tool_calls);
    const fo = req.messages.find((i) => i.role === "tool");
    assert(fc && fc.tool_calls[0].id === "call_1" && fc.tool_calls[0].function.name === "get_price",
           "в истории нет assistant.tool_calls: " + JSON.stringify(fc));
    assert(fo && fo.tool_call_id === "call_1", "в истории нет ответа функции");
    assert(JSON.parse(fo.content).price === 1000, "результат функции искажён: " + fo.content);
    modelReplies("Стоит тысячу рублей.");
    createdSocket.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    await tick();
    console.log("✅ функции: вызов через /functions/execute, результат → повторный запрос");

    // ── модель не приняла reasoning → повтор без него ──────────────────────
    await userSays("спасибо");
    assert(llm.requests.length === 5, "реплика не ушла в модель");
    llm.fire("C.Error", { data: { payload: { text: "Unsupported value: 'reasoning_effort' does not support 'minimal'" } } });
    await tick(400);
    assert(llm.requests.length === 6, "после отказа по reasoning нет повтора");
    assert(!lastRequest().reasoning_effort, "повтор снова с reasoning_effort");
    assert(userItems(lastRequest()).slice(-1)[0] === "спасибо", "повтор ушёл не с той репликой");
    console.log("✅ reasoning: при отказе модели ход повторяется без него");

    // ── ошибка + обрыв сокета: переподключение и повтор того же хода ───────
    const clientsBefore = llmClients.length;
    const failedClient = llm;
    failedClient.fire("C.Error", { data: { payload: { text: "Missing required parameter" } } });
    failedClient.params.onWebSocketClose({ code: 1006, reason: "closed" });
    await tick(400);
    assert(llmClients.length === clientsBefore + 1, "после обрыва сокета клиент не переподключён");
    assert(llm.requests.length === 7, "после переподключения ход не повторён");
    assert(userItems(lastRequest()).slice(-1)[0] === "спасибо", "повтор после обрыва ушёл не с той репликой");
    console.log("✅ обрыв: переподключение и повтор того же хода");

    // ── длинное первое предложение: первый flush по запятой ───────────────
    createdSocket.sent = [];
    modelReplies("У нас есть финская сауна, русская баня на дровах и турецкий хамам. Записать вас?");
    await tick();
    const firstFlush = createdSocket.sent.findIndex((m) => m.event === "flush");
    assert(firstFlush > 0, "flush не отправлен");
    const beforeFlush = createdSocket.sent.slice(0, firstFlush)
        .filter((m) => m.event === "text").map((m) => m.text).join("");
    assert(beforeFlush.indexOf("сауна,") !== -1 && beforeFlush.indexOf("хамам.") === -1,
           "первый flush не по запятой: до него ушло «" + beforeFlush + "»");
    assert(createdSocket.sent.filter((m) => m.event === "text").map((m) => m.text).join("") ===
           "У нас есть финская сауна, русская баня на дровах и турецкий хамам. Записать вас?",
           "текст с ранним flush склеился неверно");
    createdSocket.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    console.log("✅ Fish: длинное первое предложение уходит в синтез по запятой");

    await userSays("нет, спасибо, до свидания");
    assert(llm.requests.length === 8, "реплика перед прощанием не ушла в модель");

    // ── прощание и hangup по speech_done ───────────────────────────────────
    createdSocket.sent = [];
    modelCallsTool("hangup_call", { farewell_message: "Всего доброго!", reason: "done" }, "call_2");
    await tick();

    const farewell = createdSocket.sent.filter((m) => m.event === "text");
    assert(farewell.length === 1 && farewell[0].text === "Всего доброго!",
           "прощание не ушло в синтез: " + JSON.stringify(createdSocket.sent));
    assert(llm.requests.length === 8, "после hangup_call модель вызвана ещё раз");

    assert(!call.hungup, "трубка положена до окончания прощания");
    createdSocket.fire("WebSocket.Message", {
        text: JSON.stringify({ event: "speech_done", remaining_ms: 30 }),
    });
    await tick(400);
    assert(call.hungup, "трубка не положена после speech_done");
    console.log("✅ прощание: озвучено, трубка положена по speech_done");

    // ── итоговый лог: диалог и стоимость ASR ───────────────────────────────
    asr.fire("ASR.Stopped", { cost: 0.12 });
    call.fire("RecordStopped", { url: "https://rec", cost: 0.3 });
    call.fire("Disconnected", { cost: 1.5, duration: 42 });
    await tick(700);
    const logCall = httpCalls.filter((c) => c.url.indexOf("/voximplant/log") !== -1).pop();
    assert(logCall, "финальный лог не отправлен");
    const payload = JSON.parse(logCall.opts.postData);
    assert(payload.call_cost === 1.92, "в стоимость не добавлены ASR и запись: " + payload.call_cost);
    assert(payload.call_cost_parts.record === 0.3, "нет стоимости записи в call_cost_parts");
    const roles = payload.data.dialog.map((d) => d.role + ":" + d.text);
    assert(roles.includes("user:сколько стоит доставка"), "в диалоге нет уточнённой реплики: " + JSON.stringify(roles));
    assert(roles.includes("user:а для юрлиц тоже есть скидка"), "в диалоге нет склеенной реплики");
    assert(!roles.includes("user:а для юрлиц"), "в диалоге остался кусок до склейки");
    assert(roles.includes("assistant:Всего доброго!"), "в диалоге нет прощания");
    console.log("✅ лог: диалог с уточнениями, cost = звонок + ASR + запись");

    // ── модель недоступна: извиниться голосом и положить трубку ───────────
    const call2 = new FakeCall();
    await appHandlers.CallAlerting({ call: call2, destination: "74951234567" });
    createdSocket.fire("WebSocket.Open");
    createdSocket.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 0 }) });
    await tick();
    await userSays("алло");
    for (let i = 0; i < 3; i++) {
        const dying = llm;
        dying.fire("C.Error", { data: { payload: { text: "Service unavailable" } } });
        dying.params.onWebSocketClose({ code: 1006, reason: "closed" });
        await tick(400);
    }
    const apology = createdSocket.sent.filter((m) => m.event === "text").pop();
    assert(apology && apology.text.indexOf("технические неполадки") !== -1,
           "при недоступной модели нет извинения: " + JSON.stringify(createdSocket.sent));
    assert(!call2.hungup, "трубка положена до конца извинения");
    createdSocket.fire("WebSocket.Message", { text: JSON.stringify({ event: "speech_done", remaining_ms: 20 }) });
    await tick(400);
    assert(call2.hungup, "после извинения трубка не положена");
    console.log("✅ модель недоступна: извинение голосом, затем hangup");

    console.log("\nвсе проверки inbound_fish пройдены");
})();
