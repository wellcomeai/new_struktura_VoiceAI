/**
 * Стенд для VoxTurnTaking.
 *
 * Подменяет модули Voximplant (Silero / Pipecat / ASR / Logger) заглушками и
 * проигрывает таймлайн событий в реальном времени. Нужен потому, что вся логика
 * turn-taking — про тайминги и гонки между тремя асинхронными источниками
 * (VAD, turn-detector, ASR), и глазами такие вещи не проверяются.
 *
 * Запуск: node voximplant_scenarios/tests/turn_taking.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RUNTIME = path.join(__dirname, "..", "vox-turn-taking.js");

function makeEmitter() {
    const handlers = {};
    return {
        addEventListener(name, cb) {
            (handlers[name] = handlers[name] || []).push(cb);
        },
        emit(name, event) {
            (handlers[name] || []).forEach((cb) => cb(event));
        },
    };
}

function loadRuntime({ quiet = true } = {}) {
    const lines = [];
    const Silero = {
        VADEvents: { Result: "vad.Result", ConnectorInformation: "vad.Info", Error: "vad.Error" },
        createVAD: async () => Object.assign(makeEmitter(), { close() {} }),
    };
    const Pipecat = {
        TurnEvents: { Result: "turn.Result", ConnectorInformation: "turn.Info", Error: "turn.Error" },
        createTurnDetector: async () => {
            const e = makeEmitter();
            e.predict = () => { e.predictCalls = (e.predictCalls || 0) + 1; };
            e.close = () => {};
            return e;
        },
    };
    const sandbox = {
        Modules: { ASR: "ASR", Silero: "Silero", Pipecat: "Pipecat" },
        require: () => {},
        Logger: { write: (l) => { lines.push(String(l)); if (!quiet) console.log("   " + l); } },
        Silero,
        Pipecat,
        ASREvents: { Result: "asr.Result", InterimResult: "asr.Interim" },
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Number,
        Math,
        console,
    };
    vm.createContext(sandbox);
    // `const VoxTurnTaking` — лексическое объявление, в свойства sandbox оно не
    // попадает. Достаём явным экспортом, дописанным в конец скрипта.
    const src = fs.readFileSync(RUNTIME, "utf8") + "\n;globalThis.__VTT = VoxTurnTaking;\n";
    vm.runInContext(src, sandbox, { filename: RUNTIME });
    return { VoxTurnTaking: sandbox.__VTT, lines };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Сколько ждём после последнего события таймлайна, чтобы дать отработать
// отложенным закрытиям (самое длинное окно — vetoHoldStrongMs = 2000мс).
const TAIL_MS = 3000;

/**
 * Проигрывает таймлайн и возвращает всё, что рантайм отдал наружу.
 *
 * timeline: [{ at, kind, ...payload }], где kind:
 *   "interim" { text } | "final" { text, confidence }
 *   "speechStart" | "speechEnd"
 *   "turn" { endOfTurn, p }
 */
async function run(timeline, options = {}) {
    const { policy, vadOptions, agentSpeaking = () => false, quiet = true } = options;
    const { VoxTurnTaking, lines } = loadRuntime({ quiet });
    const stt = makeEmitter();
    const call = { sendMediaTo() {} };

    const turns = [];
    const interrupts = [];
    const corrections = [];

    const tt = await VoxTurnTaking.create({
        call,
        stt,
        policy,
        vadOptions,
        enableLogging: true,
        isAgentSpeaking: agentSpeaking,
        onUserTurn: (input, version, reason) =>
            turns.push({ input, version, reason, at: Date.now() - t0 }),
        onInterrupt: () => interrupts.push({ at: Date.now() - t0 }),
        onTurnCorrection: (full, turnId, meta) =>
            corrections.push({ full, turnId, meta, at: Date.now() - t0 }),
    });

    const vad = tt.vad;
    const det = tt.turnDetector;
    const t0 = Date.now();

    let last = 0;
    for (const ev of timeline.slice().sort((a, b) => a.at - b.at)) {
        await sleep(Math.max(0, ev.at - last));
        last = ev.at;
        switch (ev.kind) {
            case "interim":
                stt.emit("asr.Interim", { text: ev.text });
                break;
            case "final":
                stt.emit("asr.Result", { text: ev.text, confidence: ev.confidence ?? 0.95 });
                break;
            // Silero отдаёт метку времени внутри сессии; +1000 чтобы событие на
            // at=0 не оказалось нулевым (реальный VAD и так отстаёт ~на секунду).
            case "speechStart":
                vad.emit("vad.Result", { speechStartAt: ev.at + 1000 });
                break;
            case "speechEnd":
                vad.emit("vad.Result", { speechEndAt: ev.at + 1000 });
                break;
            case "turn":
                det.emit("turn.Result", { endOfTurn: ev.endOfTurn, probability: ev.p });
                break;
            default:
                throw new Error("неизвестный тип события: " + ev.kind);
        }
    }
    await sleep(TAIL_MS);
    return { turns, interrupts, corrections, lines, tt };
}

module.exports = { run, loadRuntime };
