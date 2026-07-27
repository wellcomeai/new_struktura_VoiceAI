/**
 * outbound_cascade — ИСХОДЯЩИЙ full-cascade Voice AI сценарий Voicyfy.
 *
 *   STT:  встроенный ASR (Yandex v2, streaming + interim), язык из конфига
 *   LLM:  OpenAI gpt-5.4-nano — Chat Completions (stateless, ручная история) + tool calling
 *   TTS:  VoxTTS (realtime-стриминг, голоса Anna/Sergey)
 *   Turn-taking: Silero VAD + Pipecat Smart Turn через VoxTurnTaking
 *
 * ОТЛИЧИЯ ОТ inbound_cascade:
 *  1. Точка входа — AppEvents.Started + VoxEngine.customData() (не CallAlerting).
 *  2. Мы САМИ звоним: VoxEngine.callPSTN(phone, caller_id).
 *  3. Конфиг — /api/telephony/outbound-config?assistant_id=...&assistant_type=cascade.
 *  4. Контекст звонка (задача + CRM) инжектится в system-промпт.
 *  5. READINESS-BEFORE-DIAL: клиент OpenAI / TTS / ASR готовим ДО дозвона — если
 *     что-то не поднялось, PSTN не набираем (0₽ телефонии).
 *  6. MUTE-окно: первые mute_duration_ms после ответа мик абонента закрыт
 *     (флаг micOpen) — «Алло»/шум при поднятии трубки не обрывают приветствие.
 *  7. TOOL CALLING: ассистент может вызывать функции (в т.ч. hangup_call, чтобы
 *     самому завершить звонок). Разбор tool_calls из сырого OpenAI-чанка.
 *  8. Silence hard-timeout ~180с (защита от автоответчика/тишины). Session-TTL
 *     НЕ нужен (это лимит Gemini Live; у Chat Completions его нет).
 *
 * СПЕКУЛЯЦИЯ здесь НЕ используется (в отличие от inbound): в реальных тестах она
 * не срабатывала (быстрый endpointing её вытесняет), а совмещать её с tool-calling
 * небезопасно (спекулятивно выполнять функцию нельзя). Один LLM-клиент, гейтинг
 * по completion-id сохранён.
 *
 * ТРЕБОВАНИЯ:
 * 1. Правило outbound_cascade — цепочка [vox-turn-taking, outbound_cascade].
 * 2. Запуск: StartScenarios с script_custom_data (phone_number, assistant_id,
 *    caller_id, contact_name, task_title, task_description, custom_greeting, task).
 */

