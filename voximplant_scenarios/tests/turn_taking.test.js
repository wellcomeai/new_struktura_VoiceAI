/**
 * Регрессии turn-taking каскадных сценариев.
 *
 * Сценарии 1-3 воспроизводят то, на что жаловались пользователи по продовым
 * логам (перебивание клиента на микропаузе, фолбэк поверх вердикта детектора,
 * протухшее предсказание). Остальные закрывают механики, добавленные при
 * починке, и следят, чтобы лечение не стоило латентности на чистом ходе.
 *
 * Запуск: node voximplant_scenarios/tests/turn_taking.test.js
 */
const { run } = require("./turn_taking_harness");

// Политика как в продовых сценариях каскада.
const POLICY = {
    confidentEouProbability: 0.8,
    transcriptSettleFastMs: 120,
    transcriptSettleMs: 350,
    userSpeechTimeoutMs: 900,
    vetoStrongProbability: 0.15,
    vetoSoftProbability: 0.4,
    vetoHoldStrongMs: 2000,
    vetoHoldSoftMs: 1400,
    maxVetoHolds: 3,
    maxTurnHoldMs: 4000,
    interimStableMs: 400,
    maxInterimWaitMs: 1500,
    userSpeakingRecheckMs: 250,
    userSpeakingMaxHoldMs: 15000,
    reconcileWindowMs: 5000,
    bargeInMinSpeechMs: 150,
    shortUtteranceExtensionMs: 900,
    fastShortUtteranceTimeoutMs: 500,
    shortUtteranceMaxChars: 12,
    shortUtteranceMaxWords: 2,
    lowConfidenceShortUtteranceThreshold: 0.75,
    continuationTokens: ["и", "а", "но", "ну", "вот", "так", "значит", "короче", "эм", "ээ", "мм", "это"],
    trailingContinuationTokens: ["чтобы", "потому", "который", "которая", "которое", "которые", "про", "либо", "если", "когда", "пока", "хотя"],
    completeShortAnswers: ["да", "нет", "ок", "окей", "хорошо", "ага", "угу", "не", "стоп", "верно", "точно", "конечно", "давай", "давайте", "спасибо", "понятно", "нет спасибо", "да давайте"],
    speculativeEouProbability: 0.6,
};

let failed = 0;
const check = (name, cond, detail) => {
    if (cond) { console.log(`  ✔ ${name}`); }
    else { failed++; console.log(`  ✘ ${name}\n      ${detail}`); }
};

async function t1_logRepro() {
    console.log("\n[1] Репро из лога сессии 4908941612 (микропауза 0.33с внутри фразы)");
    // Времена — фактическая доставка событий из лога, приведённая к t=0.
    const { turns, corrections } = await run([
        { at: 0,    kind: "interim", text: "здрасьте" },
        { at: 300,  kind: "speechEnd" },              // VAD speechEnd @-1.01с (лаг Silero)
        { at: 441,  kind: "speechStart" },            // клиент продолжает говорить
        { at: 560,  kind: "turn", endOfTurn: true, p: 0.5 }, // вердикт ДЛЯ ПРОШЛОГО сегмента
        { at: 1200, kind: "interim", text: "здрасьте а у меня" },
        { at: 1600, kind: "interim", text: "здрасьте а у меня александр" },
        { at: 2100, kind: "speechEnd" },
        { at: 2300, kind: "turn", endOfTurn: true, p: 0.92 },
        { at: 3000, kind: "final", text: "Здрасьте а у меня александр" },
    ], { policy: POLICY });

    check("ход закрыт ровно один раз", turns.length === 1,
        `закрытий: ${turns.length} -> ${JSON.stringify(turns)}`);
    check("в LLM ушла полная фраза, а не «здрасьте»",
        turns.length === 1 && /александр/i.test(turns[0].input),
        `ушло: "${turns[0] && turns[0].input}"`);
    check("закрытие произошло после того, как клиент договорил",
        turns.length === 1 && turns[0].at > 2100,
        `закрытие на ${turns[0] && turns[0].at}мс (речь кончилась на 2100мс)`);
    check("реконсиляция не понадобилась (текст и так полный)",
        corrections.length === 0, JSON.stringify(corrections));
}

