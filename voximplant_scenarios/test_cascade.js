/*
 * Прогон inbound_cascade.js и outbound_cascade.js (v4.0, каскад ASR → прокси
 * модели → VoxTTS) на заглушках VoxEngine. LLM-часть, склейку и retract
 * подробно проверяют тесты Fish (код общий) — здесь то, что своё у каскада:
 * URL прокси из конфига, пауза Silero из пресета, плеер VoxTTS (flush,
 * clearBuffer, конец озвучки по AudioChunksPlaybackFinished), исходящая
 * специфика и итоговый /log.
 *
 *   node voximplant_scenarios/test_cascade.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PROXY_URL = "wss://voicyfy.ru/ws/cascade/llm/" + ID;
const BASE_CONFIG = {
    success: true, assistant_type: "cascade", assistant_id: ID, assistant_name: "Тестовый каскад",
    api_key: "sk-server", system_prompt: "Ты ассистент.", first_phrase: "Здравствуйте! Чем помочь?",
    tts_provider: "voxtts", tts_voice: "Sergey", tts_lang: "ru", asr_lang: "ru",
    silence_duration_ms: 650, llm_proxy_url: PROXY_URL,
    functions: [
        { type: "function", function: { name: "get_price", description: "Цена",
          parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "hangup_call", description: "Положить трубку",
          parameters: { type: "object", properties: { farewell_message: { type: "string" } } } } },
    ],
};

function makeSandbox(file, config, customData) {
    const st = { appHandlers: {}, logs: [], player: null, playerParams: null, llmSockets: [],
                 vad: null, vadParams: null, asr: null, asrParams: null, call: null, dialed: null,
                 terminated: false, httpPosts: [] };
    function Emitter() {
        this._h = {};
        this.addEventListener = (ev, cb) => { (this._h[ev] = this._h[ev] || []).push(cb); };
        this.fire = (ev, payload) => (this._h[ev] || []).forEach((cb) => cb(payload));
    }
    class FakeSocket extends Emitter {
        constructor(url) { super(); this.url = url; this.sent = []; }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.closed = true; }
    }
    class FakePlayer extends Emitter {
        constructor() { super(); this.sent = []; this.cleared = 0; this.mediaTo = null; }
        send(msg) { this.sent.push(JSON.parse(JSON.stringify(msg))); }
        clearBuffer() { this.cleared++; }
        sendMediaTo(u) { this.mediaTo = u; }
    }
    class FakeCall extends Emitter {
        constructor() { super(); this.mediaTo = []; this.hungup = false; this.recording = false; this.answered = false; }
        id() { return "call-1"; }
        callerid() { return "+70000000000"; }
        answer() { this.answered = true; }
        record() { this.recording = true; }
        sendMediaTo(u) { this.mediaTo.push(u); }
        hangup() { this.hungup = true; }
    }
    st.FakeCall = FakeCall;
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Array, Object, RegExp, Error, Number,
        isFinite, encodeURIComponent,
        require: () => {},
        Modules: { ASR: "ASR", Silero: "Silero", OpenAI: "OpenAI", VoxTTS: "VoxTTS" },
        Logger: { write: (m) => st.logs.push(String(m)) },
        AppEvents: { Started: "Started", CallAlerting: "CallAlerting" },
        CallEvents: { Connected: "Connected", Disconnected: "Disconnected", Failed: "Failed",
                      RecordStarted: "RecordStarted", RecordStopped: "RecordStopped" },
        PlayerEvents: { AudioChunksPlaybackFinished: "Player.AudioChunksPlaybackFinished", Error: "Player.Error" },
        WebSocketEvents: { OPEN: "WebSocket.Open", MESSAGE: "WebSocket.Message", CLOSE: "WebSocket.Close",
                           ERROR: "WebSocket.Error" },
        ASREvents: { InterimResult: "ASR.InterimResult", Result: "ASR.Result", Stopped: "ASR.Stopped", ASRError: "ASR.Error" },
        ASRProfileList: { Yandex: { ru_RU: "yandex-ru", en_US: "yandex-en", de_DE: "yandex-de",
                                    es_ES: "yandex-es", fr_FR: "yandex-fr" },
                          Deepgram: { ru: "deepgram-ru", en_US: "deepgram-en" } },
        ASRModelList: { Yandex: { general: "yandex-general" }, Deepgram: { nova2_general: "nova2-general" } },
        Silero: {
            VADEvents: { Result: "Silero.VAD.Result", Error: "Silero.VAD.Error" },
            createVAD: async (p) => { st.vadParams = p; st.vad = new Emitter(); st.vad.close = () => {}; return st.vad; },
        },
        VoxTTS: {
            VoiceList: { Anna: "Anna", Sergey: "Sergey" },
            ModelList: { VoxTTS: "voxtts" },
            createRealtimeTTSPlayer: (p) => { st.playerParams = p; st.player = new FakePlayer(); return st.player; },
        },
        VoxEngine: {
            addEventListener: (ev, cb) => { st.appHandlers[ev] = cb; },
            createWebSocket: (url) => { const s = new FakeSocket(url); st.llmSockets.push(s); return s; },
            createASR: (p) => { st.asrParams = p; st.asr = new Emitter(); st.asr.stop = () => {}; return st.asr; },
            customData: () => customData,
            callPSTN: (num, cid) => { st.dialed = { num, cid }; st.call = new FakeCall(); return st.call; },
            terminate: () => { st.terminated = true; },
        },
        Net: {
            httpRequestAsync: async (url, o) => {
                if (url.indexOf("/telephony/") !== -1) {
                    st.configUrl = url;
                    return { code: 200, text: JSON.stringify(config) };
                }
                if (o && o.postData) st.httpPosts.push({ url, body: JSON.parse(o.postData) });
                if (url.indexOf("/functions/execute") !== -1) return { code: 200, text: JSON.stringify({ price: 1000 }) };
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
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    if (!/var LLM_TRANSPORT\s*=\s*"proxy"/.test(source)) throw new Error("в " + file + " LLM_TRANSPORT не \"proxy\"");
    vm.runInContext(source, sandbox, { filename: file });
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
    server({ event: "chunk", id, payload: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10,
                                                               prompt_tokens_details: { cached_tokens: 80 } } } });
    server({ event: "done", id, openai_first_ms: 250, total_ms: 400 });
}
function callTool(id, name, args) {
    chunk(id, { tool_calls: [{ index: 0, id: "c" + id, function: { name, arguments: JSON.stringify(args) } }] });
    chunk(id, {}, "tool_calls");
    server({ event: "done", id });
}
const ttsTexts = () => st.player.sent.map((m) => m.send_text.text);
const ttsFlushes = () => st.player.sent.filter((m) => m.send_text.flush_context).length;
const played = (final) => st.player.fire("Player.AudioChunksPlaybackFinished",
                                          final === undefined ? {} : { final });
const speechStart = () => st.vad.fire("Silero.VAD.Result", { speechStartAt: 1 });
const speechEnd = () => st.vad.fire("Silero.VAD.Result", { speechEndAt: 2 });
async function userSays(text) {
    speechStart();
    st.asr.fire("ASR.InterimResult", { text });
    speechEnd();
    await tick(200);
}

async function inboundFlow() {
    st = makeSandbox("inbound_cascade.js", BASE_CONFIG);
    st.appHandlers.Started({ sessionId: "sess-in" });
    const call = new st.FakeCall();
    const done = st.appHandlers.CallAlerting({ call, destination: "74951234567" });
    await tick(10);

    // ── до ответа: конфиг, сокет прокси из llm_proxy_url ──────────────────
    assert(st.configUrl.indexOf("/telephony/config?phone=74951234567&caller=70000000000") !== -1,
           "конфиг запрошен не по номеру: " + st.configUrl);
    assert(st.llmSockets.length === 1 && llm().url === PROXY_URL, "сокет модели не на llm_proxy_url");
    assert(!call.answered, "ответ на звонок до готовности модели");
    llm().fire("WebSocket.Open");
    await done;
    assert(call.answered && call.recording, "звонок не отвечен или нет записи");

    // ── пайплайн: VAD с паузой из пресета, ASR, VoxTTS с голосом ассистента
    assert(st.vadParams.minSilenceDurationMs === 650, "тишина VAD не из silence_duration_ms: " + JSON.stringify(st.vadParams));
    assert(st.asrParams.profile === "yandex-ru" && st.asrParams.interimResults === true, "ASR настроен неверно");
    assert(call.mediaTo.includes(st.asr) && call.mediaTo.includes(st.vad), "аудио звонящего не в ASR/VAD");
    assert(st.playerParams.createContextParameters.create.voiceId === "Sergey", "голос VoxTTS не из конфига");
    assert(st.player.mediaTo === call, "VoxTTS не подключён к звонку");
    console.log("✅ пайплайн: прокси по llm_proxy_url, Silero 650 мс из пресета, VoxTTS Sergey → звонок");

    // ── приветствие напрямую в VoxTTS + прогрев модели ────────────────────
    assert(ttsTexts()[0] === BASE_CONFIG.first_phrase && st.player.sent[0].send_text.flush_context,
           "приветствие не ушло в VoxTTS с flush: " + JSON.stringify(st.player.sent[0]));
    assert(requests().length === 1, "прогрев не ушёл во время приветствия");
    const warm = requests()[0].payload;
    assert(warm.model === "deepseek/deepseek-v4.1-flash", "модель не та: " + warm.model);
    assert(warm.messages[0].content.indexOf("Ты ассистент.") === 0 &&
           warm.messages[0].content.indexOf("Числа, даты и время произноси словами") !== -1 &&
           warm.messages[0].content.indexOf("Не здоровайся повторно") !== -1,
           "system-промпт без правил телефонии / пометки о приветствии");
    assert(warm.messages[1].content === BASE_CONFIG.first_phrase && warm.messages[2].content === "Алло",
           "прогрев не совпадает с первым ходом");
    const hang = warm.tools.find((t) => t.function.name === "hangup_call");
    assert(hang && hang.function.description.indexOf("НЕМЕДЛЕННО") !== -1, "hangup_call без усиленного описания");
    reply(1, "Слушаю.");
    await tick();
    assert(st.player.sent.length === 1, "ответ прогрева ушёл в синтез");
    played(true);                                          // приветствие договорено
    await tick();
    console.log("✅ приветствие: в VoxTTS с flush, прогрев тем же префиксом выброшен");

    // ── ход: тишина → запрос; длинное первое предложение → flush по запятой
    await userSays("какие у вас есть бани");
    assert(lastReq().id === 2, "реплика не ушла в модель");
    assert(lastReq().payload.messages.slice(-1)[0].content === "какие у вас есть бани", "реплика искажена");
    st.player.sent = [];
    const answer = "У нас есть финская сауна, русская баня на дровах и турецкий хамам. Записать вас?";
    reply(2, answer);
    await tick();
    assert(st.player.sent[0].send_text.text === "У нас есть финская сауна," && st.player.sent[0].send_text.flush_context,
           "первый кусок не ровно до запятой с flush: " + JSON.stringify(st.player.sent[0]));
    assert(ttsTexts().join("").replace(/ $/, "") === answer, "текст склеился неверно: " + JSON.stringify(ttsTexts()));
    assert(st.player.sent.slice(-1)[0].send_text.flush_context, "реплика не закрыта flush");
    assert(ttsFlushes() === 2, "лишние flush: " + ttsFlushes());
    console.log("✅ ответ: ранний flush по запятой, дальше пачками, в конце flush");

    // ── конец озвучки: ждём последний flush, авто-flush (final=false) не считаем
    played(false);
    played(true);                                          // ранний flush доигран — реплика ещё звучит
    await tick();
    const clearedBefore = st.player.cleared;
    speechStart();
    await tick(350);
    assert(st.player.cleared === clearedBefore + 1, "речь поверх недоигранной реплики не перебила");
    speechEnd();
    await tick(1000);                                      // шум без текста
    console.log("✅ перебивание: речь > 300 мс поверх агента — clearBuffer");

    // ── после конца озвучки речь абонента не считается перебиванием ───────
    await userSays("сколько стоит");
    reply(3, "Тысяча рублей.");
    await tick();
    played(true);
    await tick();
    const cl = st.player.cleared;
    speechStart();
    await tick(350);
    assert(st.player.cleared === cl, "после конца озвучки речь абонента сочтена перебиванием");
    st.asr.fire("ASR.InterimResult", { text: "а со скидкой" });
    speechEnd();
    await tick(200);
    assert(lastReq().id === 4, "реплика не ушла");

    // ── перебивание посреди ответа: cancel в прокси + clearBuffer ─────────
    chunk(4, { content: "Со скидкой выходит, " });
    chunk(4, { content: "если прийти до обеда" });
    await tick();
    const cl2 = st.player.cleared;
    speechStart();
    await tick(350);
    assert(st.player.cleared === cl2 + 1 && llm().sent.some((m) => m.event === "cancel" && m.id === 4),
           "перебивание не оборвало ответ (cancel + clearBuffer)");
    st.asr.fire("ASR.InterimResult", { text: "понятно спасибо до свидания" });
    speechEnd();
    await tick(200);
    console.log("✅ конец озвучки по AudioChunksPlaybackFinished; перебивание: cancel + clearBuffer");

    // ── функция: /functions/execute → повторный запрос ────────────────────
    assert(lastReq().id === 5, "реплика после перебивания не ушла");
    callTool(5, "get_price", { item: "баня" });
    await tick(20);
    const fn = st.httpPosts.find((p) => p.url.indexOf("/functions/execute") !== -1);
    assert(fn && fn.body.function_id === "1" && fn.body.call_data.called_number === "74951234567",
           "функция вызвана неверно: " + JSON.stringify(fn && fn.body));
    assert(lastReq().id === 6 && lastReq().payload.messages.some((m) => m.role === "tool"),
           "после функции нет повторного запроса с результатом");

    // ── hangup_call: прощание, трубка после конца озвучки ─────────────────
    callTool(6, "hangup_call", { farewell_message: "Всего доброго!" });
    await tick();
    assert(ttsTexts().slice(-1)[0] === "Всего доброго!", "прощание не ушло в VoxTTS");
    assert(!call.hungup, "трубка положена до конца прощания");
    await tick(450);                                       // > TTS_CLEAR_GRACE_MS после перебивания
    played(true);
    await tick(300);
    assert(call.hungup, "трубка не положена после конца прощания");
    console.log("✅ функции через /functions/execute; hangup_call — трубка после конца озвучки");

    // ── итоговый /log ─────────────────────────────────────────────────────
    st.asr.fire("ASR.Stopped", { cost: 0.12 });
    call.fire("RecordStopped", { url: "https://rec", cost: 0.3 });
    call.fire("Disconnected", { cost: 1.5, duration: 42 });
    await tick(700);
    const log = st.httpPosts.filter((p) => p.url.indexOf("/voximplant/log") !== -1).pop();
    assert(log, "финальный лог не отправлен");
    const b = log.body;
    assert(b.caller_number === "INBOUND: +70000000000" && b.call_cost === 1.92 && b.record_url === "https://rec",
           "лог: номер/стоимость/запись неверны: " + JSON.stringify(b));
    assert(b.cascade_usage && b.cascade_usage.model === "deepseek/deepseek-v4.1-flash" &&
           b.cascade_usage.cached_prompt_tokens === 240 && b.cascade_usage.prompt_tokens === 60 &&
           b.cascade_usage.completion_tokens === 30, "cascade_usage неверен: " + JSON.stringify(b.cascade_usage));
    const roles = b.data.dialog.map((d) => d.role + ":" + d.text);
    assert(roles[0] === "assistant:" + BASE_CONFIG.first_phrase && roles.includes("user:какие у вас есть бани") &&
           roles.includes("assistant:Всего доброго!"), "диалог неверен: " + JSON.stringify(roles));
    assert(st.terminated, "сессия не завершена");
    console.log("✅ /log: INBOUND, cost = звонок + ASR + запись, cascade_usage с моделью");
}

async function inboundGuardFlow() {
    // Событие конца озвучки не пришло — трубка всё равно кладётся по оценке длительности.
    st = makeSandbox("inbound_cascade.js", Object.assign({}, BASE_CONFIG, { first_phrase: "" }));
    st.appHandlers.Started({ sessionId: "sess-in-2" });
    const call = new st.FakeCall();
    const done = st.appHandlers.CallAlerting({ call, destination: "74951234567" });
    await tick(10);
    llm().fire("WebSocket.Open");
    await done;
    // Нет first_phrase — здоровается модель, разовым запросом.
    assert(requests().length === 1 && requests()[0].payload.messages.slice(-1)[0].content.indexOf("Поприветствуй") !== -1,
           "без first_phrase приветствие не запрошено у модели");
    callTool(1, "hangup_call", { farewell_message: "Пока!" });
    await tick();
    assert(!call.hungup, "трубка положена сразу");
    await tick(3700);
    assert(call.hungup, "без события конца озвучки трубка не положена по оценке");
    console.log("✅ без first_phrase здоровается модель; без события конца озвучки hangup по оценке");
}

async function inboundNoProxyFlow() {
    st = makeSandbox("inbound_cascade.js", Object.assign({}, BASE_CONFIG, { llm_proxy_url: null }));
    const call = new st.FakeCall();
    await st.appHandlers.CallAlerting({ call, destination: "74951234567" });
    assert(st.terminated && !call.answered && st.llmSockets.length === 0, "без llm_proxy_url звонок принят");
    console.log("✅ конфиг без llm_proxy_url: звонок не принимается");
}

async function outboundFlow() {
    const GREETING = "Иван, добрый день! Это Светлана из спа-центра.";
    st = makeSandbox("outbound_cascade.js", BASE_CONFIG, JSON.stringify({
        phone_number: "+79990000000", assistant_id: ID, caller_id: "+74951234567",
        mute_duration_ms: 100, contact_name: "Иван", task_title: "Напомнить о записи",
        custom_greeting: GREETING,
    }));
    const done = st.appHandlers.Started({ sessionId: "sess-out" });
    await tick(10);

    // ── до набора: сокет модели, набор ждёт его открытия ──────────────────
    assert(st.configUrl.indexOf("/telephony/outbound-config?assistant_id=" + ID) !== -1, "конфиг не по assistant_id");
    assert(llm() && llm().url === PROXY_URL, "сокет прокси модели не создан или URL неверен");
    assert(!st.dialed, "номер набран до открытия сокета модели");
    llm().fire("WebSocket.Open");
    await done;
    assert(st.dialed && st.dialed.num === "+79990000000" && st.dialed.cid === "+74951234567",
           "неверные параметры набора: " + JSON.stringify(st.dialed));
    assert(st.player && st.player.mediaTo === null, "VoxTTS не создан до набора или подключён раньше Connected");

    // ── прогрев во время гудков с контекстом CRM ──────────────────────────
    const warm = requests()[0].payload;
    const sys = warm.messages[0].content;
    assert(sys.indexOf("Клиент: Иван") !== -1 && sys.indexOf("Напомнить о записи") !== -1, "нет контекста CRM в промпте");
    assert(sys.indexOf("«" + GREETING + "»") !== -1 && sys.indexOf("+79990000000") !== -1, "нет приветствия/номера в промпте");
    assert(warm.messages[1].content === GREETING && warm.messages[2].content === "Алло", "прогрев не совпадает с первым ходом");
    reply(1, "Да.");
    await tick();
    console.log("✅ до набора: прокси и VoxTTS готовы, прогрев с контекстом CRM во время гудков");

    // ── Connected: приветствие, мьют ──────────────────────────────────────
    st.call.fire("Connected");
    await tick();
    assert(st.player.mediaTo === st.call && st.call.recording, "VoxTTS не привязан к звонку или нет записи");
    assert(ttsTexts()[0] === GREETING && st.player.sent[0].send_text.flush_context, "custom_greeting не ушёл в VoxTTS");
    assert(st.call.mediaTo.length === 0, "аудио абонента в ASR/VAD без мьюта");
    await tick(160);
    assert(st.call.mediaTo.includes(st.asr) && st.call.mediaTo.includes(st.vad), "после мьюта аудио не подключено");
    console.log("✅ Connected: custom_greeting в VoxTTS, ASR/VAD после мьюта");

    // ── речь поверх приветствия не перебивает его ─────────────────────────
    speechStart();
    st.asr.fire("ASR.InterimResult", { text: "да слушаю" });
    await tick(400);
    speechEnd();
    await tick(200);
    assert(st.player.cleared === 0, "приветствие перебито");
    assert(lastReq().id === 2 && lastReq().payload.messages.slice(-1)[0].content === "да слушаю", "реплика не ушла модели");
    reply(2, "Иван, напоминаю: вы записаны на завтра.");
    await tick();
    assert(ttsTexts().slice(1).join("").trim() === "Иван, напоминаю: вы записаны на завтра.",
           "ответ не встал в синтез за приветствием: " + JSON.stringify(ttsTexts()));
    played(true);                                          // приветствие
    await tick();
    assert(st.logs.some((l) => l.indexOf("Приветствие отзвучало") !== -1), "приветствие не завершилось по событию плеера");
    played(true); played(true);
    console.log("✅ приветствие не перебивается, ответ встаёт в очередь VoxTTS");

    // ── после приветствия перебивание работает ────────────────────────────
    await userSays("а во сколько");
    chunk(3, { content: "В десять утра, " });
    chunk(3, { content: "вас ждём в холле." });
    await tick();
    speechStart();
    await tick(350);
    assert(st.player.cleared === 1 && llm().sent.some((m) => m.event === "cancel" && m.id === 3),
           "перебивание после приветствия не сработало");
    st.asr.fire("ASR.InterimResult", { text: "всё понял до свидания" });
    speechEnd();
    await tick(200);

    // ── hangup_call → трубка после конца озвучки, /log OUTBOUND ───────────
    callTool(4, "hangup_call", { farewell_message: "Всего доброго!" });
    await tick();
    assert(ttsTexts().slice(-1)[0] === "Всего доброго!" && !st.call.hungup, "прощание не ушло или трубка положена рано");
    await tick(450);                                       // > TTS_CLEAR_GRACE_MS после перебивания
    played(true);
    await tick(300);
    assert(st.call.hungup, "трубка не положена после прощания");
    st.call.fire("Disconnected", { cost: 1.2, duration: 30 });
    await tick(600);
    const log = st.httpPosts.find((p) => p.url.indexOf("/voximplant/log") !== -1);
    assert(log && log.body.caller_number === "OUTBOUND: +79990000000" && log.body.call_duration === 30 &&
           log.body.data.dialog[0].text === GREETING && log.body.context.contact_name === "Иван" &&
           log.body.cascade_usage, "финальный лог неверен: " + JSON.stringify(log && log.body));
    assert(st.terminated, "сессия не завершена");
    console.log("✅ перебивание после приветствия; hangup_call; /log OUTBOUND с контекстом");
}

async function outboundFailFlow() {
    // Прокси модели не открылся — номер не набираем.
    st = makeSandbox("outbound_cascade.js", BASE_CONFIG,
                     JSON.stringify({ phone_number: "+79990000000", assistant_id: ID }));
    const done = st.appHandlers.Started({ sessionId: "sess-out-2" });
    await tick(10);
    llm().fire("WebSocket.Close", { code: 1006, reason: "refused" });
    await done;
    assert(!st.dialed && st.terminated, "при недоступной модели номер набран");
    console.log("✅ исходящий: модель недоступна — звонок не совершается");
}

(async () => {
    await inboundFlow();
    await inboundNoProxyFlow();
    await outboundFlow();
    await outboundFailFlow();
    await inboundGuardFlow();
    if (process.env.DUMP_LOG) st.logs.forEach((l) => console.log("   " + l));
    console.log("\nвсе проверки inbound_cascade / outbound_cascade пройдены");
    process.exit(0);
})();
