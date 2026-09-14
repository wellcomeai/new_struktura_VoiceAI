/**
 * ПРОБА: доходит ли SIP-вызов из Voximplant до OpenAI GPT-Live.
 *
 * Одноразовый диагностический сценарий. Основной inbound_openai не трогает,
 * заливается и вешается на отдельное правило (или временно на тестовый номер).
 *
 * ЗАЧЕМ. Дока OpenAI (Telephony and SIP) требует для SIP-медиа TLS на
 * сигнализации и SRTP на аудио. TLS у VoxEngine.callSIP задокументирован
 * (sips:host:5061 либо ;transport=tls), а SRTP не упоминается ни в
 * CallSIPParameters, ни в доках, ни в voxengine.d.ts. Пока это не проверено,
 * весь вариант «Voximplant → SIP → OpenAI» — гадание.
 *
 * ЧТО ЭТА ПРОБА ОТВЕЧАЕТ (шаг 1, сигнализация):
 *   - доходит ли наш INVITE до OpenAI по TLS;
 *   - что именно отвечает их сторона (SIP-код и заголовки).
 *
 * ЧЕГО НЕ ОТВЕЧАЕТ. Порядок у OpenAI такой: INVITE → вебхук
 * live.transport.incoming нам → мы делаем POST /accept → и только тогда они
 * шлют 200 OK с SDP. Вебхука сейчас нет, поэтому до согласования медиа (а
 * значит и до вопроса про SRTP) проба, скорее всего, не доедет. Это нормально:
 * сначала надо убедиться, что транспорт вообще живой.
 *
 * КАК ЧИТАТЬ РЕЗУЛЬТАТ:
 *   Connected                     — дозвонились, медиа согласовано. Смотреть
 *                                   в логе поле encrypted: true = SRTP есть.
 *   Failed 4xx (401/403/404/486)  — TLS работает, INVITE дошёл, отлуп на
 *                                   уровне приложения. Транспорт живой,
 *                                   дальше нужен вебхук + accept.
 *   Failed 488                    — дошли до согласования медиа и не сошлись
 *                                   по кодеку/SRTP. Прямой ответ про SRTP.
 *   Failed 503/504, нет ответа    — не дошли вообще: TLS, маршрут или firewall.
 */

// platform.openai.com → Project → General. Вида proj_xxxxxxxx.
const OPENAI_PROJECT_ID = "proj_ЗАПОЛНИ_МЕНЯ";

// Европейская точка — ближе, чем US. Для US: sip.api.openai.com
const OPENAI_SIP_URI = "sip:" + OPENAI_PROJECT_ID + "@sip-eu.api.openai.com;transport=tls";

const PROBE_TIMEOUT_MS = 30000;

function dump(label, e) {
    var parts = [];
    for (var k in e) {
        if (k === "call") continue;                 // объект Call не сериализуется
        var v = e[k];
        parts.push(k + "=" + (typeof v === "object" ? JSON.stringify(v) : String(v)));
    }
    Logger.write("[SIP-PROBE] " + label + ": " + parts.join("  "));
}

var probed = false;

function probe() {
    if (probed) return;          // Started и CallAlerting оба сюда ведут — пускаем один раз
    probed = true;
    Logger.write("[SIP-PROBE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Logger.write("[SIP-PROBE] цель: " + OPENAI_SIP_URI);

    if (OPENAI_PROJECT_ID.indexOf("ЗАПОЛНИ") !== -1) {
        Logger.write("[SIP-PROBE] ❌ не задан OPENAI_PROJECT_ID — заполни константу в сценарии");
        VoxEngine.terminate();
        return;
    }

    var started = Date.now();
    var sip = VoxEngine.callSIP(OPENAI_SIP_URI, { callerid: "79311071031", displayName: "voicyfy-probe" });

    sip.addEventListener(CallEvents.Connected, function(e) {
        Logger.write("[SIP-PROBE] ✅ CONNECTED за " + (Date.now() - started) + " мс — INVITE принят, медиа согласовано");
        Logger.write("[SIP-PROBE] ⬇️ поле encrypted ниже и есть ответ про SRTP (true = есть)");
        dump("Connected", e);
        setTimeout(function() { try { sip.hangup(); } catch (err) {} VoxEngine.terminate(); }, 3000);
    });
    sip.addEventListener(CallEvents.Failed, function(e) {
        Logger.write("[SIP-PROBE] ⛔ FAILED за " + (Date.now() - started) + " мс — смотри code/reason");
        dump("Failed", e);
        VoxEngine.terminate();
    });
    sip.addEventListener(CallEvents.Disconnected, function(e) {
        Logger.write("[SIP-PROBE] 📴 DISCONNECTED за " + (Date.now() - started) + " мс");
        dump("Disconnected", e);
        VoxEngine.terminate();
    });

    setTimeout(function() {
        Logger.write("[SIP-PROBE] ⏳ таймаут " + PROBE_TIMEOUT_MS + " мс — ответа не было вообще "
            + "(TLS, маршрут или firewall)");
        try { sip.hangup(); } catch (err) {}
        VoxEngine.terminate();
    }, PROBE_TIMEOUT_MS);
}

// Работает двумя способами: по входящему звонку на тестовое правило
// и standalone через StartScenarios — входящий вызов пробе не нужен.
VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    Logger.write("[SIP-PROBE] входящий от " + e.callerid + " — отвечаем и пробуем SIP");
    e.call.answer();
    e.call.addEventListener(CallEvents.Disconnected, function() { VoxEngine.terminate(); });
    probe();
});

VoxEngine.addEventListener(AppEvents.Started, function() {
    // Запуск без звонка (StartScenarios): ждём секунду на случай, если следом
    // придёт CallAlerting, и только потом пробуем сами. Защёлка выше не даст
    // выстрелить дважды.
    setTimeout(probe, 1000);
});
