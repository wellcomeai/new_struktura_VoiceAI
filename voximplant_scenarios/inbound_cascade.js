/**
 * inbound_cascade — входящий full-cascade Voice AI сценарий Voicyfy.
 *
 *   STT:  встроенный ASR (YandexV3, язык из конфига ассистента)
 *   LLM:  OpenAI gpt-4o-mini (Responses API, стриминг, память диалога)
 *   TTS:  VoxTTS (realtime-стриминг, голоса Anna/Sergey)
 *   Turn-taking: Silero VAD + Pipecat Smart Turn через VoxTurnTaking
 *
 * ТРЕБОВАНИЯ:
 * 1. В правиле роутинга сценарий `vox-turn-taking` стоит ПЕРВЫМ в цепочке,
 *    этот сценарий — ВТОРЫМ (бекенд уже создаёт правило [tt, cascade]
 *    при привязке cascade-ассистента, см. telephony.py bind-assistant).
 * 2. Конфиг ассистента приходит с бекенда: GET /api/telephony/config
 *    (api_key = платформенный OPENAI_API_KEY из ENV сервера).
 */

require(Modules.ASR);
require(Modules.OpenAI);
require(Modules.VoxTTS);

const BACKEND_URL = "https://voicyfy.ru";
const LLM_MODEL = "gpt-5.4-nano";
// Для GPT-5.x reasoning обязателен к отключению: с ним TTFT растёт с ~0.6с до 5-8с
const LLM_REASONING = { effort: "minimal" };

// Правила телефонного стиля добавляются к промпту ассистента из конфига
const TELEPHONY_STYLE_RULES = `

Правила голосового ответа (телефония):
- Отвечай коротко, обычно 1-2 предложения, без списков, markdown и эмодзи.
- Числа, даты и время произноси словами.
- Если реплика оборвана или неясна — вежливо переспроси одним вопросом.`;

// asr_lang из конфига -> профиль встроенного ASR (YandexV3)
function asrProfileForLang(lang) {
    const map = {
        ru: ASRProfileList.YandexV3.ru_RU,
        en: ASRProfileList.YandexV3.en_US,
        de: ASRProfileList.YandexV3.de_DE,
        es: ASRProfileList.YandexV3.es_ES,
        fr: ASRProfileList.YandexV3.fr_FR,
    };
    return map[(lang || "ru").toLowerCase()] || ASRProfileList.YandexV3.auto;
}

// tts_voice из конфига -> голос VoxTTS (по умолчанию Anna)
function voxttsVoice(voiceId) {
    return VoxTTS.VoiceList[voiceId] || VoxTTS.VoiceList.Anna;
}

