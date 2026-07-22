/**
 * Voximplant turn-taking runtime for sequenced scenarios.
 *
 * Include this scenario BEFORE any scenario that wants to use VoxTurnTaking
 * in the same routing rule sequence.
 *
 * This runtime hides the current Silero + Pipecat + timer-based turn policy
 * behind a small API so scenarios stay simple today and can transition more
 * easily if Voximplant later exposes a more Pipecat-native Smart Turn model.
 *
 * ВАЖНО ПРО ASR: этот runtime рассчитан на потоковый ASR, отдающий interim
 * (ASREvents.InterimResult). YandexV3 interim НЕ отдаёт, поэтому с ним половина
 * логики (interimTranscript, спекулятивные сигналы) простаивала. Начиная с этой
 * версии стек рассчитан на Yandex v2 (ASRProfileList.Yandex.ru_RU) с
 * interimResults: true — тогда interim реально течёт и endpointing честно
 * опирается на свежий текст, а не на опоздавший на ~2с финал.
 *
 * НОВОЕ В ЭТОЙ ВЕРСИИ:
 *  - onSpeculativeTurn(input, version): ранний сигнал, когда interim выглядит
 *    завершённым (p >= speculativeEouProbability), но EOU ещё НЕ подтверждён.
 *    Сценарий может по нему заранее запустить LLM (спекулятивная генерация).
 *  - currentVersion(): номер текущего сигнала (для гейтинга ходов в сценарии).
 *  - Двухскоростной endpointing (confidentEouProbability + settleFast/settle).
 */

require(Modules.ASR);
require(Modules.Silero);
require(Modules.Pipecat);

