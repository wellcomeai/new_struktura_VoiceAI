/**
 * Voximplant turn-taking runtime for sequenced scenarios.
 *
 * Include this scenario BEFORE any scenario that wants to use VoxTurnTaking
 * in the same routing rule sequence.
 *
 * This runtime hides the current Silero + Pipecat + timer-based turn policy
 * behind a small API so scenarios stay simple today and can transition more
 * easily if Voximplant later exposes a more Pipecat-native Smart Turn model.
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
            transcriptSettleMs: 500,
            userSpeechTimeoutMs: 1000,
            shortUtteranceExtensionMs: 1800,
            fastShortUtteranceTimeoutMs: 700,
            shortUtteranceMaxChars: 12,
            shortUtteranceMaxWords: 2,
            lowConfidenceShortUtteranceThreshold: 0.75,
            continuationTokens: ["and", "but", "so", "well", "then", "uh", "um"],
        },
    },

    /**
     * Creates a turn-taking controller around a call, STT engine, Silero VAD,
     * and Pipecat turn detector.
     *
     * A user turn stays open until this runtime calls `onUserTurn()`. Silero,
     * Pipecat, and the timeout policy only provide evidence that the current
     * turn may be ready to submit.
     *
     * @param {object} options
     * @param {Call} options.call
     *   Active VoxEngine call whose inbound media should be analyzed.
     * @param {ASR} options.stt
     *   Speech-to-text engine already configured by the consuming scenario.
     * @param {(input: string, reason: string) => void} options.onUserTurn
     *   Callback invoked when the accumulated user turn should be submitted to
     *   the LLM.
     * @param {() => void} [options.onInterrupt]
     *   Callback invoked on barge-in so the consuming scenario can stop agent
     *   playback and flush TTS state.
     * @param {boolean} [options.enableLogging=false]
     *   When true, emits debug logs for turn-taking decisions. Disabled by
     *   default so scenarios can keep logs quiet unless they are debugging.
     * @param {(line: string) => void} [options.logger]
     *   Optional logger used when `enableLogging` is true.
     * @param {object} [options.vadOptions]
     *   Silero VAD options merged over `VoxTurnTaking.DEFAULTS.vadOptions`.
     * @param {number} [options.vadOptions.threshold]
     *   Voice activity threshold passed to `Silero.createVAD()`.
     * @param {number} [options.vadOptions.minSilenceDurationMs]
     *   Silence required before Silero emits `speechEndAt`.
     * @param {number} [options.vadOptions.speechPadMs]
     *   Padding used around detected speech segments.
     * @param {object} [options.turnDetectorOptions]
     *   Pipecat options merged over
     *   `VoxTurnTaking.DEFAULTS.turnDetectorOptions`.
     * @param {number} [options.turnDetectorOptions.threshold]
     *   End-of-turn probability threshold passed to
     *   `Pipecat.createTurnDetector()`.
     * @param {object} [options.policy]
     *   Local policy layered on top of Silero and Pipecat to bridge gaps in
     *   the current API.
     * @param {number} [options.policy.transcriptSettleMs]
     *   Extra ASR grace period after Pipecat signals end-of-turn but a final
     *   transcript chunk has not arrived yet.
     * @param {number} [options.policy.userSpeechTimeoutMs]
     *   Default fallback timeout started after `speechEndAt`.
     * @param {number} [options.policy.shortUtteranceExtensionMs]
     *   Longer hold time used for short fragments that may be followed by a
     *   continuation.
     * @param {number} [options.policy.fastShortUtteranceTimeoutMs]
     *   Shorter fallback used for brief, high-confidence utterances that are
     *   likely complete, such as a standalone greeting.
     * @param {number} [options.policy.shortUtteranceMaxChars]
     *   Maximum character count considered a short fragment.
     * @param {number} [options.policy.shortUtteranceMaxWords]
     *   Maximum word count considered a short fragment.
     * @param {number} [options.policy.lowConfidenceShortUtteranceThreshold]
     *   Confidence threshold below which a short final transcript stays
     *   replaceable instead of being committed immediately.
     * @param {string[]} [options.policy.continuationTokens]
     *   Short leading words that usually indicate the caller is continuing a
     *   thought rather than finishing a turn.
     * @returns {Promise<object>}
     * @returns {object} return.vad
     *   Silero VAD instance created by the runtime.
     * @returns {object} return.turnDetector
     *   Pipecat turn detector instance created by the runtime.
     * @returns {() => boolean} return.canPlayAgentAudio
     *   Indicates whether agent audio should still be forwarded to TTS.
     * @returns {() => void} return.close
     *   Cleans up timers and closes the VAD and turn detector.
     */
    async create(options) {
        const {
            call,
            stt,
            onUserTurn,
            onInterrupt,
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

            // Hold short replaceable fragments open for one extra window so
            // resumed speech can overwrite them. After that extension, submit
            // the turn instead of looping forever.
            if (replaceableShortFinal && !shortExtensionApplied) {
                shortExtensionApplied = true;
                startHardTimeout(signalVersion, policy.shortUtteranceExtensionMs);
                return false;
            }

            log(`===${reason}===`);
            log(`===USER=== ${input}`);
            allowAgentAudio = true;
            onUserTurn(input, reason);
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

        // Connector information and error events are part of the module's core
        // contract, so log them here instead of making every consuming scenario
        // re-register the same listeners.
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

            // A short low-confidence fragment like "they" or "so" is often an
            // early clipped piece of a longer utterance. Keep it replaceable so
            // the next final STT chunk can overwrite it. Also keep short
            // trailing chunks replaceable when they arrive after an existing
            // transcript prefix, which helps prevent submits like
            // "do they support open" before the final "AI" lands.
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
            log(
                `===Pipecat.TurnEvents.Result=== ${JSON.stringify(event.probability)}`
            );
            if (!event.endOfTurn) return;

            smartTurnComplete = true;
            if (finalTranscript) {
                submitCurrentTurn("TURN_DETECT: END_OF_TURN");
                return;
            }

            if (settleTimer) clearTimeout(settleTimer);
            const version = signalVersion;
            settleTimer = setTimeout(() => {
                if (version !== signalVersion) return;
                submitCurrentTurn("TURN_DETECT: ASR_GRACE");
            }, policy.transcriptSettleMs);
        });

        return {
            vad,
            turnDetector,
            canPlayAgentAudio() {
                return allowAgentAudio;
            },
            close() {
                clearTimers();
                vad?.close();
                turnDetector?.close();
            },
        };
    },
};

