/**
 * test_inworld_tts.js — проверка озвучки Inworld (Modules.Inworld) в звонке.
 *
 * Разовый тестовый сценарий, в прод-правила не подключается. Загрузить на
 * аккаунт, где есть тестовый номер, повесить на номер правило с этим
 * сценарием и позвонить. Ключ Inworld не передаётся — синтез идёт на биллинге
 * Voximplant (тариф «Inworld», $0.00025 за 10 символов).
 *
 * Прогон 1 показал: Inworld отдаёт первый байт за ~0.6 с, а звук в звонке
 * начинается через ~1.9 с (PlaybackReady). Прогон 2 ищет, откуда разрыв:
 *   - короткая фраза (как первый кусок каскада) против длинной;
 *   - VoxTTS (плеер каскада сейчас) на тех же фразах — общее ли это поведение
 *     плеера Voximplant;
 *   - autoMode у контекста Inworld;
 *   - speakingRate 1.15 в двух местах (create и create.audioConfig): у какой
 *     записи сократится длительность фразы (audio=...), та и работает.
 * Плюс прежние проверки: модели 1.5-max / 1.5-mini, текст кусками,
 * перебивание clearBuffer().
 *
 * Результаты — в логе сессии: по ходу строки ===INWORLD===, в конце сводка
 * ===INWORLD=== SUMMARY (ready / started / ttfb / audio / total, мс от отправки
 * текста). Трубку не класть до «Тест окончен» (~2 мин).
 */
require(Modules.Inworld);
require(Modules.VoxTTS);

var INWORLD_VOICE = "Galina";
var STEP_PAUSE_MS = 700;
var STEP_TIMEOUT_MS = 25000;
var SESSION_LIMIT_MS = 300000;

var SHORT = "Здравствуйте, слушаю вас.";
var LONG = "Записала вас на консультацию завтра в 15:30, стоимость 2500 рублей. " +
           "Адрес пришлю сообщением, а за час до встречи ещё раз напомню.";

var STEPS = [
    { title: "voxtts-short",       provider: "voxtts",  text: SHORT },
    { title: "tts2-short",         provider: "inworld", model: "inworld-tts-2", text: SHORT },
    { title: "tts2-short-auto",    provider: "inworld", model: "inworld-tts-2", text: SHORT,
      create: { autoMode: true } },
    { title: "tts15max-short",     provider: "inworld", model: "inworld-tts-1.5-max", text: SHORT },
    { title: "tts15mini-short",    provider: "inworld", model: "inworld-tts-1.5-mini", text: SHORT },
    { title: "voxtts-long",        provider: "voxtts",  text: LONG },
    { title: "tts2-long",          provider: "inworld", model: "inworld-tts-2", text: LONG },
    { title: "tts2-long-auto",     provider: "inworld", model: "inworld-tts-2", text: LONG,
      create: { autoMode: true } },
    { title: "tts2-long-rate",     provider: "inworld", model: "inworld-tts-2", text: LONG,
      create: { speakingRate: 1.15 } },
    { title: "tts2-long-rate-cfg", provider: "inworld", model: "inworld-tts-2", text: LONG,
      create: { audioConfig: { speakingRate: 1.15 } } },
    { title: "tts2-pieces-auto",   provider: "inworld", model: "inworld-tts-2", pieceGapMs: 150,
      create: { autoMode: true },
      pieces: ["Теперь текст приходит кусками, ", "как ответ языковой модели, ",
               "а последний кусок закрывает фразу."] },
    { title: "barge-in",           provider: "inworld", model: "inworld-tts-2", clearAfterMs: 2500,
      text: "Сейчас будет длинная фраза, которую тест оборвёт посередине. " +
            "Если вы слышите это предложение целиком, значит очистка буфера не сработала, " +
            "и перебивание в звонке работать не будет." },
    { title: "after-clear",        provider: "inworld", model: "inworld-tts-2",
      text: "Перебивание проверено. Тест окончен, до свидания!" }
];

VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    var call = e.call;
    var player = null;
    var stepIndex = -1;
    var stepDone = false;
    var results = [];
    var finished = false;

    function log(msg) {
        Logger.write("===INWORLD=== " + msg);
    }

    function finish(reason) {
        if (finished) return;
        finished = true;
        stopPlayer();
        log("done (" + reason + ")");
        results.forEach(function(r) {
            log("SUMMARY " + r.title + " model=" + r.model + " chars=" + r.chars +
                " ready=" + r.ready + " started=" + r.started + " ttfb=" + r.ttfb +
                " audio=" + r.audio + " total=" + r.total + " end=" + r.end);
        });
        try { call.hangup(); } catch (err) {}
        VoxEngine.terminate();
    }

    function stopPlayer() {
        if (!player) return;
        try { player.stop(); } catch (err) {}
        player = null;
    }

    function nextStep() {
        stopPlayer();
        stepIndex++;
        if (stepIndex >= STEPS.length) {
            setTimeout(function() { finish("all steps"); }, 500);
            return;
        }
        setTimeout(function() { runStep(STEPS[stepIndex]); }, STEP_PAUSE_MS);
    }

    function createPlayer(step, contextId) {
        if (step.provider === "voxtts") {
            return VoxTTS.createRealtimeTTSPlayer({
                createContextParameters: {
                    create: { modelId: VoxTTS.ModelList.VoxTTS, voiceId: VoxTTS.VoiceList.Anna }
                }
            });
        }
        var create = { voiceId: INWORLD_VOICE, modelId: step.model };
        var extra = step.create || {};
        for (var k in extra) create[k] = extra[k];
        return Inworld.createRealtimeTTSPlayer({
            createContextParameters: { create: create, contextId: contextId }
        });
    }

    function sendText(step, contextId, text, flush) {
        var msg = { send_text: { text: text } };
        if (flush) msg.send_text.flush_context = {};
        // VoxTTS-плеер в каскаде шлёт без contextId — держим так же.
        if (step.provider === "inworld") msg.contextId = contextId;
        player.send(msg);
    }

    function runStep(step) {
        var contextId = "step-" + stepIndex;
        var sentAt = 0;
        var startedAt = 0;
        var r = {
            title: step.title,
            model: step.provider === "voxtts" ? "voxtts/Anna" : step.model,
            chars: (step.text || (step.pieces || []).join("")).length,
            ready: "-", started: "-", ttfb: "-", audio: "-", total: "-", end: "-"
        };
        results.push(r);
        stepDone = false;

        function complete(reason) {
            if (stepDone) return;
            stepDone = true;
            r.end = reason;
            log(step.title + " → " + reason);
            nextStep();
        }

        try {
            player = createPlayer(step, contextId);
        } catch (err) {
            log(step.title + " create failed: " + err);
            complete("create-error");
            return;
        }

        player.addEventListener(PlayerEvents.PlaybackReady, function() {
            r.ready = Date.now() - sentAt;
            log(step.title + " ready +" + r.ready + "ms");
        });
        player.addEventListener(PlayerEvents.Started, function() {
            startedAt = Date.now();
            r.started = startedAt - sentAt;
            log(step.title + " started +" + r.started + "ms");
        });
        player.addEventListener(PlayerEvents.AudioChunksPlaybackFinished, function(ev) {
            if (ev && ev.final === false) {
                log(step.title + " intermediate flush ttfb=" + ev.timeToFirstByte + "ms");
                return;
            }
            var now = Date.now();
            r.ttfb = ev && ev.timeToFirstByte;
            r.total = now - sentAt;
            if (startedAt) r.audio = now - startedAt;
            log(step.title + " model=" + r.model + " ttfb=" + r.ttfb + "ms audio=" + r.audio +
                "ms total=" + r.total + "ms");
            complete("finished");
        });
        player.addEventListener(PlayerEvents.Error, function(ev) {
            log(step.title + " ERROR " + JSON.stringify(ev && (ev.error || ev.reason || ev.code || ev)));
            complete("error");
        });

        player.sendMediaTo(call);
        sentAt = Date.now();

        if (step.pieces) {
            step.pieces.forEach(function(piece, i) {
                setTimeout(function() {
                    if (stepDone) return;
                    var last = i === step.pieces.length - 1;
                    sendText(step, contextId, piece, last);
                    log(step.title + " piece " + (i + 1) + (last ? " (flush)" : "") + " +" + (Date.now() - sentAt) + "ms");
                }, i * step.pieceGapMs);
            });
        } else {
            sendText(step, contextId, step.text, true);
        }

        if (step.clearAfterMs) {
            setTimeout(function() {
                if (stepDone || !player) return;
                player.clearBuffer();
                log(step.title + " clearBuffer at +" + (Date.now() - sentAt) + "ms");
                complete("cleared");
            }, step.clearAfterMs);
        }

        // Страховка: событие окончания может не прийти.
        var myIndex = stepIndex;
        setTimeout(function() {
            if (!stepDone && stepIndex === myIndex) complete("timeout");
        }, STEP_TIMEOUT_MS);
    }

    call.addEventListener(CallEvents.Connected, function() {
        log("call connected, voice=" + INWORLD_VOICE + ", steps=" + STEPS.length);
        nextStep();
    });
    call.addEventListener(CallEvents.Disconnected, function() { finish("caller hung up"); });
    call.addEventListener(CallEvents.Failed, function() { VoxEngine.terminate(); });

    setTimeout(function() { finish("session limit"); }, SESSION_LIMIT_MS);

    call.answer();
});