require(Modules.ASR);
require(Modules.OpenAI);
require(Modules.VoxTTS);
require(Modules.Recorder);
require(Modules.Silero);
require(Modules.Pipecat);
// ===== BEGIN INLINE VoxTurnTaking (auto-synced from vox-turn-taking.js) =====
// Идемпотентно: если правило — цепочка [vox-turn-taking, outbound_cascade], то
// vox-turn-taking.js уже объявил глобальный VoxTurnTaking (const) → typeof !==
// "undefined" → это определение ПРОПУСКАЕТСЯ. Если правило одиночное —
// объявляем здесь. Присваивание без const/var, чтобы не конфликтовать с
// const-объявлением в цепочечном режиме.
//
// НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ: блок генерируется скриптом
// voximplant_scenarios/tools/sync_inline_runtime.py из vox-turn-taking.js.
if (typeof VoxTurnTaking === "undefined") {
    // eslint-disable-next-line no-global-assign, no-undef
    VoxTurnTaking = {

        DEFAULTS: {
            vadOptions: {
                // Для русской разговорной речи паузы 0.3-0.5с внутри фразы — норма
                // («пока не знаю... машина у вас»). 200-300мс дробили одну фразу на
                // сегменты: отсюда лишние barge-in и закрытие хода на границе
                // ложного сегмента.
                //
                // 500мс — компромисс скорость/перебивания. Каждые убранные 100мс
                // напрямую снимают 100мс с ответа, но перекладывают ответственность
                // на смысловой детектор: защиты рантайма срабатывают на его
                // НЕСОГЛАСИЕ, а если он на паузе внутри фразы ошибочно скажет «ход
                // закончен» — мы ответим и никакая защита не поможет. Насколько
                // Pipecat Smart Turn надёжен на русском, пока не измерено, поэтому
                // ниже 500мс не опускаться без звонка с «мямлящим» собеседником.
                threshold: 0.5,
                minSilenceDurationMs: 500,
                // 10мс срезало края сегментов. 200мс — слышимый запас по краям.
                speechPadMs: 200,
            },
            turnDetectorOptions: {
                threshold: 0.5,
            },
            policy: {
                // ── Закрытие хода по вердикту детектора ────────────────────────
                //  - p >= confidentEouProbability: фраза уверенно закончена ->
                //    быстрый settle;
                //  - серая зона -> осторожный settle.
                confidentEouProbability: 0.95,
                transcriptSettleFastMs: 120,
                transcriptSettleMs: 350,

                // ── Страховочный таймаут (фолбэк) ──────────────────────────────
                // Взводится на speechEnd. Больше НЕ является основным механизмом
                // закрытия: детектор может его отодвинуть (см. вето ниже).
                userSpeechTimeoutMs: 900,

                // ── Вето детектора (лечение причины №3) ────────────────────────
                // endOfTurn=false -> отодвигаем закрытие тем сильнее, чем увереннее
                // детектор в том, что фраза не закончена.
                vetoStrongProbability: 0.15, // p < 0.15 — «точно не договорил»
                vetoSoftProbability: 0.4,    // p < 0.40 — «скорее не договорил»
                vetoHoldStrongMs: 2000,
                vetoHoldSoftMs: 1400,
                maxVetoHolds: 3,
                // Абсолютный потолок удержания одного хода от первого speechEnd —
                // чтобы вето не подвесило разговор.
                maxTurnHoldMs: 4000,

                // ── Стабильность транскрипта (лечение причины №1, часть 2) ─────
                // Не закрываем ход, пока ASR ещё дописывает текст. Признак по
                // факту, а не по таймеру: сколько прошло с последнего изменения.
                interimStableMs: 400,
                maxInterimWaitMs: 1500,

                // Перепроверка «клиент всё ещё говорит?».
                userSpeakingRecheckMs: 250,
                // Аварийный потолок: если VAD залип в speech, через столько мс
                // закрываем ход принудительно, иначе агент немой до конца звонка.
                userSpeakingMaxHoldMs: 15000,

                // ── Реконсиляция позднего финала ───────────────────────────────
                reconcileWindowMs: 5000,

                // ── Barge-in ───────────────────────────────────────────────────
                bargeInMinSpeechMs: 150,

                // ── Эвристики коротких реплик (из v1) ──────────────────────────
                shortUtteranceExtensionMs: 900,
                fastShortUtteranceTimeoutMs: 500,
                shortUtteranceMaxChars: 12,
                shortUtteranceMaxWords: 2,
                lowConfidenceShortUtteranceThreshold: 0.75,
                continuationTokens: ["and", "but", "so", "well", "then", "uh", "um"],
                trailingContinuationTokens: [],
                completeShortAnswers: [],

                // Порог вероятности EOU, при котором ход считается ГОТОВЫМ к ранней
                // (спекулятивной) подаче через onSpeculativeTurn.
                speculativeEouProbability: 0.7,
            },
        },

        async create(options) {
            const {
                call,
                stt,
                onUserTurn,
                onInterrupt,
                // Ранний сигнал для спекулятивной генерации. Опционален.
                onSpeculativeTurn,
                // Поздний ASR-финал расширил уже отправленный текст. Опционален.
                // (fullText, turnId, { sentText, lagMs })
                onTurnCorrection,
                // Звучит ли агент прямо сейчас. Нужен, чтобы barge-in считался
                // только настоящим перебиванием, а не любым сегментом VAD.
                isAgentSpeaking,
                enableLogging = false,
                logger = (line) => Logger.write(line),
            } = options;
            const vadOptions = Object.assign({}, this.DEFAULTS.vadOptions, options.vadOptions);
            const turnDetectorOptions = Object.assign(
                {},
                this.DEFAULTS.turnDetectorOptions,
                options.turnDetectorOptions
            );
            const policy = Object.assign({}, this.DEFAULTS.policy, options.policy);

            const vad = await Silero.createVAD(vadOptions);
            const turnDetector = await Pipecat.createTurnDetector(turnDetectorOptions);

            call.sendMediaTo(vad);
            call.sendMediaTo(turnDetector);

            const log = (line) => {
                if (enableLogging) logger(line);
            };
            const emitModuleEvent = (eventName, event) => {
                logger(`===${eventName}===`);
                if (event) logger(JSON.stringify(event));
            };

            // ── Таймеры ────────────────────────────────────────────────────────
            let closeTimer = null;   // фолбэк / отложенное закрытие
            let settleTimer = null;  // окно ожидания после вердикта детектора
            let bargeInTimer = null; // дебаунс перебивания
            let stuckTimer = null;   // сторож залипшего VAD

            // ── Транскрипт ─────────────────────────────────────────────────────
            let finalTranscript = "";
            let interimTranscript = "";
            let transcriptSeparator = "";
            let lastTranscriptChangeAt = 0;
            let stabilityWaitStartedAt = 0;
            let lastFinalConfidence = 1;
            let replaceableShortFinal = false;
            let shortExtensionApplied = false;
            let acceptingTranscript = false;

            // ── Счётчики поколений (лечение причины №2) ────────────────────────
            // turnId    — растёт ТОЛЬКО при сабмите. Отдаётся сценарию как version.
            // segmentId — растёт на каждом speechStart. Гейтит таймеры/предсказания.
            let turnId = 0;
            let segmentId = 0;

            // ── Состояние речи клиента (лечение причины №1) ────────────────────
            let userSpeaking = false;
            let userSpeakingSince = 0;
            let turnHoldStartedAt = 0; // первый speechEnd текущего хода
            let vetoHolds = 0;

            // ── Состояние детектора ────────────────────────────────────────────
            let smartTurnComplete = false;
            let predictSegment = -1;   // segmentId в момент predict()
            let speculativeFiredForSegment = -1;

            // ── Прочее ─────────────────────────────────────────────────────────
            let allowAgentAudio = true;
            let submitted = null; // { turnId, norm, raw, at } — для реконсиляции

            const stats = {
                segments: 0,
                closes: {},
                holdsUserSpeaking: 0,
                holdsUnstable: 0,
                holdsVeto: 0,
                stalePredictions: 0,
                bargeIns: 0,
                bargeInsSuppressed: 0,
                corrections: 0,
                correctionCharsGained: 0,
                renormalizedFinals: 0,
                forcedCloses: 0,
            };

            const clearTimers = () => {
                if (closeTimer) clearTimeout(closeTimer);
                if (settleTimer) clearTimeout(settleTimer);
                closeTimer = null;
                settleTimer = null;
            };

            const normalize = (text) =>
                (text || "")
                    .trim()
                    .toLowerCase()
                    .replace(/[.,!?;:…—-]+/gu, " ")
                    .replace(/\s+/gu, " ")
                    .trim();

            const normalizeConfidence = (value) => {
                if (typeof value !== "number" || Number.isNaN(value)) return null;
                return value > 1 ? value / 100 : value;
            };

            const isShortUtterance = (text) => {
                if (!text) return false;
                const words = text.trim().split(/\s+/).filter(Boolean);
                return (
                    text.length <= policy.shortUtteranceMaxChars &&
                    words.length <= policy.shortUtteranceMaxWords
                );
            };

            const startsWithContinuationToken = (text) => {
                if (!text) return false;
                const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase();
                return policy.continuationTokens.includes(firstWord);
            };

            // Завершённый короткий ответ из вайтлиста («да», «нет», «ок»...).
            const isCompleteShortAnswer = (text) => {
                const list = policy.completeShortAnswers || [];
                if (!list.length || !text) return false;
                const norm = text.trim().toLowerCase().replace(/[.,!?;:…]+$/u, "");
                return list.includes(norm);
            };

            // Фраза выглядит оборванной, если её последнее слово — предлог/союз/
            // вопросительное слово, после которого обычно следует продолжение.
            const endsWithContinuationToken = (text) => {
                if (!text) return false;
                const tokens = policy.trailingContinuationTokens || [];
                if (!tokens.length) return false;
                const words = text.trim().split(/\s+/);
                const lastWord = words[words.length - 1]
                    ?.toLowerCase()
                    .replace(/[.,!?;:…]+$/u, "");
                return tokens.includes(lastWord);
            };

            const buildInput = () => {
                let input = finalTranscript;
                if (interimTranscript) {
                    if (input) input += transcriptSeparator;
                    input += interimTranscript;
                }
                return input.trim();
            };

            const noteTranscriptChange = () => {
                lastTranscriptChangeAt = Date.now();
            };

            // Решение опирается на частичный результат, если финала ещё нет вовсе
            // либо поверх финала уже течёт новый interim (клиент продолжает).
            const leaningOnPartial = () => !finalTranscript || !!interimTranscript;

            // Отложить закрытие хода, сохранив исходную причину для логов/статистики.
            const deferClose = (delayMs, reason) => {
                if (closeTimer) clearTimeout(closeTimer);
                if (settleTimer) clearTimeout(settleTimer);
                settleTimer = null;
                const seg = segmentId;
                closeTimer = setTimeout(() => {
                    if (seg !== segmentId) return;
                    submitCurrentTurn(reason);
                }, delayMs);
            };

            const bumpClose = (reason, count) => {
                stats.closes[reason] = (stats.closes[reason] || 0) + (count || 1);
            };

            function submitCurrentTurn(reason) {
                const input = buildInput();
                if (!input) return false;

                const forced = reason === "FORCED_CLOSE";

                // ── ИНВАРИАНТ 1. Пока клиент говорит — ход не закрывается. ─────
                // Ровно этой проверки не было в v1, и именно её отсутствие давало
                // перебивание на микропаузе внутри фразы.
                if (!forced && userSpeaking) {
                    const held = userSpeakingSince ? Date.now() - userSpeakingSince : 0;
                    if (held < policy.userSpeakingMaxHoldMs) {
                        stats.holdsUserSpeaking += 1;
                        log(`===HOLD_USER_SPEAKING=== (${reason}) held=${held}ms :: ${input}`);
                        deferClose(policy.userSpeakingRecheckMs, reason);
                        return false;
                    }
                    // Аварийный выход: VAD, похоже, залип в speech.
                    log(`===VAD_STUCK=== speech активен ${held}ms, закрываем принудительно`);
                }

                // ── ИНВАРИАНТ 2. Текст ещё дописывается — ждём. ────────────────
                // Признак по факту («ASR дописал слово N мс назад»), а не по слепому
                // таймеру: это то, что реально отличает «фраза кончилась» от
                // «человек ещё говорит, а мы просто быстрее ASR».
                if (!forced && leaningOnPartial()) {
                    const sinceChange = Date.now() - (lastTranscriptChangeAt || 0);
                    if (sinceChange < policy.interimStableMs) {
                        if (!stabilityWaitStartedAt) stabilityWaitStartedAt = Date.now();
                        if (Date.now() - stabilityWaitStartedAt < policy.maxInterimWaitMs) {
                            stats.holdsUnstable += 1;
                            const wait = Math.max(60, policy.interimStableMs - sinceChange);
                            log(`===HOLD_TRANSCRIPT_UNSTABLE=== (${reason}) +${wait}ms :: ${input}`);
                            deferClose(wait, reason);
                            return false;
                        }
                        log(`===STABILITY_CAP=== ${policy.maxInterimWaitMs}ms исчерпаны, закрываем`);
                    }
                }

                // ── Эвристики коротких/оборванных реплик (из v1) ───────────────
                const isWhitelisted = isCompleteShortAnswer(input);

                if (
                    !forced &&
                    !isWhitelisted &&
                    reason !== "FALLBACK_END_OF_TURN" &&
                    endsWithContinuationToken(input) &&
                    !shortExtensionApplied
                ) {
                    shortExtensionApplied = true;
                    log(`===HOLD_TRAILING=== ${input}`);
                    deferClose(policy.shortUtteranceExtensionMs, reason);
                    return false;
                }

                if (!forced && !isWhitelisted && replaceableShortFinal && !shortExtensionApplied) {
                    shortExtensionApplied = true;
                    log(`===HOLD_SHORT_FINAL=== ${input}`);
                    deferClose(policy.shortUtteranceExtensionMs, reason);
                    return false;
                }

                // ── Закрываем ход ─────────────────────────────────────────────
                if (forced) stats.forcedCloses += 1;
                bumpClose(reason);
                log(`===${reason}===`);
                log(`===USER=== ${input}`);

                const closedTurnId = turnId;
                submitted = { turnId: closedTurnId, norm: normalize(input), raw: input, at: Date.now() };

                allowAgentAudio = true;
                onUserTurn(input, closedTurnId, reason);

                finalTranscript = "";
                interimTranscript = "";
                transcriptSeparator = "";
                smartTurnComplete = false;
                acceptingTranscript = false;
                lastFinalConfidence = 1;
                replaceableShortFinal = false;
                shortExtensionApplied = false;
                stabilityWaitStartedAt = 0;
                turnHoldStartedAt = 0;
                vetoHolds = 0;
                predictSegment = -1;
                turnId += 1;
                clearTimers();
                if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
                return true;
            }

            const startHardTimeout = (delay = policy.userSpeechTimeoutMs) => {
                clearTimers();
                const seg = segmentId;
                closeTimer = setTimeout(() => {
                    if (seg !== segmentId) return;
                    if (!buildInput()) {
                        // Сегмент речи закончился, а текста в нём не оказалось —
                        // кашель, шум линии, эхо. Возвращаем агенту право говорить:
                        // иначе allowAgentAudio, снятый на speechStart, останется
                        // снятым до следующего настоящего хода, и агент онемеет.
                        if (!allowAgentAudio && !userSpeaking) {
                            allowAgentAudio = true;
                            log("===EMPTY_SEGMENT=== текста нет, агенту возвращён голос");
                        }
                        return;
                    }
                    submitCurrentTurn("FALLBACK_END_OF_TURN");
                }, delay);
            };

            [
                Silero.VADEvents.ConnectorInformation,
                Silero.VADEvents.Error,
            ].forEach((eventName) => {
                vad.addEventListener(eventName, (event) => emitModuleEvent(eventName, event));
            });

            [
                Pipecat.TurnEvents.ConnectorInformation,
                Pipecat.TurnEvents.Error,
            ].forEach((eventName) => {
                turnDetector.addEventListener(eventName, (event) =>
                    emitModuleEvent(eventName, event)
                );
            });

            // ── ASR: промежуточные результаты ──────────────────────────────────
            stt.addEventListener(ASREvents.InterimResult, (event) => {
                if (!acceptingTranscript) return;
                const text = event?.text?.trim();
                if (!text) return;
                if (text === interimTranscript) return; // текст не изменился
                if (!transcriptSeparator && finalTranscript) transcriptSeparator = " ";
                interimTranscript = text;
                noteTranscriptChange();

                // Настоящее перебивание: агент звучит, а от клиента уже пошёл текст.
                // Это надёжнее таймера дебаунса — есть подтверждённая речь.
                if (userSpeaking && agentIsSpeaking()) fireBargeIn("interim");
            });

            // ── ASR: финальные результаты (+ реконсиляция) ─────────────────────
            stt.addEventListener(ASREvents.Result, (event) => {
                const text = event?.text?.trim();
                if (!text) return;
                const norm = normalize(text);

                // РЕКОНСИЛЯЦИЯ. Ход уже закрыт по interim, а полный текст пришёл
                // только сейчас (в проде — в среднем +4.6с). В v1 он молча
                // выбрасывался вместе с именем/маркой/годом; хуже того — мог
                // приклеиться к следующей реплике. Теперь: если финал расширяет
                // отправленное — отдаём сценарию как исправление.
                if (submitted && Date.now() - submitted.at <= policy.reconcileWindowMs) {
                    if (norm === submitted.norm) return; // дубль отправленного

                    // Расширение по границе слова: иначе «да» ложно совпадёт с
                    // «дальше» и мы починим ход чужим текстом.
                    const extendsSent =
                        submitted.norm &&
                        norm.length > submitted.norm.length &&
                        norm.indexOf(submitted.norm) === 0 &&
                        norm.charAt(submitted.norm.length) === " ";

                    // Yandex отдаёт финал ПЕРЕНОРМИРОВАННЫМ: interim «две тысячи
                    // тринадцатый» -> финал «2013», «двести тридцать четыре тысячи»
                    // -> «234000». Сверка по префиксу этого не узнаёт, поэтому
                    // одного её мало — иначе тот же самый отрезок речи уезжает в
                    // LLM вторым, фантомным ходом (в тестовом звонке так было
                    // 3 хода из 8, и один сбил ассистента с толку). Признак
                    // реальной обрезки, устойчивый к перенормировке: в финале
                    // СТАЛО БОЛЬШЕ слов, чем мы отправили.
                    const words = (s) => (s ? s.split(" ").filter(Boolean).length : 0);
                    const gotMoreWords = words(norm) > words(submitted.norm);

                    if (extendsSent || gotMoreWords) {
                        const lagMs = Date.now() - submitted.at;
                        const gained = text.length - submitted.raw.length;
                        stats.corrections += 1;
                        stats.correctionCharsGained += Math.max(0, gained);
                        log(
                            `===TURN_TRUNCATED=== lag=${lagMs}ms ` +
                            `sent="${submitted.raw}" full="${text}"`
                        );
                        const sentText = submitted.raw;
                        const correctedTurnId = submitted.turnId;
                        submitted = { turnId: correctedTurnId, norm, raw: text, at: submitted.at };
                        if (onTurnCorrection) {
                            onTurnCorrection(text, correctedTurnId, { sentText, lagMs });
                        }
                        return;
                    }

                    // Слов не прибавилось, а VAD о новой речи ещё не сообщил —
                    // значит это тот же отрезок аудио, просто записанный иначе.
                    // Новым ходом он быть не может: новую речь VAD объявил бы
                    // раньше, чем ASR успел отдать по ней финал.
                    if (!acceptingTranscript) {
                        stats.renormalizedFinals += 1;
                        log(`===ASR_RENORMALIZED=== sent="${submitted.raw}" final="${text}" — не новый ход`);
                        return;
                    }
                }

                // Финал пришёл раньше, чем VAD доложил о начале речи (Silero
                // отстаёт ~1с). Не теряем его — открываем ход этим текстом.
                let asrLedTurn = false;
                if (!acceptingTranscript) {
                    acceptingTranscript = true;
                    asrLedTurn = true;
                    finalTranscript = "";
                    interimTranscript = "";
                    transcriptSeparator = "";
                    log(`===ASR_LED_TURN=== финал раньше VAD :: ${text}`);
                }

                const confidence = normalizeConfidence(event?.confidence);
                const hadCommittedPrefix = !!finalTranscript;

                if (replaceableShortFinal) {
                    finalTranscript = text;
                } else {
                    if (finalTranscript) finalTranscript += transcriptSeparator || " ";
                    finalTranscript += text;
                }

                interimTranscript = "";
                transcriptSeparator = " ";
                noteTranscriptChange();
                lastFinalConfidence = confidence === null ? 1 : confidence;
                replaceableShortFinal =
                    isShortUtterance(text) &&
                    (
                        hadCommittedPrefix ||
                        lastFinalConfidence < policy.lowConfidenceShortUtteranceThreshold ||
                        startsWithContinuationToken(text)
                    );
                shortExtensionApplied = false;

                log(`===STT Final: ${event.text}`);

                if (
                    isShortUtterance(text) &&
                    !replaceableShortFinal &&
                    !smartTurnComplete &&
                    !userSpeaking
                ) {
                    startHardTimeout(
                        Math.min(policy.userSpeechTimeoutMs, policy.fastShortUtteranceTimeoutMs)
                    );
                } else if (asrLedTurn) {
                    // Ход открыт финалом ASR, а не VAD — значит speechEnd по нему не
                    // придёт и взводить закрытие некому. Без своего таймера такой ход
                    // повиснет навсегда (речь уже распознана, но в LLM не уходит).
                    startHardTimeout();
                }
                if (smartTurnComplete) submitCurrentTurn("TURN_DETECT: FINAL_TRANSCRIPT");
            });

            // ── Barge-in: только настоящее перебивание ─────────────────────────
            const agentIsSpeaking = () => {
                if (typeof isAgentSpeaking !== "function") return true;
                try {
                    return !!isAgentSpeaking();
                } catch (e) {
                    return true;
                }
            };

            let bargeInFiredForSegment = -1;
            const fireBargeIn = (why) => {
                if (bargeInFiredForSegment === segmentId) return;
                bargeInFiredForSegment = segmentId;
                if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null; }
                stats.bargeIns += 1;
                log(`===BARGE-IN=== (${why})`);
                if (onInterrupt) onInterrupt();
            };

            // Сторож залипшего VAD. Аварийная проверка внутри submitCurrentTurn
            // недостижима сама по себе: если speechEnd не пришёл, закрывать ход
            // просто некому — все таймеры взводятся именно на speechEnd. Поэтому
            // сторож взводится на speechStart и работает независимо.
            const armStuckWatchdog = () => {
                if (stuckTimer) clearTimeout(stuckTimer);
                const seg = segmentId;
                stuckTimer = setTimeout(() => {
                    stuckTimer = null;
                    if (seg !== segmentId || !userSpeaking) return;
                    if (!buildInput()) return;
                    log(`===VAD_WATCHDOG=== speech активен ${policy.userSpeakingMaxHoldMs}ms без speechEnd`);
                    submitCurrentTurn("FORCED_CLOSE");
                }, policy.userSpeakingMaxHoldMs);
            };

            vad.addEventListener(Silero.VADEvents.Result, (event) => {
                // Именно «поле присутствует», а не «истинно»: speechStartAt === 0
                // (начало сессии) — валидное значение и не должно теряться.
                const hasStart = event.speechStartAt !== undefined && event.speechStartAt !== null;
                const hasEnd = event.speechEndAt !== undefined && event.speechEndAt !== null;

                if (hasStart) {
                    segmentId += 1;
                    stats.segments += 1;
                    userSpeaking = true;
                    if (!userSpeakingSince) userSpeakingSince = Date.now();
                    clearTimers();
                    smartTurnComplete = false;
                    acceptingTranscript = true;
                    allowAgentAudio = false;
                    stabilityWaitStartedAt = 0;
                    armStuckWatchdog();
                    if (finalTranscript || interimTranscript) transcriptSeparator = " ... ";

                    // Раньше onInterrupt звался на КАЖДЫЙ speechStart — то есть был
                    // счётчиком сегментов VAD, а не перебиваний (184 за 22 минуты).
                    // Теперь: агент должен реально звучать, а речь — продержаться.
                    if (!agentIsSpeaking()) {
                        stats.bargeInsSuppressed += 1;
                    } else if (policy.bargeInMinSpeechMs > 0) {
                        if (bargeInTimer) clearTimeout(bargeInTimer);
                        const seg = segmentId;
                        bargeInTimer = setTimeout(() => {
                            bargeInTimer = null;
                            if (seg !== segmentId) return;
                            if (!userSpeaking) { stats.bargeInsSuppressed += 1; return; }
                            if (!agentIsSpeaking()) { stats.bargeInsSuppressed += 1; return; }
                            fireBargeIn("vad");
                        }, policy.bargeInMinSpeechMs);
                    } else {
                        fireBargeIn("vad");
                    }
                }

                if (hasEnd) {
                    userSpeaking = false;
                    userSpeakingSince = 0;
                    if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
                    if (!turnHoldStartedAt) turnHoldStartedAt = Date.now();
                    startHardTimeout();
                    // Штампуем предсказание текущим сегментом: результат, пришедший
                    // уже после начала следующего сегмента, будет отброшен.
                    predictSegment = segmentId;
                    turnDetector.predict();
                }
            });

            // ── Turn detector ─────────────────────────────────────────────────
            turnDetector.addEventListener(Pipecat.TurnEvents.Result, (event) => {
                const probability = event?.probability;
                log(
                    `===Pipecat.TurnEvents.Result=== p=${JSON.stringify(probability)} ` +
                    `eot=${!!event.endOfTurn} seg=${segmentId}/${predictSegment}`
                );

                // Ранний сигнал для спекуляции — не решение о закрытии, гейтим мягко.
                if (
                    !event.endOfTurn &&
                    typeof probability === "number" &&
                    probability >= policy.speculativeEouProbability &&
                    speculativeFiredForSegment !== segmentId
                ) {
                    const speculativeInput = buildInput();
                    if (speculativeInput) {
                        speculativeFiredForSegment = segmentId;
                        log(`===SPECULATIVE_READY=== p=${probability} :: ${speculativeInput}`);
                        if (onSpeculativeTurn) onSpeculativeTurn(speculativeInput, turnId);
                    }
                }

                // ЛЕЧЕНИЕ ПРИЧИНЫ №2. Вердикт относится к сегменту, который уже
                // закончился и сменился новым — клиент продолжил говорить, пока
                // детектор думал. Применять такой вердикт к текущей речи нельзя.
                if (predictSegment !== -1 && predictSegment !== segmentId) {
                    stats.stalePredictions += 1;
                    log(`===STALE_PREDICTION=== вердикт для сегмента ${predictSegment}, сейчас ${segmentId}`);
                    return;
                }

                // ЛЕЧЕНИЕ ПРИЧИНЫ №3. Детектор говорит «фраза не закончена» —
                // раньше это игнорировалось и фолбэк всё равно закрывал ход через
                // 700мс. Теперь вердикт отодвигает закрытие.
                if (!event.endOfTurn) {
                    if (typeof probability !== "number") return;
                    if (probability >= policy.vetoSoftProbability) return; // серая зона
                    const heldFor = turnHoldStartedAt ? Date.now() - turnHoldStartedAt : 0;
                    if (vetoHolds >= policy.maxVetoHolds || heldFor >= policy.maxTurnHoldMs) {
                        log(`===VETO_EXHAUSTED=== holds=${vetoHolds} held=${heldFor}ms`);
                        return;
                    }
                    vetoHolds += 1;
                    stats.holdsVeto += 1;
                    const hold =
                        probability < policy.vetoStrongProbability
                            ? policy.vetoHoldStrongMs
                            : policy.vetoHoldSoftMs;
                    log(`===VETO_NOT_EOT=== p=${probability} -> ждём ещё ${hold}ms (#${vetoHolds})`);
                    startHardTimeout(hold);
                    return;
                }

                smartTurnComplete = true;

                // Двухскоростной выбор окна ожидания.
                const confident =
                    (typeof probability === "number" &&
                        probability >= policy.confidentEouProbability) ||
                    isCompleteShortAnswer(buildInput());
                const settleMs = confident
                    ? policy.transcriptSettleFastMs
                    : policy.transcriptSettleMs;

                if (settleTimer) clearTimeout(settleTimer);

                if (finalTranscript && !interimTranscript && confident) {
                    submitCurrentTurn("TURN_DETECT: END_OF_TURN");
                    return;
                }

                const seg = segmentId;
                const reason = finalTranscript
                    ? "TURN_DETECT: END_OF_TURN_SETTLED"
                    : "TURN_DETECT: ASR_GRACE";
                settleTimer = setTimeout(() => {
                    if (seg !== segmentId) return;
                    submitCurrentTurn(reason);
                }, settleMs);
            });

            return {
                vad,
                turnDetector,
                canPlayAgentAudio() {
                    return allowAgentAudio;
                },
                currentVersion() {
                    return turnId;
                },
                isUserSpeaking() {
                    return userSpeaking;
                },
                stats() {
                    return stats;
                },
                statsSummary() {
                    const closes = Object.keys(stats.closes)
                        .map((k) => `${k}=${stats.closes[k]}`)
                        .join(" ");
                    return (
                        `segments=${stats.segments} | closes: ${closes || "none"} | ` +
                        `holds: speaking=${stats.holdsUserSpeaking} unstable=${stats.holdsUnstable} ` +
                        `veto=${stats.holdsVeto} | stale_predictions=${stats.stalePredictions} | ` +
                        `barge-in: real=${stats.bargeIns} suppressed=${stats.bargeInsSuppressed} | ` +
                        `truncations=${stats.corrections} (+${stats.correctionCharsGained} chars) | ` +
                        `renormalized=${stats.renormalizedFinals} | ` +
                        `forced=${stats.forcedCloses}`
                    );
                },
                close() {
                    clearTimers();
                    if (bargeInTimer) clearTimeout(bargeInTimer);
                    if (stuckTimer) clearTimeout(stuckTimer);
                    bargeInTimer = null;
                    stuckTimer = null;
                    vad?.close();
                    turnDetector?.close();
                },
            };
        },
    };
}
// ===== END INLINE VoxTurnTaking =====

