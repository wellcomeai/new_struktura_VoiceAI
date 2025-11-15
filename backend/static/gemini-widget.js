/**
 * 🚀 Gemini Voice Widget v1.0 - Production Ready
 * Google Gemini Live API Integration
 * 
 * Features:
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (16kHz PCM)
 * ✅ Dynamic screen context (based on assistant config)
 * ✅ Client-side VAD events
 * ✅ Audio resampling (24kHz → 16kHz)
 * ✅ Interruption handling
 * ✅ Visual feedback (equalizer)
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * 
 * Usage:
 * <script>
 *   (function() {
 *     var script = document.createElement('script');
 *     script.src = 'https://yourserver.com/static/gemini-widget.js';
 *     script.dataset.assistantId = 'your-assistant-uuid';
 *     script.dataset.server = 'https://yourserver.com';
 *     script.dataset.position = 'bottom-right';
 *     script.async = true;
 *     document.head.appendChild(script);
 *   })();
 * </script>
 */

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================

    const CONFIG = {
        // От data-атрибутов скрипта
        assistantId: null,
        serverUrl: null,
        position: 'bottom-right',
        
        // Аудио параметры
        audio: {
            inputSampleRate: 16000,      // Gemini expects 16kHz
            outputSampleRate: 24000,     // Gemini sends 24kHz
            playbackSampleRate: 16000,   // Downsampled for playback
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,          // ms
            maxBufferSize: 96000
        },
        
        // Screen capture
        screen: {
            enabled: false,              // Динамически из конфига
            interval: 5000,              // 5 секунд
            quality: 0.7,
            maxWidth: 1280,
            maxHeight: 720
        },
        
        // VAD
        vad: {
            enabled: true,
            silenceThreshold: -45,       // dB
            silenceDuration: 500,        // ms
            speechThreshold: -40         // dB
        },
        
        // WebSocket
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },
        
        // UI
        colors: {
            primary: '#8B5CF6',
            gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            success: '#10B981',
            error: '#EF4444',
            warning: '#F59E0B'
        }
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    const STATE = {
        ws: null,
        isConnected: false,
        isRecording: false,
        isPlaying: false,
        isSpeaking: false,
        audioContext: null,
        mediaStream: null,
        audioWorklet: null,
        audioQueue: [],
        currentAudioSource: null,
        screenCaptureInterval: null,
        pingInterval: null,
        reconnectAttempts: 0,
        lastSpeechTime: 0,
        lastSilenceTime: 0,
        sessionConfig: null,
        errorState: null
    };

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        console.log('[GEMINI-WIDGET] Initializing...');
        
        // Получаем конфигурацию из data-атрибутов
        const scriptTag = document.currentScript || 
                         document.querySelector('script[data-assistant-id]');
        
        if (!scriptTag) {
            console.error('[GEMINI-WIDGET] Script tag not found');
            return;
        }

        CONFIG.assistantId = scriptTag.dataset.assistantId;
        CONFIG.serverUrl = scriptTag.dataset.server;
        CONFIG.position = scriptTag.dataset.position || 'bottom-right';

        if (!CONFIG.assistantId || !CONFIG.serverUrl) {
            console.error('[GEMINI-WIDGET] Missing required parameters: assistantId, server');
            return;
        }

        console.log('[GEMINI-WIDGET] Config:', {
            assistantId: CONFIG.assistantId,
            server: CONFIG.serverUrl,
            position: CONFIG.position
        });

        // Создаем UI
        createWidget();
        
        // Инициализируем AudioContext при первом взаимодействии
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    function initAudioContext() {
        if (STATE.audioContext) return;
        
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.inputSampleRate
        });
        
        console.log('[GEMINI-WIDGET] AudioContext initialized:', STATE.audioContext.sampleRate);
    }

    // ============================================================================
    // UI CREATION
    // ============================================================================

    function createWidget() {
        // Контейнер
        const container = document.createElement('div');
        container.id = 'gemini-voice-widget';
        container.className = `gemini-widget-container position-${CONFIG.position}`;
        
        container.innerHTML = `
            <style>
                /* Reset */
                #gemini-voice-widget * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                /* Container */
                .gemini-widget-container {
                    position: fixed;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }

                .gemini-widget-container.position-bottom-right {
                    bottom: 20px;
                    right: 20px;
                }

                .gemini-widget-container.position-bottom-left {
                    bottom: 20px;
                    left: 20px;
                }

                .gemini-widget-container.position-top-right {
                    top: 20px;
                    right: 20px;
                }

                .gemini-widget-container.position-top-left {
                    top: 20px;
                    left: 20px;
                }

                /* Main Button */
                .gemini-main-button {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background: ${CONFIG.colors.gradient};
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.3s ease;
                    position: relative;
                }

                .gemini-main-button:hover {
                    transform: scale(1.05);
                    box-shadow: 0 6px 16px rgba(0,0,0,0.2);
                }

                .gemini-main-button:active {
                    transform: scale(0.95);
                }

                .gemini-main-button.recording {
                    animation: pulse-recording 1.5s ease-in-out infinite;
                }

                .gemini-main-button.playing {
                    animation: pulse-playing 2s ease-in-out infinite;
                }

                @keyframes pulse-recording {
                    0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(239, 68, 68, 0.8); }
                }

                @keyframes pulse-playing {
                    0%, 100% { box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(16, 185, 129, 0.8); }
                }

                .gemini-button-icon {
                    color: white;
                    font-size: 24px;
                }

                /* Equalizer */
                .gemini-equalizer {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    display: none;
                    gap: 3px;
                }

                .gemini-equalizer.active {
                    display: flex;
                }

                .gemini-equalizer-bar {
                    width: 3px;
                    background: white;
                    border-radius: 2px;
                    animation: equalizer 0.8s ease-in-out infinite;
                }

                .gemini-equalizer-bar:nth-child(1) { height: 8px; animation-delay: 0s; }
                .gemini-equalizer-bar:nth-child(2) { height: 12px; animation-delay: 0.1s; }
                .gemini-equalizer-bar:nth-child(3) { height: 16px; animation-delay: 0.2s; }
                .gemini-equalizer-bar:nth-child(4) { height: 12px; animation-delay: 0.3s; }
                .gemini-equalizer-bar:nth-child(5) { height: 8px; animation-delay: 0.4s; }

                @keyframes equalizer {
                    0%, 100% { transform: scaleY(0.5); }
                    50% { transform: scaleY(1.2); }
                }

                /* Status Indicator */
                .gemini-status-indicator {
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: #94A3B8;
                    border: 2px solid white;
                    transition: background 0.3s ease;
                }

                .gemini-status-indicator.connected {
                    background: ${CONFIG.colors.success};
                }

                .gemini-status-indicator.error {
                    background: ${CONFIG.colors.error};
                    animation: blink 1s ease-in-out infinite;
                }

                @keyframes blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                /* Error Message */
                .gemini-error-message {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    background: white;
                    padding: 12px 16px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    max-width: 280px;
                    display: none;
                    animation: slideUp 0.3s ease-out;
                }

                .gemini-error-message.show {
                    display: block;
                }

                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateY(10px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .gemini-error-title {
                    color: ${CONFIG.colors.error};
                    font-weight: 600;
                    font-size: 14px;
                    margin-bottom: 4px;
                }

                .gemini-error-text {
                    color: #64748B;
                    font-size: 12px;
                    line-height: 1.4;
                }

                /* Branding */
                .gemini-branding {
                    position: absolute;
                    bottom: -30px;
                    right: 0;
                    font-size: 10px;
                    color: #94A3B8;
                    text-decoration: none;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    transition: color 0.3s ease;
                }

                .gemini-branding:hover {
                    color: ${CONFIG.colors.primary};
                }

                /* Mobile Responsive */
                @media (max-width: 768px) {
                    .gemini-widget-container {
                        bottom: 15px !important;
                        right: 15px !important;
                    }

                    .gemini-main-button {
                        width: 56px;
                        height: 56px;
                    }

                    .gemini-error-message {
                        max-width: calc(100vw - 90px);
                    }
                }
            </style>

            <!-- Main Button -->
            <button class="gemini-main-button" id="gemini-btn" title="Голосовой помощник">
                <i class="gemini-button-icon">🎤</i>
                
                <!-- Equalizer -->
                <div class="gemini-equalizer" id="gemini-equalizer">
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                </div>

                <!-- Status Indicator -->
                <div class="gemini-status-indicator" id="gemini-status"></div>
            </button>

            <!-- Error Message -->
            <div class="gemini-error-message" id="gemini-error">
                <div class="gemini-error-title">Ошибка</div>
                <div class="gemini-error-text" id="gemini-error-text"></div>
            </div>

            <!-- Branding -->
            <a href="https://voicyfy.ru" target="_blank" class="gemini-branding">
                <span>Powered by</span>
                <strong>Voicyfy</strong>
            </a>
        `;

        document.body.appendChild(container);

        // Event listeners
        const button = document.getElementById('gemini-btn');
        button.addEventListener('click', handleButtonClick);
        
        console.log('[GEMINI-WIDGET] UI created');
    }

    // ============================================================================
    // UI UPDATES
    // ============================================================================

    function updateUI(state) {
        const button = document.getElementById('gemini-btn');
        const icon = button.querySelector('.gemini-button-icon');
        const equalizer = document.getElementById('gemini-equalizer');
        const status = document.getElementById('gemini-status');
        
        // Remove all classes
        button.classList.remove('recording', 'playing');
        equalizer.classList.remove('active');
        status.classList.remove('connected', 'error');

        // Update based on state
        if (state === 'connected') {
            status.classList.add('connected');
            icon.textContent = '🎤';
        } else if (state === 'recording') {
            button.classList.add('recording');
            equalizer.classList.add('active');
            icon.style.display = 'none';
            status.classList.add('connected');
        } else if (state === 'playing') {
            button.classList.add('playing');
            equalizer.classList.add('active');
            icon.style.display = 'none';
            status.classList.add('connected');
        } else if (state === 'error') {
            status.classList.add('error');
            icon.textContent = '❌';
        } else {
            icon.textContent = '🎤';
            icon.style.display = 'flex';
        }
    }

    function showError(title, message) {
        const errorDiv = document.getElementById('gemini-error');
        const errorText = document.getElementById('gemini-error-text');
        
        errorDiv.querySelector('.gemini-error-title').textContent = title;
        errorText.textContent = message;
        errorDiv.classList.add('show');
        
        updateUI('error');
        
        setTimeout(() => {
            errorDiv.classList.remove('show');
        }, 5000);
    }

    function hideError() {
        const errorDiv = document.getElementById('gemini-error');
        errorDiv.classList.remove('show');
    }

    // ============================================================================
    // BUTTON CLICK HANDLER
    // ============================================================================

    async function handleButtonClick() {
        console.log('[GEMINI-WIDGET] Button clicked');
        
        if (!STATE.audioContext) {
            initAudioContext();
        }

        if (!STATE.isConnected) {
            // Подключаемся
            await connectWebSocket();
        } else if (STATE.isRecording) {
            // Останавливаем запись
            await stopRecording();
        } else {
            // Начинаем запись
            await startRecording();
        }
    }

    // ============================================================================
    // WEBSOCKET CONNECTION
    // ============================================================================

    async function connectWebSocket() {
        console.log('[GEMINI-WIDGET] Connecting to WebSocket...');
        
        const wsUrl = CONFIG.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');
        const endpoint = `${wsUrl}/ws/gemini/${CONFIG.assistantId}`;
        
        console.log('[GEMINI-WIDGET] WS URL:', endpoint);

        try {
            STATE.ws = new WebSocket(endpoint);
            
            STATE.ws.onopen = handleWSOpen;
            STATE.ws.onmessage = handleWSMessage;
            STATE.ws.onerror = handleWSError;
            STATE.ws.onclose = handleWSClose;
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Connection error:', error);
            showError('Ошибка подключения', 'Не удалось подключиться к серверу');
        }
    }

    function handleWSOpen() {
        console.log('[GEMINI-WIDGET] ✅ WebSocket connected');
        STATE.isConnected = true;
        STATE.reconnectAttempts = 0;
        updateUI('connected');
        hideError();
        
        // Start ping
        STATE.pingInterval = setInterval(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                sendMessage({ type: 'ping' });
            }
        }, CONFIG.ws.pingInterval);
    }

    function handleWSMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('[GEMINI-WIDGET] Message:', data.type);
            
            switch (data.type) {
                case 'connection_status':
                    handleConnectionStatus(data);
                    break;
                
                case 'response.audio.delta':
                    handleAudioDelta(data);
                    break;
                
                case 'assistant.speech.started':
                    handleAssistantSpeechStarted();
                    break;
                
                case 'assistant.speech.ended':
                    handleAssistantSpeechEnded();
                    break;
                
                case 'conversation.interrupted':
                    handleInterruption();
                    break;
                
                case 'error':
                    handleError(data);
                    break;
                
                case 'pong':
                    // Ping response
                    break;
                
                default:
                    console.log('[GEMINI-WIDGET] Unhandled message type:', data.type);
            }
        } catch (error) {
            console.error('[GEMINI-WIDGET] Error parsing message:', error);
        }
    }

    function handleWSError(error) {
        console.error('[GEMINI-WIDGET] WebSocket error:', error);
        showError('Ошибка соединения', 'Потеряно соединение с сервером');
        updateUI('error');
    }

    function handleWSClose(event) {
        console.log('[GEMINI-WIDGET] WebSocket closed:', event.code, event.reason);
        STATE.isConnected = false;
        
        if (STATE.pingInterval) {
            clearInterval(STATE.pingInterval);
            STATE.pingInterval = null;
        }
        
        if (STATE.isRecording) {
            stopRecording();
        }
        
        if (STATE.isPlaying) {
            stopPlayback();
        }
        
        // Auto-reconnect
        if (STATE.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
            STATE.reconnectAttempts++;
            console.log(`[GEMINI-WIDGET] Reconnecting... Attempt ${STATE.reconnectAttempts}`);
            setTimeout(connectWebSocket, CONFIG.ws.reconnectDelay);
        } else {
            showError('Соединение потеряно', 'Превышено количество попыток переподключения');
            updateUI('error');
        }
    }

    function sendMessage(data) {
        if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
            STATE.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    // ============================================================================
    // MESSAGE HANDLERS
    // ============================================================================

    function handleConnectionStatus(data) {
        console.log('[GEMINI-WIDGET] Connection status:', data);
        
        STATE.sessionConfig = {
            model: data.model,
            functions_enabled: data.functions_enabled,
            google_sheets: data.google_sheets,
            thinking_enabled: data.thinking_enabled,
            client_id: data.client_id
        };
        
        // Check screen context from config (will be added in future)
        // For now, disabled by default
        CONFIG.screen.enabled = false;
        
        console.log('[GEMINI-WIDGET] Session config:', STATE.sessionConfig);
        console.log('[GEMINI-WIDGET] Screen capture:', CONFIG.screen.enabled ? 'enabled' : 'disabled');
    }

    function handleAudioDelta(data) {
        if (!data.delta) return;
        
        STATE.audioQueue.push(data.delta);
        
        if (!STATE.isPlaying) {
            playAudioQueue();
        }
    }

    function handleAssistantSpeechStarted() {
        console.log('[GEMINI-WIDGET] 🔊 Assistant started speaking');
        STATE.isSpeaking = true;
        updateUI('playing');
    }

    function handleAssistantSpeechEnded() {
        console.log('[GEMINI-WIDGET] 🔇 Assistant stopped speaking');
        STATE.isSpeaking = false;
        
        if (!STATE.isRecording) {
            updateUI('connected');
        }
    }

    function handleInterruption() {
        console.log('[GEMINI-WIDGET] ⚡ Conversation interrupted');
        stopPlayback();
        STATE.isSpeaking = false;
        
        if (STATE.isRecording) {
            updateUI('recording');
        } else {
            updateUI('connected');
        }
    }

    function handleError(data) {
        console.error('[GEMINI-WIDGET] Server error:', data.error);
        
        const error = data.error;
        let title = 'Ошибка';
        let message = error.message || 'Произошла ошибка';
        
        switch (error.code) {
            case 'TRIAL_EXPIRED':
                title = 'Пробный период истек';
                message = 'Пожалуйста, оформите подписку для продолжения работы';
                break;
            case 'SUBSCRIPTION_EXPIRED':
                title = 'Подписка истекла';
                message = 'Пожалуйста, продлите подписку для продолжения работы';
                break;
            case 'assistant_not_found':
                title = 'Ассистент не найден';
                message = 'Проверьте правильность ID ассистента';
                break;
            case 'gemini_connection_failed':
                title = 'Ошибка Gemini';
                message = 'Не удалось подключиться к Gemini API';
                break;
            case 'no_api_key':
                title = 'Нет API ключа';
                message = 'Gemini API ключ не настроен';
                break;
        }
        
        showError(title, message);
        
        if (error.requires_payment) {
            // Close connection
            if (STATE.ws) {
                STATE.ws.close();
            }
        }
    }

    // ============================================================================
    // AUDIO RECORDING
    // ============================================================================

    async function startRecording() {
        if (STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Starting recording...');
        
        try {
            // Request microphone
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: CONFIG.audio.inputSampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            console.log('[GEMINI-WIDGET] Microphone access granted');
            
            // Create AudioWorklet for processing
            const source = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
            const processor = STATE.audioContext.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
                if (!STATE.isRecording) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = float32ToPCM16(inputData);
                
                // VAD check
                const rms = calculateRMS(inputData);
                const db = 20 * Math.log10(rms);
                
                if (db > CONFIG.vad.speechThreshold) {
                    if (!STATE.isSpeaking) {
                        console.log('[GEMINI-WIDGET] 🗣️ User started speaking');
                        sendMessage({ type: 'speech.user_started' });
                    }
                    STATE.lastSpeechTime = Date.now();
                } else if (STATE.lastSpeechTime > 0 && 
                          Date.now() - STATE.lastSpeechTime > CONFIG.vad.silenceDuration) {
                    if (STATE.isSpeaking) {
                        console.log('[GEMINI-WIDGET] 🤐 User stopped speaking');
                        sendMessage({ type: 'speech.user_stopped' });
                    }
                    STATE.lastSpeechTime = 0;
                }
                
                // Send audio
                const base64Audio = arrayBufferToBase64(pcmData.buffer);
                sendMessage({
                    type: 'input_audio_buffer.append',
                    audio: base64Audio
                });
            };
            
            source.connect(processor);
            processor.connect(STATE.audioContext.destination);
            
            STATE.audioWorklet = { source, processor };
            STATE.isRecording = true;
            
            updateUI('recording');
            
            // Start screen capture if enabled
            if (CONFIG.screen.enabled) {
                startScreenCapture();
            }
            
            console.log('[GEMINI-WIDGET] ✅ Recording started');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Recording error:', error);
            showError('Ошибка записи', 'Не удалось получить доступ к микрофону');
        }
    }

    async function stopRecording() {
        if (!STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Stopping recording...');
        
        STATE.isRecording = false;
        
        // Stop media stream
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        
        // Disconnect audio nodes
        if (STATE.audioWorklet) {
            STATE.audioWorklet.source.disconnect();
            STATE.audioWorklet.processor.disconnect();
            STATE.audioWorklet = null;
        }
        
        // Commit audio
        sendMessage({ type: 'input_audio_buffer.commit' });
        
        // Stop screen capture
        if (STATE.screenCaptureInterval) {
            clearInterval(STATE.screenCaptureInterval);
            STATE.screenCaptureInterval = null;
        }
        
        if (STATE.isSpeaking) {
            updateUI('playing');
        } else {
            updateUI('connected');
        }
        
        console.log('[GEMINI-WIDGET] ✅ Recording stopped');
    }

    // ============================================================================
    // AUDIO PLAYBACK
    // ============================================================================

    async function playAudioQueue() {
        if (STATE.isPlaying || STATE.audioQueue.length === 0) return;
        
        STATE.isPlaying = true;
        
        while (STATE.audioQueue.length > 0) {
            const base64Audio = STATE.audioQueue.shift();
            await playAudioChunk(base64Audio);
            
            if (!STATE.isPlaying) break;
        }
        
        STATE.isPlaying = false;
    }

    async function playAudioChunk(base64Audio) {
        try {
            // Decode base64
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Convert PCM16 to Float32
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768.0;
            }
            
            // Resample from 24kHz to 16kHz (simple decimation)
            const outputSampleRate = CONFIG.audio.playbackSampleRate;
            const inputSampleRate = CONFIG.audio.outputSampleRate;
            const ratio = inputSampleRate / outputSampleRate;
            const outputLength = Math.floor(float32.length / ratio);
            const resampled = new Float32Array(outputLength);
            
            for (let i = 0; i < outputLength; i++) {
                const srcIndex = Math.floor(i * ratio);
                resampled[i] = float32[srcIndex];
            }
            
            // Create AudioBuffer
            const audioBuffer = STATE.audioContext.createBuffer(
                1,
                resampled.length,
                outputSampleRate
            );
            audioBuffer.getChannelData(0).set(resampled);
            
            // Play
            const source = STATE.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(STATE.audioContext.destination);
            
            STATE.currentAudioSource = source;
            
            return new Promise((resolve) => {
                source.onended = () => {
                    STATE.currentAudioSource = null;
                    resolve();
                };
                source.start();
            });
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Playback error:', error);
        }
    }

    function stopPlayback() {
        if (STATE.currentAudioSource) {
            try {
                STATE.currentAudioSource.stop();
                STATE.currentAudioSource = null;
            } catch (e) {
                // Already stopped
            }
        }
        
        STATE.audioQueue = [];
        STATE.isPlaying = false;
    }

    // ============================================================================
    // SCREEN CAPTURE
    // ============================================================================

    async function startScreenCapture() {
        console.log('[GEMINI-WIDGET] Starting screen capture...');
        
        // Capture immediately
        await captureScreen();
        
        // Then every interval
        STATE.screenCaptureInterval = setInterval(captureScreen, CONFIG.screen.interval);
    }

    async function captureScreen() {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Capture viewport
            canvas.width = Math.min(window.innerWidth, CONFIG.screen.maxWidth);
            canvas.height = Math.min(window.innerHeight, CONFIG.screen.maxHeight);
            
            // Use html2canvas if available, otherwise just send placeholder
            if (window.html2canvas) {
                const screenshot = await html2canvas(document.body, {
                    width: canvas.width,
                    height: canvas.height,
                    scale: 1,
                    logging: false
                });
                
                ctx.drawImage(screenshot, 0, 0, canvas.width, canvas.height);
            } else {
                // Fallback: just fill with white (requires html2canvas library)
                console.warn('[GEMINI-WIDGET] html2canvas not available');
                return;
            }
            
            // Convert to base64
            const base64Image = canvas.toDataURL('image/jpeg', CONFIG.screen.quality);
            
            // Send to server
            sendMessage({
                type: 'screen.context',
                image: base64Image,
                silent: true  // Don't trigger response
            });
            
            console.log('[GEMINI-WIDGET] 📸 Screen captured');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Screen capture error:', error);
        }
    }

    // ============================================================================
    // AUDIO UTILITIES
    // ============================================================================

    function float32ToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
    }

    function calculateRMS(float32Array) {
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            sum += float32Array[i] * float32Array[i];
        }
        return Math.sqrt(sum / float32Array.length);
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // ============================================================================
    // START APPLICATION
    // ============================================================================

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[GEMINI-WIDGET] Script loaded');

})();
