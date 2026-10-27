require(Modules.Inworld);
require(Modules.Recorder);   // без него VoxEngine.createRecorder не определён

/*
 * voice_samples_inworld.js — примеры голосов Inworld для Каскада без звонка.
 * ====================================================================
 * Запускает scripts/inworld_voice_samples.py через StartScenarios (правило
 * voice_samples_inworld на родительском аккаунте): синтез идёт через
 * Modules.Inworld на биллинге Voximplant, ключ Inworld не нужен.
 *
 * customData (JSON): { voices: ["Galina", ...], phrase: "...", model: "inworld-tts-2" }
 *
 * Голоса озвучиваются по очереди: плеер Inworld → Recorder (hd_audio, mp3
 * 48 кГц). Запись голоса называется "voice-sample-<голос>" — по этому имени
 * скрипт находит её в GetCallHistory (with_records) и копирует в R2.
 * В лог: ===SAMPLE=== <голос> ok|error <ttfb/причина> <url>.
 */

var DEFAULT_MODEL = "inworld-tts-2";
var LEAD_MS = 300;          // пауза записи до текста — чтобы не срезать начало
var TAIL_MS = 400;          // запас после конца озвучки до остановки записи
var VOICE_TIMEOUT_MS = 25000;
var SESSION_LIMIT_MS = 600000;

VoxEngine.addEventListener(AppEvents.Started, function() {
    var data = {};
    try { data = JSON.parse(VoxEngine.customData() || "{}"); } catch (err) {}
    var voices = Array.isArray(data.voices) ? data.voices : [];
    var phrase = data.phrase || "Это мой пример голоса, которым я буду говорить на платформе Voicyfy.";
    var model = data.model || DEFAULT_MODEL;
    var index = -1;

    function log(msg) { Logger.write("===SAMPLE=== " + msg); }

    if (!voices.length) {
        log("no voices in customData");
        VoxEngine.terminate();
        return;
    }
    log("start: " + voices.length + " voices, model=" + model);

    function next() {
        index++;
        if (index >= voices.length) {
            log("done");
            setTimeout(function() { VoxEngine.terminate(); }, 1000);
            return;
        }
        record(voices[index]);
    }

    function record(voice) {
        var done = false;
        var player = null;
        var recorder = null;
        try {
            recorder = VoxEngine.createRecorder({ name: "voice-sample-" + voice, hd_audio: true, secure: false });
        } catch (err) {
            log(voice + " error recorder " + err);
            setTimeout(next, 0);
            return;
        }

        function finish(status, info) {
            if (done) return;
            done = true;
            setTimeout(function() {
                try { recorder.stop(); } catch (err) {}
                try { if (player) player.stop(); } catch (err) {}
                log(voice + " " + status + " " + (info || ""));
                setTimeout(next, 500);
            }, status === "ok" ? TAIL_MS : 0);
        }

        recorder.addEventListener(RecorderEvents.Started, function(e) {
            log(voice + " recording " + e.url);
        });
        recorder.addEventListener(RecorderEvents.RecorderError, function(e) {
            finish("error", "recorder " + JSON.stringify(e && (e.error || e)));
        });

        try {
            player = Inworld.createRealtimeTTSPlayer({
                createContextParameters: { create: { voiceId: voice, modelId: model } }
            });
        } catch (err) {
            finish("error", "create " + err);
            return;
        }
        player.addEventListener(PlayerEvents.AudioChunksPlaybackFinished, function(e) {
            finish("ok", "ttfb=" + (e && e.timeToFirstByte) + "ms");
        });
        player.addEventListener(PlayerEvents.Error, function(e) {
            finish("error", "player " + JSON.stringify(e && (e.error || e.reason || e)));
        });
        player.sendMediaTo(recorder);

        setTimeout(function() {
            if (done) return;
            player.send({ send_text: { text: phrase, flush_context: {} } });
        }, LEAD_MS);
        setTimeout(function() { finish("error", "timeout"); }, VOICE_TIMEOUT_MS);
    }

    setTimeout(function() { log("session limit"); VoxEngine.terminate(); }, SESSION_LIMIT_MS);
    next();
});