const BACKEND_URL = "https://voicyfy.ru";
const LOG_URL = BACKEND_URL + "/api/voximplant/log";
const FUNCTIONS_URL = BACKEND_URL + "/api/voximplant/functions/execute";
const LLM_MODEL = "gpt-5.4-nano";
const LLM_REASONING_EFFORT = "none";
const SILENCE_HARD_TIMEOUT_MS = 180000;

const CC = OpenAI.ChatCompletionsAPIEvents;

function ccPayload(event) {
    return event?.data?.payload ?? event?.data ?? {};
}
function extractDelta(event) {
    const p = ccPayload(event);
    return p?.choices?.[0]?.delta?.content ?? "";
}
function extractCompletionId(event) {
    const p = ccPayload(event);
    return p?.id ?? p?.choices?.[0]?.id ?? "";
}
function extractFinishReason(event) {
    const p = ccPayload(event);
    const fr = p?.choices?.[0]?.finish_reason;
    return typeof fr === "string" && fr.length > 0 ? fr : "";
}
function extractToolCallDeltas(event) {
    const p = ccPayload(event);
    const tc = p?.choices?.[0]?.delta?.tool_calls;
    return Array.isArray(tc) ? tc : null;
}
function extractUsage(event) {
    // При stream_options.include_usage финальный чанк несёт usage с
    // prompt_tokens / completion_tokens (choices при этом пустой).
    const p = ccPayload(event);
    return p && p.usage ? p.usage : null;
}

