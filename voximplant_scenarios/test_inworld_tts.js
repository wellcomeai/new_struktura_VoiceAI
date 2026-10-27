/**
 * test_inworld_tts.js — проверка озвучки Inworld (Modules.Inworld) в звонке.
 *
 * Разовый тестовый сценарий, в прод-правила не подключается. Загрузить на
 * аккаунт, где есть тестовый номер, повесить на номер правило с этим
 * сценарием и позвонить. Ключ Inworld не передаётся — синтез идёт на биллинге
 * Voximplant (тариф «Inworld», $0.00025 за 10 символов).
 *
 * Что проверяем (результаты — в логе сессии, маркеры ===INWORLD===):
 *   1–3. Голос INWORLD_VOICE на моделях inworld-tts-2 / 1.5-max / 1.5-mini:
 *        TTFB от Voximplant (timeToFirstByte) и полное время фразы.
 *        В тексте время и сумма цифрами — слышно, читает ли модель числа
 *        по-русски (нормализации русского у Inworld нет).
 *   4.   Текст кусками без flush, как дельты модели в каскаде: начинается ли
 *        синтез до flush_context.
 *   5.   Перебивание: clearBuffer() посреди длинной фразы — звук должен
 *        оборваться сразу.
 *   6.   Новая фраза после clearBuffer на новом плеере.
 */
require(Modules.Inworld);

var INWORLD_VOICE = "Galina";
var STEP_PAUSE_MS = 700;
var SESSION_LIMIT_MS = 180000;

var NUMBERS_TEXT = "Записала вас на консультацию завтра в 15:30, стоимость 2500 рублей.";

var STEPS = [
    { title: "tts-2",        model: "inworld-tts-2",
      text: "Здравствуйте! Это модель TTS два. " + NUMBERS_TEXT },
    { title: "tts-1.5-max",  model: "inworld-tts-1.5-max",
      text: "Это модель полтора макс. " + NUMBERS_TEXT },
    { title: "tts-1.5-mini", model: "inworld-tts-1.5-mini",
      text: "Это модель полтора мини. " + NUMBERS_TEXT },
    { title: "stream-pieces", model: "inworld-tts-2", pieceGapMs: 150,
      pieces: ["Теперь текст приходит кусками, ", "как ответ языковой модели, ",
               "а последний кусок закрывает фразу."] },
    { title: "barge-in",     model: "inworld-tts-2", clearAfterMs: 2500,
      text: "Сейчас будет длинная фраза, которую тест оборвёт посередине. " +
            "Если вы слышите это предложение целиком, значит очистка буфера не сработала, " +
            "и перебивание в звонке работать не будет." },
    { title: "after-clear",  model: "inworld-tts-2",
      text: "Перебивание проверено. Тест окончен, до свидания!" }
];

VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    var call = e.call;
    var player = null;
    var stepIndex = -1;
    var stepDone = false;

    function log(msg) {
        Logger.write("===INWORLD=== " + msg);
    }

    function finish() {
        log("done");
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
            setTimeout(finish, 500);
            return;
        }
        setTimeout(function() { runStep(STEPS[stepIndex]); }, STEP_PAUSE_MS);
    }

    function completeStep(reason) {
        if (stepDone) return;
        stepDone = true;
        log(STEPS[stepIndex].title + " → " + reason);
        nextStep();
    }

    function runStep(step) {
        var contextId = "step-" + stepIndex;
        var sentAt = 0;
        stepDone = false;

        try {
            player = Inworld.createRealtimeTTSPlayer({
                createContextParameters: {
                    create: { voiceId: INWORLD_VOICE, modelId: step.model },
                    contextId: contextId
                }
            });
        } catch (err) {
            log(step.title + " create failed: " + err);
            completeStep("create error");
            return;
        }

        player.addEventListener(PlayerEvents.Started, function() {
            log(step.title + " started +" + (Date.now() - sentAt) + "ms");
        });
        player.addEventListener(PlayerEvents.AudioChunksPlaybackFinished, function(ev) {
            log(step.title + " model=" + step.model + " voice=" + INWORLD_VOICE +
                " ttfb=" + (ev && ev.timeToFirstByte) + "ms total=" + (Date.now() - sentAt) + "ms");
            completeStep("finished");
        });
        player.addEventListener(PlayerEvents.Error, function(ev) {
            log(step.title + " ERROR " + JSON.stringify(ev && (ev.error || ev.reason || ev.code || ev)));
            completeStep("error");
        });

        player.sendMediaTo(call);
        sentAt = Date.now();

        if (step.pieces) {
            step.pieces.forEach(function(piece, i) {
                setTimeout(function() {
                    if (stepDone) return;
                    var last = i === step.pieces.length - 1;
                    var msg = { send_text: { text: piece }, contextId: contextId };
                    if (last) msg.send_text.flush_context = {};
                    player.send(msg);
                    log(step.title + " piece " + (i + 1) + (last ? " (flush)" : "") + " +" + (Date.now() - sentAt) + "ms");
                }, i * step.pieceGapMs);
            });
        } else {
            player.send({ send_text: { text: step.text, flush_context: {} }, contextId: contextId });
        }

        if (step.clearAfterMs) {
            setTimeout(function() {
                if (stepDone || !player) return;
                player.clearBuffer();
                log(step.title + " clearBuffer at +" + (Date.now() - sentAt) + "ms");
                completeStep("cleared");
            }, step.clearAfterMs);
        }

        // Страховка: событие окончания может не прийти.
        setTimeout(function() {
            if (!stepDone && stepIndex === STEPS.indexOf(step)) completeStep("timeout 20s");
        }, 20000);
    }

    call.addEventListener(CallEvents.Connected, function() {
        log("call connected, voice=" + INWORLD_VOICE);
        nextStep();
    });
    call.addEventListener(CallEvents.Disconnected, function() { VoxEngine.terminate(); });
    call.addEventListener(CallEvents.Failed, function() { VoxEngine.terminate(); });

    setTimeout(function() { log("session limit"); finish(); }, SESSION_LIMIT_MS);

    call.answer();
});