async function t2_veto() {
    console.log("\n[2] Вето детектора: endOfTurn=false, p=0.021 (причина №2 из фидбэка)");
    const { turns, lines } = await run([
        { at: 0,    kind: "speechStart" },
        { at: 100,  kind: "interim", text: "меня зовут" },
        { at: 400,  kind: "speechEnd" },
        { at: 600,  kind: "turn", endOfTurn: false, p: 0.021 }, // раньше игнорировалось
        { at: 1500, kind: "interim", text: "меня зовут владимир вот машина 2014 года" },
        { at: 2000, kind: "speechEnd" },
        { at: 2200, kind: "turn", endOfTurn: true, p: 0.9 },
    ], { policy: POLICY });

    check("вето зафиксировано в логе", lines.some((l) => l.includes("VETO_NOT_EOT")),
        "нет строки VETO_NOT_EOT");
    check("фолбэк не закрыл ход на 900мс вопреки вердикту",
        turns.length === 1 && turns[0].at > 1300,
        `закрытий ${turns.length}, первое на ${turns[0] && turns[0].at}мс`);
    check("в LLM ушёл полный текст с маркой и годом",
        turns.length === 1 && /2014/.test(turns[0].input),
        `ушло: "${turns[0] && turns[0].input}"`);
}

async function t3_stalePrediction() {
    console.log("\n[3] Протухшее предсказание: вердикт пришёл после начала нового сегмента");
    const { turns, lines } = await run([
        { at: 0,    kind: "speechStart" },
        { at: 50,   kind: "interim", text: "коробка вариатор" },
        { at: 300,  kind: "speechEnd" },
        { at: 350,  kind: "speechStart" },                    // клиент продолжил
        { at: 500,  kind: "turn", endOfTurn: true, p: 0.95 }, // вердикт для сегмента до паузы
        { at: 1400, kind: "interim", text: "коробка вариатор ниссан мурано 2012 года" },
        { at: 1900, kind: "speechEnd" },
        { at: 2100, kind: "turn", endOfTurn: true, p: 0.95 },
    ], { policy: POLICY });

    check("протухший вердикт отброшен", lines.some((l) => l.includes("STALE_PREDICTION")),
        "нет строки STALE_PREDICTION");
    check("ход не закрыт по обрезку «коробка вариатор»",
        turns.length === 1 && /мурано/i.test(turns[0].input),
        `закрытий ${turns.length}: ${JSON.stringify(turns.map((t) => t.input))}`);
}

async function t4_reconcile() {
    console.log("\n[4] Реконсиляция: поздний финал длиннее отправленного (лаг ASR)");
    const { turns, corrections } = await run([
        { at: 0,    kind: "speechStart" },
        { at: 50,   kind: "interim", text: "да" },
        { at: 400,  kind: "speechEnd" },
        { at: 700,  kind: "turn", endOfTurn: true, p: 0.95 },
        // финал приходит через ~2.6с — как в проде
        { at: 3400, kind: "final", text: "Да, меня зовут Сергей, но мне никто ничего не объяснял" },
    ], { policy: POLICY });

    check("ход закрылся по короткому «да»", turns.length === 1 && turns[0].input === "да",
        JSON.stringify(turns));
    check("обрезка поймана реконсиляцией", corrections.length === 1,
        `коррекций: ${corrections.length}`);
    check("полный текст доступен сценарию",
        corrections.length === 1 && /Сергей/.test(corrections[0].full),
        JSON.stringify(corrections[0] && corrections[0].full));
    check("коррекция привязана к правильному ходу",
        corrections.length === 1 && corrections[0].turnId === turns[0].version,
        `turnId=${corrections[0] && corrections[0].turnId} vs version=${turns[0] && turns[0].version}`);
}

async function t5_reconcileFalsePositive() {
    console.log("\n[5] Реконсиляция не срабатывает на чужой текст (не расширение)");
    const { turns, corrections } = await run([
        { at: 0,    kind: "speechStart" },
        { at: 50,   kind: "interim", text: "да" },
        { at: 400,  kind: "speechEnd" },
        { at: 700,  kind: "turn", endOfTurn: true, p: 0.95 },
        { at: 2000, kind: "final", text: "дальше по адресу ленина пять" }, // НЕ расширение «да»
    ], { policy: POLICY });

    check("ложная коррекция не сработала", corrections.length === 0,
        JSON.stringify(corrections));
    check("новый текст не потерян — открыт следующий ход",
        turns.length === 2 && /ленина/.test(turns[1].input),
        `ходы: ${JSON.stringify(turns.map((t) => t.input))}`);
}