async function fetchConfig(phone, caller) {
    const url =
        `${BACKEND_URL}/api/telephony/config` +
        `?phone=${encodeURIComponent(phone)}` +
        (caller ? `&caller=${encodeURIComponent(caller)}` : "");
    const response = await Net.httpRequestAsync(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (response.code !== 200 || !response.text) {
        Logger.write(`[CASCADE] Config HTTP error: ${response.code}`);
        return null;
    }
    try {
        const config = JSON.parse(response.text);
        return config && config.success ? config : null;
    } catch (e) {
        Logger.write(`[CASCADE] Config parse error: ${e}`);
        return null;
    }
}

// Транскрипты реплик в CRM/аналитику (fire-and-forget)
function sendTranscript(assistantId, callId, role, transcript) {
    if (!assistantId || !transcript) return;
    Net.httpRequestAsync(`${BACKEND_URL}/api/voximplant/webhook/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        postData: JSON.stringify({
            assistant_id: assistantId,
            call_id: callId,
            role: role,
            transcript: transcript,
            timestamp: new Date().toISOString(),
        }),
    }).catch((e) => Logger.write(`[CASCADE] Transcript send error: ${e}`));
}

VoxEngine.addEventListener(AppEvents.CallAlerting, async ({ call }) => {
    let stt;
    let responsesClient;
    let ttsPlayer;
    let turnTaking;
    // true, пока идёт прогревочный запрос к OpenAI — его вывод не озвучиваем
    let warmupActive = false;

    const terminate = () => {
        stt?.stop();
        responsesClient?.close();
        turnTaking?.close();
        VoxEngine.terminate();
    };

    call.addEventListener(CallEvents.Disconnected, terminate);
    call.addEventListener(CallEvents.Failed, terminate);

    try {
        call.answer();

        const config = await fetchConfig(call.number(), call.callerid());
        if (!config) {
            Logger.write("[CASCADE] No config for this number, hanging up");
            call.hangup();
            return;
        }

        const assistantId = config.assistant_id;
        const callId = call.id();
        let systemPrompt = (config.system_prompt || "Ты — голосовой ассистент.") + TELEPHONY_STYLE_RULES;

        Logger.write(`[CASCADE] Assistant: ${config.assistant_name} (${assistantId})`);
        Logger.write(`[CASCADE] TTS: ${config.tts_provider}/${config.tts_voice}, ASR lang: ${config.asr_lang}`);

        // --- STT: встроенный ASR (YandexV3) ---
        stt = VoxEngine.createASR({
            profile: asrProfileForLang(config.asr_lang),
            interimResults: true,
        });

        // --- LLM: OpenAI Responses API, стриминг + память диалога ---
        responsesClient = await OpenAI.createResponsesAPIClient({
            apiKey: config.api_key,
            storeContext: true,
            onWebSocketClose: (event) => {
                Logger.write("[CASCADE] OpenAI WebSocket closed");
                if (event) Logger.write(JSON.stringify(event));
                terminate();
            },
        });

        // --- TTS: VoxTTS (другие провайдеры каскада пока не в этом сценарии) ---
        if (config.tts_provider && config.tts_provider !== "voxtts") {
            Logger.write(`[CASCADE] ⚠️ tts_provider='${config.tts_provider}' не поддержан, fallback на VoxTTS/Anna`);
        }
        ttsPlayer = VoxTTS.createRealtimeTTSPlayer({
            createContextParameters: {
                create: {
                    modelId: VoxTTS.ModelList.VoxTTS,
                    voiceId: voxttsVoice(config.tts_voice),
                },
            },
        });

        // --- Turn-taking: конец хода + barge-in (VoxTurnTaking из первого
        //     сценария цепочки правила) ---
        turnTaking = await VoxTurnTaking.create({
            call,
            stt,
            vadOptions: {
                threshold: 0.5,
                minSilenceDurationMs: 250,
                speechPadMs: 10,
            },
            turnDetectorOptions: {
                threshold: 0.5,
            },
            policy: {
                // Финалы YandexV3 опаздывают на ~2с, ждать их бессмысленно —
                // interim к моменту endOfTurn уже полный, окно можно короткое
                transcriptSettleMs: 300,
                userSpeechTimeoutMs: 800,
                shortUtteranceExtensionMs: 1800,
                fastShortUtteranceTimeoutMs: 700,
                shortUtteranceMaxChars: 14,
                shortUtteranceMaxWords: 2,
                lowConfidenceShortUtteranceThreshold: 0.75,
                continuationTokens: [
                    "и", "а", "но", "ну", "вот", "так", "значит",
                    "короче", "эм", "ээ", "мм", "это",
                ],
            },
            enableLogging: true,
            onUserTurn: (input) => {
                // Страховка: реальный ход всегда важнее незавершённого прогрева
                warmupActive = false;
                sendTranscript(assistantId, callId, "user", input);
                responsesClient.createResponses({
                    model: LLM_MODEL,
                    reasoning: LLM_REASONING,
                    instructions: systemPrompt,
                    input,
                });
            },
            onInterrupt: () => {
                ttsPlayer?.clearBuffer();
            },
        });

        // --- Стрим LLM -> TTS с гейтом устаревших ответов ---
        responsesClient.addEventListener(
            OpenAI.ResponsesAPIEvents.ResponseTextDelta,
            (event) => {
                if (warmupActive) return;
                const text = event?.data?.payload?.delta;
                if (!text || !turnTaking.canPlayAgentAudio()) return;
                ttsPlayer.send({ send_text: { text } });
            }
        );

        responsesClient.addEventListener(
            OpenAI.ResponsesAPIEvents.ResponseTextDone,
            (event) => {
                if (warmupActive) {
                    warmupActive = false;
                    Logger.write("[CASCADE] OpenAI warmup done");
                    return;
                }
                const text = event?.data?.payload?.text;
                Logger.write(`[CASCADE] ===AGENT=== ${text}`);
                sendTranscript(assistantId, callId, "assistant", text);
                if (!turnTaking.canPlayAgentAudio()) return;
                // Форсируем синтез остатка буфера
                ttsPlayer.send({ send_text: { text: " ", flush_context: {} } });
            }
        );

        [
            OpenAI.ResponsesAPIEvents.ResponseFailed,
            OpenAI.ResponsesAPIEvents.ResponsesAPIError,
            OpenAI.ResponsesAPIEvents.ConnectorInformation,
        ].forEach((eventName) => {
            responsesClient.addEventListener(eventName, (event) => {
                Logger.write(`[CASCADE] ===${event?.name || eventName}===`);
                if (event?.data) Logger.write(JSON.stringify(event.data));
            });
        });

        // --- Маршрутизация медиа (VAD и turn detector подключает VoxTurnTaking) ---
        call.sendMediaTo(stt);
        ttsPlayer.sendMediaTo(call);

        // --- Приветствие ---
        if (config.first_phrase) {
            // Фиксированная первая фраза: произносим напрямую и сообщаем LLM,
            // что приветствие уже прозвучало
            systemPrompt += `\n\nТы уже поприветствовал абонента фразой: «${config.first_phrase}». Не здоровайся повторно.`;
            sendTranscript(assistantId, callId, "assistant", config.first_phrase);
            ttsPlayer.send({ send_text: { text: config.first_phrase, flush_context: {} } });
            // Приветствие идёт мимо LLM, поэтому прогреваем соединение с OpenAI
            // заранее — иначе первый ход абонента платит ~0.5-1с за установку
            // канала. Ответ прогрева отбрасывается по флагу warmupActive.
            warmupActive = true;
            responsesClient.createResponses({
                model: LLM_MODEL,
                reasoning: LLM_REASONING,
                instructions: "Техническая проверка связи.",
                input: "Ответь одним словом: ок",
                max_output_tokens: 32,
            });
        } else {
            responsesClient.createResponses({
                model: LLM_MODEL,
                reasoning: LLM_REASONING,
                instructions: systemPrompt,
                input: "Поприветствуй звонящего одной короткой фразой и спроси, чем можешь помочь.",
            });
        }
    } catch (error) {
        Logger.write("[CASCADE] ===UNHANDLED_ERROR===");
        Logger.write(String(error));
        terminate();
    }
});