const TELEPHONY_STYLE_RULES = `

Правила голосового ответа (телефония):
- Отвечай коротко, обычно 1-2 предложения, без списков, markdown и эмодзи.
- Числа, даты и время произноси словами.
- Если реплика оборвана или неясна — вежливо переспроси одним вопросом.`;

function asrProfileForLang(lang) {
    const map = {
        ru: ASRProfileList.Yandex.ru_RU,
        en: ASRProfileList.Yandex.en_US,
        de: ASRProfileList.Yandex.de_DE,
        es: ASRProfileList.Yandex.es_ES,
        fr: ASRProfileList.Yandex.fr_FR,
    };
    return map[(lang || "ru").toLowerCase()] || ASRProfileList.Yandex.ru_RU;
}
function asrModelForLang() {
    return ASRModelList.Yandex.general;
}
function voxttsVoice(voiceId) {
    return VoxTTS.VoiceList[voiceId] || VoxTTS.VoiceList.Anna;
}

async function fetchOutboundConfig(assistantId) {
    const url =
        `${BACKEND_URL}/api/telephony/outbound-config` +
        `?assistant_id=${encodeURIComponent(assistantId)}&assistant_type=cascade`;
    const response = await Net.httpRequestAsync(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (response.code !== 200 || !response.text) {
        Logger.write(`[OUT-CASCADE] Config HTTP error: ${response.code}`);
        return null;
    }
    try {
        const config = JSON.parse(response.text);
        return config && config.success ? config : null;
    } catch (e) {
        Logger.write(`[OUT-CASCADE] Config parse error: ${e}`);
        return null;
    }
}

let call_session_history_id = null;

VoxEngine.addEventListener(AppEvents.Started, async (e) => {
    call_session_history_id = e.sessionId;
    Logger.write(`[OUT-CASCADE] Session History ID: ${call_session_history_id}`);

    // --- Параметры звонка из customData ---
    let callData;
    try {
        callData = JSON.parse(VoxEngine.customData());
    } catch (err) {
        Logger.write(`[OUT-CASCADE] Bad customData: ${err}`);
        VoxEngine.terminate();
        return;
    }

    const PHONE_NUMBER = callData.phone_number;
    const ASSISTANT_ID = callData.assistant_id;
    const CALLER_ID = callData.caller_id || "";
    if (!PHONE_NUMBER || !ASSISTANT_ID) {
        Logger.write("[OUT-CASCADE] Missing phone_number/assistant_id");
        VoxEngine.terminate();
        return;
    }
    const MUTE_DURATION_MS = callData.mute_duration_ms || 3000;
    const CONTACT_NAME = callData.contact_name || "";
    const TASK_TITLE = callData.task_title || "";
    const TASK_DESCRIPTION = callData.task_description || "";
    const CUSTOM_GREETING = callData.custom_greeting || "";
    const API_TASK = callData.task || "";
    const FIRST_PHRASE_OVERRIDE = callData.first_phrase || "";

    const chat_id = "vox_" + Math.random().toString(36).substring(2, 15);
    const caller_number = "OUTBOUND: " + PHONE_NUMBER;

    let callType = "API";
    const isCrmCall = !!(CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION);
    if (isCrmCall && API_TASK) callType = "CRM+Task";
    else if (isCrmCall) callType = "CRM";
    else if (API_TASK) callType = "API+Task";

    // --- Состояние LLM/каскада ---
    let call;
    let stt;
    let llm;
    let ttsPlayer;
    let turnTaking;
    let greeting = "";

    const messages = []; // [0]=system, далее user/assistant/tool
    const main = { accepting: false, id: null, text: "", toolCalls: {}, version: -1 };
    const mainStaleIds = new Set();

    let tools = [];
    const functionNameToIdMap = {};

    let micOpen = false; // мик абонента открывается после mute-окна
    let terminating = false;
    let firstDeltaLoggedForTurn = false;
    let turnStartedAt = 0;
    const loggedShapes = new Set();

    // --- Данные для /log ---
    let record_url = null;
    let call_cost = 0;
    let call_duration = 0;
    // Учёт токенов LLM для списания кредитов каскада (все completion'ы звонка,
    // включая warmup и tool-раунды — всё это реальный расход на серверном ключе).
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const dialogLog = [];
    let userMessageBuffer = "";
    let assistantMessageBuffer = "";

    // --- Silence hard-timeout ---
    let hardTimer = null;
    const resetHardTimeout = () => {
        if (hardTimer) clearTimeout(hardTimer);
        hardTimer = setTimeout(() => {
            Logger.write(`[OUT-CASCADE] ===SILENCE_TIMEOUT=== ${SILENCE_HARD_TIMEOUT_MS / 1000}s`);
            terminateCall();
        }, SILENCE_HARD_TIMEOUT_MS);
    };

    const logShapeOnce = (tag, event) => {
        if (loggedShapes.has(tag)) return;
        loggedShapes.add(tag);
        try {
            Logger.write(`[OUT-CASCADE] ===SHAPE ${tag}=== ${JSON.stringify(event?.data)}`);
        } catch (e) {
            Logger.write(`[OUT-CASCADE] SHAPE ${tag} stringify error`);
        }
    };
    const logFirstDelta = (tag) => {
        if (firstDeltaLoggedForTurn) return;
        firstDeltaLoggedForTurn = true;
        const dt = turnStartedAt ? Date.now() - turnStartedAt : -1;
        Logger.write(`[OUT-CASCADE] ===FIRST_DELTA=== +${dt}ms${tag ? " " + tag : ""}`);
    };

    const logDialog = (role, text) => {
        if (!text) return;
        dialogLog.push({ role, text, ts: Date.now() });
        if (role === "user") {
            userMessageBuffer += (userMessageBuffer ? "\n" : "") + text;
        } else {
            assistantMessageBuffer += (assistantMessageBuffer ? "\n" : "") + text;
        }
    };

    // Заменяет обрезанную реплику клиента полным текстом — и в истории для LLM,
    // и в логе разговора (иначе имя/марка/год не доедут до CRM). Возвращает
    // true, если нашли что чинить.
    const replaceUserMessage = (oldText, newText) => {
        if (!oldText || !newText || oldText === newText) return false;
        let patched = false;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user" && messages[i].content === oldText) {
                messages[i].content = newText;
                patched = true;
                break;
            }
        }
        for (let i = dialogLog.length - 1; i >= 0; i--) {
            if (dialogLog[i].role === "user" && dialogLog[i].text === oldText) {
                dialogLog[i].text = newText;
                dialogLog[i].corrected = true;
                break;
            }
        }
        userMessageBuffer = dialogLog
            .filter((d) => d.role === "user")
            .map((d) => d.text)
            .join("\n");
        return patched;
    };

    const canPlay = () => turnTaking && turnTaking.canPlayAgentAudio();

    // --- Оценка «агент сейчас звучит» ---
    // Нужна turn-taking рантайму, чтобы barge-in считался только настоящим
    // перебиванием. Realtime-плеер VoxTTS не отдаёт событие окончания
    // воспроизведения, поэтому ведём оценку по объёму отданного в TTS текста
    // (~16 симв/с для русской речи). Оценка намеренно консервативна (скорее
    // недооценит длительность), чтобы не глушить настоящее перебивание.
    const TTS_MS_PER_CHAR = 60;
    const TTS_TAIL_MS = 300;
    let agentAudioUntil = 0;
    const noteAgentAudio = (text) => {
        if (!text) return;
        agentAudioUntil = Math.max(agentAudioUntil, Date.now()) + text.length * TTS_MS_PER_CHAR;
    };
    const stopAgentAudio = () => { agentAudioUntil = 0; };
    const isAgentSpeaking = () => Date.now() < agentAudioUntil + TTS_TAIL_MS;

    const ttsSendText = (text) => {
        if (!text) return;
        noteAgentAudio(text);
        ttsPlayer.send({ send_text: { text } });
    };
    const ttsFlush = () => {
        ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
    };

    const sendCompletion = (msgs) => {
        const req = {
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            stream_options: { include_usage: true },
            messages: msgs,
        };
        if (tools.length) {
            req.tools = tools;
            req.tool_choice = "auto";
        }
        llm.createChatCompletions(req);
    };

    const warmup = () => {
        llm.createChatCompletions({
            model: LLM_MODEL,
            reasoning_effort: LLM_REASONING_EFFORT,
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: "user", content: "привет" }],
        });
    };

    const startMain = (msgs, version) => {
        if (main.id) mainStaleIds.add(main.id);
        main.accepting = true;
        main.id = null;
        main.text = "";
        main.toolCalls = {};
        main.version = version;
        sendCompletion(msgs);
        resetHardTimeout();
    };

    const finalizeMain = () => {
        const text = main.text;
        if (text) {
            messages.push({ role: "assistant", content: text });
            Logger.write(`[OUT-CASCADE] ===AGENT=== ${text}`);
            logDialog("assistant", text);
        }
        if (canPlay()) ttsFlush();
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        main.text = "";
        main.toolCalls = {};
        resetHardTimeout();
    };

    const executeFunction = async (name, args) => {
        const function_id = args.function_id || functionNameToIdMap[name];
        const clean = Object.assign({}, args);
        delete clean.function_id;
        if (!function_id) return `Error: function_id not found for ${name}`;
        try {
            const resp = await Net.httpRequestAsync(FUNCTIONS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                postData: JSON.stringify({
                    function_id: function_id,
                    arguments: Object.assign({}, clean, { assistant_id: ASSISTANT_ID }),
                    call_data: {
                        call_id: call ? call.id() : "unknown",
                        chat_id: chat_id,
                        assistant_id: ASSISTANT_ID,
                        // Чистые номера для функций (send_sms и т.п.): caller_number —
                        // клиент (кому звоним), called_number — наш номер (caller_id).
                        caller_number: PHONE_NUMBER,
                        called_number: CALLER_ID,
                    },
                }),
            });
            if (resp.code === 200) return resp.text || "{}";
            return `Error: HTTP ${resp.code}`;
        } catch (e) {
            return `Error: ${e}`;
        }
    };

    // Разбор и выполнение tool_calls (Chat Completions manual tool loop).
    const handleToolCalls = async (version) => {
        const calls = Object.keys(main.toolCalls)
            .map((k) => main.toolCalls[k])
            .filter((c) => c && c.name);

        // Останавливаем гейтинг текущей генерации.
        main.accepting = false;
        if (main.id) mainStaleIds.add(main.id);
        main.id = null;
        const pendingText = main.text;
        main.text = "";
        main.toolCalls = {};

        // Ассистентское сообщение с tool_calls в историю.
        messages.push({
            role: "assistant",
            content: pendingText || null,
            tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.args || "{}" },
            })),
        });

        // hangup_call — ассистент сам завершает звонок.
        const hangup = calls.find((c) => c.name === "hangup_call");
        if (hangup) {
            let farewell = "";
            try {
                farewell = (JSON.parse(hangup.args || "{}").farewell_message) || "";
            } catch (e) { /* noop */ }
            Logger.write(`[OUT-CASCADE] ===HANGUP=== ${farewell}`);
            if (farewell) {
                logDialog("assistant", farewell);
                if (canPlay()) { ttsSendText(farewell); ttsFlush(); }
            }
            setTimeout(() => terminateCall(), farewell ? 3500 : 300);
            return;
        }

        // Остальные функции: выполнить, вернуть результат в историю.
        for (const c of calls) {
            let args = {};
            try { args = JSON.parse(c.args || "{}"); } catch (e) { /* noop */ }
            Logger.write(`[OUT-CASCADE] ===FUNCTION=== ${c.name} ${c.args || ""}`);
            const result = await executeFunction(c.name, args);
            messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
        }
        if (terminating) return;
        // Повторный запрос — модель озвучит ответ по результатам функций.
        startMain(messages.slice(), version);
    };

    const sendConversationLog = async () => {
        if (!userMessageBuffer && !assistantMessageBuffer && dialogLog.length === 0) return;
        const payload = {
            assistant_id: ASSISTANT_ID,
            chat_id: chat_id,
            call_id: call ? call.id() : "unknown",
            caller_number: caller_number,
            type: "conversation",
            call_type: callType,
            call_cost: call_cost,
            call_duration: call_duration,
            cascade_usage: {
                prompt_tokens: totalPromptTokens,
                completion_tokens: totalCompletionTokens,
            },
            context: {
                contact_name: CONTACT_NAME,
                task_title: TASK_TITLE,
                task_description: TASK_DESCRIPTION,
                api_task: API_TASK,
            },
            data: {
                user_message: userMessageBuffer,
                assistant_message: assistantMessageBuffer,
                dialog: dialogLog,
            },
        };
        if (record_url) payload.record_url = record_url;
        if (call_session_history_id) payload.call_session_history_id = String(call_session_history_id);
        try {
            const resp = await Net.httpRequestAsync(LOG_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                postData: JSON.stringify(payload),
            });
            Logger.write(`[OUT-CASCADE] /log HTTP ${resp.code} (turns=${dialogLog.length})`);
        } catch (e) {
            Logger.write(`[OUT-CASCADE] /log error: ${e}`);
        }
    };

    let terminatePromise = null;
    const terminateCall = () => {
        if (terminatePromise) return terminatePromise;
        terminating = true;
        terminatePromise = (async () => {
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
            try { stt?.stop(); } catch (e) { /* noop */ }
            try { turnTaking?.close(); } catch (e) { /* noop */ }

            if (main.accepting && main.text) logDialog("assistant", main.text);

            await new Promise((r) => setTimeout(r, 400));

            Logger.write(
                `[OUT-CASCADE] ===BILLING=== cost=${call_cost} dur=${call_duration}s ` +
                `turns=${dialogLog.length} rec=${record_url ? "yes" : "no"} session=${call_session_history_id || "none"}`
            );
            // Сводка turn-taking: по ней видно на проде, сколько ходов закрылось
            // какой причиной, сколько было удержаний и сколько обрезок поймала
            // реконсиляция. Без неё эффект правок проверить нечем.
            try {
                if (turnTaking) Logger.write(`[OUT-CASCADE] ===TURN_STATS=== ${turnTaking.statsSummary()}`);
            } catch (e) { /* noop */ }
            await sendConversationLog();

            try { call?.hangup(); } catch (e) { /* noop */ }
            setTimeout(() => VoxEngine.terminate(), 400);
        })();
        return terminatePromise;
    };

    function determineGreeting(configFirstPhrase) {
        if (CUSTOM_GREETING) return CUSTOM_GREETING;
        if (FIRST_PHRASE_OVERRIDE) return FIRST_PHRASE_OVERRIDE;
        if (configFirstPhrase) return configFirstPhrase;
        return "Здравствуйте!";
    }

    function buildContextBlock() {
        let block = "";
        if (API_TASK) {
            block +=
                "══════════════════════════════════════\n" +
                "ЗАДАЧА НА ЭТОТ ЗВОНОК\n" +
                "══════════════════════════════════════\n" +
                API_TASK + "\n" +
                "Выполни эту задачу — это главная цель звонка.\n" +
                "══════════════════════════════════════\n\n";
        }
        if (CONTACT_NAME || TASK_TITLE || TASK_DESCRIPTION) {
            block +=
                "══════════════════════════════════════\n" +
                "КОНТЕКСТ ЗВОНКА (CRM)\n" +
                "══════════════════════════════════════\n";
            if (CONTACT_NAME) block += `Клиент: ${CONTACT_NAME} (обращайся по имени).\n`;
            if (TASK_TITLE) block += `Задача: ${TASK_TITLE}\n`;
            if (TASK_DESCRIPTION) block += `Подробности: ${TASK_DESCRIPTION}\n`;
            block += "══════════════════════════════════════\n\n";
        }
        return block;
    }

    // --- Обработчик стрима LLM (единственный клиент; текст + tool_calls) ---
    const attachLlmHandler = () => {
        llm.addEventListener(CC.Chunk, (event) => {
            if (terminating) return;
            logShapeOnce("Chunk", event);
            // Учёт токенов — ДО гейтинга: usage приходит в финальном чанке любого
            // completion'а (в т.ч. stale/прерванного), и это реальный расход.
            const usage = extractUsage(event);
            if (usage) {
                if (typeof usage.prompt_tokens === "number") totalPromptTokens += usage.prompt_tokens;
                if (typeof usage.completion_tokens === "number") totalCompletionTokens += usage.completion_tokens;
            }
            const id = extractCompletionId(event);
            if (id && mainStaleIds.has(id)) return;
            if (!main.accepting) {
                if (id) mainStaleIds.add(id);
                return;
            }
            if (main.id === null) {
                main.id = id || "";
            } else if (id && id !== main.id) {
                return;
            }

            const text = extractDelta(event);
            if (text) {
                main.text += text;
                if (canPlay()) {
                    logFirstDelta("");
                    ttsSendText(text);
                }
            }

            const toolDeltas = extractToolCallDeltas(event);
            if (toolDeltas) {
                logShapeOnce("Chunk.tool_calls", event);
                for (const tc of toolDeltas) {
                    const idx = tc.index != null ? tc.index : 0;
                    if (!main.toolCalls[idx]) main.toolCalls[idx] = { id: "", name: "", args: "" };
                    const slot = main.toolCalls[idx];
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = tc.function.name;
                    if (tc.function?.arguments) slot.args += tc.function.arguments;
                }
            }

            const fr = extractFinishReason(event);
            if (fr === "tool_calls") {
                handleToolCalls(main.version);
            } else if (fr) {
                finalizeMain();
            }
        });

        llm.addEventListener(CC.ChatCompletionsAPIError, (event) => {
            Logger.write("[OUT-CASCADE] ===LLM_ERROR===");
            if (event?.data) Logger.write(JSON.stringify(event.data));
        });
    };

    // --- Обработчики звонка (навешиваем на созданный call) ---
    const attachCallHandlers = () => {
        call.addEventListener(CallEvents.RecordStarted, (event) => {
            record_url = event.url;
            Logger.write(`[OUT-CASCADE] Recording started: ${event.url}`);
        });
        call.addEventListener(CallEvents.RecordStopped, (event) => {
            if (event && event.url) record_url = event.url;
        });
        call.addEventListener(CallEvents.Failed, (event) => {
            if (event && event.cost !== undefined) call_cost = event.cost;
            if (event && event.duration !== undefined) call_duration = event.duration;
            Logger.write(`[OUT-CASCADE] ===CALL_FAILED=== code=${event?.code} ${event?.reason || ""}`);
            terminateCall();
        });
        call.addEventListener(CallEvents.Disconnected, (event) => {
            if (event && event.cost !== undefined) call_cost = event.cost;
            if (event && event.duration !== undefined) call_duration = event.duration;
            Logger.write(`[OUT-CASCADE] ===DISCONNECTED=== cost=${call_cost} dur=${call_duration}s`);
            terminateCall();
        });

        call.addEventListener(CallEvents.Connected, async () => {
            Logger.write(`[OUT-CASCADE] ===CONNECTED=== ${caller_number}`);
            try {
                call.record({ stereo: false, lossless: false, hd_audio: true });
            } catch (e) {
                Logger.write(`[OUT-CASCADE] record() error: ${e}`);
            }

            ttsPlayer.sendMediaTo(call);

            turnTaking = await VoxTurnTaking.create({
                call,
                stt,
                // Пауза 0.2с считалась концом речи и рвала фразу на сегменты —
                // для русской разговорной речи это норма внутри предложения.
                // 500мс — текущий компромисс скорость/перебивания (см. коммент к
                // DEFAULTS.vadOptions в vox-turn-taking.js). Ниже опускать только
                // после звонка с собеседником, который формулирует на ходу.
                vadOptions: { threshold: 0.5, minSilenceDurationMs: 500, speechPadMs: 200 },
                turnDetectorOptions: { threshold: 0.7 },
                policy: {
                    confidentEouProbability: 0.8,
                    transcriptSettleFastMs: 120,
                    transcriptSettleMs: 350,
                    // Фолбэк больше не основной механизм закрытия: детектор его
                    // отодвигает через вето (см. vetoHold*Ms).
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
                    continuationTokens: [
                        "и", "а", "но", "ну", "вот", "так", "значит",
                        "короче", "эм", "ээ", "мм", "это",
                    ],
                    trailingContinuationTokens: [
                        "чтобы", "потому", "который", "которая", "которое", "которые",
                        "про", "либо", "если", "когда", "пока", "хотя",
                    ],
                    completeShortAnswers: [
                        "да", "нет", "ок", "окей", "хорошо", "ага", "угу", "не",
                        "стоп", "верно", "точно", "конечно", "давай", "давайте",
                        "спасибо", "понятно", "нет спасибо", "да давайте",
                    ],
                    speculativeEouProbability: 0.6,
                },
                enableLogging: true,
                isAgentSpeaking,

                onUserTurn: (input, version) => {
                    if (terminating || !micOpen) return;
                    firstDeltaLoggedForTurn = false;
                    turnStartedAt = Date.now();
                    Logger.write(`[OUT-CASCADE] ===USER=== ${input}`);
                    logDialog("user", input);
                    messages.push({ role: "user", content: input });
                    startMain(messages.slice(), version);
                },

                // Поздний ASR-финал оказался длиннее того, что ушло в LLM.
                // Раньше он просто выбрасывался — вместе с именем, маркой,
                // годом авто. Теперь чиним историю всегда, а если агент ещё не
                // успел заговорить — ещё и перегенериваем ответ по полному
                // тексту.
                onTurnCorrection: (fullText, turnId, meta) => {
                    if (terminating || !micOpen) return;
                    const fixed = replaceUserMessage(meta.sentText, fullText);
                    const canRegen =
                        main.accepting && main.version === turnId && !firstDeltaLoggedForTurn;
                    Logger.write(
                        `[OUT-CASCADE] ===TURN_CORRECTION=== lag=${meta.lagMs}ms ` +
                        `regen=${canRegen ? "yes" : "no"} history=${fixed ? "fixed" : "miss"} :: ${fullText}`
                    );
                    if (!canRegen) return;
                    ttsPlayer?.clearBuffer();
                    stopAgentAudio();
                    startMain(messages.slice(), turnId);
                },

                onInterrupt: () => {
                    if (terminating || !micOpen) return;
                    ttsPlayer?.clearBuffer();
                    stopAgentAudio();
                    main.accepting = false;
                    if (main.id) mainStaleIds.add(main.id);
                    main.id = null;
                    main.text = "";
                    main.toolCalls = {};
                },
            });

            // Приветствие (фиксированная фраза, мимо LLM).
            messages.push({ role: "assistant", content: greeting });
            logDialog("assistant", greeting);
            noteAgentAudio(greeting);
            ttsPlayer.send({ send_text: { text: greeting, flush_context: {} } });
            resetHardTimeout();

            // MUTE-окно: открываем мик абонента только после mute_duration_ms,
            // чтобы «Алло»/шум при поднятии трубки не оборвали приветствие.
            setTimeout(() => {
                if (terminating) return;
                call.sendMediaTo(stt);
                micOpen = true;
                Logger.write(`[OUT-CASCADE] MIC OPEN (after ${MUTE_DURATION_MS}ms mute)`);
            }, MUTE_DURATION_MS);
        });
    };

    try {
        Logger.write(`[OUT-CASCADE] Outbound -> ${PHONE_NUMBER} (caller_id=${CALLER_ID}) type=${callType}`);

        const config = await fetchOutboundConfig(ASSISTANT_ID);
        if (!config || !config.api_key) {
            Logger.write("[OUT-CASCADE] No outbound config / api_key — abort (no dial)");
            VoxEngine.terminate();
            return;
        }

        greeting = determineGreeting(config.first_phrase);

        // system-промпт: контекст (задача + CRM) + база + стиль + анти-повтор приветствия.
        let systemPrompt = buildContextBlock();
        systemPrompt += (config.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;
        systemPrompt +=
            `\n\nТип звонка: ИСХОДЯЩИЙ (ты звонишь абоненту, номер ${PHONE_NUMBER}). ` +
            `Разговор уже начат: приветствие собеседнику уже произнесено. ` +
            `Не здоровайся и не представляйся заново — сразу переходи к цели звонка.`;
        // Информация о звонке в промпт: реальные номера и текущее время, чтобы
        // модель могла корректно вызывать функции (например, send_sms) и
        // ориентироваться во времени. Для исходящего caller_number — номер
        // клиента (кому звоним), called_number — наш номер (caller_id). МСК (UTC+3).
        const mskTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
        systemPrompt +=
            `\n\nИнформация о звонке:\n` +
            `- Номер клиента (caller_number): ${PHONE_NUMBER}\n` +
            `- Наш номер (called_number): ${CALLER_ID}\n` +
            `- Текущее время: ${mskTime} (МСК)`;
        messages.push({ role: "system", content: systemPrompt });

        // Функции ассистента -> tools для Chat Completions.
        if (config.functions && config.functions.length > 0) {
            const decls = [];
            for (let i = 0; i < config.functions.length; i++) {
                const t = config.functions[i];
                const fn = (t.type === "function" && t.function) ? t.function : (t.name ? t : null);
                if (!fn) continue;
                functionNameToIdMap[fn.name] = String(i + 1);
                let desc = fn.description;
                if (fn.name === "hangup_call") {
                    desc = "КРИТИЧЕСКИ ВАЖНО: вызови эту функцию НЕМЕДЛЕННО, когда задача звонка выполнена или собеседник хочет завершить разговор («пока», «до свидания», «всё, спасибо»). Не прощайся просто словами — вызови функцию.";
                }
                decls.push({
                    type: "function",
                    function: { name: fn.name, description: desc, parameters: fn.parameters },
                });
            }
            tools = decls;
            Logger.write(`[OUT-CASCADE] Functions: ${JSON.stringify(functionNameToIdMap)}`);
        }

        // READINESS: готовим ASR / LLM / TTS ДО дозвона.
        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            model: asrModelForLang(config.asr_lang),
            interimResults: true,
        });

        llm = await OpenAI.createChatCompletionsAPIClient({ apiKey: config.api_key });
        attachLlmHandler();

        if (config.tts_provider && config.tts_provider !== "voxtts") {
            Logger.write(`[OUT-CASCADE] ⚠️ tts_provider='${config.tts_provider}' не поддержан, fallback VoxTTS/Anna`);
        }
        ttsPlayer = VoxTTS.createRealtimeTTSPlayer({
            createContextParameters: {
                create: {
                    modelId: VoxTTS.ModelList.VoxTTS,
                    voiceId: voxttsVoice(config.tts_voice),
                },
            },
        });

        // Прогрев LLM пока идёт дозвон (первый ход абонента будет быстрым).
        warmup();

        Logger.write(`[OUT-CASCADE] Ready -> dialing PSTN ${PHONE_NUMBER}`);
        call = VoxEngine.callPSTN(PHONE_NUMBER, CALLER_ID);
        attachCallHandlers();
    } catch (error) {
        Logger.write("[OUT-CASCADE] ===UNHANDLED_ERROR===");
        Logger.write(String(error));
        if (call) terminateCall();
        else VoxEngine.terminate();
    }
});