async function t6_bargeIn() {
    console.log("\n[6] Barge-in считается только когда агент реально звучит");
    // Агент молчит: сегменты VAD не должны считаться перебиванием.
    const silent = await run([
        { at: 0,   kind: "speechStart" },
        { at: 300, kind: "speechEnd" },
        { at: 500, kind: "speechStart" },
        { at: 800, kind: "speechEnd" },
        { at: 900, kind: "interim", text: "здравствуйте а мне бы узнать ваш адрес" },
        { at: 1200, kind: "speechEnd" },
        { at: 1400, kind: "turn", endOfTurn: true, p: 0.95 },
    ], { policy: POLICY, agentSpeaking: () => false });
    check("агент молчит -> ни одного перебивания", silent.interrupts.length === 0,
        `перебиваний: ${silent.interrupts.length}`);
    check("подавленные barge-in попали в статистику",
        silent.tt.stats().bargeInsSuppressed >= 2,
        JSON.stringify(silent.tt.stats()));

    // Агент говорит: настоящее перебивание должно пройти.
    const speaking = await run([
        { at: 0,   kind: "speechStart" },
        { at: 200, kind: "interim", text: "стоп" },
        { at: 600, kind: "speechEnd" },
        { at: 800, kind: "turn", endOfTurn: true, p: 0.95 },
    ], { policy: POLICY, agentSpeaking: () => true });
    check("агент говорит -> перебивание проходит", speaking.interrupts.length === 1,
        `перебиваний: ${speaking.interrupts.length}`);
}

async function t7_noRegression() {
    console.log("\n[7] Обычный чистый ход не тормозится лишними удержаниями");
    const { turns } = await run([
        { at: 0,    kind: "speechStart" },
        { at: 100,  kind: "interim", text: "хочу записаться на завтра" },
        { at: 600,  kind: "final", text: "Хочу записаться на завтра" },
        { at: 700,  kind: "speechEnd" },
        { at: 850,  kind: "turn", endOfTurn: true, p: 0.97 },
    ], { policy: POLICY });

    check("ход закрыт один раз", turns.length === 1, JSON.stringify(turns));
    check("закрытие сразу по вердикту, без лишнего ожидания",
        turns.length === 1 && turns[0].at < 1000,
        `закрытие на ${turns[0] && turns[0].at}мс (вердикт на 850мс)`);
    check("причина — уверенный конец хода",
        turns.length === 1 && turns[0].reason === "TURN_DETECT: END_OF_TURN",
        `reason=${turns[0] && turns[0].reason}`);
}

async function t8_vadStuck() {
    console.log("\n[8] Защита от залипшего VAD (speechStart без speechEnd)");
    const p = Object.assign({}, POLICY, { userSpeakingMaxHoldMs: 800 });
    const { turns, lines } = await run([
        { at: 0,   kind: "speechStart" },
        { at: 100, kind: "interim", text: "алло" },
        { at: 300, kind: "speechEnd" },
        { at: 350, kind: "speechStart" },  // и больше никаких speechEnd
        { at: 500, kind: "turn", endOfTurn: true, p: 0.95 },
    ], { policy: p });

    check("аварийное закрытие сработало", turns.length === 1, JSON.stringify(turns));
    check("залипание зафиксировано в логе", lines.some((l) => l.includes("VAD_WATCHDOG")),
        "нет строки VAD_WATCHDOG");
    check("закрытие помечено как принудительное",
        turns.length === 1 && turns[0].reason === "FORCED_CLOSE", JSON.stringify(turns));
}

async function t9_emptySegment() {
    console.log("\n[9] Шум без текста не оставляет агента немым");
    const { turns, tt } = await run([
        { at: 0,   kind: "speechStart" }, // кашель: allowAgentAudio снимается
        { at: 200, kind: "speechEnd" },
    ], { policy: POLICY });

    check("ход не открыт — текста не было", turns.length === 0, JSON.stringify(turns));
    check("право говорить возвращено агенту", tt.canPlayAgentAudio() === true,
        "canPlayAgentAudio() === false: агент онемел до конца звонка");
}

(async () => {
    await t1_logRepro();
    await t2_veto();
    await t3_stalePrediction();
    await t4_reconcile();
    await t5_reconcileFalsePositive();
    await t6_bargeIn();
    await t7_noRegression();
    await t8_vadStuck();
    await t9_emptySegment();
    console.log(failed ? `\nПРОВАЛЕНО проверок: ${failed}` : "\nВсе проверки пройдены.");
    process.exit(failed ? 1 : 0);
})();