// eslint-disable-next-line no-unused-vars
const VoxTurnTaking = {
    DEFAULTS: {
        vadOptions: {
            threshold: 0.5,
            minSilenceDurationMs: 300,
            speechPadMs: 10,
        },
        turnDetectorOptions: {
            threshold: 0.5,
        },
        policy: {
            // Раньше окно ожидания финала после endOfTurn держали большим, т.к.
            // финал YandexV3 опаздывал на ~2с. С interim v2 к моменту endOfTurn
            // текст уже полный, поэтому грейс режем агрессивно.
            // Двухскоростной endpointing. Pipecat даёт вероятность конца хода:
            //  - p >= confidentEouProbability: фраза уверенно закончена -> быстрый
            //    путь, settle = transcriptSettleFastMs, trailing/hold НЕ применяем.
            //  - confidentEou > p >= (порог threshold): серая зона -> осторожный
            //    путь, settle = transcriptSettleMs + trailing-проверка.
            confidentEouProbability: 0.95,
            transcriptSettleFastMs: 120,
            transcriptSettleMs: 350,
            userSpeechTimeoutMs: 700,
            shortUtteranceExtensionMs: 900,
            fastShortUtteranceTimeoutMs: 500,
            shortUtteranceMaxChars: 12,
            shortUtteranceMaxWords: 2,
            lowConfidenceShortUtteranceThreshold: 0.75,
            continuationTokens: ["and", "but", "so", "well", "then", "uh", "um"],
            // Оборванный хвост. Держим только явно-обрывочные слова; частые
            // короткие («а","и","о","у","к","с","в») УБРАНЫ — давали ложные
            // удержания на нормальных фразах.
            trailingContinuationTokens: [],
            // Короткие законченные ответы, которые НЕ держим никогда, даже если
            // сработал бы trailing/short-путь. Задаётся сценарием под язык.
            completeShortAnswers: [],
            // Порог вероятности EOU от Pipecat, при котором мы считаем ход
            // ГОТОВЫМ к ранней (спекулятивной) подаче через onSpeculativeTurn.
            speculativeEouProbability: 0.7,
        },
    },

    async create(options) {
        const {
            call,
            stt,
            onUserTurn,
            onInterrupt,
            // Ранний сигнал для спекулятивной генерации. Вызывается, когда interim
            // выглядит завершённым, но EOU ещё НЕ подтверждён. Опционален.
            onSpeculativeTurn,
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

        let fallbackTimer;
        let settleTimer;
        let finalTranscript = "";
        let interimTranscript = "";
        let transcriptSeparator = "";
        let smartTurnComplete = false;
        let acceptingTranscript = false;
        let signalVersion = 0;
        let allowAgentAudio = true;
        let lastFinalConfidence = 1;
        let replaceableShortFinal = false;
        let shortExtensionApplied = false;
        let speculativeFiredForVersion = -1;

        const clearTimers = () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (settleTimer) clearTimeout(settleTimer);
            fallbackTimer = null;
            settleTimer = null;
        };

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
        // Такие никогда не держим, даже если сработал бы trailing/short-путь.
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

        const submitCurrentTurn = (reason) => {
            const input = buildInput();
            if (!input) return false;

            // Вайтлист завершённых коротких ответов — сабмитим немедленно,
            // никаких удержаний.
            const isWhitelisted = isCompleteShortAnswer(input);

            // Оборванный хвост («...а что это за») — не отдаём в LLM недоговорку.
            // Придерживаем на одно окно ожидания продолжения. FALLBACK_END_OF_TURN
            // не придерживаем: это уже страховочный таймаут, дальше тянуть нельзя.
            if (
                !isWhitelisted &&
                reason !== "FALLBACK_END_OF_TURN" &&
                endsWithContinuationToken(input) &&
                !shortExtensionApplied
            ) {
                shortExtensionApplied = true;
                log(`===HOLD_TRAILING=== ${input}`);
                startHardTimeout(signalVersion, policy.shortUtteranceExtensionMs);
                return false;
            }

            if (!isWhitelisted && replaceableShortFinal && !shortExtensionApplied) {
                shortExtensionApplied = true;
                startHardTimeout(signalVersion, policy.shortUtteranceExtensionMs);
                return false;
            }

            log(`===${reason}===`);
            log(`===USER=== ${input}`);
            allowAgentAudio = true;
            onUserTurn(input, signalVersion, reason);
            finalTranscript = "";
            interimTranscript = "";
            transcriptSeparator = "";
            smartTurnComplete = false;
            acceptingTranscript = false;
            lastFinalConfidence = 1;
            replaceableShortFinal = false;
            shortExtensionApplied = false;
            signalVersion += 1;
            clearTimers();
            return true;
        };

        const startHardTimeout = (version, delay = policy.userSpeechTimeoutMs) => {
            clearTimers();
            fallbackTimer = setTimeout(() => {
                if (version !== signalVersion) return;
                const input = buildInput();
                if (!input) return;
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

        stt.addEventListener(ASREvents.InterimResult, (event) => {
            if (!acceptingTranscript) return;
            const text = event?.text?.trim();
            if (!text) return;
            if (!transcriptSeparator && finalTranscript) transcriptSeparator = " ";
            interimTranscript = text;
        });

        stt.addEventListener(ASREvents.Result, (event) => {
            if (!acceptingTranscript) return;
            const text = event?.text?.trim();
            if (!text) return;
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
            if (isShortUtterance(text) && !replaceableShortFinal && !smartTurnComplete) {
                startHardTimeout(
                    signalVersion,
                    Math.min(
                        policy.userSpeechTimeoutMs,
                        policy.fastShortUtteranceTimeoutMs
                    )
                );
            }
            if (smartTurnComplete) submitCurrentTurn("TURN_DETECT: FINAL_TRANSCRIPT");
        });

        vad.addEventListener(Silero.VADEvents.Result, (event) => {
            if (event.speechStartAt) {
                signalVersion += 1;
                clearTimers();
                smartTurnComplete = false;
                acceptingTranscript = true;
                allowAgentAudio = false;
                if (finalTranscript || interimTranscript) transcriptSeparator = " ... ";
                log("===BARGE-IN===");
                if (onInterrupt) onInterrupt();
            }

            if (event.speechEndAt) {
                startHardTimeout(signalVersion);
                turnDetector.predict();
            }
        });

        turnDetector.addEventListener(Pipecat.TurnEvents.Result, (event) => {
            const probability = event?.probability;
            log(`===Pipecat.TurnEvents.Result=== ${JSON.stringify(probability)}`);

            // Ранний сигнал для спекуляции: высокая вероятность EOU, но ещё не
            // подтверждён, и уже есть текст. Один раз на версию сигнала.
            if (
                !event.endOfTurn &&
                typeof probability === "number" &&
                probability >= policy.speculativeEouProbability &&
                speculativeFiredForVersion !== signalVersion
            ) {
                const speculativeInput = buildInput();
                if (speculativeInput) {
                    speculativeFiredForVersion = signalVersion;
                    log(`===SPECULATIVE_READY=== p=${probability} :: ${speculativeInput}`);
                    if (onSpeculativeTurn) onSpeculativeTurn(speculativeInput, signalVersion);
                }
            }

            if (!event.endOfTurn) return;

            smartTurnComplete = true;

            // Двухскоростной выбор окна ожидания:
            //  - уверенный конец (p >= confidentEouProbability) -> быстрый settle;
            //  - серая зона -> осторожный settle (даём interim домолчать).
            const confident =
                (typeof probability === "number" &&
                    probability >= policy.confidentEouProbability) ||
                isCompleteShortAnswer(buildInput());
            const settleMs = confident
                ? policy.transcriptSettleFastMs
                : policy.transcriptSettleMs;

            if (finalTranscript) {
                // Финал уже есть. На уверенном конце сабмитим сразу; в серой зоне
                // даём короткий settle, чтобы возможное продолжение interim дошло.
                if (confident) {
                    submitCurrentTurn("TURN_DETECT: END_OF_TURN");
                    return;
                }
                if (settleTimer) clearTimeout(settleTimer);
                const v = signalVersion;
                settleTimer = setTimeout(() => {
                    if (v !== signalVersion) return;
                    submitCurrentTurn("TURN_DETECT: END_OF_TURN_SETTLED");
                }, settleMs);
                return;
            }

            if (settleTimer) clearTimeout(settleTimer);
            const version = signalVersion;
            settleTimer = setTimeout(() => {
                if (version !== signalVersion) return;
                submitCurrentTurn("TURN_DETECT: ASR_GRACE");
            }, settleMs);
        });

        return {
            vad,
            turnDetector,
            canPlayAgentAudio() {
                return allowAgentAudio;
            },
            currentVersion() {
                return signalVersion;
            },
            close() {
                clearTimers();
                vad?.close();
                turnDetector?.close();
            },
        };
    },
};
